-- List price (MRP) read from the page, for "X% off" and inflated-price checks.
ALTER TABLE products ADD COLUMN list_price REAL;

-- Speeds up the public Deals feed (biggest recent drops across everyone).
CREATE INDEX products_by_checked ON products (checked_at);
