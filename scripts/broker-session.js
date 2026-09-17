"use strict";

/**
 * Broker session helper.
 *
 *   node scripts/broker-session.js status
 *   node scripts/broker-session.js angel-login          mint a session from TOTP
 *   node scripts/broker-session.js angel-refresh        rotate the JWT
 *   node scripts/broker-session.js upstox-login-url     the consent URL to open
 *   node scripts/broker-session.js upstox-code <code>   exchange it for a token
 */

const {
  angelEnsureSession, angelLogin, angelRefresh,
  sessionStatus, upstoxExchangeCode, upstoxLoginUrl
} = require("../api/_lib/broker-auth");

const [command, argument] = process.argv.slice(2);

(async () => {
  if (!command || command === "status") {
    const status = sessionStatus();
    console.log("ANGEL ONE");
    console.log(`  mode            ${status.angelone.mode}`);
    console.log(`  token present   ${status.angelone.hasToken}`);
    console.log(`  auto-refresh    ${status.angelone.canAutoRefresh}`);
    if (status.angelone.missing.length) console.log(`  missing         ${status.angelone.missing.join(", ")}`);
    console.log("UPSTOX");
    console.log(`  mode            ${status.upstox.mode}`);
    console.log(`  token present   ${status.upstox.hasToken}`);
    console.log(`  expires at      ${status.upstox.expiresAt}  (${status.upstox.hoursRemaining}h)`);
    console.log(`  auto-refresh    ${status.upstox.canAutoRefresh}  -- ${status.upstox.note}`);
    if (status.upstox.loginUrl) console.log(`  login url       ${status.upstox.loginUrl}`);
    return;
  }
  if (command === "angel-login") { console.log(JSON.stringify(redact(await angelLogin()), null, 2)); return; }
  if (command === "angel-refresh") { console.log(JSON.stringify(redact(await angelRefresh()), null, 2)); return; }
  if (command === "angel-ensure") { console.log(JSON.stringify(redact(await angelEnsureSession()), null, 2)); return; }
  if (command === "upstox-login-url") {
    const url = upstoxLoginUrl();
    console.log(url || "Set UPSTOX_API_KEY and UPSTOX_REDIRECT_URI first.");
    return;
  }
  if (command === "upstox-code") { console.log(JSON.stringify(redact(await upstoxExchangeCode(argument)), null, 2)); return; }
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
})();

/** A token printed to a terminal is a token in a scrollback buffer. */
function redact(result) {
  if (!result?.session) return result;
  const session = { ...result.session };
  for (const field of ["accessToken", "refreshToken", "feedToken"]) {
    if (session[field]) session[field] = `${String(session[field]).slice(0, 8)}...[stored in .private/brokers.json]`;
  }
  return { ...result, session };
}
