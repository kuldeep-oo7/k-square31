"use strict";
// Long-running, observation-only Node service. Not a GitHub cron or static-page
// timer. Uses an authorized external quote feed; never accesses broker orders.
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), zlib = require("node:zlib");
const { SignalMonitor } = require("../api/_lib/signal-monitor");
const { sessionDate } = require("../api/_lib/indian-instruments");
const root = path.resolve(__dirname, "..");
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
function start({ env = process.env, fetchImpl = fetch } = {}) {
  const directory = path.join(root, ".private", "signal-monitor"); fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, "runtime.lock");
  const descriptor = fs.openSync(lock, "wx"); fs.writeSync(descriptor, String(process.pid)); fs.closeSync(descriptor);
  const release = () => { try { fs.unlinkSync(lock); } catch {} };
  let server, timer;
  try {
    const catalogue = read(path.join(root, ".cache", "indian-instruments", "latest.json"), {});
    const monitor = new SignalMonitor({ instruments: catalogue.instruments || [], plan: read(path.join(root, "plan-full.json"), {}), restored: read(path.join(directory, "state.json"), null) });
    const url = env.K2_MARKET_QUOTE_FEED_URL ? new URL(env.K2_MARKET_QUOTE_FEED_URL) : null;
    if (url && (url.protocol !== "https:" || url.username || url.password)) throw new Error("Feed must use HTTPS with credentials supplied separately");
    const port = Number(env.K2_MONITOR_PORT || 8788), interval = Number(env.K2_MONITOR_POLL_MS || 1000);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(interval) || interval < 1000) throw new Error("Invalid port or polling interval (minimum 1000ms)");
    const maxBytes = Number(env.K2_MONITOR_MAX_DAILY_BYTES || 100000000);
    if (!Number.isFinite(maxBytes) || maxBytes < 1000) throw new Error("Invalid raw archive size limit");
    let busy = false, feedIssue = url ? "AWAITING_FIRST_BATCH" : "MARKET_DATA_FEED_NOT_CONFIGURED", lastPersisted = null;
    const poll = async () => {
      if (busy || !url || env.K2_MARKET_DATA_ENTITLEMENT_CONFIRMED !== "true") return;
      busy = true;
      try {
        const response = await fetchImpl(url, { headers: env.K2_MARKET_DATA_TOKEN ? { Authorization: `Bearer ${env.K2_MARKET_DATA_TOKEN}` } : {}, signal: AbortSignal.timeout(8000), redirect: "error" });
        if (!response.ok) throw new Error(`UPSTREAM_HTTP_${response.status}`);
        const contentLength = Number(response.headers.get("content-length"));
        if (contentLength > 10000000) throw new Error("QUOTE_BATCH_TOO_LARGE");
        const text = await response.text(); if (text.length > 10000000) throw new Error("QUOTE_BATCH_TOO_LARGE");
        const body = JSON.parse(text);
        if (!Array.isArray(body.quotes) || body.quotes.length > 100000) throw new Error("QUOTE_BATCH_SCHEMA_INVALID");
        const archive = path.join(directory, `${sessionDate()}.ndjson.gz`);
        const block = zlib.gzipSync(JSON.stringify({ receivedAt: new Date().toISOString(), quotes: body.quotes }) + "\n");
        const currentSize = fs.existsSync(archive) ? fs.statSync(archive).size : 0;
        if (currentSize + block.length > maxBytes) throw new Error("RAW_ARCHIVE_LIMIT_REACHED");
        fs.appendFileSync(archive, block); // Save raw batch before interpreting it.
        const newAlerts = body.quotes.flatMap((q) => monitor.consume(q).alerts);
        if (newAlerts.length) fs.appendFileSync(path.join(directory, "alerts.ndjson"), newAlerts.map((a) => JSON.stringify(a)).join("\n") + "\n");
        fs.writeFileSync(path.join(directory, "state.json.tmp"), JSON.stringify(monitor.snapshot()));
        fs.renameSync(path.join(directory, "state.json.tmp"), path.join(directory, "state.json"));
        lastPersisted = new Date().toISOString(); feedIssue = null;
      } catch (e) {
        // Do not expose endpoint, authorization headers or raw provider errors.
        feedIssue = /^(UPSTREAM_HTTP_\d+|QUOTE_BATCH_TOO_LARGE|QUOTE_BATCH_SCHEMA_INVALID|RAW_ARCHIVE_LIMIT_REACHED)$/.test(e.message) ? e.message : "FEED_OR_PERSISTENCE_ERROR";
      } finally { busy = false; }
    };
    server = http.createServer((req, res) => {
      const allowedOrigin = env.K2_MONITOR_ALLOWED_ORIGIN || "https://kuldeep-oo7.github.io";
      if (req.headers.origin && req.headers.origin !== allowedOrigin) { res.writeHead(403); res.end(); return; }
      if (req.method !== "GET" || !["/health", "/alerts"].includes(req.url)) { res.writeHead(404); res.end(); return; }
      res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
      if (req.headers.origin) { res.setHeader("Access-Control-Allow-Origin", allowedOrigin); res.setHeader("Vary", "Origin"); }
      const data = { ...monitor.status(), feedIssue: env.K2_MARKET_DATA_ENTITLEMENT_CONFIRMED === "true" ? feedIssue : "DATA_ENTITLEMENT_NOT_CONFIRMED", lastPersisted,
        serviceRunning: true, evaluation: "Every accepted quote, not once per week", pollIntervalMs: interval };
      if (req.url === "/alerts") data.alerts = env.K2_MARKET_DATA_DISPLAY_ALLOWED === "true" && !data.feedIssue ? monitor.alerts : [];
      res.end(JSON.stringify(data));
    });
    server.listen(port, env.K2_MONITOR_HOST || "127.0.0.1");
    timer = setInterval(poll, interval); poll();
    const close = () => { clearInterval(timer); server.close(); release(); };
    process.once("SIGINT", close); process.once("SIGTERM", close); process.once("exit", release);
    console.log(JSON.stringify({ port, mode: "RESEARCH_OBSERVER_NO_ORDERS", feedConfigured: Boolean(url), instrumentCount: catalogue.instruments?.length || 0 }));
    return { server, monitor, close, poll };
  } catch (e) { clearInterval(timer); server?.close(); release(); throw e; }
}
if (require.main === module) { try { start(); } catch (e) { console.error(e.code === "EEXIST" ? "A runtime lock exists. Verify the existing process before removing a stale lock." : e.message); process.exitCode = 1; } }
module.exports = { start };
