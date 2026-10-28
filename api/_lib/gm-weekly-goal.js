"use strict";

// Price-return arithmetic for the friends' GM futures competition. This is a
// goal and an outcome measurement, not a stock-selection rule. No GM connection.
// Keep this module self-contained: the same functions run on the static desk.
function createGmWeeklyGoal(calendar = { holidays: [], coveredYears: [] }) {
  const TARGET_PCT = 3;
  const number = (v) => typeof v === "number" && Number.isFinite(v);
  const date = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  const cents = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
  const holidays = new Set(calendar.holidays), years = new Set(calendar.coveredYears);
  function isSession(d) {
    if (!years.has(d.slice(0, 4))) throw new Error("NSE holiday calendar does not cover this date.");
    const weekday = new Date(d).getUTCDay();
    return weekday !== 0 && weekday !== 6 && !holidays.has(d);
  }

  function plan({ entryPrice, side, quantity = 20, tickSize, entryDate, expiry, roundTripCostsInr = null, maxHoldingSessions = null } = {}) {
    if (!number(entryPrice) || entryPrice <= 0) throw new Error("Enter the actual futures fill price.");
    if (!["BUY", "SELL"].includes(side)) throw new Error("Choose BUY or SELL.");
    if (!number(quantity) || !Number.isSafeInteger(quantity) || quantity < 20) throw new Error("Enter at least 20 whole units.");
    if (!number(tickSize) || tickSize <= 0 || tickSize < 0.01
      || Math.abs(tickSize * 100 - Math.round(tickSize * 100)) > 1e-8) throw new Error("Enter the contract tick size, in whole paise.");
    if (!date(entryDate) || !date(expiry) || expiry < entryDate) throw new Error("Enter valid entry and contract expiry dates.");
    if (!isSession(entryDate)) throw new Error("Entry date must be an NSE trading session.");
    if (maxHoldingSessions !== null && (!Number.isInteger(maxHoldingSessions) || maxHoldingSessions < 1 || maxHoldingSessions > 20)) throw new Error("Holding limit must be 1 to 20 sessions.");
    if (roundTripCostsInr !== null && (!number(roundTripCostsInr) || roundTripCostsInr < 0)) throw new Error("Costs must be a known nonnegative rupee amount, or blank.");
    const direction = side === "BUY" ? 1 : -1;
    const costPerUnit = roundTripCostsInr === null ? 0 : roundTripCostsInr / quantity;
    // Round OUTWARD: a target rounded towards entry can pay less than 3%.
    const raw = entryPrice * (1 + direction * TARGET_PCT / 100) + direction * costPerUnit;
    const steps = direction > 0 ? Math.ceil(raw / tickSize - 1e-9) : Math.floor(raw / tickSize + 1e-9);
    const targetPrice = cents(steps * tickSize);
    if (!(targetPrice > 0) || !Number.isFinite(targetPrice)) throw new Error("No positive target price is possible with these costs.");
    // Preserve v1's weekly policy on old records (null). V2 explicitly stores
    // its own session ceiling; every target/stop may exit on the entry day.
    const weekEnd = new Date(Date.parse(entryDate) + 6 * 864e5).toISOString().slice(0, 10);
    let ceiling = weekEnd;
    if (maxHoldingSessions !== null) {
      ceiling = entryDate; let sessions = 1;
      while (sessions < maxHoldingSessions && ceiling < expiry) {
        ceiling = new Date(Date.parse(ceiling) + 864e5).toISOString().slice(0, 10);
        if (isSession(ceiling)) sessions++;
      }
    }
    let deadline = expiry < ceiling ? expiry : ceiling;
    while (!isSession(deadline)) deadline = new Date(Date.parse(deadline) - 864e5).toISOString().slice(0, 10);
    const grossPnlInr = direction * (targetPrice - entryPrice) * quantity;
    if (![grossPnlInr, entryPrice * quantity].every(Number.isFinite)) throw new Error("Position value is too large.");
    return { targetPct: TARGET_PCT, entryPrice, side, quantity, tickSize, entryDate, expiry, deadline, targetPrice, maxHoldingSessions,
      basis: roundTripCostsInr === null ? "BEFORE_GM_COSTS" : "AFTER_SUPPLIED_GM_COSTS",
      roundTripCostsInr, grossPnlInr: cents(grossPnlInr),
      netPnlInr: roundTripCostsInr === null ? null : cents(grossPnlInr - roundTripCostsInr),
      targetReturnPct: 100 * (grossPnlInr - (roundTripCostsInr ?? 0)) / (entryPrice * quantity) };
  }

  function result(goal, { exitPrice, exitDate, roundTripCostsInr = null } = {}) {
    // Revalidate a loaded goal instead of trusting saved or browser input.
    const p = plan(goal);
    if (!number(exitPrice) || exitPrice <= 0 || !date(exitDate) || exitDate < p.entryDate) throw new Error("Enter a valid exit fill and date.");
    if (!isSession(exitDate)) throw new Error("Exit date must be an NSE trading session.");
    if (exitDate > p.expiry) throw new Error("The exit belongs after this contract's expiry.");
    if (roundTripCostsInr !== null && (!number(roundTripCostsInr) || roundTripCostsInr < 0)) throw new Error("Enter actual nonnegative costs, or leave them unknown.");
    const gross = (p.side === "BUY" ? 1 : -1) * (exitPrice - p.entryPrice) * p.quantity;
    const grossPct = 100 * gross / (p.entryPrice * p.quantity);
    const netPct = roundTripCostsInr === null ? null : 100 * (gross - roundTripCostsInr) / (p.entryPrice * p.quantity);
    return { grossPnlInr: cents(gross), netPnlInr: netPct === null ? null : cents(gross - roundTripCostsInr),
      grossReturnPct: grossPct, netReturnPct: netPct, withinWeek: exitDate <= new Date(Date.parse(p.entryDate) + 6 * 864e5).toISOString().slice(0, 10), withinHoldingPeriod: exitDate <= p.deadline,
      grossGoalMet: exitDate <= p.deadline && grossPct >= TARGET_PCT - 1e-9,
      netGoalMet: netPct === null ? null : exitDate <= p.deadline && netPct >= TARGET_PCT - 1e-9 };
  }
  return { TARGET_PCT, plan, result };
}

const { NSE_HOLIDAYS, COVERED_YEARS } = require("./nse-holidays");
const CALENDAR = { holidays: [...NSE_HOLIDAYS.keys()], coveredYears: [...COVERED_YEARS] };
module.exports = { createGmWeeklyGoal, CALENDAR, ...createGmWeeklyGoal(CALENDAR) };
