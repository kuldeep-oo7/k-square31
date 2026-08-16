// A hard read-only boundary for everything that talks to GM.
//
// The desk's book is the trader's to change, never this software's. Reading is
// the whole job: fetch positions, prices and context, show them, and stop.
//
// This is enforced rather than intended. Endpoint discovery once probed
// add_market_watch.php and clear_pending_trade.php simply because their names
// contained "market" — they were rejected by the server, but nothing in the code
// would have stopped them. A name-shape check is not a security control, but it
// does stop the realistic failure: a broad filter sweeping a mutating endpoint
// into a list of candidates.

// Verbs that change something. Matched against the endpoint's file name.
const MUTATING = /(^|_)(add|place|create|update|edit|modify|delete|remove|clear|cancel|close|square|rollover|roll_over|deposit|withdraw|transfer|reset|change|set|save|submit|confirm|approve|reject|block|unblock|bet|buy|sell|order|trade_execute)(_|$)/i;

// Endpoints this software is allowed to call, named individually. Anything not
// on this list has to be added deliberately, which is the point.
const ALLOWED = new Set([
  "ajaxfiles/logincheck.php",
  "ajaxfiles/check_login.php",
  "ajaxfiles/view_login_map_account.php",
  "ajaxfiles/login_into_mapped_account.php",
  "datatables/position_book_list.php",
  "datatables/position_book_list_new.php",
  "datatables/position_book_list_forex.php"
]);

function normalise(path) {
  return String(path || "").replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "").split("?")[0].toLowerCase();
}

// True when the endpoint's name contains a verb that changes state. Used to keep
// discovery away from anything that writes, even when it is only probing.
function looksMutating(path) {
  const file = normalise(path).split("/").pop() || "";
  return MUTATING.test(file.replace(/\.php$/, ""));
}

// The check discovery uses: safe to probe only if it is not mutation-shaped.
function safeToProbe(path) {
  return !looksMutating(path);
}

// The check the working readers use: on the list, and not mutation-shaped.
function allowedEndpoint(path) {
  const clean = normalise(path);
  return ALLOWED.has(clean) && !looksMutating(clean);
}

function assertReadOnly(path) {
  if (!safeToProbe(path)) {
    throw new Error(`Refusing to call ${normalise(path)}: its name indicates it changes state, and this software only reads from GM`);
  }
  return true;
}

module.exports = { ALLOWED, allowedEndpoint, assertReadOnly, looksMutating, safeToProbe };
