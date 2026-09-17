"use strict";

/**
 * Boots the real production server and attacks it.
 *
 * Before this test existed the static handler resolved request paths against the
 * repository root, so GET /.private/k2-trading.db returned the entire trading
 * ledger with HTTP 200, and every module under api/_lib was readable source.
 * These assertions are the thing that keeps that from coming back, so they run
 * against a listening socket rather than against the shape of the code.
 */

const assert = require("node:assert/strict");
const http = require("node:http");

process.env.PORT = "0";
process.env.HOST = "127.0.0.1";
const { server, engine } = require("../server");

// The tick engine polls live venues on a timer; a test must not keep that open.
if (engine && typeof engine.stop === "function") engine.stop();

function get(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: requestPath, method: "GET" },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode,
          type: response.headers["content-type"] || "",
          body: Buffer.concat(chunks)
        }));
      }
    );
    request.on("error", reject);
    request.end();
  });
}

async function run(port) {
  // --- files that must never leave the box -----------------------------------
  const forbidden = [
    "/.private/k2-trading.db",
    "/.private/k2-trading.db-wal",
    "/.private/k2-trading.db-shm",
    "/package.json",
    "/server.js",
    "/api/_lib/db-sqlite.js",
    "/api/_lib/institutional-calculus.js",
    "/.env",
    "/.git/config",
    "/data/trade-signals.json"
  ];
  for (const target of forbidden) {
    const response = await get(port, target);
    const body = response.body.toString("latin1");
    assert.ok(
      !body.startsWith("SQLite format 3"),
      `${target} served a raw SQLite database`
    );
    assert.ok(
      !body.includes("seedDefaultData") && !body.includes("calculateCornishFisherRisk"),
      `${target} served server-side source code`
    );
    assert.ok(
      !(response.type.includes("application/json") && body.trimStart().startsWith("{\n  \"name\"")),
      `${target} served package manifest`
    );
    assert.ok(
      !response.type.includes("octet-stream"),
      `${target} served an opaque binary payload`
    );
  }

  // --- traversal, encoded traversal, and dotfiles -----------------------------
  for (const target of [
    "/../server.js",
    "/../../Downloads/pivot31/package.json",
    "/%2e%2e/server.js",
    "/%2e%2e%2f%2e%2e%2fpackage.json",
    "/..%2fapi/_lib/db-sqlite.js",
    "/./../.private/k2-trading.db"
  ]) {
    const response = await get(port, target);
    const body = response.body.toString("latin1");
    assert.ok(!body.startsWith("SQLite format 3"), `${target} escaped the static root`);
    assert.ok(!body.includes("seedDefaultData"), `${target} escaped the static root`);
  }

  // --- the application itself must still work --------------------------------
  for (const target of ["/", "/index.html", "/app"]) {
    const response = await get(port, target);
    assert.equal(response.status, 200, `${target} must serve the application`);
    assert.ok(response.type.includes("text/html"), `${target} must serve HTML`);
    assert.ok(response.body.toString().includes("<!doctype html>"), `${target} must serve the page`);
  }

  // Genuine assets under site/ are still reachable.
  const asset = await get(port, "/portal-mobile-preview.png");
  assert.equal(asset.status, 200, "assets inside site/ must still be served");
  assert.ok(asset.type.includes("image/png"));

  // --- an unknown API route is an error, not a page --------------------------
  for (const target of ["/api/accuracy", "/api/health", "/api/does-not-exist"]) {
    const response = await get(port, target);
    assert.equal(response.status, 404, `${target} must be 404, not a 200 page`);
    assert.ok(response.type.includes("application/json"), `${target} must answer JSON`);
    const payload = JSON.parse(response.body.toString());
    assert.equal(payload.error, "Unknown endpoint");
  }

  // --- the real API still answers --------------------------------------------
  const state = await get(port, "/api/state");
  assert.equal(state.status, 200);
  assert.ok(state.type.includes("application/json"));
  const parsed = JSON.parse(state.body.toString());
  assert.ok(parsed.timestamp, "/api/state must carry a timestamp");

  console.log("Server security tests passed: ledger and source unreachable, traversal blocked, dotfiles refused, app and /api/state intact, unknown API routes 404");
}

server.listen(0, "127.0.0.1", async () => {
  const { port } = server.address();
  try {
    await run(port);
    server.close();
    process.exit(0);
  } catch (error) {
    server.close();
    console.error(error.message);
    process.exit(1);
  }
});
