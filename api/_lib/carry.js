// Carry: the return a position earns from time passing rather than from the
// price moving.
//
// Koijen, Moskowitz, Pedersen and Vrugt (JFE 2018) show carry predicts returns in
// both the cross section and the time series across global equities, bonds,
// currencies, commodities, Treasuries, credit and index options — one of the few
// signals with that breadth, and the reason it belongs in a book that may later
// trade something other than NSE futures.
//
// For a stock future the carry is the basis: the gap between the futures price
// and spot, which must close by expiry. A future trading above spot bleeds that
// premium away as expiry approaches, which costs a long and pays a short. It is
// free information here because GM already reports the contract price and the
// spot is a public quote.

const DAY_MS = 86_400_000;

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function sessionsBetween(fromMs, toMs) {
  // Calendar days decay the basis, but only trading days carry price risk, so
  // both are reported and the caller picks.
  const calendarDays = Math.max(0, Math.round((toMs - fromMs) / DAY_MS));
  let sessions = 0;
  for (let day = 1; day <= calendarDays; day += 1) {
    const weekday = new Date(fromMs + day * DAY_MS).getUTCDay();
    if (weekday !== 0 && weekday !== 6) sessions += 1;
  }
  return { calendarDays, sessions };
}

// `futures` is the contract price, `spot` the underlying cash price, `expiry` an
// ISO date. `side` decides who pays: convergence moves the futures toward spot.
function carry({ futures, spot, expiry, side = "long", nowMs = Date.now() }) {
  const contract = Number(futures);
  const cash = Number(spot);
  const expiryMs = Date.parse(`${expiry}T10:00:00Z`);
  if (!(contract > 0) || !(cash > 0) || !Number.isFinite(expiryMs)) {
    return { ready: false, reason: "Need a futures price, a spot price and an expiry" };
  }
  const { calendarDays, sessions } = sessionsBetween(nowMs, expiryMs);
  if (calendarDays <= 0) return { ready: false, reason: "The contract has expired" };

  const basisPct = (contract / cash - 1) * 100;
  // Convergence pays the short when the future is rich and pays the long when it
  // is cheap, so the long's carry is the negative of the basis.
  const direction = side === "short" ? 1 : -1;
  const toExpiryPct = direction * basisPct;
  const annualisedPct = toExpiryPct * (365 / calendarDays);
  // What accrues over one weekly cycle, capped at what is left to expiry.
  const weekFraction = Math.min(calendarDays, 7) / calendarDays;

  return {
    ready: true,
    side,
    futures: round(contract, 2),
    spot: round(cash, 2),
    expiry,
    calendarDays,
    sessions,
    basisPct: round(basisPct, 3),
    // Positive means time is working for the position.
    toExpiryPct: round(toExpiryPct, 3),
    weeklyPct: round(toExpiryPct * weekFraction, 3),
    annualisedPct: round(annualisedPct, 2),
    state: basisPct > 0.05 ? "premium" : basisPct < -0.05 ? "discount" : "flat",
    favourable: toExpiryPct > 0
  };
}

// Score in [0, 1] for the conviction blend. A weekly ladder targets 2%, so carry
// worth a tenth of that over the week is already meaningful; the scale is set
// against the target rather than against an annualised number, which would make
// every short-dated contract look enormous.
function carryScore(result, targetPct = 2) {
  if (!result?.ready) return 0;
  const ratio = Number(result.weeklyPct) / (Number(targetPct) * 0.1);
  return Math.max(0, Math.min(1, (ratio + 1) / 2));
}

module.exports = { carry, carryScore, sessionsBetween };
