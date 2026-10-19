-- Products being tracked, with their latest known price.
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  image TEXT,
  store TEXT NOT NULL,
  currency TEXT,
  price REAL,
  target REAL,
  error TEXT,
  created_at INTEGER NOT NULL,
  checked_at INTEGER
);

-- One row per successful price check.
CREATE TABLE prices (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price REAL NOT NULL,
  checked_at INTEGER NOT NULL
);
CREATE INDEX prices_by_product ON prices (product_id, checked_at);
