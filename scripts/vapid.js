// Makes a VAPID key pair for Web Push. Puts the public key in wrangler.jsonc
// and the private key in the VAPID_PRIVATE_KEY secret (and .dev.vars).
const { generateKeyPairSync } = require("node:crypto");
const { execSync } = require("node:child_process");
const fs = require("node:fs");

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
const b = (s) => Buffer.from(s, "base64url");
const publicKey = Buffer.concat([Buffer.from([4]), b(jwk.x), b(jwk.y)]).toString("base64url");

const cfg = fs.readFileSync("wrangler.jsonc", "utf8").replace(/"VAPID_PUBLIC_KEY": "[^"]*"/, `"VAPID_PUBLIC_KEY": "${publicKey}"`);
fs.writeFileSync("wrangler.jsonc", cfg);
fs.writeFileSync(".dev.vars", `VAPID_PRIVATE_KEY=${jwk.d}\n`, { mode: 0o600 });
execSync("npx wrangler secret put VAPID_PRIVATE_KEY", { input: jwk.d, stdio: ["pipe", "inherit", "inherit"] });
console.log("VAPID keys set. Public key written to wrangler.jsonc; private key stored as a secret and in .dev.vars.");
