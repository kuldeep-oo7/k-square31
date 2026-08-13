"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");

// The snapshot writer is exercised against an in-memory operational store so the
// completeness, staleness and account-routing rules are verified without
// touching the live document store.
const storePath = require.resolve("../api/_lib/store");
const writes = [];
let stored = { version: 2, lots: [], realizedPnl: 0, transactions: [], updatedAt: null };
require.cache[storePath] = {
  id: storePath,
  filename: storePath,
  loaded: true,
  exports: {
    async mutatePortfolio(username, mutator) {
      const next = await mutator(structuredClone(stored));
      next.version = 2;
      next.updatedAt = new Date().toISOString();
      writes.push({ username, next });
      stored = next;
      return next;
    }
  }
};

const { BRIDGE_USERNAME } = require("../api/_lib/gm-bridge");
const { applyBrokerSnapshot, measureSnapshot } = require("../api/_lib/gm-snapshot");
const { directStoreConfigured, publishSnapshot, snapshotPayload } = require("./gm-cloud-sync");

const positions = [
  { symbol: "AUBANK", price: 1029.8, quantity: 70, position: "long", expiry: "2026-08-25", markPrice: 1035.4, mtm: 392, buyQuantity: 70, buyAverage: 1029.8, sellQuantity: 0, sellAverage: 0 },
  { symbol: "NIFTY", price: 24321.7, quantity: 35, position: "short", expiry: "2026-08-27", markPrice: 24290.5, mtm: 1092, buyQuantity: 0, buyAverage: 0, sellQuantity: 35, sellAverage: 24321.7 }
];
const metadata = { recordCount: 2, totalQuantity: 35, totalMtm: 1484 };

function snapshot(overrides = {}) {
  return {
    snapshotId: crypto.createHash("sha256").update("gm-snapshot-test").digest("hex"),
    capturedAt: new Date().toISOString(),
    positions,
    ...metadata,
    ...overrides
  };
}

const measured = measureSnapshot(snapshot());
assert.equal(measured.trusted, true, "a reconciled GM snapshot is trusted");
assert.equal(measured.verifiedComplete, true);
assert.equal(measured.totalQuantity, 35, "signed quantity nets the short leg against the long leg");
assert.equal(measured.totalAbsoluteQuantity, 105);

assert.equal(measureSnapshot(snapshot({ recordCount: 3 })).trusted, false, "a short read is rejected");
assert.equal(measureSnapshot(snapshot({ totalQuantity: 105 })).trusted, false, "a quantity mismatch is rejected");
assert.equal(measureSnapshot(snapshot({ totalMtm: 9999 })).trusted, false, "an MTM mismatch is rejected");
assert.equal(measureSnapshot(snapshot({ snapshotId: "not-a-digest" })).trusted, false);
assert.equal(measureSnapshot(snapshot({ capturedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() })).trusted, false, "a future capture is rejected");
assert.equal(measureSnapshot(snapshot({ capturedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() })).trusted, false, "a day-old capture is rejected");

(async () => {
  await assert.rejects(
    () => applyBrokerSnapshot(BRIDGE_USERNAME, snapshot({ recordCount: 5 }), { source: "gm-cloud", deviceId: "gm-cloud-worker" }),
    (error) => error.code === "SNAPSHOT",
    "an unverified snapshot never reaches the store"
  );
  assert.equal(writes.length, 0);

  const applied = await applyBrokerSnapshot(BRIDGE_USERNAME, snapshot(), { source: "gm-cloud", deviceId: "gm-cloud-worker" });
  assert.equal(applied.positions, 2);
  assert.equal(applied.ignoredStale, false);
  assert.equal(writes[0].username, BRIDGE_USERNAME, "the snapshot is written to the account the web app reads");
  assert.equal(writes[0].next.brokerSync.source, "gm-cloud");
  assert.equal(writes[0].next.brokerSync.verifiedComplete, true);
  assert.equal(writes[0].next.brokerSync.totalMtm, 1484);
  assert.equal(writes[0].next.lots.find((lot) => lot.symbol === "AUBANK").markPrice, 1035.4, "the live GM mark is stored with the position");
  assert.equal(writes[0].next.lots.find((lot) => lot.symbol === "NIFTY").sellAverage, 24321.7, "sold quantity and average survive the write");

  const stale = await applyBrokerSnapshot(BRIDGE_USERNAME, snapshot({
    capturedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    positions: [positions[0]],
    recordCount: 1,
    totalQuantity: 70,
    totalMtm: 392
  }), { source: "gm-cloud", deviceId: "gm-cloud-worker" });
  assert.equal(stale.ignoredStale, true, "an out-of-order snapshot cannot roll the portfolio back");
  assert.equal(stored.lots.length, 2, "the newer snapshot's positions are preserved");

  process.env.K2_GOOGLE_SHEETS_WEB_APP_URL = "https://script.google.com/macros/s/test/exec";
  process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET = "s".repeat(64);
  assert.equal(directStoreConfigured(), true);
  const published = await publishSnapshot(positions, "", { ...metadata, endpoint: "https://gmglobal.org/datatables/position_book_list.php" });
  assert.equal(published.via, "google-sheets-store", "a configured store is written directly, not through the web host");
  assert.equal(published.username, BRIDGE_USERNAME);
  assert.equal(writes.at(-1).username, BRIDGE_USERNAME);
  assert.match(snapshotPayload(positions, metadata).snapshotId, /^[a-f0-9]{64}$/);

  process.env.K2_GM_PUBLISH_MODE = "http";
  await assert.rejects(() => publishSnapshot(positions, "short", metadata), /K2_GM_CLOUD_SYNC_SECRET is required/, "forced HTTP mode still demands the bridge secret");
  delete process.env.K2_GM_PUBLISH_MODE;
  delete process.env.K2_GOOGLE_SHEETS_WEB_APP_URL;
  delete process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET;

  console.log("GM snapshot tests passed: completeness gating, stale-snapshot protection and direct store publication");
})();
