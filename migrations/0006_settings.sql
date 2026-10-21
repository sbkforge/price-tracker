-- Small key/value store for the Worker's own bookkeeping (e.g. which catalog
-- category the discovery job searched last).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
