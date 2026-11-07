-- A check link made for a particular site (0.25.0): the owner gave the address, or made it for a friend, so the
-- person opening it can't point it at another site.
ALTER TABLE site_checks ADD COLUMN site_fixed INTEGER NOT NULL DEFAULT 0;
UPDATE site_checks SET site_fixed = 1 WHERE connection_id IS NOT NULL
