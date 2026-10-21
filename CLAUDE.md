# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A price tracker on Cloudflare's free plan: paste a product link, the Worker reads the price from the page, re-checks it on a cron, and sends Web Push alerts when it drops. TypeScript end to end, no framework, no accounts. Live at https://price-tracker.sbkforge.workers.dev; repo `sbkforge/price-tracker`.

## Commands

```sh
npm run typecheck     # tsc for the page (tsconfig.json) and the Worker (tsconfig.worker.json)
npm run build         # esbuild web/app.ts -> public/app.js (gitignored; always rebuild before dev/deploy)
npm run dev           # build + wrangler dev --test-scheduled (local D1, local browser rendering)
npm run db:local      # apply migrations/ to the local D1
npm run db:remote     # apply migrations/ to production D1 (run BEFORE deploying code that needs them)
npm run deploy        # typecheck + build + wrangler deploy
node scripts/vapid.js # new VAPID key pair: public -> wrangler.jsonc, private -> secret + .dev.vars
```

`npm test` runs `scripts/e2e.mjs` against a local `npm run dev` (port 8787; pass another base URL as the first argument, or `npm run test:live`). It adds real Amazon.in, Flipkart and brand-store products under a throwaway owner, exercises every API the page uses (history, target, bought, check, CSV, share, search, deals, cleanup) and reports pass/fail/skipped; stores that block or rate-limit count as skipped unless marked required. There are no unit tests. For a single parser question, inspect real pages:

```sh
curl -s "localhost:8787/__scheduled?cron=*/15+*+*+*+*"                       # run the price check now
curl -s -H "x-owner: ownerAAAAAAAAAAAAAAAA" "localhost:8787/api/inspect?url=<product link>"   # what the reader sees
curl -s -H "x-owner: ownerAAAAAAAAAAAAAAAA" "localhost:8787/api/inspect?url=<link>&render=1"  # force Browser Rendering
```

`/api/inspect` returns `via` (which extraction step won) and, on failure, clues (page title, counts, guesses). Use it before touching the parser. Local `.dev.vars` needs `VAPID_PRIVATE_KEY` (see `.dev.vars.example`); nothing else is secret.

GitHub Actions deploys on push to `main` only if the repo has `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets; otherwise it skips the deploy step. Deploying from a machine with `wrangler login` is the normal path.

## Architecture

Three parts share one types file:

- `src/worker.ts`: the whole backend. Routes in `fetch()`, cron in `scheduled()`. Serves `public/` through the `ASSETS` binding (`run_worker_first` only for `/api/*`).
- `web/app.ts`: the whole frontend, plain DOM code, bundled to `public/app.js`. `public/index.html`, `style.css`, `sw.js` (push notifications), `manifest.json` (PWA + Web Share Target) are hand-written.
- `src/shared.ts`: row and API types used by both. Change the DB schema here, in a new migration, and in the SQL that reads/writes it.
- `src/push.ts`: Web Push without a third party: VAPID JWT (ES256) and RFC 8291 `aes128gcm` encryption via WebCrypto. Workers' type for ECDH params spells the field `$public`, hence the cast.

### History is site-wide

`prices` rows belong to a product row, but history is read **by url** across every row (`historyByUrl`): all owners, the `catalog` owner, and `archive` rows (what's left when the last follower removes a product; `deleteProduct` re-parents points or converts the row). `checkDue` fetches once per url and `UPDATE ... WHERE url = ?`, then alerts each follower from their own target. Adding a url the site already knows clones the row instantly (`via: "shared"`), no fetch. `POST /api/open` is the public entry: new links join the catalog owner; nothing goes on the visitor's list until they set an alert (`POST /api/products` with `target`).

`backfill()` pulls dated prices from the Wayback Machine (CDX list → up to N `id_` snapshots spread over the span → `parsePage` with the original url so marketplace rules apply). Guards: claim `backfilled_at` first so concurrent calls skip, reject `guess:` readings and prices 4× off the current one, and never insert twins within 1.5 days. Runs via `ctx.waitUntil` on open/add, on demand from the sheet, and 2 per cron. `prices.source` marks `wayback`/`bookmark`.

### Identity: owner ids, not accounts

Every browser generates a random id (`localStorage.owner`) and sends it as the `x-owner` header. All product routes are scoped by it; it doubles as the "sync code" users paste on another device. `/api/config`, `/api/deals` and static files are the only owner-less routes. Max 30 products per owner.

### Reading a price (`readProduct` -> `parsePage`)

One `HTMLRewriter` pass over the page collects: JSON-LD scripts, `<meta>` tags, `itemprop` values, store-specific selectors (`PRICE_SELECTORS`, `LIST_PRICE_SELECTORS`: Amazon buy box, Flipkart), and generic `[class*=price]` guesses. Then it picks the price in that order: JSON-LD offer -> meta -> store selectors -> most-common "guess" amount. Any handler that calls `onEndTag` must skip `VOID_TAGS` first or the whole parse throws "No end tag".

If the plain fetch finds no price, or the store answers a `BLOCKED` status (403/429/5xx/529), the page is loaded in Cloudflare Browser Rendering (`@cloudflare/puppeteer`, `BROWSER` binding) and parsed again. Products that needed that get `render = 1` and are always checked that way. Free-plan Browser Rendering allows only a few new sessions per minute; expect 429s when testing several in a row.

Share/short links (`dl.flipkart.com`, `amzn.in`, ...) are resolved by `canonicalUrl`, which also strips tracking params; that canonical URL is what's stored and deduped on. Flipkart's `dl.flipkart.com` answers Cloudflare with 529, which is why the browser fallback exists.

### Catalog (auto-discovery)

`discover()` runs after each cron's checks: it takes the next entry of `CATALOG_QUERIES` (round robin, cursor in the `settings` table), searches Flipkart sorted by popularity, and inserts up to `CATALOG_PER_RUN` new products under owner `"catalog"` straight from the listing (title, price, image), one per model, skipping anything under the query's `min` price. The next cron reads their real pages like any product. `/api/catalog` serves them read-only; the page's Browse tab shows them and Deals naturally includes them. Capped at `CATALOG_MAX`. To seed quickly, run `wrangler dev --remote --test-scheduled` and hit `/__scheduled` repeatedly (it uses production D1).

### Checks and alerts

`scheduled()` runs every 15 minutes (`wrangler.jsonc` `triggers`) and re-checks up to 25 products not checked in 6 hours (`CHECK_EVERY`, `BATCH`; the free plan allows 50 subrequests per invocation). `checkProduct` writes a `prices` row on success and only sets `products.error` on failure, keeping the last good price. `alertIfNeeded` pushes when the price fell (any drop without a target, or at/below the target) or an item comes back in stock; subscriptions that return 404/410 are deleted.

### Stores that work / don't

JSON-LD stores (Shopify brands, Myntra, Zepto, Vijay Sales, Samsung, Apple, Decathlon, Flipkart product pages) work statically; Amazon.in via buy-box selectors; Blinkit, Instamart and Tata CLiQ only after Browser Rendering (non-HTML or empty static answers fall through to it). `BLOCKED_STORES` (Croma, Reliance Digital, Nykaa, Ajio, Meesho, BigBasket, Snapdeal) refuse even the browser: they're added through the bookmark `snapshot` in `POST /api/products` (`cleanSnapshot`/`recordSnapshot`), and their scheduled checks fail with a message pointing at the bookmark. `marketplace` hosts skip the generic `[class*=price]` guesses so an unavailable Amazon listing can't pick up an accessory's price. `/api/compare` can only read Flipkart's search page; the others are returned in `blocked` and the page shows search links instead. Free-plan Browser Rendering allows a few new sessions per minute; back-to-back renders get 429 and the test marks them skipped.

### Database

D1 `price-tracker` (id in `wrangler.jsonc`). Tables: `products` (one row per owner+url), `prices` (history), `subscriptions` (push). Migrations are plain SQL in `migrations/`, applied by wrangler; SQLite can't alter constraints, so `0002` recreated `products` to add `owner`.

## Frontend conventions

- Build DOM with the `el()` helper and `textContent`; never `innerHTML` with store data.
- Every API call goes through `api()` (adds `content-type` and `x-owner`, throws on non-2xx with the server's `error`).
- Verdicts ("Great price" ... "Wait") and the "inflated MRP" check are computed client-side in `verdict()` from `history`, `lowest`, `average`; they need >= 3 checks.
- Charts are inline SVG (`chart()` for cards, `timeline()` in the History sheet). Keep `preserveAspectRatio="none"` plus `vector-effect: non-scaling-stroke`.
- Apple-style UI: tokens in `:root` with a dark-mode override, `[hidden] { display: none !important }` so JS toggles always win.
- Icons are Lucide (`lucide` vanilla package, tree-shaken by esbuild): `icon(name)` / `pill(name, label)` in `web/app.ts`; static markup uses `<i class="ic" data-icon="bell"></i>` placeholders that are hydrated on load. Add new icons to the `ICONS` map.
- `BOOKMARKLET_SRC` in `web/app.ts` is the "Track price" bookmark: plain ES5, no dependencies, runs on the store's page and opens `/?capture=<json>`. Keep it that way (store CSPs block fetch; navigation always works).
