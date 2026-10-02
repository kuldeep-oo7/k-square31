---
name: k2-build-rewrites-package-type
description: "npm run build (vinext) injects \"type\":\"module\" into package.json, which breaks every CommonJS script in the K² repo"
metadata: 
  node_type: memory
  type: project
  originSessionId: 19be2213-a4d7-4db0-b6e5-1f38bf2164c1
  modified: 2026-08-13T19:16:14.242Z
---

`npm run build` in pivot31 (`vinext build`) **writes `"type": "module"` into the root `package.json`** if the field is absent. Verified 2026-08-13: strip the field, run the build, and it reappears.

All of this repo's runtime code is CommonJS — `api/*.js`, `api/_lib/*.js`, every `scripts/*.js`. With `type: module` in place, running any of them as an entry point dies with `ReferenceError: require is not defined in ES module scope`, so `npm run check` fails and `node scripts/weekly-plan.js` produces nothing while still exiting 0 when piped.

**Fix in place:** `package.json` now pins `"type": "commonjs"` explicitly. vinext only fills in a *missing* `type`, so the explicit value survives the build and both `npm run check` and `npm run build` pass.

**Why:** the failure is silent under a pipe and looks exactly like "the scan found nothing", so it can burn a lot of time. HEAD before this never had the field, which is why it only appears after someone runs a build.

**How to apply:** if scripts suddenly fail with `require is not defined`, check `git diff package.json` for the `type` field before debugging anything else. Related: [[k2-hosting-and-store]].
