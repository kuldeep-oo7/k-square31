"use strict";

const assert = require("node:assert");
const { CookieJar, fingerprint, positionForm } = require("./gm-cloud-sync");
const { readCloudBridgeToken } = require("../api/_lib/gm-bridge");

const form = positionForm();
assert.equal(form.get("iDisplayLength"), "-1");
assert.equal(form.get("all_outstanding"), "1");
assert.equal(form.get("group_by"), "u.user_full_name");
assert.equal(form.get("market_type_id"), "");
assert.equal(form.get("mDataProp_11"), "11");

const jar = new CookieJar();
jar.add({ headers: { getSetCookie: () => ["PHPSESSID=abc123; Path=/; Secure; HttpOnly", "device=cloud; Path=/"] } });
assert.equal(jar.header(), "PHPSESSID=abc123; device=cloud");

const positions = [{ symbol: "AUBANK", position: "long", expiry: "2026-08-25", quantity: 70, price: 1073.7, buyQuantity: 70, buyAverage: 1073.1 }];
assert.match(fingerprint(positions), /^[a-f0-9]{64}$/);
assert.equal(fingerprint(positions), fingerprint([...positions]));

process.env.K2_GM_CLOUD_SYNC_SECRET = "a".repeat(64);
assert.equal(readCloudBridgeToken("wrong"), null);
assert.equal(readCloudBridgeToken("a".repeat(64))?.username, "shah@kamlesh");
assert.equal(readCloudBridgeToken("a".repeat(64))?.deviceId, "gm-cloud-worker");
delete process.env.K2_GM_CLOUD_SYNC_SECRET;

console.log("GM cloud sync tests passed: read-only form, cookies, fingerprints and Kamlesh-only cloud authorization");
