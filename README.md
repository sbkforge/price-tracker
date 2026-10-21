# Price Tracker

Track product prices from online stores, see the history, and get a push alert when a price drops. Paste a product link, optionally set a target price, and it checks the price every 6 hours.

Written in TypeScript and runs entirely on Cloudflare's free plan: a Worker, a D1 database, a cron trigger, Browser Rendering for JavaScript-heavy stores, and Web Push with no third-party service. No accounts, no credit card.

## Features

- Add any product link; it reads the name, price, currency, photo and stock status from the page
- Price checked every 6 hours, with full history, a chart, and low / high / average
- **Push alerts** when a price drops (any drop, or at or below your target) and when an item is back in stock
- **Buy or Wait verdict** per product, judged from its own history (lowest, average), plus "% off MRP" with an inflated-MRP warning
- **Deals feed**: biggest drops in the last 7 days across everything people track (product facts only, never who tracks what)
- **Compare stores**: Flipkart results inline, one-tap search links for Amazon, Croma, Reliance Digital, Vijay Sales and Tata CLiQ
- **Share to app**: on Android, share a product link from any app straight into Price Tracker (Web Share Target); on desktop, put the site's address in front of any product link, or use the Track price bookmark
- **Deal score** out of 100 with a gauge and points breakup (price pumped before the drop, above all-time low, above 30-day low, above average), like a deal scanner
- **Search by name** (typed or spoken) with live Flipkart results you can track in one tap
- **Share a product** (WhatsApp, copy, system share) and a **read-only link to your whole list**
- **Bought** marking with a Spend summary; Alerts, Bought and Out-of-stock filters; sort by deal score
- Deals feed with category chips and a minimum-discount filter; related products and deals in the same category inside each product's sheet
- Lucide icons, skeleton loading, example links on first visit
- **Sync code** to see the same list on your phone and laptop; no sign-up
- Filters (dropped, below target, out of stock), search and sort
- History sheet with every check, and CSV export
- Stores that fill prices in with JavaScript are read in a real browser (Cloudflare Browser Rendering)
- Apple-style UI, light and dark mode, installable on a phone's home screen

## How it reads prices

Most stores publish product data for search engines. The Worker reads, in order:

1. JSON-LD (`<script type="application/ld+json">` with a schema.org `Product` and its `offers`)
2. Meta tags (`product:price:amount`, `og:price:amount`, `itemprop="price"`)
3. Store-specific price elements (Amazon's buy box, Flipkart)
4. Any element whose class or id mentions "price" and whose text looks like an amount (most common amount wins)

If none of those finds a price, the page is loaded once more in a real browser (Browser Rendering) and read again; products that needed that are always checked that way.

### Stores

Tested end to end with real product pages (`npm run test:live`):

| Store | How it's read |
|---|---|
| Amazon.in | buy-box price elements, list price, stock line |
| Flipkart (incl. `dl.flipkart.com` share links) | JSON-LD; share links resolved to the product page |
| Myntra, Zepto, Vijay Sales, Samsung, Apple, Decathlon, boAt and most Shopify/brand stores | JSON-LD or meta tags |
| Blinkit, Instamart, Tata CLiQ | loaded in Cloudflare Browser Rendering, then JSON-LD |
| Croma, Reliance Digital, Nykaa, Ajio, Meesho, BigBasket, Snapdeal | block robots, even a real browser. The **Track price** bookmark (Settings) reads the page in your own browser and sends what it saw; click it again to record a new price |

Prices are always taken from the product's own page, never from a third-party feed. Marketplaces (Amazon, Flipkart, Myntra, Ajio, Meesho, Nykaa) only count their own price elements, so an unavailable listing never gets an accessory's price. The app explains why a link can't be tracked and what to do.

## API

Every request sends an `x-owner` header: a random 16–64 character id the page generates and keeps in the browser.

| Route | What it does |
|---|---|
| `GET /api/config` | Public push key and limits |
| `GET /api/deals` | Public feed of the biggest drops in the last 7 days |
| `GET /api/share` | Create/get a read-only share token for this owner's list |
| `GET /api/shared/<token>` | A shared list (targets and purchases stripped) |
| `POST /api/products` with `snapshot` | Add or refresh a product from what the Track price bookmark read in the browser |
| `GET /https://<store>/...` | Redirects to the app with that product ready to track |
| `GET /api/compare?q=` | Search other stores for a product name |
| `GET /api/inspect?url=` | What the reader sees on a page (for "why can't this be tracked?") |
| `GET /api/products` | All products with price history |
| `GET /api/products/<id>/history.csv` | Price history as CSV |
| `POST /api/push` / `DELETE /api/push` | Turn push alerts on or off for this browser |
| `POST /api/push/test` | Send a test alert |
| `POST /api/products` | Track a link: `{ "url": "...", "target": 999 }` |
| `PATCH /api/products/<id>` | `{ "target": 899 }` and/or `{ "bought": { "price": 850 } }` (`null` clears) |
| `POST /api/products/<id>/check` | Check the price now |
| `DELETE /api/products/<id>` | Stop tracking |

## Deploy your own

```sh
npm install
npx wrangler login
npx wrangler d1 create price-tracker      # put the printed id in wrangler.jsonc
npm run db:remote                         # create the tables
node scripts/vapid.js                     # prints a public key for wrangler.jsonc and sets the private one
npm run deploy                            # typecheck, build, deploy
```

`npm run deploy` type-checks (`tsc`), bundles `web/app.ts` with esbuild into `public/app.js`, and deploys with wrangler.

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
