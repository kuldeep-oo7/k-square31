const { mutatePortfolio } = require("./store");
const { cleanPortfolio, replaceBrokerSnapshot } = require("./portfolio-model");

const MAX_POSITIONS = 250;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const PAST_TOLERANCE_MS = 24 * 60 * 60 * 1000;

function snapshotError(message) {
  const error = new Error(message);
  error.code = "SNAPSHOT";
  return error;
}

// Every GM snapshot replaces the whole futures book, so a partially read page
// would silently close positions. The broker reports its own record count,
// signed quantity and MTM totals; a snapshot is only trusted when the rows we
// parsed reconcile against all three.
function measureSnapshot(snapshot) {
  const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
  const snapshotId = String(snapshot?.snapshotId || "");
  const capturedAt = Date.parse(snapshot?.capturedAt || "");
  const recordCount = Number(snapshot?.recordCount);
  const totalQuantity = Number(snapshot?.totalQuantity);
  const totalMtm = Number(snapshot?.totalMtm);
  const signedQuantity = positions.reduce((sum, item) => sum + (item.position === "short" ? -1 : 1) * Number(item.quantity || 0), 0);
  const totalAbsoluteQuantity = positions.reduce((sum, item) => sum + Math.abs(Number(item.quantity || 0)), 0);
  const summedMtm = positions.reduce((sum, item) => sum + Number(item.mtm || 0), 0);
  const verifiedComplete = Number.isInteger(recordCount)
    && recordCount === positions.length
    && Number.isFinite(totalQuantity)
    && Math.abs(signedQuantity - totalQuantity) < .01
    && Number.isFinite(totalMtm)
    && Math.abs(summedMtm - totalMtm) < Math.max(1, positions.length * .05);
  const trusted = /^[a-f0-9]{64}$/.test(snapshotId)
    && positions.length <= MAX_POSITIONS
    && Number.isFinite(capturedAt)
    && capturedAt <= Date.now() + FUTURE_TOLERANCE_MS
    && capturedAt >= Date.now() - PAST_TOLERANCE_MS
    && verifiedComplete;
  return { positions, snapshotId, capturedAt, totalQuantity, totalAbsoluteQuantity, totalMtm, verifiedComplete, trusted };
}

// Shared by the /api/gm-sync bridge endpoint and the scheduled cloud sync, which
// writes to the operational store directly so a paused web host cannot stop the
// portfolio from tracking GM.
async function applyBrokerSnapshot(username, snapshot, { source, deviceId }) {
  const measured = measureSnapshot(snapshot);
  if (!measured.trusted) throw snapshotError("GM snapshot failed completeness, quantity or MTM validation");

  let ignoredStale = false;
  const updated = await mutatePortfolio(username, (portfolio) => {
    const previousCapture = Date.parse(portfolio?.brokerSync?.capturedAt || "");
    if (Number.isFinite(previousCapture) && previousCapture > measured.capturedAt) {
      ignoredStale = true;
      return cleanPortfolio(portfolio);
    }
    return replaceBrokerSnapshot(portfolio, measured.positions, measured.snapshotId, undefined, {
      capturedAt: new Date(measured.capturedAt).toISOString(),
      source,
      deviceId,
      totalQuantity: measured.totalQuantity,
      totalAbsoluteQuantity: measured.totalAbsoluteQuantity,
      totalMtm: measured.totalMtm,
      verifiedComplete: measured.verifiedComplete
    });
  });
  const clean = cleanPortfolio(updated);
  return {
    positions: clean.lots.length,
    updatedAt: clean.updatedAt,
    snapshotId: clean.brokerSync?.snapshotId || measured.snapshotId,
    capturedAt: clean.brokerSync?.capturedAt || new Date(measured.capturedAt).toISOString(),
    totalMtm: measured.totalMtm,
    ignoredStale
  };
}

module.exports = { MAX_POSITIONS, applyBrokerSnapshot, measureSnapshot };
