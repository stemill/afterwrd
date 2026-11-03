import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("AFTERWRD_DATA", Path(__file__).resolve().parent.parent / "data"))
DB_PATH = DATA_DIR / "afterwrd.db"
MEDIA_DIR = DATA_DIR / "media"
THUMB_DIR = DATA_DIR / "thumbs"


def thumb_name(media_path: str) -> str:
    """Where a photo's thumbnail lives, relative to THUMB_DIR."""
    return str(Path(media_path).with_suffix(".jpg"))
