"use strict";
const http = require("node:http"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { buildSnapshot, saveSnapshot, quotesFrom, ROOT } = require("./runtime");
const { render } = require("./view");
const { openTrade, closeTrade, observe } = require("./paper");
const { demoNow, cases } = require("./demo");
async function createDesk({ source = "nse", port = 4174, dataDir = path.join(ROOT, ".private/fresh-desk/app"), autoRefresh = true, collectors = {} } = {}) {
  if (!["nse", "crypto", "demo"].includes(source)) throw Error("UNKNOWN_DATA_SOURCE");
  fs.mkdirSync(dataDir, { recursive: true });
  const csrf = crypto.randomBytes(24).toString("hex"), job = { running: false, error: null };
  let currentSource = source, snapshot = buildSnapshot({ inputs: [], errors: [], state: "WAITING_FOR_SCAN" }, { source });
  let pending = null;
  const nowForSource = () => currentSource === "demo" ? demoNow : Date.now();
  const bookFile = () => path.join(dataDir, currentSource === "demo" ? "paper-demo.json" : currentSource === "import" ? "paper-import.json" : "paper-live.json");
  function readBook() { const file = bookFile(); if (!fs.existsSync(file)) return []; try { const a = JSON.parse(fs.readFileSync(file)); if (!Array.isArray(a)) throw Error(); return a; } catch { throw Error("PAPER_RECORD_UNREADABLE_NO_CHANGES_SAVED"); } }
  function writeBook(book) { const file = bookFile(); fs.writeFileSync(file + ".tmp", JSON.stringify(book, null, 2)); fs.renameSync(file + ".tmp", file); }
  async function refresh(nextSource = currentSource, symbols = null) {
    if (job.running) throw Error("SCAN_ALREADY_RUNNING");
    if (!["nse", "crypto", "demo"].includes(nextSource)) throw Error("CHOOSE_A_LIVE_SOURCE_OR_IMPORT_DATA");
    job.running = true; job.error = null; currentSource = nextSource;
    // Drop the old source immediately so a source switch cannot label old prices as new.
    snapshot = buildSnapshot({ inputs: [], errors: [], state: "SCANNING" }, { source: currentSource, demo: currentSource === "demo", now: nowForSource() });
    pending = (async () => {
      try {
        const data = currentSource === "demo" ? { inputs: cases(), tradingSession: true, errors: [], state: "SYNTHETIC_DEMO" }
          : currentSource === "crypto" ? await (collectors.crypto || require("./crypto-feed").collectCrypto)(symbols || undefined)
            : await (collectors.nse || require("./feed").collect)(symbols);
        const now = nowForSource(); snapshot = buildSnapshot(data, { now, source: currentSource, demo: currentSource === "demo" });
        const book = readBook();
        const knownQuotes = quotesFrom(data), missing = book.filter((t) => !knownQuotes[t.instrumentId]);
        const monitor = currentSource === "demo" ? { quotes: {}, errors: [] } : await require("./position-quotes").positionQuotes(missing, { now });
        snapshot.errors.push(...monitor.errors);
        writeBook(observe(book, { ...knownQuotes, ...monitor.quotes }, currentSource === "demo" ? now : Date.now()));
        saveSnapshot(snapshot, path.join(dataDir, currentSource));
      } catch (e) {
        job.error = e.message === "PAPER_RECORD_UNREADABLE_NO_CHANGES_SAVED" ? e.message : "SCAN_UNAVAILABLE_CHECK_DATA_ACCESS";
        snapshot = buildSnapshot({ inputs: [], errors: [job.error], state: "DATA_UNAVAILABLE" }, { source: currentSource, demo: currentSource === "demo", now: nowForSource() });
      } finally { job.running = false; }
    })();
    return pending;
  }
  function json(res, code, data) { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(data)); }
  async function body(req) {
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw Error("JSON_REQUIRED");
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 4e6) throw Error("IMPORT_TOO_LARGE"); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Error("INVALID_JSON"); }
  }
  const server = http.createServer(async (req, res) => {
    const portNow = server.address()?.port, hosts = [`127.0.0.1:${portNow}`, `localhost:${portNow}`];
    if (!hosts.includes(req.headers.host)) return json(res, 403, { error: "LOCAL_HOST_REQUIRED" });
    const url = new URL(req.url, "http://" + req.headers.host);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
        return res.end(render(snapshot, { server: true, csrf, job, book: readBook() }));
      }
      if (req.method === "GET" && ["/app.css", "/app.js"].includes(url.pathname)) {
        res.writeHead(200, { "Content-Type": url.pathname.endsWith("css") ? "text/css" : "text/javascript", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); return res.end(fs.readFileSync(path.join(__dirname, url.pathname.slice(1))));
      }
      if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, { builtAt: snapshot.builtAt, source: currentSource, job });
      if (req.method === "GET" && url.pathname === "/api/snapshot") return json(res, 200, snapshot);
      if (req.method !== "POST") return json(res, 404, { error: "NOT_FOUND" });
      if (req.headers["x-fresh-csrf"] !== csrf || req.headers.origin && req.headers.origin !== "http://" + req.headers.host) return json(res, 403, { error: "SAME_ORIGIN_TOKEN_REQUIRED" });
      const data = await body(req);
      if (url.pathname === "/api/refresh") {
        if (job.running) return json(res, 409, { error: "SCAN_ALREADY_RUNNING" });
        if (!["nse", "crypto", "demo"].includes(data.source)) throw Error("UNKNOWN_DATA_SOURCE");
        if (data.symbols && (!Array.isArray(data.symbols) || data.symbols.some((s) => typeof s !== "string" || !/^[A-Z0-9&-]{1,30}$/.test(s)))) throw Error("INVALID_SYMBOLS");
        void refresh(data.source, data.symbols); return json(res, 202, { accepted: true });
      }
      if (job.running) return json(res, 409, { error: "WAIT_FOR_SCAN_TO_FINISH" });
      if (url.pathname === "/api/import") {
        const now = Date.now();
        const imported = buildSnapshot({ ...data, tradingSession: require("./feed").sessionAt(now), state: "IMPORTED_RESEARCH", errors: [] }, { now, source: "import", demo: false });
        currentSource = "import"; snapshot = imported; saveSnapshot(snapshot, path.join(dataDir, "import")); return json(res, 200, { imported: snapshot.results.length });
      }
      if (url.pathname === "/api/paper") {
        const plan = snapshot.results.flatMap((r) => r.plans).find((p) => p.id === data.planId);
        if (!plan) throw Error("PLAN_NOT_IN_CURRENT_SNAPSHOT");
        const book = openTrade(readBook(), plan, { fill: data.fill, quantity: data.quantity, now: nowForSource() }); writeBook(book); return json(res, 201, { recorded: true, id: book.at(-1).id });
      }
      if (url.pathname === "/api/paper/close") {
        const book = readBook(), index = book.findIndex((t) => t.id === data.id); if (index < 0) throw Error("PAPER_TRADE_NOT_FOUND");
        book[index] = closeTrade(book[index], { price: data.price, costs: data.costs ?? null, at: new Date(nowForSource()).toISOString() }); writeBook(book); return json(res, 200, { recorded: true });
      }
      return json(res, 404, { error: "NOT_FOUND" });
    } catch (e) { return json(res, 400, { error: /^[A-Z0-9_]+$/.test(e.message) ? e.message : "INVALID_REQUEST_OR_DATA" }); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  await refresh(source);
  const timer = autoRefresh ? setInterval(() => { if (!job.running && ["nse", "crypto"].includes(currentSource)) void refresh(); }, 5 * 60000) : null;
  timer?.unref();
  return { server, url: "http://127.0.0.1:" + server.address().port, refresh, getSnapshot: () => snapshot,
    close: async () => { if (timer) clearInterval(timer); await pending; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
if (require.main === module) {
  const args = process.argv.slice(2), portAt = args.indexOf("--port"), port = portAt < 0 ? 4174 : Number(args[portAt + 1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error("Choose a local port from 1024 to 65535."); process.exitCode = 1; }
  else createDesk({ source: args.includes("--demo") ? "demo" : args.includes("--crypto") ? "crypto" : "nse", port }).then((app) => {
    console.log("Fresh Desk: " + app.url + " · local research app; press Ctrl+C to stop.");
    process.once("SIGINT", () => app.close().then(() => process.exit(0)));
  }).catch(() => { console.error("Fresh Desk could not start; check the local port and data connection."); process.exitCode = 1; });
}
module.exports = { createDesk };
