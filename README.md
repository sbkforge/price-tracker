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

Every request sends an `x-owner` header: a random 16–64 character id the page generates and keeps in the browser.

| Route | What it does |
|---|---|
| `GET /api/products` | All products with price history |
| `POST /api/products` | Track a link: `{ "url": "...", "target": 999 }` |
| `PATCH /api/products/<id>` | Change the target: `{ "target": 899 }` |
| `POST /api/products/<id>/check` | Check the price now |
| `DELETE /api/products/<id>` | Stop tracking |

## Deploy your own

```sh
npm install
npx wrangler login
npx wrangler d1 create price-tracker      # put the printed id in wrangler.jsonc
npm run db:remote                         # create the tables
npm run deploy
```

Open the `*.workers.dev` URL and add products. No sign-in: each visitor gets a random id kept in their browser, and their list is private to it.

### Local development

```sh
# no secrets needed
npm run db:local
npx wrangler dev --test-scheduled
curl "localhost:8787/__scheduled?cron=0+*+*+*+*"   # run the price check now
```

## Free plan limits

- Every 15 minutes a run re-checks up to 25 products that are older than 6 hours: about 2,400 checks a day, enough for 600 products.
- D1 free tier: 5 GB storage, 100,000 writes a day.

## Notes

- No accounts. Each browser gets a random owner id; products are scoped to it (up to 30 per owner). Clearing site data loses the list.
- Respect each store's terms of use.

## License

MIT
