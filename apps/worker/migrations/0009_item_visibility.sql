ALTER TABLE pins ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public'));
ALTER TABLE publications ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public'));
UPDATE pins SET visibility = 'public';
UPDATE publications SET visibility = 'public';
CREATE INDEX publication_revisions_cid ON publication_revisions(cid, publication_id);
