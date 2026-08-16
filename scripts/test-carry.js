"use strict";

const assert = require("node:assert/strict");
const { carry, carryScore, sessionsBetween } = require("../api/_lib/carry");

const now = Date.parse("2026-08-17T06:30:00Z");

// A future at a premium must cost the long and pay the short, symmetrically.
const richLong = carry({ futures: 101, spot: 100, expiry: "2026-08-27", side: "long", nowMs: now });
const richShort = carry({ futures: 101, spot: 100, expiry: "2026-08-27", side: "short", nowMs: now });
assert.equal(richLong.ready, true);
assert.equal(richLong.state, "premium");
assert.equal(richLong.basisPct, 1);
assert.equal(richLong.toExpiryPct, -1, "a long pays away the premium by expiry");
assert.equal(richShort.toExpiryPct, 1, "the short collects it");
assert.equal(richLong.favourable, false);
assert.equal(richShort.favourable, true);
assert.equal(richLong.basisPct, richShort.basisPct, "the basis is a property of the contract, not the side");

// A discount reverses who is paid.
const cheapLong = carry({ futures: 99, spot: 100, expiry: "2026-08-27", side: "long", nowMs: now });
assert.equal(cheapLong.state, "discount");
assert.ok(cheapLong.toExpiryPct > 0, "a long is paid to hold a future trading below spot");
assert.equal(cheapLong.favourable, true);

// Annualising must account for how little time is left: the same 1% basis is a
// far larger rate over ten days than over a year.
const near = carry({ futures: 101, spot: 100, expiry: "2026-08-27", side: "short", nowMs: now });
const far = carry({ futures: 101, spot: 100, expiry: "2027-08-27", side: "short", nowMs: now });
assert.ok(near.annualisedPct > far.annualisedPct * 20, `near-dated carry must annualise much higher: ${near.annualisedPct} vs ${far.annualisedPct}`);
assert.equal(near.calendarDays, 10);

// The weekly figure is what the desk actually earns in one cycle, and it can
// never exceed what is left to expiry.
assert.ok(Math.abs(near.weeklyPct) < Math.abs(near.toExpiryPct), "a week is less than the ten days remaining");
const threeDays = carry({ futures: 101, spot: 100, expiry: "2026-08-20", side: "short", nowMs: now });
assert.equal(threeDays.weeklyPct, threeDays.toExpiryPct, "with under a week left, the week's carry is all of it");

// Weekend days decay the basis but carry no price risk, so both counts are given.
const span = sessionsBetween(Date.parse("2026-08-17T00:00:00Z"), Date.parse("2026-08-24T00:00:00Z"));
assert.equal(span.calendarDays, 7);
assert.equal(span.sessions, 5, "a calendar week holds five trading sessions");

// Refusals rather than guesses.
assert.equal(carry({ futures: 0, spot: 100, expiry: "2026-08-27" }).ready, false);
assert.equal(carry({ futures: 101, spot: 0, expiry: "2026-08-27" }).ready, false);
assert.equal(carry({ futures: 101, spot: 100, expiry: "not-a-date" }).ready, false);
assert.equal(carry({ futures: 101, spot: 100, expiry: "2026-08-10", nowMs: now }).ready, false, "an expired contract carries nothing");

// The score is bounded, ordered, and neutral when there is nothing to say.
assert.equal(carryScore({ ready: false }), 0);
assert.ok(carryScore(richShort) > carryScore(richLong), "the side being paid must score higher");
[richLong, richShort, cheapLong, near, far].forEach((item) => {
  const score = carryScore(item);
  assert.ok(score >= 0 && score <= 1, `score out of range: ${score}`);
});
assert.equal(carryScore(carry({ futures: 100, spot: 100, expiry: "2026-08-27", side: "long", nowMs: now })), 0.5, "a flat basis sits in the middle");

console.log("Carry tests passed: basis direction by side, time-scaled annualisation, weekly accrual and a bounded score");
