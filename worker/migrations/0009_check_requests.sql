-- Friends asking for their site to be checked (0.35.0): a friend's site sends POST /_peer/check-request when its owner
-- taps "Ask … to check my site" on Update (checks.js). Home shows it, with one tap to make the check link and share it
-- back. Checks only ever start this way, or from a message the person sent: the person checked always asks first.
CREATE TABLE check_requests (
    connection_id  INTEGER PRIMARY KEY,       -- the friend asking (one request from each at a time)
    created_at     INTEGER NOT NULL
);
