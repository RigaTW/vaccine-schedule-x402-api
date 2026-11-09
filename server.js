// 台灣寶寶疫苗時程查詢 — x402 API server
// Zero dependencies, plain node:http. Node >= 18 (uses global fetch).
// Data: public CDC 114-year schedule only. No Easy2Baby user data, ever.
//
// Pricing: USDC $0.01 / call on Base (exact scheme).
//   amount "10000" (USDC has 6 decimals), payTo below, asset = USDC on Base.
// Free trial: 10 calls per wallet identifier (see README — the trial
//   identifier is self-asserted, it is NOT authentication).
// Paid flow: X-Payment (or PAYMENT-SIGNATURE) header -> POST /verify to the
//   public facilitator -> if valid, POST /settle -> only then serve data.
//   If the facilitator is unreachable or settle fails, respond 502 and
//   NEVER serve paid data for free.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const FACILITATOR_URL = (process.env.FACILITATOR_URL || 'https://x402.org/facilitator').replace(/\/$/, '');
const TRIALS_FILE = path.join(__dirname, 'data', 'trials.json');
// CDP facilitator auth (only used when the facilitator is api.cdp.coinbase.com).
// Set as environment variables on the host (Render/Railway) — never paste the
// secret into chat or commit it. See cdp-auth.js for the JWT format.
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID || '';
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET || '';
const { cdpAuthHeaders } = require('./cdp-auth');
const IS_CDP_FACILITATOR = (() => {
  try { return new URL(FACILITATOR_URL).hostname === 'api.cdp.coinbase.com'; } catch (_) { return false; }
})();
const CDP_AUTH_CONFIGURED = IS_CDP_FACILITATOR && Boolean(CDP_API_KEY_ID && CDP_API_KEY_SECRET);

const PAY_TO = '0xf56069ed9a60a477c52de3fa615ccabcd6b6dbf2';
const ASSET_USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bd029029';
const AMOUNT = '10000'; // $0.01 USDC, 6 decimals
const NETWORK = 'base';
const FREE_TRIAL_LIMIT = 10;
const SOURCE = '衛福部疾管署 現行兒童預防接種時程表 114 年版';
const DISCLAIMER = '僅供查詢參考，實際接種請依醫師與兒童健康手冊為準';

// ---------------------------------------------------------------- data ----
const SCHEDULE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'vaccine-schedule-data.json'), 'utf8')
);

// ------------------------------------------------------- trial storage ----
function loadTrials() {
  try {
    const raw = JSON.parse(fs.readFileSync(TRIALS_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && raw.counts && typeof raw.counts === 'object') {
      return raw;
    }
  } catch (_) {
    // missing / corrupt -> start fresh (a corrupt file is renamed, not deleted)
    try {
      if (fs.existsSync(TRIALS_FILE)) {
        fs.renameSync(TRIALS_FILE, TRIALS_FILE + '.corrupt-' + Date.now());
      }
    } catch (_) {}
  }
  return { counts: {} };
}

let trials = loadTrials();

function saveTrials() {
  fs.mkdirSync(path.dirname(TRIALS_FILE), { recursive: true });
  fs.writeFileSync(TRIALS_FILE, JSON.stringify(trials, null, 2) + '\n', 'utf8');
}

// ------------------------------------------------------------- helpers ----
function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function isValidDateParts(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function parseBirthdate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!isValidDateParts(y, mo, d)) return null;
  return new Date(y, mo - 1, d);
}

function startOfToday() {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

// Completed months between birthdate and today.
function completedMonths(birth, today) {
  let months = (today.getFullYear() - birth.getFullYear()) * 12
    + (today.getMonth() - birth.getMonth());
  if (today.getDate() < birth.getDate()) months -= 1;
  return months;
}

function addMonths(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

function formatDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  const raw = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
  return raw.replace(/^::ffff:/, '');
}

// ------------------------------------------------------- schedule logic ---
function buildResult(ageMonths, birthdate) {
  const idx = SCHEDULE.findIndex((s) => s.months >= ageMonths);
  if (idx === -1) {
    return {
      age_months: ageMonths,
      next_dose: null,
      upcoming: [],
      message: '本時程 12 個階段皆已到期（最後一階段為滿 5 歲至入國小前），請依兒童健康手冊與醫師指示確認後續接種。',
    };
  }
  const stage = SCHEDULE[idx];
  const first = stage.vaccines[0];
  const note = stage.note || stage.windowLabel || first.desc || '';
  const nextDose = {
    vaccine: first.name,
    dose: first.dose,
    due_month: stage.months,
    due_date: birthdate ? formatDate(addMonths(birthdate, stage.months)) : null,
    note,
    protect: first.protect || '',
    care: first.care || '',
  };
  const upcoming = [];
  // Same stage: any further vaccine in this stage comes first (never drop one).
  for (let i = 1; i < stage.vaccines.length; i++) {
    upcoming.push({
      vaccine: stage.vaccines[i].name,
      dose: stage.vaccines[i].dose,
      due_month: stage.months,
    });
  }
  // Later stages, in schedule order.
  for (let j = idx + 1; j < SCHEDULE.length; j++) {
    for (const v of SCHEDULE[j].vaccines) {
      upcoming.push({ vaccine: v.name, dose: v.dose, due_month: SCHEDULE[j].months });
    }
  }
  return { age_months: ageMonths, next_dose: nextDose, upcoming };
}

// ---------------------------------------------------------- x402 payment --
function paymentRequirements() {
  return {
    scheme: 'exact',
    network: NETWORK,
    amount: AMOUNT,
    asset: ASSET_USDC_BASE,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2' },
  };
}

function paymentRequiredBody(extra) {
  return {
    x402Version: 2,
    error: 'Payment Required',
    accepts: [paymentRequirements()],
    ...(extra || {}),
  };
}

function send402(res, extra) {
  const body = paymentRequiredBody(extra);
  sendJson(res, 402, body, {
    'X-Payment-Required': JSON.stringify(body),
  });
  return body;
}

function decodePaymentHeader(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    if (s.startsWith('{')) return JSON.parse(s);
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function extractPayer(paymentPayload) {
  if (!paymentPayload || typeof paymentPayload !== 'object') return null;
  const candidates = [
    paymentPayload?.payload?.authorization?.from,
    paymentPayload?.payload?.from,
    paymentPayload?.authorization?.from,
    paymentPayload?.payload?.payer,
    paymentPayload?.payer,
    paymentPayload?.payload?.authorization?.payer,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c)) return c.toLowerCase();
  }
  return null;
}

async function facilitatorCall(pathSuffix, body) {
  // CDP facilitator calls need a fresh JWT per request, bound to this exact
  // method + host + path (see cdp-auth.js). The public x402.org facilitator
  // needs no auth. If CDP auth is misconfigured, fail loudly here so
  // verifyAndSettle turns it into a 502 — never serve paid data.
  let headers = { 'Content-Type': 'application/json' };
  if (IS_CDP_FACILITATOR) {
    if (!CDP_AUTH_CONFIGURED) {
      throw new Error('CDP facilitator is configured but CDP_API_KEY_ID / CDP_API_KEY_SECRET are not set');
    }
    const u = new URL(FACILITATOR_URL + pathSuffix);
    headers = {
      ...headers,
      ...cdpAuthHeaders({
        apiKeyId: CDP_API_KEY_ID,
        apiKeySecret: CDP_API_KEY_SECRET,
        method: 'POST',
        host: u.hostname,
        path: u.pathname,
      }),
    };
  }
  const res = await fetch(FACILITATOR_URL + pathSuffix, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, ok: res.ok, json, text };
}

// Returns { ok: true, settlement } on success, or { ok: false, status, body }
// where status is 402 (invalid payment) or 502 (facilitator / settle failure).
async function verifyAndSettle(paymentPayload) {
  const requirements = paymentRequirements();
  const body = { x402Version: 2, paymentPayload, paymentRequirements: requirements };

  let verify;
  try {
    verify = await facilitatorCall('/verify', body);
  } catch (e) {
    return {
      ok: false,
      status: 502,
      body: {
        error: 'Facilitator unreachable',
        detail: `Could not reach ${FACILITATOR_URL}/verify (${e && e.name ? e.name : 'fetch failed'}). No data was served and no payment was settled.`,
      },
    };
  }
  if (verify.json && typeof verify.json.isValid === 'boolean') {
    if (!verify.json.isValid) {
      return {
        ok: false,
        status: 402,
        body: paymentRequiredBody({
          invalidReason: verify.json.invalidReason || 'invalid_payment',
          payer: verify.json.payer || undefined,
        }),
      };
    }
  } else if (verify.status >= 500) {
    return {
      ok: false,
      status: 502,
      body: {
        error: 'Facilitator error',
        detail: `Facilitator /verify returned HTTP ${verify.status}. No data was served and no payment was settled.`,
      },
    };
  } else if (!verify.ok) {
    // 4xx without an isValid flag: the payload was rejected by the facilitator.
    return {
      ok: false,
      status: 402,
      body: paymentRequiredBody({
        invalidReason: (verify.json && (verify.json.invalidReason || verify.json.error)) || 'invalid_payment',
      }),
    };
  }

  // Verify passed: settle. Never serve paid data if settle does not succeed.
  let settle;
  try {
    settle = await facilitatorCall('/settle', body);
  } catch (e) {
    return {
      ok: false,
      status: 502,
      body: {
        error: 'Facilitator unreachable',
        detail: `Verification passed but ${FACILITATOR_URL}/settle could not be reached (${e && e.name ? e.name : 'fetch failed'}). No data was served.`,
      },
    };
  }
  if (!settle.json || settle.json.success !== true) {
    return {
      ok: false,
      status: 502,
      body: {
        error: 'Settlement failed',
        detail: `Verification passed but settlement did not succeed (facilitator HTTP ${settle.status}). No data was served.`,
        errorReason: settle.json ? (settle.json.errorReason || settle.json.error || undefined) : undefined,
      },
    };
  }
  return { ok: true, settlement: settle.json };
}

// ------------------------------------------------------------ trial id ----
function trialIdentifier(req, payer) {
  if (payer) return { key: 'wallet:' + payer, type: 'wallet', wallet: payer };
  const headerWallet = req.headers['x-trial-wallet'];
  const url = new URL(req.url, 'http://localhost');
  const paramWallet = url.searchParams.get('trial_wallet');
  const raw = String(headerWallet || paramWallet || '').trim();
  if (raw) {
    const norm = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : raw.toLowerCase();
    return { key: 'wallet:' + norm, type: 'wallet', wallet: norm };
  }
  const ip = clientIp(req);
  return { key: 'ip:' + ip, type: 'ip', wallet: null };
}

// ---------------------------------------------------------------- server --
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed. This API only serves GET.' });
    return;
  }

  if (pathname === '/health') {
    sendJson(res, 200, { status: 'ok', time: new Date().toISOString(), facilitator: FACILITATOR_URL, facilitatorAuth: IS_CDP_FACILITATOR ? (CDP_AUTH_CONFIGURED ? 'cdp' : 'cdp-missing-credentials') : 'none' });
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    sendJson(res, 200, {
      service: '台灣寶寶疫苗時程查詢 x402 API',
      version: '1.0.0',
      price: 'USDC $0.01 / call on Base (exact scheme)',
      free_trial: '10 calls per wallet',
      payTo: PAY_TO,
      asset: ASSET_USDC_BASE,
      network: NETWORK,
      facilitator: FACILITATOR_URL,
      facilitatorAuth: IS_CDP_FACILITATOR ? (CDP_AUTH_CONFIGURED ? 'cdp' : 'cdp-missing-credentials') : 'none',
      endpoints: {
        health: 'GET /health',
        schedule: 'GET /v1/vaccine-schedule?birthdate=YYYY-MM-DD or ?age_months=N',
      },
      source: SOURCE,
      disclaimer: DISCLAIMER,
    });
    return;
  }

  if (pathname !== '/v1/vaccine-schedule') {
    sendJson(res, 404, { error: 'Not found. See GET / for endpoints.' });
    return;
  }

  // ---- validate input (no trial consumed, no payment needed for a 400) ----
  const birthdateParam = url.searchParams.get('birthdate');
  const ageParam = url.searchParams.get('age_months');
  let ageMonths;
  let birthdate = null;

  if (birthdateParam) {
    birthdate = parseBirthdate(birthdateParam);
    if (!birthdate) {
      sendJson(res, 400, { error: 'Invalid birthdate. Use YYYY-MM-DD with a real calendar date, e.g. birthdate=2025-05-10.' });
      return;
    }
    const today = startOfToday();
    if (birthdate > today) {
      sendJson(res, 400, { error: 'Invalid birthdate. Birthdate must not be in the future.' });
      return;
    }
    ageMonths = completedMonths(birthdate, today);
  } else if (ageParam !== null) {
    if (!/^\d+$/.test(ageParam)) {
      sendJson(res, 400, { error: 'Invalid age_months. Use a whole number of months, e.g. age_months=18.' });
      return;
    }
    ageMonths = Number(ageParam);
    if (ageMonths < 0 || ageMonths > 72) {
      sendJson(res, 400, { error: 'Invalid age_months. Must be between 0 and 72.' });
      return;
    }
  } else {
    sendJson(res, 400, { error: 'Missing parameter. Provide ?birthdate=YYYY-MM-DD or ?age_months=N.' });
    return;
  }

  const result = buildResult(ageMonths, birthdate);
  const base = {
    ...result,
    ...(birthdate ? { birthdate: formatDate(birthdate) } : {}),
    source: SOURCE,
    disclaimer: DISCLAIMER,
  };

  // ---- payment present? verify + settle, then serve. ----
  const paymentHeader = req.headers['x-payment'] || req.headers['payment-signature'];
  if (paymentHeader) {
    const paymentPayload = decodePaymentHeader(paymentHeader);
    if (!paymentPayload || typeof paymentPayload !== 'object') {
      send402(res, { invalidReason: 'invalid_payment_header' });
      return;
    }
    const outcome = await verifyAndSettle(paymentPayload);
    if (!outcome.ok) {
      if (outcome.status === 402) {
        // 402 body already shaped by verifyAndSettle.
        sendJson(res, 402, outcome.body, {
          'X-Payment-Required': JSON.stringify(outcome.body),
        });
      } else {
        sendJson(res, outcome.status, outcome.body);
      }
      return;
    }
    const settlement = outcome.settlement;
    const payer = extractPayer(paymentPayload) || settlement.payer || null;
    const paidBody = {
      ...base,
      settlement: {
        success: settlement.success,
        transaction: settlement.transaction || null,
        network: settlement.network || NETWORK,
        payer: payer,
      },
    };
    const settlementB64 = Buffer.from(JSON.stringify(settlement), 'utf8').toString('base64');
    sendJson(res, 200, paidBody, {
      'PAYMENT-RESPONSE': settlementB64,
      'X-Payment-Response': settlementB64,
    });
    console.log(`${new Date().toISOString()} PAID ${pathname} age=${ageMonths} payer=${payer}`);
    return;
  }

  // ---- no payment: free trial ----
  const trial = trialIdentifier(req, null);
  const used = trials.counts[trial.key] || 0;
  if (used >= FREE_TRIAL_LIMIT) {
    send402(res, {
      trial: { limit: FREE_TRIAL_LIMIT, used, remaining: 0 },
    });
    console.log(`${new Date().toISOString()} 402 trial-exhausted ${trial.key} age=${ageMonths}`);
    return;
  }
  trials.counts[trial.key] = used + 1;
  try {
    saveTrials();
  } catch (e) {
    console.error('Failed to persist trials.json:', e);
  }
  const remaining = FREE_TRIAL_LIMIT - trials.counts[trial.key];
  const freeBody = {
    ...base,
    trial: {
      type: trial.type,
      ...(trial.wallet ? { wallet: trial.wallet } : {}),
      used: trials.counts[trial.key],
      remaining,
      limit: FREE_TRIAL_LIMIT,
    },
  };
  sendJson(res, 200, freeBody);
  console.log(`${new Date().toISOString()} FREE ${pathname} age=${ageMonths} ${trial.key} used=${trials.counts[trial.key]}`);
});

server.listen(PORT, () => {
  console.log(`vaccine-schedule x402 API listening on port ${PORT}`);
  console.log(`Facilitator: ${FACILITATOR_URL}`);
  if (IS_CDP_FACILITATOR) {
    console.log(CDP_AUTH_CONFIGURED
      ? 'Facilitator auth: CDP JWT enabled (CDP_API_KEY_ID set, secret present)'
      : 'WARNING: CDP facilitator configured but CDP_API_KEY_ID / CDP_API_KEY_SECRET are NOT set — paid verify/settle will fail');
  }
  console.log(`PayTo (Base USDC): ${PAY_TO}`);
});
