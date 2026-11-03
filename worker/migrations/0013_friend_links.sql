-- Which person in the owner's Facebook download each friend on afterwrd is, so Friends can be one list. Kept by
-- name, as Facebook's download has no lasting ids (they change with every import). A NULL name means the owner said
-- the suggested match wasn't them, so it isn't suggested again.
CREATE TABLE friend_links (
    connection_id  INTEGER PRIMARY KEY,
    person_name    TEXT,
    created_at     INTEGER NOT NULL
);
