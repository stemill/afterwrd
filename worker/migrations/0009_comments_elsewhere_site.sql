-- Which site each of the owner's comments elsewhere is on, so the copy still says where it belongs after
-- disconnecting (when the connection's row goes), and Download everything can give its full address.
ALTER TABLE comments_elsewhere ADD COLUMN site TEXT;
UPDATE comments_elsewhere SET site = (SELECT origin FROM connections WHERE connections.id = comments_elsewhere.connection_id);
