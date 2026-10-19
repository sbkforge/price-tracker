// Web Push from a Worker with no third-party service: VAPID (RFC 8292)
// signed with WebCrypto, and aes128gcm payload encryption (RFC 8291).

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string; // base64url, 65-byte uncompressed P-256 point
  auth: string;   // base64url, 16 bytes
}

export interface PushKeys {
  publicKey: string;  // base64url uncompressed point, same value the page uses
  privateKey: string; // base64url 32-byte scalar (the JWK "d")
  subject: string;    // "mailto:..." or an https URL
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** The push service says this subscription is dead; delete it. */
  gone: boolean;
}

const enc = new TextEncoder();

export async function sendPush(
  sub: PushSubscriptionRow, payload: unknown, keys: PushKeys, ttl = 60 * 60 * 12
): Promise<PushResult> {
  const body = await encrypt(enc.encode(JSON.stringify(payload)), sub);
  const jwt = await vapidToken(new URL(sub.endpoint).origin, keys);

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "content-encoding": "aes128gcm",
      ttl: String(ttl),
      urgency: "normal",
      authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
    },
    body,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

// ---------- VAPID ----------

async function vapidToken(audience: string, keys: PushKeys): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: keys.subject,
  })));
  const input = `${header}.${claims}`;

  const pub = fromB64url(keys.publicKey); // 0x04 || x || y
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC", crv: "P-256",
      x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)),
      d: keys.privateKey,
    },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  // WebCrypto gives r||s (64 bytes), which is exactly the JWS form.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

// ---------- aes128gcm encryption ----------

async function encrypt(plaintext: Uint8Array, sub: PushSubscriptionRow): Promise<Uint8Array> {
  const uaPublic = fromB64url(sub.p256dh);
  const authSecret = fromB64url(sub.auth);

  const local = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  )) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // Workers' type for the ECDH params spells the field "$public"; the runtime wants "public".
  const ecdh = { name: "ECDH", public: uaKey } as unknown as Parameters<SubtleCrypto["deriveBits"]>[0];
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, local.privateKey, 256));

  const info = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, info, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // One record: payload, then the 0x02 "last record" delimiter.
  const record = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  // Header: salt(16) | record size(4) | key id length(1) | key id (our public key)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8)
  );
}

// ---------- bytes ----------

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
