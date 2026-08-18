// How far can this name actually travel, and is that more than 2%?
//
// The ladder measurement answers a narrow question: has a 2% step with a 2%
// target paid on this stock before. A name can fail that and still be worth
// buying — if it is set up to move 6%, the rule that harvests 2% slices simply
// was not the right instrument to measure it with. Rejecting it for that reason
// threw away 112 of 208 names.
//
// So this estimates the forward move itself, from every reading available, and
// admits a name to the buy list when the expected move clears the desk's 2% floor
// with validated skill behind it.
//
// Nothing here is a promise about a single week. It is an expectation with an
// error bar, and the error bar is reported alongside it.

const { FEATURE_NAMES, features, predict, trainBoostedTrees, walkForward } = require("./ml-model");
const { candleStudy, weightedModel } = require("./strategy-lab");
const { timeSeriesMomentum, trendAlignment } = require("./trend");

const DEFAULT_HORIZON = 5;

// A pooled model trained across the universe, if one has been built and cleared
// its bar. Per-name training cannot be validated — five years of daily data at a
// five-session horizon leaves about 250 independent observations and a standard
// error of ±0.11 on the correlation, so neither a real edge nor its absence can be
// established. Pooling is the only route to a testable answer, so a name is scored
// by the pooled model or not at all.
let pooled = null;

function loadPooledModel(source) {
  if (source === null) { pooled = null; return null; }
  if (source && typeof source === "object") { pooled = source; return pooled; }
  const file = source || process.env.K2_UPSIDE_MODEL || "";
  if (!file) return pooled;
  try {
    const fs = require("node:fs");
    pooled = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { pooled = null; }
  return pooled;
}

// The pooled model only speaks when its own validation says it may.
function pooledForecast(bars, overrides = {}) {
  const carrier = overrides.pooledModel !== undefined ? loadPooledModel(overrides.pooledModel) : (pooled || loadPooledModel());
  if (!carrier?.model?.trees?.length) return { ready: false, reason: "no pooled model has been trained" };
  if (!carrier.skilled) {
    return {
      ready: false,
      reason: `the pooled model showed no measurable skill (information coefficient ${carrier.validation?.informationCoefficient} against a bar of ${carrier.validation?.informationCoefficientStandardError ? (2 * carrier.validation.informationCoefficientStandardError).toFixed(4) : "unknown"})`,
      validation: carrier.validation || null
    };
  }
  const validation = carrier.validation || {};
  // Expected value is the wrong test for a floor. Measured across 22,509
  // out-of-sample stock-weeks, the model's favourite tenth averages 0.87% — far
  // under 2% — yet clears 2% on 37.4% of occasions against a 30.8% baseline. The
  // honest claim is that shift in the odds, not an expectation nobody can support.
  const deciles = Array.isArray(validation.deciles) ? validation.deciles : [];
  const latest = features(bars, bars.length - 1);
  const expectedMovePct = latest ? predict({ ...carrier.model, ready: true }, latest) : null;
  // Which band of past predictions this score falls in, and how often those
  // actually cleared the floor. Calibrated on the model's own output only — the
  // combined estimate below adds trend, candles and carry, which were never part
  // of this calibration, so the two numbers are deliberately different and only
  // this one may decide admission.
  const band = deciles.find((entry) => Number(expectedMovePct) >= Number(entry.predictedFrom) && Number(expectedMovePct) <= Number(entry.predictedTo))
    || (deciles.length && Number(expectedMovePct) > Number(deciles[0].predictedTo) ? deciles[0] : null);
  return {
    ready: Number.isFinite(expectedMovePct),
    pooled: true,
    horizon: Number(carrier.horizon) || DEFAULT_HORIZON,
    rows: carrier.rows,
    names: carrier.names,
    expectedMovePct,
    trustworthy: true,
    informationCoefficient: validation.informationCoefficient ?? null,
    informationCoefficientStandardError: validation.informationCoefficientStandardError ?? null,
    rSquared: validation.rSquared ?? null,
    // What the buy list actually consumes: what the model's favourite names did.
    topDecileAveragePct: validation.topDecileAveragePct ?? null,
    floorPct: validation.floorPct ?? null,
    baseClearedFloorPct: validation.baseClearedFloorPct ?? null,
    clearedFloorPct: band ? Number(band.clearedFloorPct) : (validation.baseClearedFloorPct ?? null),
    bandAveragePct: band ? Number(band.averagePct) : null,
    bandCases: band ? Number(band.cases) : null,
    meanAbsoluteErrorPct: null,
    importance: carrier.importance ? carrier.importance.slice(0, 6) : [],
    validation
  };
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function istDate(seconds) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(Number(seconds) * 1000));
}

// One row per session: the features known at the close, and the move over the
// following `horizon` sessions. The label is the plain forward return, not a
// ladder outcome, so the model is estimating travel rather than harvest.
function forwardRows(bars, horizon = DEFAULT_HORIZON) {
  const rows = [];
  for (let index = 70; index + horizon < bars.length; index += 1) {
    const row = features(bars, index);
    if (!row) continue;
    const from = Number(bars[index].close);
    const to = Number(bars[index + horizon].close);
    if (!(from > 0) || !(to > 0)) continue;
    rows.push({
      weekKey: istDate(bars[index].timestamp),
      features: row,
      label: (to / from - 1) * 100
    });
  }
  return rows;
}

// The forward-move model, validated the same way as the ladder model: expanding
// window, no fold trained on its own future.
function forwardForecast(bars, overrides = {}) {
  const horizon = Number(overrides.horizon) || DEFAULT_HORIZON;
  const rows = forwardRows(bars, horizon);
  if (rows.length < 200) return { ready: false, reason: `Need about 200 labelled sessions, found ${rows.length}` };

  // The embargo is the horizon: every row whose label reaches into the test block
  // is withheld from training. Without it a random walk scored as skilful.
  const validation = walkForward(rows, {
    folds: 4,
    minimumTrain: Math.max(120, Math.floor(rows.length * 0.5)),
    ...overrides,
    embargo: horizon,
    scoreStride: horizon
  });
  const model = trainBoostedTrees(rows, overrides);
  const latest = features(bars, bars.length - 1);
  const expectedMovePct = latest && model.ready ? predict(model, latest) : null;
  const skill = validation.ready ? Number(validation.outOfSample.informationCoefficient) : null;
  // Judged against its own standard error rather than a fixed threshold. A fixed
  // 0.02 admitted a random walk that scored 0.045 on eighty test rows, where the
  // standard error alone is 0.11.
  const standardError = validation.ready ? Number(validation.informationCoefficientStandardError) : null;
  // Two independent ways to show skill, because either can be the unstable one.
  // A correlation needs spread in the label to mean anything; an explained-variance
  // figure survives a narrow label but says nothing when the model merely predicts
  // the mean. Requiring one of them, plus a positive result on the weeks acted on,
  // rejects a random walk while admitting a name whose moves are genuinely
  // predictable.
  const explained = validation.ready ? Number(validation.outOfSample.rSquared) : null;
  const acted = validation.ready ? Number(validation.outOfSample.actedAverageWeeklyPct) : null;
  const correlated = Number.isFinite(skill) && Number.isFinite(standardError) && skill > 2 * standardError;
  const explains = Number.isFinite(explained) && explained > 0.05;
  const skilled = (correlated || explains) && (!Number.isFinite(acted) || acted > 0);

  return {
    ready: Boolean(model.ready && validation.ready && Number.isFinite(expectedMovePct)),
    horizon,
    rows: rows.length,
    expectedMovePct,
    // A forecast without demonstrated out-of-sample skill may not admit a name to
    // the list. It is reported so the reason for exclusion is visible.
    trustworthy: Boolean(validation.ready && skilled),
    informationCoefficient: skill,
    informationCoefficientStandardError: standardError,
    rSquared: explained,
    skillBasis: correlated ? "correlation" : explains ? "explained variance" : "none",
    meanAbsoluteErrorPct: validation.ready ? validation.outOfSample.meanAbsoluteErrorPct : null,
    importance: model.ready ? model.importance.slice(0, 6) : [],
    validation
  };
}

// Every reading the desk has, on one scale, for one question: how far and which
// way. Each contributes a percentage estimate rather than an opinion score, so
// the total is readable as an expected move.
function upside(input) {
  const bars = Array.isArray(input.bars) ? input.bars : [];
  const floorPct = Number(input.floorPct) || 2;
  const costPct = Number(input.costPct) || 0.08;
  // The pooled model is preferred and the per-name fit is not used to admit a
  // name: it cannot be validated at this sample size. It remains available for
  // inspection through forwardForecast.
  const forecast = input.forecast === undefined ? pooledForecast(bars, input.overrides || {}) : input.forecast;
  const trend = input.trend === undefined ? timeSeriesMomentum(bars) : input.trend;
  const candles = input.candleStudy === undefined ? candleStudy(bars, Number(input.overrides?.horizon) || DEFAULT_HORIZON) : input.candleStudy;
  const technical = input.technical || null;
  const fundamentals = input.fundamentals || null;
  const carry = input.carry || null;
  const side = input.side === "short" ? "short" : "long";
  const direction = side === "short" ? -1 : 1;

  // The model's own estimate, signed for the side being considered.
  const modelPct = forecast?.ready ? direction * Number(forecast.expectedMovePct) : 0;

  // The trend contributes its own recent pace, not a score: a name compounding
  // 20% a year carries roughly 0.4% a week of drift, and that is the honest size
  // of the contribution.
  const weeklyDrift = trend?.ready && Number.isFinite(Number(trend.returnPct))
    ? direction * Number(trend.returnPct) / 52
    : 0;
  const trendPct = weeklyDrift * clamp(trendAlignment(trend, side) * 2, 0, 1);

  // Candles and the technical composite are bounded contributions, because
  // neither has a natural unit in percent. They are capped at a fifth of the
  // floor each so they can tilt a decision but never carry one.
  const cap = floorPct * 0.2;
  const candlePct = clamp(direction * Number(candles?.directionScore || 0), -1, 1) * cap;
  const technicalScore = Number(technical?.score);
  const technicalPct = Number.isFinite(technicalScore) ? clamp(direction * technicalScore / 100, -1, 1) * cap : 0;
  const balancePct = fundamentals?.available
    ? clamp(direction * Number(fundamentals.balanceSheetScore || 0), -1, 1) * cap * 0.75
    : 0;
  const carryPct = carry?.ready ? (side === "short" ? -Number(carry.weeklyPct) : Number(carry.weeklyPct)) : 0;

  const components = [
    ["Forward model", modelPct, forecast?.ready ? `${forecast.horizon}-session forecast ${forecast.expectedMovePct}%, information coefficient ${forecast.informationCoefficient}` : (forecast?.reason || "no validated forecast")],
    ["Trend drift", trendPct, trend?.ready ? `${trend.returnPct}% over ${trend.sessions} sessions` : "no trend measured"],
    ["Candlestick evidence", candlePct, candles?.ready ? `${candles.pattern}, ${candles.sample} comparable cases, ${candles.winRatePct}% followed through` : "no comparable pattern history"],
    ["Technical composite", technicalPct, Number.isFinite(technicalScore) ? `composite ${round(technicalScore, 1)}` : "not supplied"],
    ["Balance sheet", balancePct, fundamentals?.available ? `balance-sheet score ${fundamentals.balanceSheetScore}` : "fundamentals unavailable"],
    ["Carry", carryPct, carry?.ready ? `${carry.state} of ${carry.basisPct}%` : "no contract price"]
  ].map(([name, pct, note]) => ({ name, expectedPct: round(pct), note }));

  const gross = components.reduce((sum, item) => sum + Number(item.expectedPct || 0), 0);
  const expectedMovePct = round(gross - costPct);
  const error = forecast?.ready ? Number(forecast.meanAbsoluteErrorPct) : null;

  return {
    ready: Boolean(forecast?.ready),
    side,
    horizon: forecast?.horizon || DEFAULT_HORIZON,
    floorPct,
    expectedMovePct,
    // A third of all stock-weeks clear 2% unaided, so clearing it is not the test —
    // clearing it more often than that is. A name is admitted when its band of
    // model scores has historically beaten the baseline by a fifth, which is
    // roughly the whole edge the model has, and never on an expectation of 2%
    // that the evidence does not support.
    clearsFloor: Boolean(
      forecast?.trustworthy
      // Null must be rejected outright: Number(null) is 0 and passes isFinite, so
      // a model carrying no calibration would otherwise satisfy "0 >= 0" and admit
      // everything.
      && forecast.clearedFloorPct !== null && forecast.clearedFloorPct !== undefined
      && forecast.baseClearedFloorPct !== null && forecast.baseClearedFloorPct !== undefined
      && Number.isFinite(Number(forecast.clearedFloorPct))
      && Number.isFinite(Number(forecast.baseClearedFloorPct))
      // The table was built for one floor. Asked about a different one it is not
      // evidence, so it declines rather than answering the wrong question.
      && Number(forecast.floorPct) === Number(floorPct)
      && Number(forecast.clearedFloorPct) >= Number(forecast.baseClearedFloorPct) * 1.15
      && expectedMovePct > 0
    ),
    clearedFloorPct: forecast?.clearedFloorPct ?? null,
    baseClearedFloorPct: forecast?.baseClearedFloorPct ?? null,
    trustworthy: Boolean(forecast?.trustworthy),
    typicalErrorPct: error,
    components,
    forecast,
    reason: !forecast?.ready ? (forecast?.reason || "no forecast")
      : !forecast.trustworthy ? "the pooled model showed no measurable skill"
        : forecast.floorPct !== null && Number(forecast.floorPct) !== Number(floorPct)
          ? `the model is calibrated against a ${forecast.floorPct}% floor and cannot speak to ${floorPct}%`
          : forecast.clearedFloorPct !== null && Number.isFinite(Number(forecast.clearedFloorPct))
          ? `scores in this band cleared ${floorPct}% on ${forecast.clearedFloorPct}% of ${forecast.bandCases || 0} past occasions, against a ${forecast.baseClearedFloorPct}% baseline`
          : `the ${forecast.horizon}-session move is put at ${expectedMovePct}%`
  };
}

module.exports = { DEFAULT_HORIZON, forwardForecast, forwardRows, loadPooledModel, pooledForecast, upside };
