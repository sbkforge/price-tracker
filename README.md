# Price Tracker

Track product prices from online stores and see when they drop. Paste a product link, optionally set a target price, and it checks the price every 6 hours and draws the history.

Runs on Cloudflare's free plan: a Worker, a D1 database and a cron trigger. No build step, no framework, no credit card.

## Features

- Add any product link; it reads the name, price, currency and photo from the page
- Price checked every 6 hours, with full history
- Step chart of the price over time, with your target as a dashed line
- Change since you started tracking, lowest and highest price
- "Below target" badge and filters for price drops and hits
- Check a product now, change its target, or stop tracking it
- Light and dark mode, works on phones

## How it reads prices

Most stores publish product data for search engines. The Worker reads, in order:

1. JSON-LD (`<script type="application/ld+json">` with a schema.org `Product` and its `offers`)
2. Meta tags (`product:price:amount`, `og:price:amount`, `itemprop="price"`)
3. Store-specific price elements (Amazon's buy box, Flipkart)

**Works well with:** most Shopify stores and many brand stores (for example boAt, Allbirds), Myntra, Amazon India.

**Doesn't work with:** stores that block automated requests (Flipkart, Croma, Nykaa and others answer 403 or 500), and stores that load prices with JavaScript after the page opens. The app tells you when a link can't be tracked.

## API

| Route | What it does |
|---|---|
| `GET /api/products` | All products with price history |
| `POST /api/products` | Track a link: `{ "url": "...", "target": 999 }` (needs token) |
| `PATCH /api/products/<id>` | Change the target: `{ "target": 899 }` (needs token) |
| `POST /api/products/<id>/check` | Check the price now (needs token) |
| `DELETE /api/products/<id>` | Stop tracking (needs token) |

## Deploy your own

```sh
npm install
npx wrangler login
npx wrangler d1 create price-tracker      # put the printed id in wrangler.jsonc
npm run db:remote                         # create the tables
npx wrangler secret put ADMIN_TOKEN       # any long random value
npm run deploy
```

Open the `*.workers.dev` URL, click **Settings**, paste your token, and add products.

### Local development

```sh
cp .dev.vars.example .dev.vars   # set ADMIN_TOKEN
npm run db:local
npx wrangler dev --test-scheduled
curl "localhost:8787/__scheduled?cron=0+*+*+*+*"   # run the price check now
```

## Free plan limits

- Each scheduled run checks up to 25 products (a Worker can make 50 requests per run). With hourly runs that's about 600 checks a day, enough for 150 products every 6 hours.
- D1 free tier: 5 GB storage, 100,000 writes a day.

## Notes

- Anyone with the URL can see the tracked products. Only the token holder can add, check or remove them.
- Respect each store's terms of use.

## License

MIT
