-- Each friend's profile picture, as their site last gave it: a signed link that works for about a week (share.js),
-- so their picture can show beside their comments and in lists, not only when their posts are open.
ALTER TABLE connections ADD COLUMN avatar_url TEXT;
ALTER TABLE connections ADD COLUMN avatar_exp INTEGER;
