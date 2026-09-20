"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { RealtimeMarketEngine } = require("./api/_lib/realtime-market-engine");

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || "0.0.0.0";

// Everything servable to the public lives under this directory and nothing else.
const STATIC_ROOT = path.resolve(__dirname, "site");
const APP_ENTRY = path.resolve(STATIC_ROOT, "live-desk.html");

const engine = new RealtimeMarketEngine();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  // 1. Live SSE Stream endpoint
  if (pathname === "/api/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    res.write("\n");
    engine.addSseClient(res);
    return;
  }

  // 2. REST API: Current State
  if (pathname === "/api/state") {
    // ONE guard around the whole payload.
    //
    // This handler had none, so any throw anywhere inside it returned 502 for
    // the entire desk. On Friday a single unformattable provenance timestamp
    // -- new Date(NaN).toISOString() on a bar with no clock -- took down every
    // card, every price and the whole page during live market hours. A field
    // that cannot be computed must degrade to null, never to a dead endpoint.
    try {
      // Compressed when the client asks for it. The payload is about 3.5 MB of
      // JSON and the desk is read on a phone over mobile data, where pulling
      // that every few seconds is punishing: it gzips to a small fraction and
      // costs a few milliseconds of CPU. Uncompressed remains the fallback, so
      // a client that sends no Accept-Encoding still works unchanged.
      const wantsGzip = String(req.headers["accept-encoding"] || "").includes("gzip");
      const payload = JSON.stringify({
      timestamp: new Date().toISOString(),
      macro: { radar: engine.macroRadar, state: engine.macroState },
      // Whether live option quotes are available, and if not, exactly why. A
      // page that cannot tell configured from unconfigured will present
      // end-of-day settlement prices as if they were live.
      liveFeed: (() => {
        try {
          const brokers = require("./api/_lib/broker-feed").status();
          const sessions = require("./api/_lib/broker-auth").sessionStatus();
          const quotes = require("./api/_lib/live-quotes").status();
          // One sentence on whether the feed is actually working, so the
          // answer is readable from a phone instead of needing a script run
          // on the machine that happens to hold the credentials.
          const feedCheck = require("./api/_lib/live-quotes").diagnose();
          // What is configured on THIS host, so a deploy can be checked from a
          // phone instead of guessed at. Names only -- never the values.
          const persistence = (() => {
            // Report CAPABILITY, not the presence of environment variables.
            // Credentials may arrive by env var OR by a Render secret file, and
            // this check knew only about the first: with a working secret file
            // and an authenticated session it still listed all four ANGELONE_
            // names as missing. A diagnostic that says "missing" about
            // something demonstrably present is worse than none, because it is
            // read at the moment someone is trying to find out what is wrong.
            const brokerReady = Boolean(brokers.anyReady);
            const missing = [];
            if (!brokerReady) {
              missing.push("ANGELONE_API_KEY", "ANGELONE_CLIENT_CODE", "ANGELONE_MPIN", "ANGELONE_TOTP_SECRET");
            }
            for (const name of ["K2_GOOGLE_SHEETS_WEB_APP_URL", "K2_GOOGLE_SHEETS_ARCHIVE_SECRET"]) {
              if (!process.env[name]) missing.push(name);
            }
            let durable = false;
            try { durable = require("./api/_lib/google-store").googleStoreConfigured(); } catch (error) { durable = false; }
            // Whether the backup has actually SUCCEEDED from this host, as
            // opposed to merely being configured on it. A blocked egress, a
            // revoked deployment and a mistyped secret all look identical from
            // the outside, and every one leaves the ledger undurable.
            let backup = { attemptedAt: null, ok: null, detail: "unavailable" };
            try { backup = require("./api/_lib/signal-record").backupStatus(); }
            catch (error) { /* reported as unavailable */ }
            return {
              backup,
              ledgerVerified: backup.ok === true,
              brokerCredentials: brokerReady
                ? "PRESENT (environment or secret file)"
                : "ABSENT - set the four ANGELONE_ variables, or upload brokers.json as a Render secret file",
              ledgerDurable: durable,
              ledgerNote: !durable
                ? "Ledger is on an ephemeral disk and is WIPED on every deploy."
                : backup.ok === true
                  ? "Ledger mirrors to the Apps Script store; a call has succeeded from this host."
                  : backup.ok === false
                    ? `Archive CONFIGURED but the last call FAILED: ${backup.detail}`
                    : "Archive configured; no call attempted yet from this host.",
              missingEnvVars: missing
            };
          })();
          return {
            anyReady: brokers.anyReady,
            activeProvider: brokers.activeProvider,
            providers: { ...brokers.providers },
            sessions,
            quotes,
            feedCheck,
            persistence,
            howToConfigure: { ...brokers.howToConfigure }
          };
        } catch (error) { return { anyReady: false, activeProvider: null, reason: "FEED_MODULE_UNAVAILABLE" }; }
      })(),
      summary: engine.ledger.getSummary(),
      // The paper ledger is the desk's real track record: signals recorded at
      // the price shown and marked against observed prices only. The older DB
      // scorecard is used only while the paper ledger has nothing closed.
      accuracy: (() => {
        try {
          const paper = require("./api/_lib/signal-record").accuracyView();
          if (paper.hasTrackRecord || paper.openPositions > 0) return paper;
        } catch (error) { /* fall through to the DB scorecard */ }
        return engine.ledger.getSignalsAccuracy ? engine.ledger.getSignalsAccuracy() : null;
      })(),
      candidates: engine.getEnrichedCandidates(),
      // The same option chain was being sent TWICE: nested on every universe
      // row and again as the flattened `options` array the page actually
      // renders from. That duplication was 1.1 MB of a 4.6 MB payload, rebuilt
      // on every poll, on a 512 MB host -- and the desk spent Friday morning
      // reconnecting and then returning 502. The page reads universe rows only
      // for their action and score, so the nested copy goes out of the wire
      // shape while staying available in the engine.
      universe: engine.getUniverse().map(({ options, ...row }) => row),
      options: engine.getOptionsUniverse(),
      activePositions: engine.ledger.getActivePositions(),
      completedTrades: engine.ledger.getCompletedTrades(),
      archivedSignals: engine.ledger.getArchivedSignals ? engine.ledger.getArchivedSignals(50) : []
      });
      if (wantsGzip) {
        const body = require("node:zlib").gzipSync(payload);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Content-Length": body.length,
          "Access-Control-Allow-Origin": "*"
        });
        res.end(body);
      } else {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(payload);
      }
    } catch (error) {
      // Say what broke rather than showing a blank page. The desk reads this
      // and can report it instead of leaving someone staring at dashes.
      console.error("/api/state failed:", error.stack || error.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      }
      res.end(JSON.stringify({
        error: "STATE_BUILD_FAILED",
        message: String(error && error.message || error),
        timestamp: new Date().toISOString()
      }));
    }
    return;
  }

  // 3. REST API: Trigger Manual Action (Open / Track Purchased Trade)
  if (pathname === "/api/action/take" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const candidate = engine.candidates.find(c => c.id === payload.candidateId)
                       || engine.getUniverse().find(u => u.id === payload.candidateId)
                       || engine.getOptionsUniverse().find(o => o.id === payload.candidateId);
        if (candidate) {
          const pos = engine.ledger.openPosition(candidate, payload.fillPrice || candidate.entryPrice);
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: true, position: pos }));
          return;
        }
      } catch (e) {}
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Invalid candidate" }));
    });
    return;
  }

  // 4. REST API: Close a Purchased Trade
  if (pathname === "/api/action/close" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const closed = engine.ledger.closePosition(payload.positionId, payload.exitPrice, payload.reason || "MANUAL_EXIT");
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ success: true, trade: closed }));
        return;
      } catch (e) {}
      res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Failed to close position" }));
    });
    return;
  }

  // 5. An unmatched /api/ route is an error, not a page. Returning the SPA with
  // HTTP 200 for a mistyped endpoint makes a broken client look like a working
  // one, because fetch().ok is true and the body only fails later at JSON.parse.
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: "Unknown endpoint", path: pathname }));
    return;
  }

  // 6. Static assets, served ONLY from site/.
  //
  // This previously resolved the request path against the repository root, which
  // served any file the process could read: .private/k2-trading.db (the whole
  // trading ledger), every module under api/_lib, package.json. The containment
  // check below is what makes that impossible, and it is a check on the RESOLVED
  // path rather than on the request string, so encoded and nested traversal
  // attempts are all rejected by the same test.
  // decodeURIComponent throws URIError on a malformed escape, and a throw inside
  // this handler is an uncaught exception that takes the whole process down --
  // GET /% would have been enough to stop the desk. Percent-decoding is done
  // here precisely so that an encoded traversal cannot slip past the
  // containment check below, so it has to happen, and it has to be guarded.
  let requested;
  try {
    requested = decodeURIComponent(pathname);
  } catch (error) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("400 Bad Request");
    return;
  }
  // A NUL byte truncates a path inside the filesystem layer; Node throws on it.
  if (requested.includes(String.fromCharCode(0))) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("400 Bad Request");
    return;
  }
  const isAppRoute = requested === "/" || requested === "/index.html" || requested === "/app";
  const targetFile = isAppRoute ? APP_ENTRY : path.resolve(STATIC_ROOT, `.${path.sep}${requested.replace(/^\/+/, "")}`);
  const relative = path.relative(STATIC_ROOT, targetFile);
  const insideStaticRoot = targetFile === STATIC_ROOT || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  // A leading dot on any segment is refused outright: dotfiles are configuration
  // and version-control state, never page assets.
  const hidden = requested.split("/").some((segment) => segment.startsWith("."));

  if (insideStaticRoot && !hidden) {
    const ext = path.extname(targetFile);
    // fs can still throw on a path the OS rejects outright, and that throw would
    // be fatal in the same way the URIError was.
    let servable = false;
    try {
      servable = Object.prototype.hasOwnProperty.call(MIME_TYPES, ext)
        && fs.existsSync(targetFile) && fs.statSync(targetFile).isFile();
    } catch (error) {
      servable = false;
    }
    if (servable) {
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] });
      const stream = fs.createReadStream(targetFile);
      stream.on("error", () => res.end());
      stream.pipe(res);
      return;
    }
  }

  // Single-page fallback for genuine app routes only.
  if (!hidden && fs.existsSync(APP_ENTRY)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(APP_ENTRY).pipe(res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404 Not Found");
});

function announce() {
  const localIp = getLocalIp();
  console.log("========================================================================");
  console.log("  K² QUANTITATIVE RANGE DESK — REAL-TIME PRODUCTION SERVER");
  console.log("========================================================================");
  console.log(`  💻 Desktop / Laptop:       http://localhost:${PORT}`);
  console.log(`  📱 Mobile (Same Wi-Fi):    http://${localIp}:${PORT}`);
  console.log("  🌐 Free Worldwide Tunnel:  npx cloudflared tunnel --url http://localhost:" + PORT);
  console.log("========================================================================");
  console.log("  • Live Tick Engine:  4-second interval");
  console.log("  • Macro Shock Gate:  TradingView & Yahoo Exchange Quotes");
  console.log("  • 1-Tap Execution:   Zerodha Kite & Dhan Mobile Deep-Links");
  console.log("========================================================================");
}

// Importing this module must not bind a port or start polling live venues.
// It previously did both at require time, so a test that imported it inherited a
// second listening socket and an in-flight network poll, and exiting raced the
// teardown of handles the test never opened.
if (require.main === module) {
  engine.start(4000); // 4-second live tick cycle
  server.listen(PORT, HOST, announce);
}

module.exports = { server, engine, announce };
