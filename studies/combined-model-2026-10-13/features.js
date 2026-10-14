"use strict";
// Implements ./PREREGISTRATION.txt sections 2-4 (sha256 in ./PREREGISTRATION.sha256): the feature panel of the combined model.
//   node features.js <out.csv>                         real data (K2_CM_DIR, K2_ATLAS_DIR, K2_RESEARCH_DIR)
//   node features.js <out.csv> --synthetic <seed> [--plant]   check 7.1 / 7.2 (synthetic market only)
//   node features.js --coverage                        check 7.4 (counts only, no returns)
// Also a module: build(data) -> { rows, raw } for check 7.3 (checks.js).
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { context } = require(path.join(ROOT, "api/_lib/forward-v3"));
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }

const RESET = 0.18;                       // as api/_lib/forward-v3.js
const STOCK_F = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "P12", "P13", "P14", "P15", "P16", "P17", "P18", "P19", "P20", "P21", "P22", "P23",
  "D1", "D2", "F1", "F2", "F3", "F4", "O1", "O2", "X1", "L1", "L2", "L3", "W1", "W2", "M1", "M2", "I1", "I2", "I3"];
const MARKET_F = ["K1", "K2", "K3", "K4", "K5", "K6", "K7", "K8", "K9", "K10", "K11", "K12", "K13", "K14"];
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const fin = Number.isFinite;

// Hurst exponent by rescaled range (P22): slope of log(mean R/S) on log(n), n = 8..128, on 128 log returns.
function hurst(r) { const xs = [], ys = [];
  for (const n of [8, 16, 32, 64, 128]) { const rs = [];
    for (let s = 0; s + n <= r.length; s += n) { const w = r.slice(s, s + n); const m = mean(w); let cum = 0, mx = -Infinity, mn = Infinity, ss = 0;
      for (const v of w) { cum += v - m; mx = Math.max(mx, cum); mn = Math.min(mn, cum); ss += (v - m) ** 2; } const S = Math.sqrt(ss / n); if (S > 0) rs.push((mx - mn) / S); }
    if (rs.length) { xs.push(Math.log(n)); ys.push(Math.log(mean(rs))); } }
  if (xs.length < 3) return NaN; const mx = mean(xs), my = mean(ys); let a = 0, b = 0; for (let k = 0; k < xs.length; k += 1) { a += (xs[k] - mx) * (ys[k] - my); b += (xs[k] - mx) ** 2; } return a / b; }

// data: { sessions, stocks:[{sym,bars:[{d,o,h,l,c,val,qty}]}], fut: Map(d->Map(sym->{oi,contracts,near})), deliv: Map(d->Map(sym->pct)),
//   opt: Map(d->Map(sym->[callOI,putOI])), short: Map(d->Map(sym->qty)), slb: Map(d->Map(sym->qty)), fee: Map(d->Map(sym->rate)),
//   mwpl: Map(d->Map(sym->u)), mtf: Map(d->Map(sym->qty)), pit: [{sym,d,cat,mode,type,value}], pitMonths: Set(YYYY-MM with >= 1 record),
//   nifty: Map(d->{o,c,pe}), vix: Map(d->c), part: Map(d->{FII,PRO,CLIENT,DII: {fil,fis,cl,cs,pl,ps}}), cat: Map(d->{FPI,MF,RETAIL: {buy,sell}}) }
function build(data, { keepRaw = false } = {}) {
  const S = data.sessions, sIdx = new Map(S.map((d, i) => [d, i]));
  const ctx = context({ sessions: S, stocks: data.stocks });
  // ---- market features, one value per session
  const zOf = (vals) => { const out = new Map(); const hist = []; for (const [d, v] of vals) { if (!fin(v)) { out.set(d, NaN); continue; }
      const past = hist.slice(-250); out.set(d, past.length >= 120 ? (v - mean(past)) / (sdv(past) || NaN) : NaN); hist.push(v); } return out; };
  const nd = S.filter((d) => data.nifty.has(d) && data.nifty.get(d).c > 0);
  const nc = nd.map((d) => data.nifty.get(d).c);
  const series = (f) => S.map((d) => [d, f(d)]);
  const nAt = new Map(nd.map((d, k) => [d, k]));
  const nRet = (d, n) => { const k = nAt.get(d); return k !== undefined && k >= n ? nc[k] / nc[k - n] - 1 : NaN; };
  const regime = new Map(); { let ema = null; for (let k = 0; k < nd.length; k += 1) { const c = nc[k]; ema = ema === null ? c : ema + (2 / 21) * (c - ema);
      const sma50 = k >= 49 ? mean(nc.slice(k - 49, k + 1)) : NaN; regime.set(nd[k], k >= 49 ? (c < ema && ema < sma50 ? 1 : 0) : NaN); } }
  const vd = S.filter((d) => fin(data.vix.get(d)));
  const vAt = new Map(vd.map((d, k) => [d, k]));
  const partNet = (who, f) => (d) => { const r = data.part.get(d)?.[who]; return r ? f(r) : NaN; };
  const catNet = (who) => (d) => { const r = data.cat.get(d)?.[who]; return r ? r.buy - r.sell : NaN; };
  const M = {
    K1: zOf(series((d) => nRet(d, 5))), K2: zOf(series((d) => nRet(d, 20))), K3: regime,
    K4: zOf(series((d) => data.vix.get(d))), K5: zOf(series((d) => { const k = vAt.get(d); return k !== undefined && k >= 5 ? data.vix.get(d) - data.vix.get(vd[k - 5]) : NaN; })),
    K6: zOf(series(partNet("FII", (r) => r.fil - r.fis))), K7: zOf(series(partNet("PRO", (r) => r.fil - r.fis))), K8: zOf(series(partNet("CLIENT", (r) => r.fil - r.fis))),
    K9: zOf(series(partNet("DII", (r) => r.fil - r.fis))), K10: zOf(series(partNet("FII", (r) => (r.cl - r.cs) - (r.pl - r.ps)))),
    K11: zOf(series(catNet("FPI"))), K12: zOf(series(catNet("MF"))), K13: zOf(series(catNet("RETAIL"))),
    K14: (() => { const out = new Map(); const hist = []; for (const d of S) { const pe = data.nifty.get(d)?.pe; if (!(pe > 0)) { out.set(d, NaN); continue; }
        const past = hist.slice(-750); out.set(d, past.length >= 250 ? past.filter((v) => v < pe).length / past.length : NaN); hist.push(pe); } return out; })()
  };
  // ---- per-date helpers for the other families
  const prevDate = (d, n) => { const i = sIdx.get(d); return i !== undefined && i - n >= 0 ? S[i - n] : null; };
  const futDates = [...data.fut.keys()].sort(); const futAt = new Map(futDates.map((d, k) => [d, k]));
  const slbDates = [...data.slb.keys()].sort(); const slbAt = new Map(slbDates.map((d, k) => [d, k]));
  const mtfDates = [...data.mtf.keys()].sort(); const mtfAt = new Map(mtfDates.map((d, k) => [d, k]));
  const pitBy = new Map(); for (const r of data.pit) { if (!pitBy.has(r.sym)) pitBy.set(r.sym, []); pitBy.get(r.sym).push(r); }
  for (const a of pitBy.values()) a.sort((x, y) => (x.d < y.d ? -1 : 1));
  const insider = (sym, d) => { if (!data.pitMonths.has(d.slice(0, 7))) return [NaN, NaN, NaN]; let buy = 0, pledge = 0, sale = 0;
    for (const r of pitBy.get(sym) || []) { if (r.d > d) break; if (days(r.d, d) >= 28) continue;
      if (/promoter/i.test(r.cat) && /^market purchase$/i.test(r.mode) && /buy/i.test(r.type)) buy += r.value;
      else if (/promoter/i.test(r.cat) && /^pledge creation$/i.test(r.mode)) pledge += 1;
      else if ((/^director$/i.test(r.cat) || /key managerial/i.test(r.cat)) && /^market sale$/i.test(r.mode)) sale += r.value; }
    return [Math.log1p(buy), pledge, Math.log1p(sale)]; };

  const rows = []; const raw = keepRaw ? new Map() : null;
  for (const st of data.stocks) {
    const b = st.bars; const n = b.length; if (n < 30) continue;
    const cut = new Int32Array(n); for (let k = 1; k < n; k += 1) cut[k] = Math.abs(b[k].o / b[k - 1].c - 1) >= RESET ? k : cut[k - 1];
    const lr = new Float64Array(n); for (let k = 1; k < n; k += 1) lr[k] = Math.log(b[k].c / b[k - 1].c);
    // RSI(14), Wilder, restarted at each reset
    const rsi = new Float64Array(n).fill(NaN); { let ag = 0, al = 0, cnt = 0;
      for (let k = 1; k < n; k += 1) { if (cut[k] === k) { ag = 0; al = 0; cnt = 0; continue; } const ch = b[k].c - b[k - 1].c; const g = Math.max(ch, 0), l = Math.max(-ch, 0); cnt += 1;
        if (cnt <= 14) { ag += g / 14; al += l / 14; } else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; } if (cnt >= 14) rsi[k] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } }
    for (let k = 0; k < n; k += 1) {
      const d = b[k].d, i = sIdx.get(d); if (i === undefined || i + 2 >= S.length) continue; const e = S[i + 2];
      if (!ctx.uni(e.slice(0, 7)).has(st.sym)) continue; const fr = data.fut.get(d)?.get(st.sym); if (!fr) continue;
      const have = (m) => k - cut[k] >= m;                      // m bars back available inside the segment
      const c = b[k].c; const R = (m) => (have(m) ? c / b[k - m].c - 1 : NaN);
      const win = (m, f) => { if (!have(m - 1)) return NaN; const a = []; for (let j = k - m + 1; j <= k; j += 1) a.push(f(b[j], j)); return a; };
      const sma = (m) => { const a = win(m, (x) => x.c); return Array.isArray(a) ? c / mean(a) - 1 : NaN; };
      const rets = (m) => (have(m) ? Array.from(lr.subarray(k - m + 1, k + 1)) : null);
      const rv = (m) => { const a = rets(m); return a ? sdv(a) * Math.sqrt(252) : NaN; };
      const f = {};
      f.P1 = R(1); f.P2 = R(5); f.P3 = R(20); f.P4 = R(60); f.P5 = R(120);
      f.P6 = have(252) ? b[k - 21].c / b[k - 252].c - 1 : NaN;
      { const a = win(250, (x) => x.h); f.P7 = Array.isArray(a) ? c / Math.max(...a) - 1 : NaN; }
      f.P8 = sma(20); f.P9 = sma(50); f.P10 = sma(200); f.P11 = rsi[k];
      f.P12 = b[k].h > b[k].l ? (c - b[k].l) / (b[k].h - b[k].l) : NaN; f.P13 = have(1) ? b[k].o / b[k - 1].c - 1 : NaN;
      f.P14 = rv(20);
      { const a = win(20, (x) => Math.log(x.h / x.l) ** 2); f.P15 = Array.isArray(a) ? Math.sqrt(mean(a) / (4 * Math.LN2) * 252) : NaN; }
      { const a = rv(5), z = rv(60); f.P16 = z > 0 ? a / z : NaN; }
      { const a = win(60, (x) => x.val); f.P17 = Array.isArray(a) && b[k].val > 0 ? Math.log(b[k].val / median(a)) : NaN; }
      { const a = have(20) ? Array.from({ length: 20 }, (_, q) => { const j = k - 19 + q; return b[j].val > 0 ? Math.abs(lr[j]) / b[j].val : NaN; }) : null; f.P18 = a && a.every(fin) ? mean(a) : NaN; }
      { const a = have(20) ? Array.from({ length: 20 }, (_, q) => b[k - 19 + q].c / b[k - 20 + q].c - 1) : null; f.P19 = a ? Math.max(...a) : NaN; }
      { const a = rets(120); if (a) { const x = a.slice(0, -1), y = a.slice(1); const mx = mean(x), my = mean(y); let num = 0, dx = 0, dy = 0;
          for (let q = 0; q < x.length; q += 1) { num += (x[q] - mx) * (y[q] - my); dx += (x[q] - mx) ** 2; dy += (y[q] - my) ** 2; } f.P20 = num / Math.sqrt(dx * dy); } else f.P20 = NaN; }
      { const a = win(20, (x) => x.c); f.P21 = Array.isArray(a) ? (c - mean(a)) / sdv(a) : NaN; }
      { const a = rets(128); f.P22 = a ? hurst(a) : NaN; }
      { if (have(120)) { const xs = [], ys = []; for (let j = k - 119; j <= k; j += 1) { const p = nAt.get(b[j - 1].d), q = nAt.get(b[j].d); if (p === undefined || q === undefined) continue;
            xs.push(Math.log(nc[q] / nc[p])); ys.push(lr[j]); } if (xs.length >= 100) { const mx = mean(xs), my = mean(ys); let cv = 0, vx = 0; for (let q = 0; q < xs.length; q += 1) { cv += (xs[q] - mx) * (ys[q] - my); vx += (xs[q] - mx) ** 2; } f.P23 = cv / vx; } else f.P23 = NaN; } else f.P23 = NaN; }
      // delivery
      { const dp = data.deliv.get(d)?.get(st.sym); f.D1 = fin(dp) ? dp : NaN; const hist = []; for (let q = 1; q <= 60; q += 1) { const pd = prevDate(d, q); const v = pd ? data.deliv.get(pd)?.get(st.sym) : undefined; if (fin(v)) hist.push(v); }
        f.D2 = fin(dp) && hist.length >= 30 ? (dp - mean(hist)) / (sdv(hist) || NaN) : NaN; }
      // futures
      { const fk = futAt.get(d); const back = (m) => (fk !== undefined && fk >= m ? data.fut.get(futDates[fk - m])?.get(st.sym) : undefined);
        const p1 = back(1), p5 = back(5); f.F1 = p1?.oi > 0 ? fr.oi / p1.oi - 1 : NaN; f.F2 = p5?.oi > 0 ? fr.oi / p5.oi - 1 : NaN;
        f.F3 = fr.near && fr.near.close > 0 && days(d, fr.near.exp) >= 1 ? (fr.near.close / c - 1) * 365 / days(d, fr.near.exp) : NaN;
        const h = []; for (let m = 0; m < 60; m += 1) { const r = back(m); if (r?.contracts > 0) h.push(r.contracts); } f.F4 = fr.contracts > 0 && h.length >= 30 ? Math.log(fr.contracts / median(h)) : NaN; }
      // options
      { const pcr = (dd) => { const a = dd ? data.opt.get(dd)?.get(st.sym) : undefined; return a && a[0] > 0 ? a[1] / a[0] : NaN; };
        f.O1 = pcr(d); const p5 = pcr(prevDate(d, 5)); f.O2 = fin(f.O1) && fin(p5) ? f.O1 - p5 : NaN; }
      // short selling
      { const m = data.short.get(d); f.X1 = m && b[k].qty > 0 ? (m.get(st.sym) || 0) / b[k].qty : NaN; }
      // SLB open positions and fee
      { const sk = slbAt.get(d); const q = sk !== undefined ? (data.slb.get(d).get(st.sym) || 0) : NaN;
        if (sk !== undefined) { const h = []; for (let m = 1; m <= 20 && sk - m >= 0; m += 1) h.push(data.slb.get(slbDates[sk - m]).get(st.sym) || 0); const a = h.length >= 10 ? mean(h) : NaN; f.L1 = a > 0 ? q / a : NaN; }
        else f.L1 = NaN;
        f.L2 = fin(q) && b[k].qty > 0 ? q / b[k].qty : NaN; const fe = data.fee.get(d)?.get(st.sym); f.L3 = fin(fe) ? fe : NaN; }
      // MWPL
      { const u = data.mwpl.get(d)?.get(st.sym); const pd = prevDate(d, 5); const u5 = pd ? data.mwpl.get(pd)?.get(st.sym) : undefined; f.W1 = fin(u) ? u : NaN; f.W2 = fin(u) && fin(u5) ? u - u5 : NaN; }
      // margin trading
      { const mk = mtfAt.get(d); const q = mk !== undefined ? data.mtf.get(d).get(st.sym) : undefined; const q5 = mk !== undefined && mk >= 5 ? data.mtf.get(mtfDates[mk - 5]).get(st.sym) : undefined;
        f.M1 = q5 > 0 && fin(q) ? q / q5 - 1 : NaN; const a = win(20, (x) => x.qty); f.M2 = fin(q) && Array.isArray(a) && mean(a) > 0 ? q / mean(a) : NaN; }
      { const [x1, x2, x3] = insider(st.sym, d); f.I1 = x1; f.I2 = x2; f.I3 = x3; }
      // label inputs: open(e) -> close(e + 4 sessions)
      const w = ctx.window(st.sym, e, 5); let ret = NaN, x = "", oe = NaN, cx = NaN;
      if (w && w.complete) { const bb = w.st.bars; oe = bb[w.i].o; cx = bb[w.i + 4].c; x = bb[w.i + 4].d; ret = cx / oe - 1; }
      rows.push({ d, i, e, x, sym: st.sym, oe, cx, ret, f });
      if (raw) raw.set(`${d}|${st.sym}`, STOCK_F.map((q) => f[q]));
    }
  }
  // ---- per date: target, ranks, market features
  const byD = new Map(); for (const r of rows) { if (!byD.has(r.d)) byD.set(r.d, []); byD.get(r.d).push(r); }
  const pctRank = (list, get, set) => { const v = list.filter((r) => fin(get(r))).sort((a, b) => get(a) - get(b)); const n = v.length; let j = 0;
    while (j < n) { let q = j; while (q + 1 < n && get(v[q + 1]) === get(v[j])) q += 1; const pr = ((j + q) / 2 + 0.5) / n; for (let t = j; t <= q; t += 1) set(v[t], pr); j = q + 1; }
    for (const r of list) if (!fin(get(r))) set(r, NaN); };
  for (const [d, list] of byD) {
    const ok = list.filter((r) => fin(r.ret)); const m = ok.length >= 20 ? mean(ok.map((r) => r.ret)) : NaN;
    for (const r of list) r.y = fin(r.ret) && fin(m) ? r.ret - m : NaN;
    pctRank(list, (r) => r.y, (r, v) => { r.label = fin(v) ? v - 0.5 : NaN; });
    for (const q of STOCK_F) pctRank(list, (r) => r.f[q], (r, v) => { r.f[q] = v; });
    for (const q of MARKET_F) { const v = M[q].get(d); for (const r of list) r.f[q] = fin(v) ? v : NaN; }
  }
  rows.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.sym < b.sym ? -1 : 1));
  return { rows, raw };
}

const COLS = ["d", "i", "e", "x", "sym", "oe", "cx", "ret", "y", "label", ...STOCK_F, ...MARKET_F];
const num = (v) => (fin(v) ? +v.toPrecision(7) : "");
function writePanel(file, rows) { const fd = fs.openSync(file, "w"); fs.writeSync(fd, COLS.join(",") + "\n");
  let buf = []; for (const r of rows) { buf.push([r.d, r.i, r.e, r.x, r.sym, num(r.oe), num(r.cx), num(r.ret), num(r.y), num(r.label), ...STOCK_F.map((q) => num(r.f[q])), ...MARKET_F.map((q) => num(r.f[q]))].join(","));
    if (buf.length >= 5000) { fs.writeSync(fd, buf.join("\n") + "\n"); buf = []; } }
  if (buf.length) fs.writeSync(fd, buf.join("\n") + "\n"); fs.closeSync(fd); }

// ---- loaders (formats as studies nse-data-atlas, loan-fee, orderflow, families)
function unzipFirst(buf) { let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("not a zip"); const cd = buf.readUInt32LE(e + 16); const method = buf.readUInt16LE(cd + 10), size = buf.readUInt32LE(cd + 20), local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28); const dd = buf.subarray(start, start + size); return method === 0 ? dd : zlib.inflateRawSync(dd); }
const csvRows = (t) => String(t).split(/\r?\n/).filter(Boolean).map((l) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, "\"").trim()));
const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const isoOf = (s) => { let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/.exec(String(s).trim()); if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${MON[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}`;
  m = /^(\d{2})-(\d{2})-(\d{4})/.exec(String(s).trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

function loadReal() {
  const CM = path.resolve(process.env.K2_CM_DIR || path.join(ROOT, "nse-data", "cm"));
  const RS = path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research"));
  const AT = path.join(RS, "nse-atlas");
  const files = fs.readdirSync(CM).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); const sessions = files.map((f) => f.slice(0, 10)); const bySym = new Map();
  for (const f of files) { const d = f.slice(0, 10); for (const r of JSON.parse(fs.readFileSync(path.join(CM, f), "utf8"))) { const [, sym, series, o, h, l, c, , qty, val] = r;
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue; if (!bySym.has(sym)) bySym.set(sym, { sym, bars: [] }); bySym.get(sym).bars.push({ d, o, h, l, c, val, qty }); } }
  const stocks = [...bySym.values()];
  // only the symbols that are ever in the universe are kept from the other files (memory)
  const ctx = context({ sessions, stocks }); const keep = new Set(); for (const d of sessions) for (const s of ctx.uni(d.slice(0, 7))) keep.add(s);
  const closeOn = new Map(stocks.filter((s) => keep.has(s.sym)).map((st) => [st.sym, new Map(st.bars.map((b) => [b.d, b.c]))]));
  const each = (dir, ext, fn) => { if (!fs.existsSync(dir)) return 0; let n = 0;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(`.${ext}`) && /^\d{4}-\d{2}-\d{2}/.test(x)).sort()) { try { fn(f.slice(0, 10), fs.readFileSync(path.join(dir, f))); n += 1; } catch { /* unreadable: missing */ } } return n; };
  const fut = new Map(); each(path.join(RS, "orderflow-2026-10-03", "nse-fo", "fut"), "json", (d, b) => { const m = new Map();
    for (const r of JSON.parse(b.toString("utf8"))) { if (r[1] !== "STK" || !keep.has(r[0])) continue; const o = m.get(r[0]) || { oi: 0, contracts: 0, near: null };
      o.oi += +r[8] || 0; o.contracts += +r[10] || 0; if (r[2] > d && (!o.near || r[2] < o.near.exp)) o.near = { exp: r[2], close: +r[6] }; m.set(r[0], o); } fut.set(d, m); });
  const ex = path.join(RS, "families-2026-10-04", "nse-extra");
  const deliv = new Map(); each(path.join(ex, "deliv"), "json", (d, b) => { const o = JSON.parse(b.toString("utf8")); const m = new Map(); for (const s of keep) if (o[s]) m.set(s, +o[s][2]); deliv.set(d, m); });
  const opt = new Map(); each(path.join(ex, "opt"), "json", (d, b) => { const o = JSON.parse(b.toString("utf8")).oi || {}; const m = new Map(); for (const s of keep) if (o[s]) m.set(s, [+o[s][0], +o[s][1]]); opt.set(d, m); });
  const short = new Map(); each(path.join(AT, "shortselling"), "csv", (_, b) => { for (const r of csvRows(b.toString("utf8")).slice(1)) { const td = isoOf(r[2]); if (!td || !keep.has(r[1])) continue;
      if (!short.has(td)) short.set(td, new Map()); const m = short.get(td); m.set(r[1], (m.get(r[1]) || 0) + (+r[3] || 0)); } });
  // a short-selling file with no row for a date still says "no short sales reported" only for the dates it covers
  each(path.join(AT, "shortselling"), "csv", (d) => { if (!short.has(d)) short.set(d, new Map()); });
  const slb = new Map(); each(path.join(AT, "slb_openpos"), "csv", (d, b) => { const m = new Map(); for (const r of csvRows(b.toString("utf8")).slice(1)) if (r[1] && keep.has(r[1])) m.set(r[1], (m.get(r[1]) || 0) + (+r[3] || 0)); slb.set(d, m); });
  const fee = new Map(); each(path.join(AT, "slbm_bc"), "dat", (d, b) => { const by = new Map();
    for (const line of b.toString("utf8").split(/\r?\n/)) { const r = line.split(","); if (r.length < 17) continue; const sym = r[1].trim(); if (!keep.has(sym)) continue; const end = isoOf(r[3]); const qty = +r[11], value = +r[12];
      if (!(qty > 0) || !end || days(d, end) < 7) continue; const P = closeOn.get(sym)?.get(d); if (!(P > 0)) continue; const rate = (value / qty) / P * 365 / days(d, end);
      const o = by.get(sym) || { w: 0, q: 0 }; o.w += rate * qty; o.q += qty; by.set(sym, o); }
    const m = new Map(); for (const [s, o] of by) m.set(s, o.w / o.q); fee.set(d, m); });
  const mwpl = new Map(); each(path.join(AT, "combineoi"), "zip", (d, b) => { const rows = csvRows(unzipFirst(b).toString("utf8")); const h = rows[0].map((x) => x.trim()); const iS = h.indexOf("NSE Symbol"), iM = h.indexOf("MWPL"), iF = h.indexOf("Future Equivalent Open Interest");
    const m = new Map(); for (const r of rows.slice(1)) { const Mw = +r[iM], F = +r[iF]; if (r[iS] && keep.has(r[iS]) && Mw > 0 && F >= 0) m.set(r[iS], F / Mw); } mwpl.set(d, m); });
  const mtf = new Map(); each(path.join(AT, "mrg_trading"), "zip", (d, b) => { const rows = csvRows(unzipFirst(b).toString("latin1")); const hi = rows.findIndex((r) => /^symbol$/i.test(r[0] || "") && /qty fin/i.test(r[2] || ""));
    if (hi < 0) return; const m = new Map(); for (const r of rows.slice(hi + 1)) { const q = +String(r[2] || "").replace(/,/g, ""); if (r[0] && keep.has(r[0]) && fin(q)) m.set(r[0], q); } if (m.size) mtf.set(d, m); });
  const pit = []; const pitMonths = new Set(); const pdir = path.join(AT, "pit");
  if (fs.existsSync(pdir)) for (const f of fs.readdirSync(pdir).filter((x) => /^\d{4}-\d{2}\.json$/.test(x))) { const a = JSON.parse(fs.readFileSync(path.join(pdir, f), "utf8")); if (a.length) pitMonths.add(f.slice(0, 7));
    for (const r of a) { const d = isoOf(String(r.date || "")); if (!d || !r.symbol || !keep.has(r.symbol)) continue; pit.push({ sym: r.symbol, d, cat: String(r.personCategory || ""), mode: String(r.acqMode || ""), type: String(r.tdpTransactionType || ""), value: +r.secVal || 0 }); } }
  const nifty = new Map(), vix = new Map(); each(path.join(AT, "ind_close_all"), "csv", (d, b) => { const rows = csvRows(b.toString("utf8")); const h = rows[0];
    const r = rows.find((x) => x[0] === "Nifty 50"); if (r) { const c = (nm) => +r[h.indexOf(nm)]; nifty.set(d, { o: c("Open Index Value"), c: c("Closing Index Value"), pe: c("P/E") }); }
    const v = rows.find((x) => x[0] === "India VIX"); if (v && +v[h.indexOf("Closing Index Value")] > 0) vix.set(d, +v[h.indexOf("Closing Index Value")]); });
  const part = new Map(); each(path.join(AT, "part_vol"), "csv", (d, b) => { const rows = csvRows(b.toString("utf8")); const hi = rows.findIndex((x) => x[0] === "Client Type"); if (hi < 0) return; const h = rows[hi];
    const c = (r, nm) => +r[h.findIndex((x) => x.replace(/\s+/g, " ").trim() === nm)]; const o = {};
    for (const r of rows.slice(hi + 1)) { const k = r[0].toUpperCase(); if (!["FII", "PRO", "CLIENT", "DII"].includes(k)) continue;
      o[k] = { fil: c(r, "Future Index Long"), fis: c(r, "Future Index Short"), cl: c(r, "Option Index Call Long"), cs: c(r, "Option Index Call Short"), pl: c(r, "Option Index Put Long"), ps: c(r, "Option Index Put Short") }; }
    part.set(d, o); });
  let X = null; try { X = require(process.env.K2_XLSX || "xlsx"); } catch { X = null; }
  if (!X) { console.error("cm_cat_turnover needs the xlsx package: npm i --no-save xlsx@0.18.5 (or K2_XLSX=<path>)"); process.exit(3); }
  const cat = new Map(); each(path.join(AT, "cm_cat_turnover"), "xls", (d, b) => { const wb = X.read(b, { type: "buffer" }); const rows = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    const o = {}; for (const r of rows) { const name = String(r[1] || "").trim().toUpperCase(); const buy = +r[2], sell = +r[3]; if (!fin(buy) || !fin(sell)) continue;
      if (name === "FPI") o.FPI = { buy, sell }; else if (name === "MUTUAL FUNDS") o.MF = { buy, sell }; else if (name === "RETAIL") o.RETAIL = { buy, sell }; }
    if (Object.keys(o).length) cat.set(d, o); });
  return { sessions, stocks, fut, deliv, opt, short, slb, fee, mwpl, mtf, pit, pitMonths, nifty, vix, part, cat };
}

// ---- synthetic market (checks 7.1-7.3 only). plant: names with an SLB surge (qty 3x) fall 0.8% over the 5 sessions from entry
function synth(seed, plant) {
  let s = seed >>> 0; const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sessions = []; for (let t = Date.parse("2020-09-01"); sessions.length < 1500; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const NS = 120, n = sessions.length; const stocks = []; const surge = [];
  const slb = new Map(sessions.map((d) => [d, new Map()])), fut = new Map(sessions.map((d) => [d, new Map()])), deliv = new Map(sessions.map((d) => [d, new Map()]));
  const opt = new Map(sessions.map((d) => [d, new Map()])), short = new Map(sessions.map((d) => [d, new Map()])), fee = new Map(sessions.map((d) => [d, new Map()]));
  const mwpl = new Map(sessions.map((d) => [d, new Map()])), mtf = new Map(sessions.map((d) => [d, new Map()]));
  // surges (amendment A1): a fixed 10% of names (12 of 120) each session, none surging twice within 6 sessions
  const SG = Array.from({ length: NS }, () => new Array(n).fill(false)); const surgeSet = new Set();
  for (let i = 0; i < n; i += 1) { const ok = []; for (let k = 0; k < NS; k += 1) if (!SG[k].slice(Math.max(0, i - 6), i).some(Boolean)) ok.push(k);
    for (let q = 0; q < 12 && ok.length; q += 1) { const j = Math.floor(rnd() * ok.length); SG[ok[j]][i] = true; surgeSet.add(`${sessions[i]}|S${String(ok[j]).padStart(3, "0")}`); ok.splice(j, 1); } }
  for (let k = 0; k < NS; k += 1) { const sym = `S${String(k).padStart(3, "0")}`; const sg = SG[k]; surge.push(sg);
    const bars = []; let p = 100 * Math.exp(gauss() * 0.3); const base = 1e6 * (0.5 + rnd()); const vol = 1e6 * (1 + 3 * rnd());
    for (let i = 0; i < n; i += 1) { const d = sessions[i]; const hit = plant && [2, 3, 4, 5, 6].some((g) => i - g >= 0 && sg[i - g]);
      const o = p * (1 + 0.003 * gauss()); const c = o * (1 + (hit ? -0.008 / 5 : 0) + 0.01 * gauss()); const h = Math.max(o, c) * (1 + 0.004 * rnd()), l = Math.min(o, c) * (1 - 0.004 * rnd());
      const qty = vol * Math.exp(0.3 * gauss()); bars.push({ d, o, h, l, c, val: qty * c, qty }); p = c;
      slb.get(d).set(sym, (sg[i] ? 3 : 1) * base * (0.9 + 0.2 * rnd())); fut.get(d).set(sym, { oi: 1e7 * (1 + 0.1 * gauss()), contracts: 1000 * Math.exp(0.3 * gauss()), near: { exp: sessions[Math.min(n - 1, i + 15)], close: c * (1 + 0.002 * gauss()) } });
      deliv.get(d).set(sym, 30 + 30 * rnd()); opt.get(d).set(sym, [1e6 * (1 + rnd()), 1e6 * (1 + rnd())]); short.get(d).set(sym, qty * 0.01 * rnd()); fee.get(d).set(sym, 0.01 + 0.05 * rnd());
      mwpl.get(d).set(sym, 0.2 + 0.5 * rnd()); mtf.get(d).set(sym, 1e5 * (1 + rnd())); }
    stocks.push({ sym, bars }); }
  const nifty = new Map(), vix = new Map(), part = new Map(), cat = new Map(); let lv = 10000;
  for (const d of sessions) { lv *= 1 + 0.008 * gauss(); nifty.set(d, { o: lv, c: lv * (1 + 0.004 * gauss()), pe: 20 + 3 * rnd() }); vix.set(d, 15 + 3 * rnd());
    const pr = () => ({ fil: 1e5 * rnd(), fis: 1e5 * rnd(), cl: 1e5 * rnd(), cs: 1e5 * rnd(), pl: 1e5 * rnd(), ps: 1e5 * rnd() }); part.set(d, { FII: pr(), PRO: pr(), CLIENT: pr(), DII: pr() });
    const bs = () => ({ buy: 1e4 * rnd(), sell: 1e4 * rnd() }); cat.set(d, { FPI: bs(), MF: bs(), RETAIL: bs() }); }
  return { sessions, stocks, fut, deliv, opt, short, slb, fee, mwpl, mtf, pit: [], pitMonths: new Set(), nifty, vix, part, cat, surgeSet };
}

module.exports = { build, loadReal, synth, writePanel, STOCK_F, MARKET_F, COLS };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes("--coverage")) {
    const data = loadReal(); const { rows } = build(data); const yr = new Map();
    for (const r of rows) { const y = r.d.slice(0, 4); if (!yr.has(y)) yr.set(y, { rows: 0, days: new Set(), nn: {} }); const o = yr.get(y); o.rows += 1; o.days.add(r.d);
      for (const q of [...STOCK_F, ...MARKET_F]) o.nn[q] = (o.nn[q] || 0) + (fin(r.f[q]) ? 1 : 0); }
    console.log(`CM sessions ${data.sessions.length} (${data.sessions[0]} .. ${data.sessions.at(-1)}); rows ${rows.length}`);
    for (const [y, o] of [...yr].sort()) console.log(`${y}: ${o.rows} rows, ${o.days.size} days, ${(o.rows / o.days.size).toFixed(0)} names/day | non-missing %: ` + [...STOCK_F, ...MARKET_F].map((q) => `${q} ${Math.round(100 * o.nn[q] / o.rows)}`).join(" "));
    process.exit(0);
  }
  const out = a[0]; if (!out) { console.error("usage: node features.js <out.csv> [--synthetic <seed> [--plant]] | --coverage"); process.exit(1); }
  const si = a.indexOf("--synthetic"); const data = si >= 0 ? synth(+a[si + 1] || 1, a.includes("--plant")) : loadReal();
  const t = Date.now(); const { rows } = build(data); writePanel(out, rows);
  if (data.surgeSet) { const a = rows.filter((r) => Number.isFinite(r.y)); const sg = a.filter((r) => data.surgeSet.has(`${r.d}|${r.sym}`)), ot = a.filter((r) => !data.surgeSet.has(`${r.d}|${r.sym}`));
    const m = (x) => x.reduce((p, r) => p + r.y, 0) / x.length; console.log(`planted effect measured in the panel: surge names ${(100 * m(sg)).toFixed(3)}% vs others ${(100 * m(ot)).toFixed(3)}% (difference ${(100 * (m(sg) - m(ot))).toFixed(3)}%, ${sg.length} surge rows)`); }
  console.log(`features: ${rows.length} rows, ${new Set(rows.map((r) => r.d)).size} dates -> ${out} (${((Date.now() - t) / 1000).toFixed(0)} s)`);
}
