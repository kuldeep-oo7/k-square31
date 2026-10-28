"use strict";
const fs = require("node:fs"), path = require("node:path");
async function verify({ base, root = path.resolve(__dirname, "../.private/fresh-desk/pages"), attempts = 30, pauseMs = 10000, fetchImpl = fetch } = {}) {
  let lastError = "NOT_SERVED";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      for (const folder of ["", "crypto/", "demo/"]) {
        const expected = JSON.parse(fs.readFileSync(path.join(root, folder, "version.json"), "utf8"));
        const get = async (name) => {
          const r = await fetchImpl(base + folder + name + "?verify=" + expected.revision, { cache: "no-store", signal: AbortSignal.timeout(10000) });
          if (!r.ok) throw Error("HTTP_" + r.status); return r.text();
        };
        const version = JSON.parse(await get("version.json"));
        if (version.revision !== expected.revision) throw Error("OLD_VERSION");
        const html = await get("index.html");
        if (!html.includes('"revision":"' + expected.revision + '"')) throw Error("OLD_HTML");
        for (const asset of ["app.js", "app.css", "core.js", "hosted.js"]) {
          if (await get(asset) !== fs.readFileSync(path.join(root, folder, asset), "utf8")) throw Error("ASSET_MISMATCH");
        }
      }
      console.log("Served HTML, version and all assets match for NSE, crypto and demo. Browser photographs remain a separate check.");
      return true;
    } catch (e) { lastError = /^[A-Z_0-9]+$/.test(e.message) ? e.message : "FETCH_FAILED"; }
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  throw Error("SERVED_VERIFICATION_FAILED_" + lastError);
}
if (require.main === module) {
  const repo = process.env.MIRROR_REPO || "kuldeep-oo7/k2-desk";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw Error("INVALID_MIRROR_REPOSITORY");
  const [owner, name] = repo.split("/");
  verify({ base: `https://${owner}.github.io/${name}/fresh/` }).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { verify };
