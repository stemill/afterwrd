-- How often other sites' people answer events and polls (src/limits.js): one row per answer, kept a day, so an
-- answerer over their allowance changes nothing. On people's sites (friends' answers) and in groups' Workers
-- (members' answers).
CREATE TABLE answer_log (
    who    TEXT NOT NULL,                     -- the answerer's site (origin)
    token  TEXT NOT NULL,                     -- this answer's, so the answer itself is only kept if this row was
    at     INTEGER NOT NULL
);
CREATE INDEX answer_log_who ON answer_log(who, at);
CREATE UNIQUE INDEX answer_log_token ON answer_log(token);
