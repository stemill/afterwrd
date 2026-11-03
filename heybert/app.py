"""Read-only web app over the database built by heybert.ingest.

    uv run heybert            # http://127.0.0.1:8000
"""

import re
import sqlite3
from datetime import datetime
from itertools import groupby
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from markupsafe import Markup, escape

from heybert.config import DB_PATH, MEDIA_DIR, THUMB_DIR, thumb_name

HERE = Path(__file__).parent
TZ = ZoneInfo("Europe/London")
PAGE_SIZE = 50
PHOTO_PAGE_SIZE = 150

app = FastAPI(title="heybert")
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
app.mount("/media", StaticFiles(directory=MEDIA_DIR, check_dir=False), name="media")
app.mount("/thumbs", StaticFiles(directory=THUMB_DIR, check_dir=False), name="thumbs")
templates = Jinja2Templates(directory=HERE / "templates")


# --- template helpers -------------------------------------------------------

URL_RE = re.compile(r"https?://[^\s<>\"]+")
EMOJI = {"Like": "👍", "Love": "❤️", "Haha": "😆", "Wow": "😮", "Sad": "😢", "Angry": "😠", "Care": "🤗"}


def fmt_datetime(ts):
    return datetime.fromtimestamp(ts, TZ).strftime("%a %-d %b %Y, %H:%M") if ts else ""


def fmt_date(ts):
    return datetime.fromtimestamp(ts, TZ).strftime("%-d %b %Y") if ts else ""


def linkify(text):
    if not text:
        return ""
    parts, last = [], 0
    for m in URL_RE.finditer(text):
        parts.append(escape(text[last : m.start()]))
        parts.append(Markup('<a href="{0}" target="_blank" rel="noopener noreferrer">{0}</a>').format(m.group(0)))
        last = m.end()
    parts.append(escape(text[last:]))
    return Markup("").join(parts)


def safe_url(url):
    return url if url and url.startswith(("http://", "https://")) else None


def summary(title, my_name):
    """'Ste Millington shared a link.' -> 'Shared a link.'"""
    if not title:
        return ""
    if title.startswith(my_name + " "):
        title = title[len(my_name) + 1 :]
    return title[:1].upper() + title[1:]


def fmt_month(ts):
    return datetime.fromtimestamp(ts, TZ).strftime("%B %Y") if ts else ""


def date_range(start, end):
    """'3 – 9 Aug 2015', '28 Jul – 9 Aug 2015' or '2014 – 2016'."""
    if not start:
        return ""
    a, b = datetime.fromtimestamp(start, TZ), datetime.fromtimestamp(end or start, TZ)
    if a.date() == b.date():
        return fmt_date(start)
    if a.year != b.year:
        return f"{a.year} – {b.year}" if (b - a).days > 90 else f"{a:%-d %b %Y} – {b:%-d %b %Y}"
    if a.month != b.month:
        return f"{a:%-d %b} – {b:%-d %b %Y}"
    return f"{a:%-d} – {b:%-d %b %Y}"


def thumb_url(m):
    """Small version of a photo for grids; videos and unreadable photos fall back to the original."""
    if m["kind"] == "photo" and m["width"]:
        return f"/thumbs/{thumb_name(m['path'])}"
    return f"/media/{m['path']}"


def aspect(m):
    """Width / height, clamped so panoramas and very tall shots don't wreck a grid row."""
    if m["width"] and m["height"]:
        return round(min(max(m["width"] / m["height"], 0.5), 2.5), 3)
    return 1.5 if m["kind"] == "photo" else 16 / 9


def page_url(request: Request, page: int):
    url = request.url.include_query_params(page=page)
    return f"{url.path}?{url.query}"


templates.env.filters.update(dt=fmt_datetime, date=fmt_date, month=fmt_month, linkify=linkify, safe_url=safe_url,
                             summary=summary, thumb=thumb_url, aspect=aspect)
templates.env.globals.update(date_range=date_range)
templates.env.globals.update(emoji=EMOJI, page_url=page_url)


# --- data access -------------------------------------------------------------

def get_db():
    if not DB_PATH.exists():
        raise HTTPException(503, "No data yet: run `uv run heybert-ingest <export folder>` first.")
    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, check_same_thread=False)
    db.row_factory = sqlite3.Row
    try:
        yield db
    finally:
        db.close()


class Filters:
    """Accumulates WHERE clauses and their parameters."""

    def __init__(self):
        self.clauses: list[str] = []
        self.params: list = []

    def add(self, clause, *params):
        self.clauses.append(clause)
        self.params.extend(params)

    @property
    def sql(self):
        return f"WHERE {' AND '.join(self.clauses)}" if self.clauses else ""


def paginate(db, sql, params, page, size=PAGE_SIZE):
    total = db.execute(f"SELECT COUNT(*) FROM ({sql})", params).fetchone()[0]
    rows = db.execute(f"{sql} LIMIT ? OFFSET ?", [*params, size, (page - 1) * size]).fetchall()
    return rows, total, page * size < total


def years(db, table):
    sql = f"SELECT DISTINCT strftime('%Y', timestamp, 'unixepoch') AS y FROM {table} ORDER BY y DESC"
    return [r["y"] for r in db.execute(sql)]


POST_SQL = """
    SELECT p.*, t.name AS target_name FROM posts p
    LEFT JOIN people t ON t.id = p.target_id
"""
COMMENT_SQL = """
    SELECT c.*, o.name AS owner_name, a.name AS author_name, a.is_me AS author_is_me
    FROM comments c
    LEFT JOIN people o ON o.id = c.target_owner_id
    LEFT JOIN people a ON a.id = c.author_id
"""
REACTION_SQL = """
    SELECT r.*, o.name AS owner_name FROM reactions r
    LEFT JOIN people o ON o.id = r.target_owner_id
"""


def with_media(db, rows, column):
    """Return rows as dicts with a `media` list attached via media.<column>."""
    items = [dict(r) for r in rows]
    if items:
        ids = [i["id"] for i in items]
        marks = ",".join("?" * len(ids))
        media = db.execute(f"SELECT * FROM media WHERE {column} IN ({marks}) ORDER BY timestamp, id", ids).fetchall()
        by_parent = {}
        for m in media:
            by_parent.setdefault(m[column], []).append(m)
        for i in items:
            i["media"] = by_parent.get(i["id"], [])
    return items


def load_posts(db, rows):
    posts = with_media(db, rows, "post_id")
    if posts:
        ids = [p["id"] for p in posts]
        marks = ",".join("?" * len(ids))
        tags = db.execute(
            f"SELECT t.post_id, p.id, p.name FROM post_tags t JOIN people p ON p.id = t.person_id WHERE t.post_id IN ({marks})",
            ids,
        ).fetchall()
        for p in posts:
            p["tags"] = [t for t in tags if t["post_id"] == p["id"]]
    return posts


def load_comments(db, rows):
    return with_media(db, rows, "comment_id")


def me(db):
    return db.execute("""
        SELECT p.*, pm.path AS profile_path, cm.path AS cover_path FROM people p
        LEFT JOIN media pm ON pm.id = p.profile_media_id
        LEFT JOIN media cm ON cm.id = p.cover_media_id
        WHERE p.is_me = 1
    """).fetchone()


def render(request, db, name, **context):
    return templates.TemplateResponse(request, name, {"me": me(db), **context})


# --- pages -------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
def overview(request: Request, db=Depends(get_db)):
    counts = {
        table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in ("posts", "comments", "reactions", "media", "albums", "tagged_photos")
    }
    counts["friends"] = db.execute("SELECT COUNT(*) FROM people WHERE friend_since IS NOT NULL").fetchone()[0]
    by_year = db.execute("""
        SELECT year, SUM(t = 'p') AS posts, SUM(t = 'c') AS comments, SUM(t = 'r') AS reactions, SUM(t = 'm') AS photos
        FROM (
            SELECT strftime('%Y', timestamp, 'unixepoch') AS year, 'p' AS t FROM posts
            UNION ALL SELECT strftime('%Y', timestamp, 'unixepoch'), 'c' FROM comments
            UNION ALL SELECT strftime('%Y', timestamp, 'unixepoch'), 'r' FROM reactions
            UNION ALL SELECT strftime('%Y', timestamp, 'unixepoch'), 'm' FROM media WHERE timestamp IS NOT NULL
        )
        GROUP BY year ORDER BY year DESC
    """).fetchall()
    top_people = db.execute("""
        SELECT p.id, p.name, p.friend_since,
            (SELECT COUNT(*) FROM comments c WHERE c.target_owner_id = p.id) AS comments,
            (SELECT COUNT(*) FROM reactions r WHERE r.target_owner_id = p.id) AS reactions
        FROM people p WHERE p.is_me = 0
        ORDER BY comments + reactions DESC LIMIT 15
    """).fetchall()
    return render(request, db, "overview.html", counts=counts, by_year=by_year, top_people=top_people)


@app.get("/timeline", response_class=HTMLResponse)
def timeline(request: Request, year: str = "", page: int = 1, db=Depends(get_db)):
    f = Filters()
    if year:
        f.add("strftime('%Y', timestamp, 'unixepoch') = ?", year)
    sql = f"""
        SELECT * FROM (
            SELECT 'post' AS type, id, timestamp FROM posts
            UNION ALL SELECT 'comment', id, timestamp FROM comments
            UNION ALL SELECT 'reaction', id, timestamp FROM reactions
        ) {f.sql} ORDER BY timestamp DESC, type, id DESC
    """
    rows, total, has_next = paginate(db, sql, f.params, page)

    def fetch(type_, base_sql, alias, loader=None):
        ids = [r["id"] for r in rows if r["type"] == type_]
        if not ids:
            return {}
        found = db.execute(f"{base_sql} WHERE {alias}.id IN ({','.join('?' * len(ids))})", ids).fetchall()
        found = loader(db, found) if loader else [dict(r) for r in found]
        return {r["id"]: r for r in found}

    posts = fetch("post", POST_SQL, "p", load_posts)
    comments = fetch("comment", COMMENT_SQL, "c", load_comments)
    reactions = fetch("reaction", REACTION_SQL, "r")
    lookup = {"post": posts, "comment": comments, "reaction": reactions}
    items = [(r["type"], lookup[r["type"]][r["id"]]) for r in rows]
    years_all = sorted(set(years(db, "posts") + years(db, "comments") + years(db, "reactions")), reverse=True)
    return render(request, db, "timeline.html", items=items, total=total, page=page, has_next=has_next,
                  years=years_all, year=year)


@app.get("/posts", response_class=HTMLResponse)
def posts(request: Request, q: str = "", year: str = "", kind: str = "", page: int = 1, db=Depends(get_db)):
    f = Filters()
    if q:
        f.add("(p.text LIKE ? OR p.title LIKE ? OR p.link_url LIKE ?)", *[f"%{q}%"] * 3)
    if year:
        f.add("strftime('%Y', p.timestamp, 'unixepoch') = ?", year)
    if kind:
        f.add("p.kind = ?", kind)
    rows, total, has_next = paginate(db, f"{POST_SQL} {f.sql} ORDER BY p.timestamp DESC", f.params, page)
    kinds = [r[0] for r in db.execute("SELECT kind FROM posts GROUP BY kind ORDER BY COUNT(*) DESC")]
    return render(request, db, "posts.html", posts=load_posts(db, rows), total=total, page=page, has_next=has_next,
                  q=q, year=year, kind=kind, years=years(db, "posts"), kinds=kinds)


@app.get("/comments", response_class=HTMLResponse)
def comments(request: Request, q: str = "", year: str = "", kind: str = "", page: int = 1, db=Depends(get_db)):
    f = Filters()
    if q:
        f.add("(c.text LIKE ? OR o.name LIKE ? OR c.group_name LIKE ?)", *[f"%{q}%"] * 3)
    if year:
        f.add("strftime('%Y', c.timestamp, 'unixepoch') = ?", year)
    if kind:
        f.add("c.target_kind = ?", kind)
    rows, total, has_next = paginate(db, f"{COMMENT_SQL} {f.sql} ORDER BY c.timestamp DESC", f.params, page)
    kinds = [r[0] for r in db.execute(
        "SELECT target_kind FROM comments WHERE target_kind IS NOT NULL GROUP BY target_kind ORDER BY COUNT(*) DESC")]
    return render(request, db, "comments.html", comments=load_comments(db, rows), total=total, page=page,
                  has_next=has_next, q=q, year=year, kind=kind, years=years(db, "comments"), kinds=kinds)


@app.get("/likes", response_class=HTMLResponse)
def likes(request: Request, q: str = "", year: str = "", reaction: str = "", page: int = 1, db=Depends(get_db)):
    f = Filters()
    if q:
        f.add("(o.name LIKE ? OR r.group_name LIKE ?)", *[f"%{q}%"] * 2)
    if year:
        f.add("strftime('%Y', r.timestamp, 'unixepoch') = ?", year)
    if reaction:
        f.add("r.reaction = ?", reaction)
    rows, total, has_next = paginate(db, f"{REACTION_SQL} {f.sql} ORDER BY r.timestamp DESC", f.params, page)
    reactions = [r[0] for r in db.execute("SELECT reaction FROM reactions GROUP BY reaction ORDER BY COUNT(*) DESC")]
    return render(request, db, "likes.html", reactions=rows, total=total, page=page, has_next=has_next,
                  q=q, year=year, reaction=reaction, years=years(db, "reactions"), reaction_types=reactions)


def media_set(album: str):
    """Filter for a photo set: an album id, 'other' (unalbumed photos) or 'videos'."""
    if album == "videos":
        return "Videos", "album_id IS NULL AND kind = 'video'", []
    if album == "other":
        return "Other photos", "album_id IS NULL AND kind = 'photo'", []
    if album.isdigit():
        return None, "album_id = ?", [int(album)]
    raise HTTPException(404)


MEDIA_ORDER = "ORDER BY COALESCE(timestamp, 0), id"


def set_stats(db, where, params):
    return db.execute(
        f"SELECT COUNT(*) AS count, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts FROM media WHERE {where}",
        params,
    ).fetchone()


@app.get("/photos", response_class=HTMLResponse)
def photos(request: Request, db=Depends(get_db)):
    albums = db.execute("""
        SELECT a.id, a.name, m.path, m.kind, m.width, m.height,
            COUNT(x.id) AS count, MIN(x.timestamp) AS first_ts, MAX(x.timestamp) AS last_ts
        FROM albums a
        JOIN media x ON x.album_id = a.id
        LEFT JOIN media m ON m.id = a.cover_media_id
        GROUP BY a.id ORDER BY first_ts DESC
    """).fetchall()
    by_year = [(year, list(group)) for year, group in groupby(albums, key=lambda a: fmt_date(a["first_ts"])[-4:])]

    collections = []
    for key in ("other", "videos"):
        title, where, params = media_set(key)
        stats = set_stats(db, where, params)
        cover = db.execute(f"SELECT * FROM media WHERE {where} ORDER BY timestamp DESC LIMIT 1", params).fetchone()
        if cover:
            collections.append({"key": key, "title": title, "cover": cover, **stats})
    tagged = db.execute("SELECT COUNT(*) FROM tagged_photos").fetchone()[0]
    return render(request, db, "photos.html", by_year=by_year, collections=collections, tagged=tagged)


@app.get("/photos/album/{album}", response_class=HTMLResponse)
def album(request: Request, album: str, page: int = 1, db=Depends(get_db)):
    title, where, params = media_set(album)
    info = None
    if title is None:
        info = db.execute("SELECT * FROM albums WHERE id = ?", params).fetchone()
        if not info:
            raise HTTPException(404)
        title = info["name"]
    stats = set_stats(db, where, params)
    rows, total, has_next = paginate(db, f"SELECT * FROM media WHERE {where} {MEDIA_ORDER}", params, page,
                                     PHOTO_PAGE_SIZE)
    # Long-running sets read better split by month; a single trip's album doesn't need it.
    spans_months = fmt_month(stats["first_ts"]) != fmt_month(stats["last_ts"])
    groups = [(month, list(items)) for month, items in groupby(rows, key=lambda m: fmt_month(m["timestamp"]))] \
        if spans_months else [(None, rows)]
    return render(request, db, "album.html", key=album, title=title, info=info, stats=stats, groups=groups,
                  total=total, page=page, has_next=has_next)


@app.get("/photos/tagged", response_class=HTMLResponse)
def tagged(request: Request, page: int = 1, db=Depends(get_db)):
    rows, total, has_next = paginate(db, """
        SELECT t.*, p.name AS owner_name FROM tagged_photos t LEFT JOIN people p ON p.id = t.owner_id
        ORDER BY t.timestamp DESC
    """, [], page)
    return render(request, db, "tagged.html", tagged=rows, total=total, page=page, has_next=has_next)


@app.get("/photos/{media_id}", response_class=HTMLResponse)
def photo(request: Request, media_id: int, db=Depends(get_db)):
    m = db.execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone()
    if not m:
        raise HTTPException(404)
    key = str(m["album_id"]) if m["album_id"] else ("videos" if m["kind"] == "video" else "other")
    title, where, params = media_set(key)
    if title is None:
        title = db.execute("SELECT name FROM albums WHERE id = ?", params).fetchone()["name"]
    order = "(COALESCE(timestamp, 0), id)"
    position = (m["timestamp"] or 0, m["id"])
    prev = db.execute(
        f"SELECT * FROM media WHERE {where} AND {order} < (?, ?) ORDER BY COALESCE(timestamp, 0) DESC, id DESC LIMIT 1",
        [*params, *position]).fetchone()
    next_ = db.execute(f"SELECT * FROM media WHERE {where} AND {order} > (?, ?) {MEDIA_ORDER} LIMIT 1",
                       [*params, *position]).fetchone()
    index = db.execute(f"SELECT COUNT(*) FROM media WHERE {where} AND {order} < (?, ?)",
                       [*params, *position]).fetchone()[0]
    album_page = index // PHOTO_PAGE_SIZE + 1
    post = load_posts(db, db.execute(f"{POST_SQL} WHERE p.id = ?", (m["post_id"],)).fetchall()) if m["post_id"] else []
    comment = load_comments(db, db.execute(f"{COMMENT_SQL} WHERE c.id = ?", (m["comment_id"],)).fetchall()) if m["comment_id"] else []
    return render(request, db, "photo.html", m=m, set_key=key, set_title=title, prev=prev, next=next_,
                  index=index + 1, total=set_stats(db, where, params)["count"], album_page=album_page,
                  post=post[0] if post else None, comment=comment[0] if comment else None)


@app.get("/friends", response_class=HTMLResponse)
def friends(request: Request, q: str = "", show: str = "friends", sort: str = "name", db=Depends(get_db)):
    f = Filters()
    f.add("p.is_me = 0")
    if show == "friends":
        f.add("p.friend_since IS NOT NULL")
    elif show == "removed":
        f.add("p.unfriended_at IS NOT NULL")
    if q:
        f.add("p.name LIKE ?", f"%{q}%")
    order = {
        "name": "p.name COLLATE NOCASE",
        "since": "p.friend_since IS NULL, p.friend_since",
        "activity": "comments + reactions DESC, p.name COLLATE NOCASE",
    }.get(sort, "p.name COLLATE NOCASE")
    people = db.execute(f"""
        SELECT p.*,
            (SELECT COUNT(*) FROM comments c WHERE c.target_owner_id = p.id) AS comments,
            (SELECT COUNT(*) FROM reactions r WHERE r.target_owner_id = p.id) AS reactions,
            (SELECT COUNT(*) FROM posts x WHERE x.target_id = p.id) AS wall,
            (SELECT COUNT(*) FROM tagged_photos t WHERE t.owner_id = p.id) AS tagged
        FROM people p {f.sql} ORDER BY {order}
    """, f.params).fetchall()
    return render(request, db, "friends.html", people=people, q=q, show=show, sort=sort)


PERSON_TABS = {
    "comments": ("Comments", f"{COMMENT_SQL} WHERE c.target_owner_id = ? ORDER BY c.timestamp DESC"),
    "likes": ("Likes", f"{REACTION_SQL} WHERE r.target_owner_id = ? ORDER BY r.timestamp DESC"),
    "wall": ("Wall posts", f"{POST_SQL} WHERE p.target_id = ? ORDER BY p.timestamp DESC"),
    "tags": ("Tagged together", f"{POST_SQL} JOIN post_tags pt ON pt.post_id = p.id WHERE pt.person_id = ? ORDER BY p.timestamp DESC"),
    "photos": ("Photos of you", "SELECT * FROM tagged_photos t WHERE t.owner_id = ? ORDER BY t.timestamp DESC"),
}


@app.get("/people/{person_id}", response_class=HTMLResponse)
def person(request: Request, person_id: int, tab: str = "", page: int = 1, db=Depends(get_db)):
    p = db.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
    if not p:
        raise HTTPException(404)
    counts = {
        key: db.execute(f"SELECT COUNT(*) FROM ({sql})", (person_id,)).fetchone()[0]
        for key, (_, sql) in PERSON_TABS.items()
    }
    if tab not in PERSON_TABS:
        tab = next((k for k, n in counts.items() if n), "comments")
    rows, total, has_next = paginate(db, PERSON_TABS[tab][1], [person_id], page)
    if tab == "comments":
        rows = load_comments(db, rows)
    elif tab in ("wall", "tags"):
        rows = load_posts(db, rows)
    return render(request, db, "person.html", person=p, tabs=PERSON_TABS, counts=counts, tab=tab, rows=rows,
                  total=total, page=page, has_next=has_next)


def main():
    import uvicorn

    uvicorn.run("heybert.app:app", host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
