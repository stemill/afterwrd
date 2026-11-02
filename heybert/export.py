"""Render the site to static files for publishing behind the login in worker/.

    uv run heybert-export                              # posts and photos
    uv run heybert-export --sections posts,photos,timeline
    uv run heybert-export --sections all

Pages are found by following links from each section's front page, so only what those pages show is
exported: media that isn't linked from an exported page stays at home. Query strings become file names
(/posts?page=2 -> posts/_q/page-2.html); worker/src/index.js maps requests back the same way.
"""

import argparse
import re
import shutil
import sys
import warnings
from collections import deque
from html import unescape
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urljoin, urlsplit

# Starlette nudges towards httpx2; httpx still works and is what FastAPI's docs use.
warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient`")
from fastapi.testclient import TestClient  # noqa: E402

from heybert import app as web
from heybert.config import DATA_DIR, MEDIA_DIR, THUMB_DIR

SITE_DIR = DATA_DIR / "site"
MARKER = ".heybert-site"
MAX_FILE = 25 * 1024 * 1024  # Cloudflare's limit for a single static asset
DEFAULT_SECTIONS = ("posts", "photos")
SECTION_ROOTS = {s: "/" if s == "overview" else f"/{s}" for s in web.SECTIONS}
FILE_DIRS = {"static": web.HERE / "static", "media": MEDIA_DIR, "thumbs": THUMB_DIR}
LINK_RE = re.compile(r"""(?:href|src)="([^"]+)"|url\('([^']+)'\)""")
PARAM_RE = re.compile(r"^[\w-]+$")


def page_file(path, query):
    """Where a page is written, relative to the site root."""
    base = path.strip("/") or "index"
    params = sorted(parse_qsl(query))
    if not params:
        return f"{base}.html"
    return f"{base}/_q/{','.join(f'{k}-{v}' for k, v in params)}.html"


def section_of(path):
    top = path.strip("/").split("/")[0]
    return {"": "overview", "people": "friends"}.get(top, top)


def export(sections, out):
    web.templates.env.globals.update(sections=sections, published=True)
    client = TestClient(web.app)
    queue = deque(SECTION_ROOTS[s] for s in sections)
    seen, files, pages = set(queue), set(), 0

    while queue:
        url = queue.popleft()
        parts = urlsplit(url)
        response = client.get(url, follow_redirects=False)
        if response.status_code != 200:
            print(f"  skipped {url}: HTTP {response.status_code}", file=sys.stderr)
            continue
        dest = out / page_file(parts.path, parts.query)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(response.text)
        pages += 1

        for m in LINK_RE.finditer(response.text):
            link = urlsplit(urljoin(url, unescape(m.group(1) or m.group(2))))
            if link.scheme or link.netloc:
                continue
            top = link.path.split("/")[1]
            if top in FILE_DIRS:
                files.add(unquote(link.path))
            elif section_of(link.path) in sections and all(PARAM_RE.match(k + v) for k, v in parse_qsl(link.query)):
                target = link.path + (f"?{link.query}" if link.query else "")
                if target not in seen:
                    seen.add(target)
                    queue.append(target)

    if "overview" not in sections:
        shutil.copyfile(out / page_file(SECTION_ROOTS[sections[0]], ""), out / "index.html")

    copied, size, too_big = 0, 0, []
    for path in sorted(files):
        top, rest = path.lstrip("/").split("/", 1)
        src = (FILE_DIRS[top] / rest).resolve()
        if not src.is_relative_to(FILE_DIRS[top].resolve()) or not src.is_file():
            print(f"  missing {path}", file=sys.stderr)
            continue
        if src.stat().st_size > MAX_FILE:
            too_big.append((path, src.stat().st_size))
            continue
        dest = out / top / rest
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        copied += 1
        size += src.stat().st_size

    print(f"Exported {pages:,} pages and {copied:,} files ({size / 1e6:,.0f} MB) to {out}")
    print(f"Sections: {', '.join(sections)}")
    for path, n in too_big:
        print(f"  left out {path} ({n / 1e6:.0f} MB): over Cloudflare's 25 MB limit; re-encode it smaller to include it")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sections", default=",".join(DEFAULT_SECTIONS),
                        help=f"comma-separated, from: {', '.join(web.SECTIONS)}; or 'all' (default: %(default)s)")
    parser.add_argument("--out", type=Path, default=SITE_DIR, help="output folder (default: %(default)s)")
    args = parser.parse_args()

    sections = web.SECTIONS if args.sections == "all" else tuple(s.strip() for s in args.sections.split(","))
    unknown = set(sections) - set(web.SECTIONS)
    if unknown:
        parser.error(f"unknown section(s): {', '.join(sorted(unknown))}")
    if not web.DB_PATH.exists():
        sys.exit("No data yet: run `uv run heybert-ingest <export folder>` first.")
    if args.out.exists() and any(args.out.iterdir()) and not (args.out / MARKER).exists():
        sys.exit(f"{args.out} isn't empty and wasn't made by heybert-export; choose another --out.")

    shutil.rmtree(args.out, ignore_errors=True)
    args.out.mkdir(parents=True)
    (args.out / MARKER).touch()
    (args.out / ".assetsignore").write_text(f"{MARKER}\n.assetsignore\n")  # keeps them out of the upload
    export(sections, args.out)


if __name__ == "__main__":
    main()
