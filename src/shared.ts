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
  /** 1 when the page needs a real browser (prices loaded with JavaScript). */
  render: number;
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

export interface AddRequest {
  url: string;
  target?: number | string | null;
}

export interface TargetRequest {
  target: number | null;
}

export interface CheckResponse {
  ok: boolean;
  price?: number;
  cached?: boolean;
  error?: string;
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
