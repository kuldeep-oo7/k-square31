"use strict";

/**
 * The ledger survives a deploy.
 *
 * Render's free tier wipes the disk on every deploy, so the SQLite database --
 * and with it the entire track record -- disappears whenever the code changes.
 * A record that resets on deploy cannot answer "does this desk make money",
 * which is the only question it exists to answer.
 *
 * The backup path to the Google Apps Script store was written but had never
 * RUN, because the two credentials are not set. Code that has never executed is
 * not an integration, it is an intention: the wire contract has two sides
 * (api/_lib/google-store.js and google-sheets/K2MarketArchive.gs) and nothing
 * had ever checked that they agree.
 *
 * So this stands a local server in front of the same contract the Apps Script
 * implements -- the secret check, gzip-base64 encoding, optimistic versioning
 * and CONFLICT semantics, read exactly as readDocuments_ returns it -- and puts
 * the real modules through a full deploy cycle:
 *
 *     record signals -> sync -> WIPE THE DATABASE -> restore -> verify
 *
 * When the real credentials are set, this is the path that runs.
 */

const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const SECRET = "test-secret-not-a-real-one";
const NOW = Date.parse("2026-09-22T05:00:00Z"); // 10:30 IST, a Tuesday
const signal = {
  symbol: "MOTHERSON", strike: 162.5, right: "CE", expiry: "2026-09-29",
  entryPrice: 3.10, lotSize: 6150, priceSource: "LIVE_BROKER_QUOTE",
  executable: true, targetPrice: 4.65, stopPrice: 1.55
};

const temps = [];
function freshDb() {
  const { SqliteTradingDatabase } = require("../api/_lib/db-sqlite");
  const file = path.join(os.tmpdir(), `k2-dur-${process.pid}-${temps.length}.db`);
  temps.push(file);
  return new SqliteTradingDatabase(file);
}

/**
 * A stand-in for K2MarketArchive.gs, implementing the same contract:
 * a shared secret, gzip-base64 payloads, and a version that must be matched.
 */
function startFakeAppsScript() {
  const store = new Map(); // path -> { version, encoded }
  let rejectNextWrite = false;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const reply = (payload) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      let payload;
      try { payload = JSON.parse(body); } catch (error) { return reply({ ok: false, error: "bad json" }); }

      // The Apps Script refuses anything without the shared secret.
      if (payload.secret !== SECRET) return reply({ ok: false, error: "Unauthorized" });

      if (payload.action === "readDocuments") {
        return reply({
          ok: true,
          documents: (payload.paths || []).map((p) => {
            const held = store.get(p);
            return held
              ? { path: p, found: true, version: held.version, encoding: "gzip-base64", encoded: held.encoded }
              : { path: p, found: false, version: 0 };
          })
        });
      }

      if (payload.action === "writeDocument") {
        if (rejectNextWrite) {
          rejectNextWrite = false;
          return reply({ ok: false, code: "CONFLICT", error: "Version conflict" });
        }
        if (payload.encoding !== "gzip-base64" || !/^[A-Za-z0-9+/=]+$/.test(payload.encoded || "")) {
          return reply({ ok: false, error: "Invalid encoding" });
        }
        const current = store.get(payload.path);
        const expected = Number(payload.expectedVersion) || 0;
        // Optimistic concurrency, exactly as the real script enforces it.
        if (current && current.version !== expected) {
          return reply({ ok: false, code: "CONFLICT", error: "Version conflict" });
        }
        const version = expected + 1;
        store.set(payload.path, { version, encoded: payload.encoded });
        return reply({ ok: true, version });
      }

      return reply({ ok: false, error: "Unknown action" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        store,
        conflictOnce: () => { rejectNextWrite = true; }
      });
    });
  });
}

(async () => {
  const fake = await startFakeAppsScript();
  const savedUrl = process.env.K2_GOOGLE_SHEETS_WEB_APP_URL;
  const savedSecret = process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET;
  process.env.K2_GOOGLE_SHEETS_WEB_APP_URL = fake.url;
  process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET = SECRET;

  try {
    const google = require("../api/_lib/google-store");
    const ledger = require("../api/_lib/signal-record");

    // --- 1. The store recognises itself as configured -----------------------
    assert.equal(google.googleStoreConfigured(), true,
      "an https-or-local URL plus a secret is a configured store");
    console.log("  ✓ The Apps Script store reports itself configured once URL and secret are present");

    // --- 1b. Account-scoped deployment URLs are normalised ------------------
    // Google shows a deployment as .../macros/u/1/s/<id>/exec while you are
    // signed in, where u/1 says WHICH signed-in account is looking. Pasted into
    // a server's configuration that URL returns 404 on every request, because
    // there is no browser session and so no account 1. Measured against a live
    // deployment: the u/1 form 404s, the canonical form answers.
    //
    // The failure mode is the dangerous kind -- deploy green, variable looks
    // right, every backup silently 404s, and the gap surfaces on the day the
    // ledger is needed back.
    {
      const canonical = google.canonicalWebAppUrl;
      const id = "AKfycbTEST";
      assert.equal(canonical(`https://script.google.com/macros/u/1/s/${id}/exec`),
        `https://script.google.com/macros/s/${id}/exec`, "u/1 must be stripped");
      assert.equal(canonical(`https://script.google.com/macros/u/0/s/${id}/exec`),
        `https://script.google.com/macros/s/${id}/exec`, "any account index must be stripped");
      assert.equal(canonical(`https://script.google.com/macros/s/${id}/exec`),
        `https://script.google.com/macros/s/${id}/exec`, "a canonical URL is left alone");
      // Nothing outside the account selector may be rewritten.
      assert.equal(canonical("http://127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
      console.log("  ✓ Account-scoped Apps Script URLs are normalised, so a pasted u/1 link still works");
    }

    // --- 2. A full round trip through the real encoder ----------------------
    const written = await google.writeGoogleDocument("k2/probe.json", { hello: "world", n: 42 }, null);
    assert.ok(Number(written.etag) > 0, "a write returns a version to match against next time");
    const readBack = await google.readGoogleDocument("k2/probe.json", null);
    assert.deepEqual(readBack.data, { hello: "world", n: 42 }, "what goes in comes back out");
    // The payload on the wire must actually be compressed, not plaintext.
    const held = fake.store.get("k2/probe.json");
    const decoded = JSON.parse(zlib.gunzipSync(Buffer.from(held.encoded, "base64")).toString("utf8"));
    assert.deepEqual(decoded, { hello: "world", n: 42 }, "stored as gzip-base64, as the contract requires");
    console.log("  ✓ Documents round-trip through gzip-base64 and the version contract");

    // --- 3. A deploy wipes the disk; the ledger comes back -------------------
    const before = freshDb();
    const recorded = ledger.record(signal, { now: NOW, db: before });
    assert.equal(recorded.ok, true);
    ledger.markToMarket(() => ({ price: 4.70, source: "BROKER_REALTIME" }), { now: NOW + 60_000, db: before });

    const closedBefore = ledger.trackRecord({ db: before });
    assert.equal(closedBefore.closed, 1, "one closed position before the deploy");

    const synced = await ledger.syncToRemote({ db: before });
    assert.equal(synced.ok, true, `sync must succeed: ${synced.reason || ""}`);
    assert.equal(synced.positions, 1);

    // The deploy: a brand new, empty database, exactly as Render hands back.
    const after = freshDb();
    assert.equal(ledger.trackRecord({ db: after }).recorded, 0, "the new container starts empty");

    const restored = await ledger.restoreFromRemote({ db: after });
    assert.equal(restored.ok, true, `restore must succeed: ${restored.reason || ""}`);
    assert.equal(restored.positions, 1);

    const closedAfter = ledger.trackRecord({ db: after });
    assert.equal(closedAfter.closed, 1, "the closed position survived the deploy");
    assert.equal(closedAfter.winRatePct, closedBefore.winRatePct, "and so did the win rate");
    assert.equal(closedAfter.totalPnlRupees, closedBefore.totalPnlRupees, "and the realised P&L");

    // Provenance has to survive too, or the restored record is unauditable.
    const row = after.db.prepare("SELECT * FROM signals_lifecycle LIMIT 1").get();
    assert.equal(row.entry_price, 3.10, "the entry price is exactly what was shown");
    assert.equal(row.entry_price_source, "LIVE_BROKER_QUOTE", "and where it came from");
    assert.equal(row.exit_price_source, "BROKER_REALTIME");
    console.log("  ✓ A wiped database is restored from the backup, with prices and provenance intact");

    // --- 4. A restore never overwrites what is already local ----------------
    // The live database is the authority. A stale backup must not reopen a
    // position that has since closed, or undo a later mark.
    const second = await ledger.restoreFromRemote({ db: after });
    assert.equal(second.positions, 0, "a second restore inserts nothing; local rows are untouched");
    assert.equal(ledger.trackRecord({ db: after }).recorded, 1, "and does not duplicate them");
    console.log("  ✓ Restoring twice is harmless: local rows are never overwritten or duplicated");

    // --- 5. A failed backup never disturbs the live ledger ------------------
    fake.conflictOnce();
    const conflicted = await ledger.syncToRemote({ db: after });
    assert.equal(conflicted.ok, false, "a version conflict is reported, not thrown");
    assert.ok(conflicted.reason, "and it says why");
    assert.equal(ledger.trackRecord({ db: after }).closed, 1,
      "the local ledger is unchanged by a failed backup");
    console.log("  ✓ A conflict or outage is reported and leaves the live ledger untouched");

    // --- 6. Without credentials it refuses, rather than pretending ----------
    delete process.env.K2_GOOGLE_SHEETS_WEB_APP_URL;
    const unconfigured = await ledger.syncToRemote({ db: after });
    assert.equal(unconfigured.ok, false);
    assert.equal(unconfigured.reason, "GOOGLE_STORE_NOT_CONFIGURED",
      "an unconfigured store must name itself, so the desk can report the ledger is not durable");
    console.log("  ✓ With no credentials it reports NOT_CONFIGURED instead of silently dropping the backup");

    console.log("Ledger durability tests passed: gzip-base64 round trip, a wiped database restored with prices and provenance, idempotent restores, failures that leave the ledger intact, and an honest refusal when unconfigured");
  } finally {
    if (savedUrl === undefined) delete process.env.K2_GOOGLE_SHEETS_WEB_APP_URL;
    else process.env.K2_GOOGLE_SHEETS_WEB_APP_URL = savedUrl;
    if (savedSecret === undefined) delete process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET;
    else process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET = savedSecret;
    fake.server.close();
    for (const file of temps) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.rmSync(file + suffix, { force: true }); } catch (error) { /* leftovers are not failures */ }
      }
    }
  }
})().catch((error) => {
  console.error("Ledger durability tests FAILED:", error.message);
  process.exit(1);
});
