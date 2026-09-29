/**
 * K² LIVE PRICES -- a private proxy for the NOW column of the desk page.
 *
 * The page is rebuilt every 20 minutes; between builds nothing moved (the user,
 * 28 Sep: "is it live and dynamic or not?"). This Worker gives the page the
 * live price of exactly the contracts on it, from the same Angel One account
 * the builds use, every time the page asks (~20 s, market hours only). The
 * levels stay frozen: only NOW and "has the market come to my limit" move.
 *
 * PRIVATE. Every request needs the viewer key (secret K2_VIEW_KEY), which lives
 * only on the user's phone; without it the answer is 401. Angel One's data is
 * for the account holder -- re-serving it publicly would break its terms.
 *
 * SAFE BESIDE THE BUILDS. Its own Angel session does not cancel theirs:
 * measured on 29 Sep 2026 07:50 IST, a second login left the first session
 * quoting (Angel fixed that in Oct 2022, SmartAPI forum topic 2421).
 *
 *   GET /quotes?t=NFO:12345,NSE:2885   header X-K2-Key: <key>
 *   -> { ok, at, quotes: { "NFO:12345": { ltp, feedTime, tradeTime } } }
 *
 * Secrets (wrangler secret put): ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_MPIN,
 * ANGEL_TOTP_SECRET, K2_VIEW_KEY. Var: ALLOWED_ORIGIN (wrangler.toml).
 */

const ANGEL = "https://apiconnect.angelone.in";
const BATCH = 50;            // Angel's quote call takes at most 50 tokens
const SPACING_MS = 1100;     // about one quote call a second
const CACHE_SECONDS = 15;
const MAX_TOKENS = 300;

let session = null;          // { jwt, at } -- per isolate; a cold start logs in again

const headersFor = (env, jwt) => ({
  "Content-Type": "application/json", Accept: "application/json",
  "X-UserType": "USER", "X-SourceID": "WEB", "X-PrivateKey": env.ANGEL_API_KEY,
  "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00",
  ...(jwt ? { Authorization: `Bearer ${jwt}` } : {})
});

export function base32Decode(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(secret || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) with WebCrypto -- the same code api/_lib/broker-auth.js computes. */
export async function totp(secret, now = Date.now()) {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = Math.floor(now / 1000 / 30);
  const msg = new Uint8Array(8);
  for (let i = 7, c = counter; i >= 0; i -= 1) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

async function login(env, fetchImpl) {
  const res = await fetchImpl(`${ANGEL}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: "POST", headers: headersFor(env),
    body: JSON.stringify({ clientcode: env.ANGEL_CLIENT_CODE, password: env.ANGEL_MPIN, totp: await totp(env.ANGEL_TOTP_SECRET) })
  });
  const payload = await res.json().catch(() => null);
  const jwt = payload?.data?.jwtToken;
  if (!jwt) throw new Error(`Angel login refused: ${payload?.message || res.status}`);
  session = { jwt, at: Date.now() };
  return jwt;
}

async function quoteBatch(env, jwt, tokens, fetchImpl) {
  const exchangeTokens = {};
  for (const t of tokens) { const [ex, tok] = t.split(":"); (exchangeTokens[ex] = exchangeTokens[ex] || []).push(tok); }
  const res = await fetchImpl(`${ANGEL}/rest/secure/angelbroking/market/v1/quote`, {
    method: "POST", headers: headersFor(env, jwt), body: JSON.stringify({ mode: "FULL", exchangeTokens })
  });
  const payload = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403 || payload?.errorcode === "AG8001" || payload?.errorcode === "AG8002") return { expired: true };
  return { rows: payload?.data?.fetched || [] };
}

/** Live quotes for `tokens`, logging in when there is no session or it has expired. */
export async function liveQuotes(env, tokens, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let jwt = session?.jwt || await login(env, fetchImpl);
  const quotes = {};
  for (let i = 0; i < tokens.length; i += BATCH) {
    if (i) await sleep(SPACING_MS);
    let got = await quoteBatch(env, jwt, tokens.slice(i, i + BATCH), fetchImpl);
    if (got.expired) { jwt = await login(env, fetchImpl); got = await quoteBatch(env, jwt, tokens.slice(i, i + BATCH), fetchImpl); }
    for (const row of got.rows || []) {
      const ltp = Number(row.ltp);
      if (!(ltp > 0)) continue;
      quotes[`${row.exchange}:${row.symbolToken}`] = { ltp, feedTime: row.exchFeedTime || null, tradeTime: row.exchTradeTime || null };
    }
  }
  return quotes;
}

function sameKey(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !b) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handle(request, env, ctx = { waitUntil() {} }, deps = {}) {
  const cors = {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "https://kuldeep-oo7.github.io",
    "Access-Control-Allow-Headers": "X-K2-Key", "Access-Control-Allow-Methods": "GET, OPTIONS", Vary: "Origin"
  };
  const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  if (url.pathname !== "/quotes" || request.method !== "GET") return json({ ok: false, error: "not found" }, 404);
  if (!sameKey(request.headers.get("X-K2-Key") || "", env.K2_VIEW_KEY || "")) return json({ ok: false, error: "unauthorized" }, 401);
  const tokens = [...new Set((url.searchParams.get("t") || "").split(",").map((s) => s.trim())
    .filter((s) => /^(NSE|NFO):\d{1,12}$/.test(s)))].slice(0, MAX_TOKENS).sort();
  if (!tokens.length) return json({ ok: false, error: "no tokens" }, 400);

  // One answer per token set every CACHE_SECONDS, whoever asks.
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(`https://k2-live.internal/q?${tokens.join(",")}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(await hit.text(), { headers: { ...cors, "Content-Type": "application/json", "X-K2-Cache": "hit" } });
  }
  try {
    const quotes = await liveQuotes(env, tokens, deps);
    const body = JSON.stringify({ ok: true, at: new Date().toISOString(), quotes });
    if (cache) ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` } })));
    return new Response(body, { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (error) {
    session = null;
    return json({ ok: false, error: String(error.message || error).slice(0, 200) }, 502);
  }
}

export function resetSession() { session = null; }

export default { fetch: (request, env, ctx) => handle(request, env, ctx) };
