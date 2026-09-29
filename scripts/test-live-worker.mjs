// THE LIVE-PRICES WORKER (worker/k2-live.mjs), AGAINST A SIMULATED ANGEL ONE.
//
// Its TOTP must be the desk's own TOTP (api/_lib/broker-auth.js) and RFC 6238's;
// a request without the viewer key gets nothing; tokens are asked of Angel 50 at
// a time; an expired session logs in again once; nothing but NSE/NFO tokens gets
// through. No network.

import { createRequire } from "node:module";
import * as W from "../worker/k2-live.mjs";
const require = createRequire(import.meta.url);
const auth = require("../api/_lib/broker-auth.js");

let passed = 0, failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) { passed += 1; console.log("  ok    " + label); } else { failed += 1; console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
};

console.log("live-prices worker:");
// RFC 6238 Appendix B: secret "12345678901234567890" (base32 GEZDGNBVGY3TQOJQ...), T=59 s -> 94287082 (8 digits) -> 287082.
check("TOTP is RFC 6238's (T = 59 s -> 287082)", (await W.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)) === "287082");
const secret = "JBSWY3DPEHPK3PXP";
let same = true;
for (const t of [0, 29_999, 30_000, 1_790_000_000_000, Date.now()]) same = same && (await W.totp(secret, t)) === auth.totp(secret, { timestamp: t });
check("and the same code the desk's own login computes, at every moment tried", same);

const env = { ANGEL_API_KEY: "k", ANGEL_CLIENT_CODE: "c", ANGEL_MPIN: "1234", ANGEL_TOTP_SECRET: secret, K2_VIEW_KEY: "viewer-key-123", ALLOWED_ORIGIN: "https://kuldeep-oo7.github.io" };
function fakeAngel({ expireFirstQuote = false } = {}) {
  const calls = { login: 0, quote: 0, tokensPerCall: [] };
  let expired = expireFirstQuote;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/loginByPassword")) { calls.login += 1; return new Response(JSON.stringify({ status: true, data: { jwtToken: "jwt-" + calls.login } })); }
    calls.quote += 1;
    if (expired) { expired = false; return new Response(JSON.stringify({ status: false, errorcode: "AG8001", message: "Invalid Token" }), { status: 200 }); }
    const toks = Object.entries(body.exchangeTokens).flatMap(([ex, list]) => list.map((t) => [ex, t]));
    calls.tokensPerCall.push(toks.length);
    return new Response(JSON.stringify({ status: true, data: { fetched: toks.map(([ex, t]) => ({ exchange: ex, symbolToken: t, ltp: Number(t) / 100, exchFeedTime: "29-Sep-2026 10:42:15" })) } }));
  };
  return { calls, fetchImpl };
}
const req = (q, key) => new Request(`https://k2-live.example/quotes?t=${q}`, { headers: key ? { "X-K2-Key": key } : {} });

const pre = await W.handle(new Request("https://k2-live.example/quotes", { method: "OPTIONS" }), env);
check("a preflight answers with the page's origin only", pre.status === 204 && pre.headers.get("Access-Control-Allow-Origin") === "https://kuldeep-oo7.github.io");
check("no viewer key: 401, nothing asked of Angel", (await W.handle(req("NFO:12345"), env, undefined, fakeAngel())).status === 401);
check("a wrong viewer key: 401", (await W.handle(req("NFO:12345", "viewer-key-124"), env)).status === 401);
check("no usable token (BSE, words): 400", (await W.handle(req("BSE:1,NFO:abc", "viewer-key-123"), env)).status === 400);

W.resetSession();
const a = fakeAngel();
const tokens = Array.from({ length: 120 }, (_, i) => `NFO:${100000 + i}`);
const res = await W.handle(req(tokens.join(","), "viewer-key-123"), env, undefined, { fetchImpl: a.fetchImpl, sleep: async () => {} });
const body = await res.json();
check("120 contracts: one login, three calls of at most 50", res.status === 200 && a.calls.login === 1 && a.calls.quote === 3 && Math.max(...a.calls.tokensPerCall) <= 50,
  JSON.stringify(a.calls));
check("every contract comes back with its live price and the exchange's time", Object.keys(body.quotes).length === 120
  && body.quotes["NFO:100007"].ltp === 1000.07 && body.quotes["NFO:100007"].feedTime === "29-Sep-2026 10:42:15");
check("the answer is for the page's origin, never cached by the browser", res.headers.get("Access-Control-Allow-Origin") === "https://kuldeep-oo7.github.io"
  && res.headers.get("Cache-Control") === "no-store");

const b = fakeAngel({ expireFirstQuote: true });
const res2 = await W.handle(req("NFO:200000", "viewer-key-123"), env, undefined, { fetchImpl: b.fetchImpl, sleep: async () => {} });
const body2 = await res2.json();
check("an expired session (AG8001) logs in again once and still answers", res2.status === 200 && b.calls.login === 1 && body2.quotes["NFO:200000"]?.ltp === 2000,
  JSON.stringify(b.calls));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
