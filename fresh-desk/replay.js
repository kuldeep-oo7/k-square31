"use strict";
// Conservative OHLC evaluation utility. It does not claim executable fills or a
// historical strategy result. Real-data promotion needs a registered study.
const { finite } = require("./analysis");
const { clock } = require("./engine");
function replayTrade(plan, bars, { entryAt, maxBars = 100, costPerUnit = null } = {}) {
  if (!finite(clock(entryAt)) || !Number.isInteger(maxBars) || maxBars < 1 || (costPerUnit !== null && (!finite(costPerUnit) || costPerUnit < 0))) throw Error("INVALID_REPLAY_OPTIONS");
  const sign = plan.side === "BUY" ? 1 : -1; let held = 0, previousAt = -Infinity;
  for (const b of bars) {
    const at = clock(b.at); if (!finite(at) || at <= previousAt) throw Error("REPLAY_ORDER_OR_TIMESTAMP_INVALID"); previousAt = at;
    if (at < clock(entryAt)) continue;
    if (![b.open, b.high, b.low, b.close].every((v) => finite(v) && v > 0) || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)) throw Error("INVALID_REPLAY_CANDLE");
    held++;
    const stop = sign > 0 ? b.low <= plan.stop : b.high >= plan.stop, target = sign > 0 ? b.high >= plan.target : b.low <= plan.target;
    let price = null, reason = null;
    if (sign * (b.open - plan.stop) <= 0) { price = b.open; reason = "GAP_STOP"; }
    else if (sign * (b.open - plan.target) >= 0) { price = plan.target; reason = "TARGET"; }
    else if (stop) { price = plan.stop; reason = target ? "AMBIGUOUS_STOP_FIRST" : "STOP"; }
    else if (target) { price = plan.target; reason = "TARGET"; }
    else if (held >= maxBars) { price = b.close; reason = "TIME_LIMIT"; }
    if (price !== null) {
      const grossPerUnit = sign * (price - plan.entry);
      return { status: "CLOSED", reason, price, at: b.at, barsHeld: held, grossPerUnit,
        netPerUnit: costPerUnit === null ? null : grossPerUnit - costPerUnit, execution: "HYPOTHETICAL_OHLC_NOT_REAL_FILL" };
    }
  }
  return { status: "CENSORED", barsHeld: held, reason: "NO_VERIFIED_EXIT_IN_AVAILABLE_BARS" };
}
module.exports = { replayTrade };
