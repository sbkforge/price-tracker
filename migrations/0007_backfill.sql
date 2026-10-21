-- When the product's past prices were pulled from the Internet Archive's
-- Wayback Machine (NULL = not yet). Shared by every row with the same url.
ALTER TABLE products ADD COLUMN backfilled_at INTEGER;
CREATE INDEX products_by_url ON products (url);

-- Where a price point came from: NULL = one of our checks, 'wayback' = an
-- archive snapshot, 'bookmark' = the Track price bookmark.
ALTER TABLE prices ADD COLUMN source TEXT;
