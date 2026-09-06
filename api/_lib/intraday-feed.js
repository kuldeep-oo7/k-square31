"use strict";

/**
 * K-Square Range Desk - Intraday Bar & Microstructure Resolution Engine
 *
 * Replays sub-daily 1-minute or 5-minute bars to resolve exact chronological
 * execution order (eliminating ambiguity when daily bars span both target and stop).
 */

function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/**
 * Replays minute-level bars chronologically to identify the exact minute
 * when entry, stop, or target was touched.
 */
function resolveIntradayExecution({ orderIntent, minuteBars = [] }) {
  if (!orderIntent || !Array.isArray(minuteBars) || !minuteBars.length) {
    return {
      resolved: false,
      reason: "No minute bars available"
    };
  }

  const side = orderIntent.side === "short" ? "short" : "long";
  const entry = Number(orderIntent.entryPrice || orderIntent.entry);
  const target = Number(orderIntent.targetPrice || orderIntent.target);
  const stop = Number(orderIntent.stopLossPrice || orderIntent.stopLoss);

  let filled = false;
  let fillTime = null;
  let fillBarIndex = -1;
  let exitReason = null;
  let exitPrice = null;
  let exitTime = null;

  for (let i = 0; i < minuteBars.length; i += 1) {
    const bar = minuteBars[i];
    const high = Number(bar.high);
    const low = Number(bar.low);

    if (!filled) {
      const touchesEntry = side === "long" ? low <= entry : high >= entry;
      if (touchesEntry) {
        filled = true;
        fillTime = bar.timestamp || bar.time;
        fillBarIndex = i;
      }
      continue;
    }

    // Once filled, check stops and targets in exact chronological order
    if (side === "long") {
      if (low <= stop) {
        exitReason = "STOP_LOSS";
        exitPrice = stop;
        exitTime = bar.timestamp || bar.time;
        break;
      }
      if (high >= target) {
        exitReason = "TARGET_HIT";
        exitPrice = target;
        exitTime = bar.timestamp || bar.time;
        break;
      }
    } else {
      if (high >= stop) {
        exitReason = "STOP_LOSS";
        exitPrice = stop;
        exitTime = bar.timestamp || bar.time;
        break;
      }
      if (low <= target) {
        exitReason = "TARGET_HIT";
        exitPrice = target;
        exitTime = bar.timestamp || bar.time;
        break;
      }
    }
  }

  return {
    resolved: filled,
    fillTime,
    fillBarIndex,
    exitReason: exitReason || "OPEN",
    exitPrice: round(exitPrice),
    exitTime,
    intradayAmbiguityResolved: Boolean(exitReason)
  };
}

module.exports = {
  resolveIntradayExecution,
  round
};
