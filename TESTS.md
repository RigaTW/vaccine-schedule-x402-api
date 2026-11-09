# TESTS — vaccine-schedule x402 API

Test date: 2026-11-09 (server date). Node v24.22.1. Server run locally on
port 3101 (`PORT=3101 node server.js`); the 502-path server ran on port 3102
with `FACILITATOR_URL=http://127.0.0.1:9`. No real funds were spent, no real
mainnet payment was settled, no private key was used at any point.
After testing, `data/trials.json` was reset to `{"counts": {}}`.

## 1. Health / root — PASS

```
GET /health
{"status":"ok","time":"2026-11-09T01:57:53.478Z","facilitator":"https://x402.org/facilitator"}  HTTP 200

GET /
{"service":"台灣寶寶疫苗時程查詢 x402 API","version":"1.0.0","price":"USDC $0.01 / call on Base (exact scheme)","free_trial":"10 calls per wallet","payTo":"0xf56069ed9a60a477c52de3fa615ccabcd6b6dbf2","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bd029029","network":"base","facilitator":"https://x402.org/facilitator", ...}  HTTP 200
```

## 2. Age cases — all PASS

Each call used a distinct `trial_wallet` so trial counting could not interfere.

| age_months | next_dose | upcoming[0] | result |
|---|---|---|---|
| 0 | B 型肝炎疫苗 第 1 劑, due 0 | B 型肝炎疫苗 第 2 劑, due 1 | PASS |
| 2 | 五合一疫苗 第 1 劑, due 2 | 13 價結合型肺炎鏈球菌疫苗 第 1 劑, due 2 | PASS |
| 6 | 五合一疫苗 第 3 劑, due 6 | B 型肝炎疫苗 第 3 劑, due 6 | PASS |
| 12 | 水痘疫苗 1 劑, due 12 | 麻疹腮腺炎德國麻疹混合疫苗 第 1 劑, due 12 | PASS |
| 18 | 五合一疫苗 第 4 劑, due 18 | A 型肝炎疫苗 第 1 劑, due 18 | PASS |
| 27 | 日本腦炎疫苗 第 2 劑, due 27 | A 型肝炎疫苗 第 2 劑, due 27 | PASS |
| 60 | 麻疹腮腺炎德國麻疹混合疫苗 第 2 劑, due 60 | 四合一疫苗 1 劑, due 60 | PASS |
| 61 | `next_dose: null`, `upcoming: []`, message "本時程 12 個階段皆已到期（最後一階段為滿 5 歲至入國小前），請依兒童健康手冊與醫師指示確認後續接種。" | — | PASS |

Notes:
- Two-vaccine stages never drop the second vaccine: at age 2 the PCV13 1st dose
  is `upcoming[0]`; at age 18 HepA 1st dose is `upcoming[0]`; at age 27 HepA
  2nd dose is `upcoming[0]`; at age 60 the DTaP-IPV dose is `upcoming[0]`.
- HepA stays 18/27 months (changed 2025-01-01), matching the data file.
- Full age-0 response verified field-by-field: `age_months`, `next_dose`
  (`vaccine`, `dose`, `due_month`, `due_date`, `note`, `protect`, `care`),
  19-item `upcoming` in stage order, `source`, `disclaimer`, `trial`.

## 3. Birthdate — PASS

```
GET /v1/vaccine-schedule?birthdate=2025-05-10&trial_wallet=case-bd
age: 17  birthdate: 2025-05-10
next: 五合一疫苗 第 4 劑, due_month 18, due_date 2026-11-10
upcoming[0]: A 型肝炎疫苗 第 1 劑, due_month 18
```

2025-05-10 to 2026-11-09 is 17 completed months (day 9 < day 10), so the
next due stage is 18 months and `due_date` = birthdate + 18 months =
2026-11-10. Correct completed-months arithmetic.

## 4. Invalid input — all PASS (HTTP 400, no trial consumed)

| input | response | HTTP |
|---|---|---|
| (no params) | `{"error":"Missing parameter. Provide ?birthdate=YYYY-MM-DD or ?age_months=N."}` | 400 |
| `age_months=-1` | `{"error":"Invalid age_months. Use a whole number of months, e.g. age_months=18."}` | 400 |
| `age_months=73` | `{"error":"Invalid age_months. Must be between 0 and 72."}` | 400 |
| `age_months=abc` | `{"error":"Invalid age_months. Use a whole number of months, e.g. age_months=18."}` | 400 |
| `birthdate=2025-02-30` | `{"error":"Invalid birthdate. Use YYYY-MM-DD with a real calendar date, e.g. birthdate=2025-05-10."}` | 400 |
| `birthdate=2030-01-01` | `{"error":"Invalid birthdate. Birthdate must not be in the future."}` | 400 |
| `GET /nope` | `{"error":"Not found. See GET / for endpoints."}` | 404 |

## 5. Free trial counting — PASS

Wallet `trial-count-1`, `age_months=18`, 11 consecutive calls:

```
call 1  -> HTTP 200, trial.used=1
call 2  -> HTTP 200, trial.used=2
...
call 10 -> HTTP 200, trial.used=10
call 11 -> HTTP 402
```

11th call, full response (headers + body):

```
HTTP/1.1 402 Payment Required
X-Payment-Required: {"x402Version":2,"error":"Payment Required","accepts":[{"scheme":"exact","network":"base","amount":"10000","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bd029029","payTo":"0xf56069ed9a60a477c52de3fa615ccabcd6b6dbf2","maxTimeoutSeconds":60,"extra":{"name":"USDC","version":"2"}}],"trial":{"limit":10,"used":10,"remaining":0}}

{"x402Version":2,"error":"Payment Required","accepts":[{"scheme":"exact","network":"base","amount":"10000","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bd029029","payTo":"0xf56069ed9a60a477c52de3fa615ccabcd6b6dbf2","maxTimeoutSeconds":60,"extra":{"name":"USDC","version":"2"}}],"trial":{"limit":10,"used":10,"remaining":0}}
```

402 body shape verified: `x402Version` 2, `accepts[0].scheme` `exact`,
`network` `base`, `amount` `"10000"`, `asset` USDC-on-Base contract,
`payTo` `0xf56069ed9a60a477c52de3fa615ccabcd6b6dbf2`, `maxTimeoutSeconds` 60,
`extra` `{name:"USDC", version:"2"}`, plus `X-Payment-Required` header.

## 6. Restart persistence — PASS

Server on 3101 was stopped and restarted. Afterwards:
- `trial-count-1` (already at 10) still returned HTTP 402.
- A fresh wallet `post-restart-1` returned HTTP 200 with `trial.used=1`.
- `data/trials.json` on disk before reset contained
  `wallet:trial-count-1: 10` plus the per-case wallets at 1 each.

## 7. Anonymous IP fallback — PASS

Call with no `trial_wallet` and no `X-Trial-Wallet` header:

```
{"trial":{"type":"ip","used":1,"remaining":9,"limit":10}, ...}  HTTP 200
```

## 8. Paid flow: facilitator verify — PASS (invalid payment correctly rejected, no data served)

Facilitator probed directly first (read-only `POST /verify`, no funds moved):

```
GET  https://x402.org/facilitator/supported -> HTTP 200
  kinds include v2 exact on eip155:84532 (Base Sepolia), solana devnet, ...;
  v1 exact on base-sepolia / solana-devnet. NO Base mainnet (eip155:8453 / base).

POST https://x402.org/facilitator/verify  body {} -> HTTP 400, 0.7s
  {"isValid":false,"invalidReason":"missing_parameters","invalidMessage":"Missing paymentPayload or paymentRequirements",...}

POST https://x402.org/facilitator/verify  structurally complete v1 fake payload -> HTTP 500, 0.5s
  {"isValid":false,"invalidReason":"unexpected_error","invalidMessage":"No facilitator registered for scheme: exact and network: base","error":"No facilitator registered for scheme: exact and network: base"}
```

Through the server, with that same well-formed fake v1 payload as a base64
`X-Payment` header:

```
HTTP/1.1 402 Payment Required
X-Payment-Required: {"x402Version":2,"error":"Payment Required","accepts":[...same as §5...],"invalidReason":"unexpected_error"}
{"x402Version":2,"error":"Payment Required","accepts":[...],"invalidReason":"unexpected_error"}
```

No schedule data was served. PASS.

One more observation: a *malformed* dummy payload (missing `signature` /
`authorization` fields) made the facilitator hang — direct curl hit the 30s
cap with HTTP 000, and the server's 10s verify timeout turned it into a
502 (see §9). The server never served data in that case either.

## 9. Paid flow: facilitator unreachable — PASS (502, no data served)

Server on port 3102 with `FACILITATOR_URL=http://127.0.0.1:9`, same fake
`X-Payment` header:

```
HTTP/1.1 502 Bad Gateway
{"error":"Facilitator unreachable","detail":"Could not reach http://127.0.0.1:9/verify (TypeError). No data was served and no payment was settled."}
```

Also: the malformed-payload hang above produced, through the normal server:

```
HTTP/1.1 502 Bad Gateway
{"error":"Facilitator unreachable","detail":"Could not reach https://x402.org/facilitator/verify (TimeoutError). No data was served and no payment was settled."}
```

## 10. CDP facilitator auth — PASS (local JWT self-test + live CDP verify rejection)

Test date: 2026-11-09. `node test-cdp-auth.js` — PASS for both key types:
EC PEM (ES256) and Ed25519 base64 (EdDSA): header/payload claims exactly as
documented (`iss: "cdp"`, `sub` = key ID, `exp - nbf = 120`,
`uris: ["POST api.cdp.coinbase.com/platform/v2/x402/verify"]`), and the
signature verifies against the matching public key. A bad secret is rejected
with a clear error instead of producing a bad token.

Live check with an ephemeral test key (generated locally, deleted after):
server on port 3103 with `FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402`
and a dummy `CDP_API_KEY_ID` / test EC secret. `/health` returned
`"facilitatorAuth":"cdp"`, a free-trial call returned HTTP 200, and a fake
`X-Payment` call reached the real CDP facilitator and came back HTTP 402 with
`invalidReason: "policy_denied"` — i.e. CDP returned a structured verify
rejection, not `401 Unauthorized`, so the JWT was accepted for authentication
and the fake payment was rejected. No schedule data was served.

Regression (same run): server on port 3101 with the default public
facilitator returned `/health` with `"facilitatorAuth":"none"` and age 18
returned 五合一第 4 劑 correctly. `data/trials.json` was reset to
`{"counts": {}}` afterwards.

## NOT tested

- **Real Base mainnet payment, end to end.** No real USDC was spent, no real
  payment was verified as valid, and `POST /settle` was never invoked with a
  valid payload (the code only calls settle after a successful verify, which
  never happened). The settle-success response path (`settlement` object in
  the 200 body, `PAYMENT-RESPONSE` header) is implemented but **not
  live-tested**.
- **A real x402 client signing flow.** Tests used hand-built fake payloads,
  not a wallet-signed EIP-3009 authorization.
- **Production deployment.** No public URL exists yet; the server only ran on
  localhost ports 3101/3103.
- **Base mainnet settlement via the public facilitator is expected to fail.**
  The facilitator itself says "No facilitator registered for scheme: exact
  and network: base" (see §8). To actually collect Base mainnet USDC, the
  facilitator must be switched to Coinbase CDP
  (`https://api.cdp.coinbase.com/platform/v2/x402`, needs CDP API key) via
  the `FACILITATOR_URL` env var — see README "重要限制".
