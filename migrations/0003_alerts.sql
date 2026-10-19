-- Stock status read from the page, and whether the page needs a real
-- browser (Browser Rendering) because it loads prices with JavaScript.
ALTER TABLE products ADD COLUMN availability TEXT;
ALTER TABLE products ADD COLUMN render INTEGER NOT NULL DEFAULT 0;

-- Web Push subscriptions, one per browser that turned alerts on.
CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX subscriptions_by_owner ON subscriptions (owner);
