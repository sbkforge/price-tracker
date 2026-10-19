-- Each visitor gets a random owner id (kept in their browser), so the same
-- product can be tracked by many people and nobody can edit another's list.
CREATE TABLE products_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  image TEXT,
  store TEXT NOT NULL,
  currency TEXT,
  price REAL,
  target REAL,
  error TEXT,
  created_at INTEGER NOT NULL,
  checked_at INTEGER,
  UNIQUE (owner, url)
);
INSERT INTO products_new (id, owner, url, title, image, store, currency, price, target, error, created_at, checked_at)
  SELECT id, 'legacy', url, title, image, store, currency, price, target, error, created_at, checked_at FROM products;
DROP TABLE products;
ALTER TABLE products_new RENAME TO products;
CREATE INDEX products_by_owner ON products (owner, created_at);
CREATE INDEX products_due ON products (checked_at);
