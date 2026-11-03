"""One-off import of a Facebook "Download your information" export (JSON format).

Keeps friends, posts, photos/videos, comments and reactions; ignores ads,
messages, logins and everything else. Writes a SQLite database and copies the
referenced media into the data directory, so the export can be archived.

    uv run afterwrd-ingest ~/Downloads/facebook-<you>-<date>-<id>
"""

import argparse
import json
import re
import shutil
import sqlite3
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from afterwrd.config import DATA_DIR, DB_PATH, MEDIA_DIR, THUMB_DIR, thumb_name

SCHEMA = """
CREATE TABLE people (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    is_me         INTEGER NOT NULL DEFAULT 0,
    friend_since  INTEGER,          -- NULL unless currently a friend
    unfriended_at INTEGER,
    profile_media_id INTEGER REFERENCES media(id),  -- current profile picture (only known for me)
    cover_media_id   INTEGER REFERENCES media(id)   -- current cover photo (only known for me)
);

CREATE TABLE albums (
    id             INTEGER PRIMARY KEY,
    name           TEXT NOT NULL,
    description    TEXT,
    last_modified  INTEGER,
    cover_media_id INTEGER REFERENCES media(id)
);

CREATE TABLE posts (
    id            INTEGER PRIMARY KEY,
    timestamp     INTEGER NOT NULL,
    kind          TEXT NOT NULL,    -- status | photo | video | link | shared | wall | group | checkin | review
    title         TEXT,             -- Facebook's summary line, e.g. "Ste Millington shared a link."
    text          TEXT,
    target_id     INTEGER REFERENCES people(id),  -- whose profile a wall post was written on
    group_name    TEXT,
    link_url      TEXT,
    place_name    TEXT,
    place_address TEXT,
    latitude      REAL,
    longitude     REAL,
    fbid          TEXT
);

CREATE TABLE post_tags (
    post_id   INTEGER NOT NULL REFERENCES posts(id),
    person_id INTEGER NOT NULL REFERENCES people(id),
    PRIMARY KEY (post_id, person_id)
);

-- Comments I made. The export only describes the target as "X's photo", so
-- (target_owner_id, target_kind, timestamp) is what we'll match against the
-- owner's own export later.
CREATE TABLE comments (
    id              INTEGER PRIMARY KEY,
    timestamp       INTEGER NOT NULL,
    author_id       INTEGER REFERENCES people(id),  -- me, or my anonymous alias in groups
    action          TEXT NOT NULL,  -- commented | replied
    target_owner_id INTEGER REFERENCES people(id),
    target_kind     TEXT,           -- post | photo | comment | reel | link | album | ...
    group_name      TEXT,
    text            TEXT,           -- NULL when the export only kept the summary line
    link_url        TEXT,
    title           TEXT
);

CREATE TABLE reactions (
    id              INTEGER PRIMARY KEY,
    timestamp       INTEGER NOT NULL,
    reaction        TEXT NOT NULL,  -- Like | Love | Haha | Wow | Sad | Angry | Care
    target_owner_id INTEGER REFERENCES people(id),
    target_kind     TEXT,
    group_name      TEXT,
    url             TEXT,
    fbid            TEXT,
    title           TEXT
);

CREATE TABLE media (
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,   -- relative to the media directory
    kind        TEXT NOT NULL,          -- photo | video
    timestamp   INTEGER,                -- uploaded
    taken_at    INTEGER,
    width       INTEGER,                -- photos only, after EXIF rotation;
    height      INTEGER,                -- NULL means no thumbnail could be made
    description TEXT,
    latitude    REAL,
    longitude   REAL,
    album_id    INTEGER REFERENCES albums(id),
    post_id     INTEGER REFERENCES posts(id),
    comment_id  INTEGER REFERENCES comments(id)
);

-- Other people's photos I'm tagged in: the export has links, not the images.
CREATE TABLE tagged_photos (
    id        INTEGER PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    owner_id  INTEGER REFERENCES people(id),
    url       TEXT,
    fbid      TEXT
);

CREATE INDEX comments_owner ON comments(target_owner_id);
CREATE INDEX comments_ts ON comments(timestamp);
CREATE INDEX reactions_owner ON reactions(target_owner_id);
CREATE INDEX reactions_ts ON reactions(timestamp);
CREATE INDEX posts_ts ON posts(timestamp);
CREATE INDEX posts_target ON posts(target_id);
CREATE INDEX media_album ON media(album_id);
CREATE INDEX media_post ON media(post_id);
CREATE INDEX media_comment ON media(comment_id);
CREATE INDEX tagged_owner ON tagged_photos(owner_id);
"""

TARGET_KINDS = r"life event|post|photo|comment|reel|link|album|note|event|video|status"

# "Ste Millington commented on Jo Bloggs's photo." / "... replied to his own comment."
# / "... liked a post." / "... commented on St Mary's School's link in Some Group."
ACTION_RE = re.compile(
    r"^(?P<actor>.+?) (?P<verb>commented on|replied to|liked|reacted to) "
    r"(?:(?P<own>his|her|their) own |an? |(?P<owner>.+?)'s? )"
    rf"(?P<kind>{TARGET_KINDS})(?: in (?P<group>.+?))?\.$"
)
WALL_RE = re.compile(r" wrote on (?P<owner>.+?)'s? (?:profile|timeline)\.$")
GROUP_POST_RE = re.compile(r" posted in (?P<group>.+?)\.$")

REACTIONS = {
    "LIKE": "Like", "LOVE": "Love", "HAHA": "Haha", "WOW": "Wow",
    "SORRY": "Sad", "SAD": "Sad", "ANGER": "Angry", "ANGRY": "Angry",
    "SUPPORT": "Care", "CARE": "Care",
}
VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".webm"}
THUMB_BOX = (900, 600)  # big enough for a 2x-density grid row or a single photo in a post
ROTATED_ORIENTATIONS = {5, 6, 7, 8}  # EXIF orientations that swap width and height


def fix_text(value):
    """Undo Facebook's mojibake: UTF-8 bytes are written out as Latin-1 code points."""
    if isinstance(value, str):
        try:
            return value.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            return value
    if isinstance(value, list):
        return [fix_text(v) for v in value]
    if isinstance(value, dict):
        return {k: fix_text(v) for k, v in value.items()}
    return value


def reaction_name(raw):
    if not raw:
        return "Like"
    return REACTIONS.get(raw.upper(), raw.capitalize())


def exif(media):
    meta = media.get("media_metadata") or {}
    merged = {}
    for kind in ("photo_metadata", "video_metadata"):
        for entry in (meta.get(kind) or {}).get("exif_data", []):
            merged.update(entry)
    return merged


def label_values(entry):
    """Flatten the newer "label_values" format into {label: value}."""
    out = {}
    for lv in entry.get("label_values", []):
        if "label" in lv:
            out[lv["label"]] = lv.get("value") or lv.get("timestamp_value")
        elif lv.get("title"):
            for d in lv.get("dict", []):
                for inner in d.get("dict", []):
                    if inner.get("label") == "Name":
                        out[lv["title"]] = inner.get("value")
    return out


def is_video(path: Path):
    if path.suffix:
        return path.suffix.lower() in VIDEO_SUFFIXES
    with path.open("rb") as f:  # some videos come without an extension; MP4/MOV have "ftyp" at byte 4
        return f.read(12)[4:8] == b"ftyp"


def make_thumbnail(media_path):
    """Write a thumbnail if there isn't one yet; return the photo's (width, height)."""
    try:
        with Image.open(MEDIA_DIR / media_path) as img:
            width, height = img.size
            if img.getexif().get(0x0112) in ROTATED_ORIENTATIONS:
                width, height = height, width
            dest = THUMB_DIR / thumb_name(media_path)
            if not dest.is_file():
                img.draft("RGB", THUMB_BOX)
                thumb = ImageOps.exif_transpose(img)
                thumb.thumbnail(THUMB_BOX)
                dest.parent.mkdir(parents=True, exist_ok=True)
                thumb.convert("RGB").save(dest, "JPEG", quality=80, optimize=True, progressive=True)
            return width, height
    except (OSError, UnidentifiedImageError) as e:
        print(f"  (couldn't thumbnail {media_path}: {e})")
        return None, None


def kind_from_url(url):
    if "comment_id=" in url:
        return "comment"
    if "/reel/" in url:
        return "reel"
    if "/videos/" in url or "/watch" in url:
        return "video"
    if "photo" in url:
        return "photo"
    return "post"


class Importer:
    def __init__(self, root: Path, db: sqlite3.Connection):
        self.root = root
        self.db = db
        self.people: dict[str, int] = {}
        self.unparsed: Counter[str] = Counter()
        self.copied = 0

    def load(self, rel):
        path = self.root / rel
        if not path.is_file():
            print(f"  (missing {rel}, skipping)")
            return None
        return fix_text(json.loads(path.read_text(encoding="utf-8")))

    def insert(self, table, **row):
        cols = ", ".join(row)
        marks = ", ".join("?" * len(row))
        return self.db.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", tuple(row.values())).lastrowid

    def person(self, name, **fields):
        if not name:
            return None
        if name not in self.people:
            self.people[name] = self.insert("people", name=name)
        pid = self.people[name]
        if fields:
            sets = ", ".join(f"{k} = ?" for k in fields)
            self.db.execute(f"UPDATE people SET {sets} WHERE id = ?", (*fields.values(), pid))
        return pid

    def run(self):
        profile = self.load("personal_information/profile_information/profile_information.json")
        self.me = profile["profile_v2"]["name"]["full_name"]
        self.person(self.me, is_me=1)

        self.friends()
        self.albums()
        self.loose_media()
        self.posts()
        self.comments()
        self.reactions()
        self.tagged_photos()
        self.profile_photos()
        self.thumbnails()

        if self.unparsed:
            print("Summary lines not understood (kept, but without owner/kind):")
            for title, n in self.unparsed.most_common(10):
                print(f"  {n:4d}  {title}")

    def friends(self):
        for f in (self.load("connections/friends/your_friends.json") or {}).get("friends_v2", []):
            self.person(f["name"], friend_since=f["timestamp"])
        for f in (self.load("connections/friends/removed_friends.json") or {}).get("deleted_friends_v2", []):
            self.person(f["name"], unfriended_at=f["timestamp"])

    def media(self, m, **links):
        uri = m.get("uri") or ""
        src = (self.root / uri).resolve()
        if not uri or not src.is_relative_to(self.root) or not src.is_file():
            return None

        existing = self.db.execute("SELECT id FROM media WHERE path = ?", (uri,)).fetchone()
        if existing:
            for col, value in [*links.items(), ("description", m.get("description") or None)]:
                self.db.execute(f"UPDATE media SET {col} = COALESCE({col}, ?) WHERE id = ?", (value, existing[0]))
            return existing[0]

        dest = MEDIA_DIR / uri
        if not (dest.is_file() and dest.stat().st_size == src.stat().st_size):
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            self.copied += 1

        meta = exif(m)
        return self.insert(
            "media",
            path=uri,
            kind="video" if is_video(src) else "photo",
            timestamp=m.get("creation_timestamp") or None,
            taken_at=meta.get("taken_timestamp") or None,
            description=m.get("description") or None,
            latitude=meta.get("latitude"),
            longitude=meta.get("longitude"),
            **links,
        )

    def albums(self):
        album_dir = self.root / "your_facebook_activity/posts/album"
        files = sorted(album_dir.glob("*.json"), key=lambda p: int(p.stem) if p.stem.isdigit() else 0)
        for path in files:
            album = self.load(path.relative_to(self.root))
            if not album or not album.get("photos"):
                continue
            album_id = self.insert(
                "albums",
                name=album.get("name") or "Untitled album",
                description=album.get("description") or None,
                last_modified=album.get("last_modified_timestamp"),
            )
            photo_ids = {photo["uri"]: self.media(photo, album_id=album_id) for photo in album["photos"]}
            # Some exports point the cover at a generic "?" placeholder; use the first photo instead.
            cover_uri = (album.get("cover_photo") or {}).get("uri")
            cover_id = photo_ids.get(cover_uri) or next(iter(photo_ids.values()))
            self.db.execute("UPDATE albums SET cover_media_id = ? WHERE id = ?", (cover_id, album_id))

    def loose_media(self):
        posts = "your_facebook_activity/posts"
        for m in (self.load(f"{posts}/your_uncategorized_photos.json") or {}).get("other_photos_v2", []):
            self.media(m)
        for m in (self.load(f"{posts}/your_videos.json") or {}).get("videos_v2", []):
            self.media(m)

    def posts(self):
        posts = "your_facebook_activity/posts"
        wall_fbids = {
            e["timestamp"]: e.get("fbid")
            for e in self.load(f"{posts}/posts_on_other_pages_and_profiles.json") or []
        }
        for path in sorted((self.root / posts).glob("your_posts__check_ins__photos_and_videos*.json")):
            for p in self.load(path.relative_to(self.root)) or []:
                self.post(p, fbid=wall_fbids.get(p["timestamp"]))
        group_posts = self.load("your_facebook_activity/groups/group_posts_and_comments.json") or {}
        for p in group_posts.get("group_posts_v2", []):
            self.post(p)

    def post(self, p, fbid=None):
        title = p.get("title") or ""
        text = next((d["post"] for d in p.get("data", []) if d.get("post")), None)
        media, link, place = [], None, None
        for attachment in p.get("attachments", []):
            for d in attachment.get("data", []):
                if "media" in d:
                    media.append(d["media"])
                link = link or (d.get("external_context") or {}).get("url") or None
                place = place or d.get("place")

        target_id = group = None
        if m := WALL_RE.search(title):
            kind, target_id = "wall", self.person(m["owner"])
        elif m := GROUP_POST_RE.search(title):
            kind, group = "group", m["group"]
        elif "recommend" in title:
            kind = "review"
        elif media:
            videos = all(
                Path(x.get("uri", "")).suffix.lower() in VIDEO_SUFFIXES or "/videos/" in x.get("uri", "") for x in media
            )
            kind = "video" if videos else "photo"
        elif link:
            kind = "link"
        elif place:
            kind = "checkin"
        elif " shared " in title:
            kind = "shared"
        else:
            kind = "status"

        place = place or {}
        coords = place.get("coordinate") or {}
        post_id = self.insert(
            "posts",
            timestamp=p["timestamp"],
            kind=kind,
            title=title or None,
            text=text,
            target_id=target_id,
            group_name=group,
            link_url=link,
            place_name=place.get("name"),
            place_address=place.get("address"),
            latitude=coords.get("latitude"),
            longitude=coords.get("longitude"),
            fbid=fbid,
        )
        for tag in p.get("tags", []):
            self.db.execute(
                "INSERT OR IGNORE INTO post_tags (post_id, person_id) VALUES (?, ?)",
                (post_id, self.person(tag["name"])),
            )
        for m in media:
            self.media(m, post_id=post_id)

    def parse_action(self, title, actor_fallback):
        """Returns (actor, verb, owner, kind, group) from a summary line."""
        m = ACTION_RE.match(title)
        if not m:
            self.unparsed[title] += 1
            return actor_fallback, None, None, None, None
        owner = m["actor"] if m["own"] else m["owner"]
        return m["actor"], m["verb"], owner, m["kind"], m["group"]

    def comments(self):
        entries = (self.load("your_facebook_activity/comments_and_reactions/comments.json") or {}).get("comments_v2", [])
        groups = self.load("your_facebook_activity/groups/your_comments_in_groups.json") or {}
        entries += groups.get("group_comments_v2", [])

        seen = set()
        for c in entries:
            title = c.get("title") or ""
            data = next((d["comment"] for d in c.get("data", []) if "comment" in d), {})
            key = (c["timestamp"], title, data.get("comment"))
            if key in seen:
                continue
            seen.add(key)

            actor, verb, owner, kind, group = self.parse_action(title, self.me)
            media, link = [], None
            for attachment in c.get("attachments", []):
                for d in attachment.get("data", []):
                    if "media" in d:
                        media.append(d["media"])
                    link = link or (d.get("external_context") or {}).get("url") or None

            comment_id = self.insert(
                "comments",
                timestamp=data.get("timestamp") or c["timestamp"],
                author_id=self.person(data.get("author") or actor),
                action="replied" if verb == "replied to" else "commented",
                target_owner_id=self.person(owner),
                target_kind=kind,
                group_name=data.get("group") or group,
                text=data.get("comment") or None,
                link_url=link,
                title=title or None,
            )
            for m in media:
                self.media(m, comment_id=comment_id)

    def reactions(self):
        """Merge the two reaction formats Facebook exports.

        likes_and_reactions.json has URLs but only covers recent years;
        likes_and_reactions_N.json has summary lines going back to the start.
        They overlap heavily, so pair them up by timestamp.
        """
        rich, titled = [], []
        folder = self.root / "your_facebook_activity/comments_and_reactions"
        for path in sorted(folder.glob("likes_and_reactions*.json")):
            for e in self.load(path.relative_to(self.root)) or []:
                (rich if "label_values" in e else titled).append(e)

        rich_by_ts = defaultdict(list)
        for e in rich:
            v = label_values(e)
            url = v.get("URL") or None
            rich_by_ts[e["timestamp"]].append({
                "reaction": v.get("Reaction"),
                "owner": v.get("Owner") or v.get("Author") or v.get("Name") or None,
                "group": v.get("Group"),
                "url": url,
                "fbid": e.get("fbid"),
                "kind": kind_from_url(url or ""),
            })

        seen = set()
        for e in titled:
            title = e.get("title") or ""
            if (e["timestamp"], title) in seen:
                continue
            seen.add((e["timestamp"], title))
            raw = next((d["reaction"] for d in e.get("data", []) if "reaction" in d), {})
            _, _, owner, kind, group = self.parse_action(title, self.me)

            candidates = rich_by_ts.get(e["timestamp"], [])
            match = next((c for c in candidates if c["owner"] == owner), candidates[0] if candidates else None)
            if match:
                candidates.remove(match)
            match = match or {}

            self.insert(
                "reactions",
                timestamp=e["timestamp"],
                reaction=reaction_name(raw.get("reaction") or match.get("reaction")),
                target_owner_id=self.person(owner or match.get("owner")),
                target_kind=kind or match.get("kind"),
                group_name=group or match.get("group"),
                url=match.get("url"),
                fbid=match.get("fbid"),
                title=title or None,
            )

        for ts, leftovers in rich_by_ts.items():
            for r in leftovers:
                self.insert(
                    "reactions",
                    timestamp=ts,
                    reaction=reaction_name(r["reaction"]),
                    target_owner_id=self.person(r["owner"]),
                    target_kind=r["kind"],
                    group_name=r["group"],
                    url=r["url"],
                    fbid=r["fbid"],
                    title=None,
                )

    def tagged_photos(self):
        rel = "your_facebook_activity/activity_you're_tagged_in/photos_and_videos_you're_tagged_in.json"
        for e in self.load(rel) or []:
            v = label_values(e)
            self.insert(
                "tagged_photos",
                timestamp=e["timestamp"],
                owner_id=self.person(v.get("Name")),
                url=v.get("URL"),
                fbid=e.get("fbid"),
            )


    def profile_photos(self):
        """Work out my current profile picture and cover photo.

        The profile update history records each profile picture change, so the
        latest one is current. Cover photo changes usually aren't recorded, so
        fall back to the newest upload in the "Cover photos" album.
        """
        latest = {}
        history = self.load("personal_information/profile_information/profile_update_history.json") or {}
        for entry in sorted(history.get("profile_updates_v2", []), key=lambda e: e["timestamp"]):
            title = (entry.get("title") or "").lower()
            field = "profile_media_id" if "profile picture" in title else "cover_media_id" if "cover photo" in title else None
            uri = next((d["media"]["uri"] for a in entry.get("attachments", []) for d in a.get("data", []) if "media" in d), None)
            if field and uri:
                row = self.db.execute("SELECT id FROM media WHERE path = ?", (uri,)).fetchone()
                latest[field] = row[0] if row else latest.get(field)

        if "cover_media_id" not in latest:
            row = self.db.execute("""
                SELECT m.id FROM media m JOIN albums a ON a.id = m.album_id
                WHERE a.name = 'Cover photos' ORDER BY m.timestamp DESC, m.id DESC LIMIT 1
            """).fetchone()
            if row:
                latest["cover_media_id"] = row[0]

        if latest:
            self.person(self.me, **latest)

    def thumbnails(self):
        rows = self.db.execute("SELECT id, path FROM media WHERE kind = 'photo'").fetchall()
        with ThreadPoolExecutor() as pool:
            sizes = list(pool.map(make_thumbnail, [path for _, path in rows]))
        self.db.executemany(
            "UPDATE media SET width = ?, height = ? WHERE id = ?",
            [(w, h, media_id) for (media_id, _), (w, h) in zip(rows, sizes)],
        )


def main():
    parser = argparse.ArgumentParser(description="Import a Facebook JSON export into afterwrd.")
    parser.add_argument("export_dir", type=Path, help="the unzipped facebook-<you>-<date>-<id> folder")
    args = parser.parse_args()

    root = args.export_dir.expanduser().resolve()
    if not (root / "your_facebook_activity").is_dir():
        parser.error(f"{root} doesn't look like a Facebook JSON export (no your_facebook_activity folder)")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = DB_PATH.with_suffix(".db.tmp")
    tmp.unlink(missing_ok=True)
    db = sqlite3.connect(tmp)
    db.executescript(SCHEMA)

    print(f"Importing {root}")
    importer = Importer(root, db)
    importer.run()
    db.commit()

    for table in ("people", "posts", "comments", "reactions", "media", "albums", "tagged_photos"):
        print(f"  {table:14s} {db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]:6d}")
    print(f"  media copied   {importer.copied:6d}")
    db.close()
    tmp.replace(DB_PATH)
    print(f"Wrote {DB_PATH}")


if __name__ == "__main__":
    main()
