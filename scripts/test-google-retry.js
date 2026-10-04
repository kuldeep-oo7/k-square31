"use strict";
// Google-side 404s on SAFE calls are retried; appends are never repeated (a repeat could duplicate rows).
process.env.K2_GOOGLE_SHEETS_WEB_APP_URL = "https://script.google.com/macros/s/TEST-DEPLOYMENT/exec";
process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET = "test-secret";
const store = require("../api/_lib/google-store");
let passed = 0, failed = 0;
const check = (n, ok, d = "") => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const realFetch = global.fetch;
function script(responses) { let calls = 0; global.fetch = async () => { const r = responses[Math.min(calls, responses.length - 1)]; calls += 1; return r; }; return () => calls; }
const http = (status) => ({ ok: false, status, json: async () => ({}) });
const okBody = (body) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...body }) });
(async () => {
  let count = script([http(404), okBody({ documents: [] })]);
  const docs = await store.readGoogleDocuments([{ pathname: "k2/x.json", fallback: { a: 1 } }]);
  check("a read that meets a Google-side 404 is asked again, and succeeds", docs[0].data.a === 1 && count() === 2, `calls ${count()}`);
  count = script([http(404), http(404), okBody({})]);
  const probe = await store.probeGoogleAction("appendTradeSignals");
  check("the empty probe (writes nothing) is retried too, instead of failing on one 404", probe.supported === true && count() === 3, JSON.stringify(probe));
  count = script([http(404), okBody({ appended: 1 })]);
  let threw = false; try { await store.appendTradeSignalsToGoogle([{ symbol: "X" }]); } catch { threw = true; }
  check("an APPEND is never repeated after a 404 (a repeat could duplicate rows)", threw && count() === 1, `calls ${count()}`);
  count = script([http(403), okBody({ documents: [] })]);
  threw = false; try { await store.readGoogleDocuments([{ pathname: "k2/x.json", fallback: {} }]); } catch { threw = true; }
  check("a 403 (a real refusal) is final even on a safe call", threw && count() === 1, `calls ${count()}`);
  global.fetch = realFetch;
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})();
