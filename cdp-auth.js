// CDP facilitator authentication — zero dependencies, plain Node crypto.
//
// Coinbase CDP REST APIs (including the hosted x402 facilitator at
// https://api.cdp.coinbase.com/platform/v2/x402) authenticate with a JWT
// bearer token, generated fresh for every request (expires in 120s).
//
// JWT shape, per CDP docs (docs.cdp.coinbase.com, Authentication / JWT):
//   header:  { alg: "ES256" | "EdDSA", kid: <apiKeyId>, typ: "JWT",
//              nonce: <random 16-byte hex> }
//   payload: { iss: "cdp", sub: <apiKeyId>, nbf: <now>, exp: <now+120>,
//              uris: ["<METHOD> <host><path>"] }
//            e.g. uris: ["POST api.cdp.coinbase.com/platform/v2/x402/verify"]
//   signature: ES256 = ECDSA P-256 (raw R||S, 64 bytes) for EC PEM secrets,
//              EdDSA for Ed25519 base64 secrets.
// The API key secret is either:
//   - an EC private key in PEM form ("-----BEGIN EC PRIVATE KEY----- ..."), or
//   - an Ed25519 key as base64 (64 bytes: 32-byte seed + 32-byte public key,
//     or 32 bytes: seed only).
// No wallet secret is needed for the facilitator — only the API key pair.
//
// This module NEVER reads or logs a secret. Callers pass the secret in and
// only the resulting JWT (which expires in 2 minutes) leaves this module.
//
// Live CDP verification has NOT been run yet: there is no CDP API key yet
// (the user is blocked creating one — portal.cdp.coinbase.com shows
// NET::ERR_CERT_AUTHORITY_INVALID on their phone and computer, while the
// same site verifies fine from this machine, so the block is on their
// device/network, not on Coinbase). What IS verified locally, by
// test-cdp-auth.js, is: the JWT is well-formed, its claims are exactly as
// documented, and its signature verifies against the matching public key.
// The first real CDP /verify call must still be tested once a key exists.

'use strict';

const crypto = require('node:crypto');

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function normalizeSecret(secret) {
  let s = String(secret || '').trim();
  // Render / shell env vars sometimes carry the PEM with literal "\n".
  if (s.includes('\\n')) s = s.replace(/\\n/g, '\n');
  return s;
}

function isEcPem(secret) {
  const s = normalizeSecret(secret);
  return s.includes('BEGIN EC PRIVATE KEY') || s.includes('BEGIN PRIVATE KEY');
}

function isEd25519Secret(secret) {
  const s = String(secret || '').trim();
  if (isEcPem(s)) return false;
  try {
    const raw = Buffer.from(s, 'base64');
    return (raw.length === 32 || raw.length === 64) && raw.toString('base64').replace(/=+$/, '') === s.replace(/=+$/, '');
  } catch (_) {
    return false;
  }
}

// ECDSA signatures from Node are ASN.1 DER (SEQUENCE of two INTEGERs);
// JWT needs the raw 64-byte R||S form. Convert DER -> raw.
function derToRawSig(der) {
  if (der[0] !== 0x30) throw new Error('Invalid ECDSA signature: not a DER SEQUENCE');
  let off = 2;
  if (der[1] & 0x80) off = 2 + (der[1] & 0x7f); // long-form length
  if (der[off] !== 0x02) throw new Error('Invalid ECDSA signature: missing R INTEGER');
  const rLen = der[off + 1];
  let r = der.subarray(off + 2, off + 2 + rLen);
  off += 2 + rLen;
  if (der[off] !== 0x02) throw new Error('Invalid ECDSA signature: missing S INTEGER');
  const sLen = der[off + 1];
  let s = der.subarray(off + 2, off + 2 + sLen);
  // Strip a leading zero byte added for sign-bit padding, then left-pad to 32.
  if (r.length === 33 && r[0] === 0) r = r.subarray(1);
  if (s.length === 33 && s[0] === 0) s = s.subarray(1);
  const out = Buffer.alloc(64);
  r.copy(out, 32 - r.length);
  s.copy(out, 64 - s.length);
  return out;
}

// Raw R||S (64 bytes) -> DER, for verifying a JWT signature in tests.
function rawToDerSig(raw) {
  function encodeInt(b) {
    let v = Buffer.from(b);
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  }
  const r = encodeInt(raw.subarray(0, 32));
  const s = encodeInt(raw.subarray(32, 64));
  const body = Buffer.concat([r, s]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function loadPrivateKey(apiKeySecret) {
  const secret = normalizeSecret(apiKeySecret);
  if (isEcPem(secret)) {
    return { key: crypto.createPrivateKey(secret), alg: 'ES256' };
  }
  if (isEd25519Secret(secret)) {
    const raw = Buffer.from(secret.trim(), 'base64');
    const jwk = { kty: 'OKP', crv: 'Ed25519', d: base64url(raw.subarray(0, 32)) };
    if (raw.length === 64) jwk.x = base64url(raw.subarray(32, 64));
    return { key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), alg: 'EdDSA' };
  }
  throw new Error(
    'CDP_API_KEY_SECRET format not recognised: expected an EC private key PEM ' +
    '(-----BEGIN EC PRIVATE KEY-----) or a base64 Ed25519 key.'
  );
}

function generateCdpJwt({ apiKeyId, apiKeySecret, method, host, path, expiresIn = 120, nowSec } = {}) {
  if (!apiKeyId) throw new Error('CDP_API_KEY_ID is not set');
  if (!apiKeySecret) throw new Error('CDP_API_KEY_SECRET is not set');
  if (!method || !host || !path) throw new Error('generateCdpJwt needs method, host and path');
  const now = nowSec || Math.floor(Date.now() / 1000);
  const { key, alg } = loadPrivateKey(apiKeySecret);
  const header = {
    alg,
    kid: apiKeyId,
    typ: 'JWT',
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const payload = {
    iss: 'cdp',
    sub: apiKeyId,
    nbf: now,
    exp: now + expiresIn,
    uris: [`${method.toUpperCase()} ${host}${path}`],
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  let sig;
  if (alg === 'ES256') {
    const der = crypto.sign('sha256', Buffer.from(signingInput), key);
    sig = derToRawSig(der);
  } else {
    sig = crypto.sign(null, Buffer.from(signingInput), key);
  }
  return `${signingInput}.${base64url(sig)}`;
}

function cdpAuthHeaders({ apiKeyId, apiKeySecret, method, host, path }) {
  const token = generateCdpJwt({ apiKeyId, apiKeySecret, method, host, path });
  return { Authorization: `Bearer ${token}` };
}

module.exports = {
  base64url,
  derToRawSig,
  rawToDerSig,
  isEcPem,
  isEd25519Secret,
  loadPrivateKey,
  generateCdpJwt,
  cdpAuthHeaders,
};
