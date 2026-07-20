const assert = require("node:assert/strict");
const { writableEtag } = require("../api/_lib/store");

assert.equal(writableEtag('W/"fba14b3126c31898a8044a8af5d70111"'), '"fba14b3126c31898a8044a8af5d70111"');
assert.equal(writableEtag('"strong-etag"'), '"strong-etag"');
assert.equal(writableEtag(null), null);
console.log("Blob ETag normalization tests passed");
