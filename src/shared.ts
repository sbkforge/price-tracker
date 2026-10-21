// Types shared by the Worker and the web page.

export type Availability = "in_stock" | "out_of_stock" | "preorder" | null;

/** A row of the products table. */
export interface ProductRow {
  id: number;
  owner: string;
  url: string;
  title: string;
  image: string | null;
  store: string;
  currency: string | null;
  price: number | null;
  target: number | null;
  error: string | null;
  availability: Availability;
  /** List price / MRP from the page, when the store shows one. */
  list_price: number | null;
  /** 1 when the page needs a real browser (prices loaded with JavaScript). */
  render: number;
  /** Set when the person marked it as bought. */
  bought_at: number | null;
  bought_price: number | null;
  created_at: number;
  checked_at: number | null;
}

/** [checked_at, price] */
export type PricePoint = [number, number];

/** What GET /api/products returns for each product. */
export interface Product extends ProductRow {
  history: PricePoint[];
  lowest: number | null;
  highest: number | null;
  average: number | null;
  first: number | null;
}

export interface ListResponse {
  products: Product[];
}

/** What the "Track price" bookmark reads on the product page itself, for stores that block the Worker. */
export interface Snapshot {
  title?: string;
  price: number;
  currency?: string | null;
  image?: string | null;
  availability?: Availability;
  listPrice?: number | null;
}

export interface AddRequest {
  url: string;
  target?: number | string | null;
  snapshot?: Snapshot;
}

/** PATCH /api/products/:id. Only the fields present are changed. */
export interface UpdateRequest {
  target?: number | null;
  /** `{ price }` marks it bought at that price; `null` clears it. */
  bought?: { price: number } | null;
}

export interface ShareResponse {
  token: string;
  url: string;
}

export interface CheckResponse {
  ok: boolean;
  price?: number;
  cached?: boolean;
  error?: string;
}

/** A product in the public Deals feed: biggest recent drops across everyone, no owner info. */
export interface Deal {
  url: string;
  title: string;
  image: string | null;
  store: string;
  currency: string | null;
  price: number;
  was: number;
  list_price: number | null;
  drop_pct: number;
  checked_at: number;
}

export interface DealsResponse {
  deals: Deal[];
}

/** One result from another store, for the Compare panel. */
export interface CompareHit {
  store: string;
  title: string;
  url: string;
  price: number | null;
  currency: string | null;
  image: string | null;
}

export interface CompareResponse {
  query: string;
  hits: CompareHit[];
  /** Stores that couldn't be searched automatically; the page shows a search link instead. */
  blocked: string[];
}

export interface ConfigResponse {
  vapidPublicKey: string;
  maxPerOwner: number;
  browserRendering: boolean;
}

export interface PushSubscribeRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export const MAX_PER_OWNER = 30;
