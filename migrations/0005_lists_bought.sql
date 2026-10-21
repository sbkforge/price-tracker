-- "Bought it": what the person paid and when, for the Spend summary.
ALTER TABLE products ADD COLUMN bought_at INTEGER;
ALTER TABLE products ADD COLUMN bought_price REAL;

-- Read-only share links for a whole list (one token per owner).
CREATE TABLE lists (
  owner TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
