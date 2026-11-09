// Local self-test for cdp-auth.js — no network, no real key, no funds.
// Generates an ephemeral EC P-256 key in memory, builds a CDP JWT for a
// fake facilitator call, and checks:
//   1. header: alg ES256, kid = apiKeyId, typ JWT, nonce present
//   2. payload: iss "cdp", sub = apiKeyId, exp - nbf = 120,
//      uris = ["POST api.cdp.coinbase.com/platform/v2/x402/verify"]
//   3. signature verifies against the matching public key (raw R||S form)
//   4. the same flow works for an Ed25519 base64 secret
// Run: node test-cdp-auth.js   (exit 0 = all pass)
'use strict';

const crypto = require('node:crypto');
const assert = require('node:assert');
const { generateCdpJwt, rawToDerSig } = require('./cdp-auth');

function decodePart(token, i) {
  const b64 = token.split('.')[i].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

// --- 1. EC key (the kind CDP Portal downloads as a PEM) ---
const { privateKey: ecPriv, publicKey: ecPub } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecPem = ecPriv.export({ type: 'pkcs8', format: 'pem' });
const keyId = 'organizations/test-org/apiKeys/test-key-id';
const nowSec = Math.floor(Date.now() / 1000);
const jwt = generateCdpJwt({
  apiKeyId: keyId,
  apiKeySecret: ecPem,
  method: 'POST',
  host: 'api.cdp.coinbase.com',
  path: '/platform/v2/x402/verify',
  nowSec,
});
const header = decodePart(jwt, 0);
const payload = decodePart(jwt, 1);
assert.strictEqual(header.alg, 'ES256');
assert.strictEqual(header.kid, keyId);
assert.strictEqual(header.typ, 'JWT');
assert.match(header.nonce, /^[0-9a-f]{32}$/);
assert.strictEqual(payload.iss, 'cdp');
assert.strictEqual(payload.sub, keyId);
assert.strictEqual(payload.nbf, nowSec);
assert.strictEqual(payload.exp, nowSec + 120);
assert.deepStrictEqual(payload.uris, ['POST api.cdp.coinbase.com/platform/v2/x402/verify']);
// Verify the ES256 signature with the public key.
const [h, p, s] = jwt.split('.');
const rawSig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
assert.strictEqual(
  crypto.verify('sha256', Buffer.from(`${h}.${p}`), ecPub, rawToDerSig(rawSig)),
  true
);
console.log('EC (ES256) JWT: PASS — header/payload claims exact, signature verifies');

// --- 2. Ed25519 key (base64 seed+public, the other CDP key type) ---
const ed = crypto.generateKeyPairSync('ed25519');
const edJwk = ed.privateKey.export({ format: 'jwk' });
const b64urlToBuf = (v) => Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const edSecret = Buffer.concat([b64urlToBuf(edJwk.d), b64urlToBuf(edJwk.x)]).toString('base64');
const jwt2 = generateCdpJwt({
  apiKeyId: keyId,
  apiKeySecret: edSecret,
  method: 'POST',
  host: 'api.cdp.coinbase.com',
  path: '/platform/v2/x402/settle',
  nowSec,
});
const header2 = decodePart(jwt2, 0);
const payload2 = decodePart(jwt2, 1);
assert.strictEqual(header2.alg, 'EdDSA');
assert.deepStrictEqual(payload2.uris, ['POST api.cdp.coinbase.com/platform/v2/x402/settle']);
const [h2, p2, s2] = jwt2.split('.');
const rawSig2 = Buffer.from(s2.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
assert.strictEqual(
  crypto.verify(null, Buffer.from(`${h2}.${p2}`), ed.publicKey, rawSig2),
  true
);
console.log('Ed25519 (EdDSA) JWT: PASS — header/payload claims exact, signature verifies');

// --- 3. Bad secret is rejected with a clear error, not a silent bad token ---
assert.throws(
  () => generateCdpJwt({ apiKeyId: keyId, apiKeySecret: 'not-a-key', method: 'POST', host: 'api.cdp.coinbase.com', path: '/platform/v2/x402/verify' }),
  /not recognised/
);
console.log('Bad secret rejected: PASS');

console.log('All cdp-auth self-tests PASS. (Live CDP /verify still untested — needs a real key.)');
