const assert = require("node:assert");
const {
  decodeDocument,
  encodeDocument,
  googleStoreConfigured,
  readGoogleDocument,
  readGoogleDocuments,
  writeGoogleDocument
} = require("../api/_lib/google-store");

const sample = {
  version: 1,
  symbols: {
    ICICIGI: {
      observations: Array.from({ length: 1_300 }, (_, index) => ({
        session: `2026-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
        open: 1_600 + index / 10,
        high: 1_610 + index / 10,
        low: 1_590 + index / 10,
        close: 1_605 + index / 10,
        volume: 100_000 + index
      }))
    }
  }
};

const encoded = encodeDocument(sample);
assert.deepStrictEqual(decodeDocument(encoded), sample);
assert(encoded.length < JSON.stringify(sample).length, "The Sheet document must be compressed");

const previousUrl = process.env.K2_GOOGLE_SHEETS_WEB_APP_URL;
const previousSecret = process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET;
delete process.env.K2_GOOGLE_SHEETS_WEB_APP_URL;
delete process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET;
assert.strictEqual(googleStoreConfigured(), false);
process.env.K2_GOOGLE_SHEETS_WEB_APP_URL = "https://script.google.com/macros/s/example/exec";
process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET = "test-secret";
assert.strictEqual(googleStoreConfigured(), true);

const originalFetch = global.fetch;
global.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  assert.strictEqual(body.secret, "test-secret");
  if (body.action === "readDocuments") {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        documents: body.paths.map((path, index) => index === 0
          ? { path, found: true, version: 7, encoded }
          : { path, found: false, version: 0 })
      })
    };
  }
  assert.strictEqual(body.action, "writeDocument");
  assert.strictEqual(body.expectedVersion, 7);
  assert.deepStrictEqual(decodeDocument(body.encoded), sample);
  return { ok: true, json: async () => ({ ok: true, version: 8 }) };
};

(async () => {
  const single = await readGoogleDocument("ai-grid/v1/shard-0.json", {});
  assert.deepStrictEqual(single, { data: sample, etag: "7" });
  const batch = await readGoogleDocuments([
    { pathname: "ai-grid/v1/shard-0.json", fallback: {} },
    { pathname: "ai-grid/v1/shard-1.json", fallback: { empty: true } }
  ]);
  assert.deepStrictEqual(batch[0], { data: sample, etag: "7" });
  assert.deepStrictEqual(batch[1], { data: { empty: true }, etag: null });
  assert.deepStrictEqual(await writeGoogleDocument("ai-grid/v1/shard-0.json", sample, "7"), { etag: "8" });
  global.fetch = originalFetch;
  if (previousUrl === undefined) delete process.env.K2_GOOGLE_SHEETS_WEB_APP_URL;
  else process.env.K2_GOOGLE_SHEETS_WEB_APP_URL = previousUrl;
  if (previousSecret === undefined) delete process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET;
  else process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET = previousSecret;
  console.log("Google operational store codec and transport tests passed");
})().catch((error) => {
  global.fetch = originalFetch;
  console.error(error);
  process.exitCode = 1;
});
