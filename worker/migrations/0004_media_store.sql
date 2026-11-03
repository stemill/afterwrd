-- Photos and videos now live in the media store, addressed by hash, and arrive through the import page
-- (/_admin/import), which also replaces these tables. These columns let pages render until the first import.
ALTER TABLE media ADD COLUMN hash TEXT;
ALTER TABLE media ADD COLUMN thumb_hash TEXT;
ALTER TABLE media ADD COLUMN size INTEGER;
ALTER TABLE media ADD COLUMN type TEXT;
