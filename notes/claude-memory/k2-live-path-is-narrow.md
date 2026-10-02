---
name: k2-live-path-is-narrow
description: "The deployed k-square31 desk reaches only 26 of 61 api/_lib modules and ZERO external npm packages; recommendation.js, ml-model.js and upside.js are dead on the live path"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-21T02:40:52.753Z
---

Established 2026-09-21 by walking the `require()` graph from `server.js`, the
real production entry point on Render (counting lazy requires inside function
bodies as reachable, so this is a generous bound).

**The live chain is narrow:** `server.js` → `realtime-market-engine.js` →
`universe-210.js` → `unified-quant-scanner.js` → {`neural-quant-engine`,
`chart-patterns`, `candlestick-engine`, `advanced-quant`,
`institutional-calculus`, `k2-lang`}. 26 of 61 `api/_lib` modules total.

**35 modules are unreachable from the server**, including `recommendation.js`
(661 lines), `ml-model.js` (513, gradient-boosted trees), `weekly-cycle.js`
(508), `covariance.js` (421), `shadow-ledger.js` (391), `panel.js` (333),
`upside.js` (280), `iv-surface.js` (302), `fno-liquidity.js` (265). Most ARE
exercised by `npm run check` and the offline research scripts, so they are not
dead code — but **none of them runs when the desk serves a card.** In
particular the deployed desk runs **no trained model of any kind**: the boosted
trees live behind `recommendation.js`, which the server never loads, and the
"1D-CNN" is a hand-written matched-filter bank, not a fitted network.

**Zero external npm packages are reachable from `server.js`.** `playwright` is
used by 3 test scripts; `@vercel/blob` only by `store.js` and `blob-smoke.js`,
neither reachable, on the suspended Vercel account (see [[k2-hosting-and-store]]);
`next`, `react`, `react-dom`, `react-server-dom-webpack`, `vinext`,
`@vinext/cloudflare` plus the vite/wrangler tooling serve the `app/` directory,
a Vercel/Cloudflare deploy path that is not the live host. Removing the six
framework packages is provably safe but was deliberately deferred off a market
morning because it triggers a fresh `npm install` on Render — see
[[k2-render-free-tier-limits]] and [[k2-build-rewrites-package-type]].

**How to use this:** when reasoning about what the live site actually does, read
only the 26 reachable modules. `scripts/` is not the desk, and a module having a
passing test suite says nothing about whether it runs in production.
