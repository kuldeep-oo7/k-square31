const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const marketHandler = require("./api/market.js");
const authHandler = require("./api/auth.js");

const root = __dirname;
const port = Number(process.env.PORT) || 4173;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/api/market") {
    request.query = Object.fromEntries(url.searchParams);
    response.status = function status(code) { this.statusCode = code; return this; };
    response.json = function json(payload) { this.setHeader("Content-Type", "application/json"); this.end(JSON.stringify(payload)); };
    marketHandler(request, response);
    return;
  }
  if (url.pathname === "/api/auth") {
    response.status = function status(code) { this.statusCode = code; return this; };
    response.json = function json(payload) { this.setHeader("Content-Type", "application/json"); this.end(JSON.stringify(payload)); };
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (body) { try { request.body = JSON.parse(body); } catch { request.body = {}; } }
      authHandler(request, response);
    });
    return;
  }

  const requested = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const target = path.resolve(root, requested);
  if (!target.startsWith(root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    response.writeHead(404).end("Not found");
    return;
  }
  response.setHeader("Content-Type", types[path.extname(target)] || "application/octet-stream");
  fs.createReadStream(target).pipe(response);
});

server.listen(port, "127.0.0.1", () => console.log(`Pivot31 preview: http://127.0.0.1:${port}`));
