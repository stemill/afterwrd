-- How friends' sites have been answering (0.22.0). A friend whose site has gone quiet for a day, or which says this
-- site isn't connected any more (they removed you), is shown once on Friends, with a way to remove them, rather than
-- in a notice every time Home opens (src/feed.js).

ALTER TABLE connections ADD COLUMN reached_at INTEGER;                -- when their site last answered
ALTER TABLE connections ADD COLUMN missing_since INTEGER;             -- when it stopped answering (NULL: it's answering)
ALTER TABLE connections ADD COLUMN said_no INTEGER NOT NULL DEFAULT 0; -- 1: it says this site isn't connected
