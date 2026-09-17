"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { RealtimeMarketEngine } = require("./api/_lib/realtime-market-engine");

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || "0.0.0.0";

const engine = new RealtimeMarketEngine();
engine.start(4000); // 4-second live tick cycle

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
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      timestamp: new Date().toISOString(),
      macro: { radar: engine.macroRadar, state: engine.macroState },
      summary: engine.ledger.getSummary(),
      accuracy: engine.ledger.getSignalsAccuracy ? engine.ledger.getSignalsAccuracy() : null,
      candidates: engine.getEnrichedCandidates(),
      universe: engine.getUniverse(),
      options: engine.getOptionsUniverse(),
      activePositions: engine.ledger.getActivePositions(),
      completedTrades: engine.ledger.getCompletedTrades(),
      archivedSignals: engine.ledger.getArchivedSignals ? engine.ledger.getArchivedSignals(50) : []
    }));
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

  // 4. Serve the Dynamic Mobile Application by default
  let targetFile;
  if (pathname === "/" || pathname === "/index.html" || pathname === "/app") {
    targetFile = path.resolve(__dirname, "site", "live-desk.html");
  } else {
    targetFile = path.resolve(__dirname, pathname.replace(/^\/+/, ""));
  }

  if (fs.existsSync(targetFile) && !fs.statSync(targetFile).isDirectory()) {
    const ext = path.extname(targetFile);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(targetFile).pipe(res);
    return;
  }

  // Fallback to live-desk.html
  const fallback = path.resolve(__dirname, "site", "live-desk.html");
  if (fs.existsSync(fallback)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(fallback).pipe(res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" }).end("404 Not Found");
});

server.listen(PORT, HOST, () => {
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
});

module.exports = { server, engine };
