"use strict";

const assert = require("node:assert/strict");
const { allowedEndpoint, assertReadOnly, looksMutating, safeToProbe } = require("../api/_lib/gm-readonly");

// The endpoints that were actually probed by mistake must now be refused.
["ajaxfiles/add_market_watch.php", "ajaxfiles/add_market_watch_all.php", "ajaxfiles/add_market_watch_forex.php", "ajaxfiles/clear_pending_trade.php"]
  .forEach((path) => {
    assert.equal(looksMutating(path), true, `${path} must be recognised as mutating`);
    assert.equal(safeToProbe(path), false, `${path} must never be probed`);
    assert.throws(() => assertReadOnly(path), /only reads from GM/);
  });

// The rest of the write surface seen in GM's bundle.
["ajaxfiles/bet_place.php", "ajaxfiles/create_user.php", "ajaxfiles/edit_account.php", "ajaxfiles/delete_receipt.php",
 "ajaxfiles/change_password.php", "ajaxfiles/deposit_amount_cricket.php", "ajaxfiles/add_jv.php", "ajaxfiles/clear_login_attempts.php"]
  .forEach((path) => assert.equal(safeToProbe(path), false, `${path} must never be probed`));

// Reads must still be allowed, or the boundary is useless.
["datatables/position_book_list.php", "ajaxfiles/logincheck.php", "ajaxfiles/check_login.php",
 "ajaxfiles/market_watch_list.php", "ajaxfiles/get_market_lists.php", "ajaxfiles/fetch_expiry_list.php"]
  .forEach((path) => {
    assert.equal(safeToProbe(path), true, `${path} is a read and must stay callable`);
    assert.doesNotThrow(() => assertReadOnly(path));
  });

// "get_market_script_list_for_place" only fetches the list an order screen shows,
// but its name ends in "_place" and the check refuses it. That is the correct
// direction to be wrong in: over-blocking a read costs nothing here, while
// under-blocking a write costs the trader's book.
assert.equal(safeToProbe("ajaxfiles/get_market_script_list_for_place.php"), false);

// The working readers are held to the tighter list, not merely to the verb check.
assert.equal(allowedEndpoint("datatables/position_book_list.php"), true);
assert.equal(allowedEndpoint("ajaxfiles/market_watch_list.php"), false, "discovery may probe it; the readers may not call it unlisted");
assert.equal(allowedEndpoint("ajaxfiles/add_market_watch.php"), false);

// Shape handling: absolute URLs, query strings, leading slashes and case.
assert.equal(looksMutating("https://gmglobal.org/ajaxfiles/ADD_MARKET_WATCH.php?x=1"), true);
assert.equal(allowedEndpoint("/datatables/position_book_list.php?sEcho=1"), true);
assert.equal(looksMutating(""), false);
assert.equal(allowedEndpoint(""), false);

// A verb inside a longer word must not trip the check.
assert.equal(looksMutating("ajaxfiles/get_broker_list.php"), false, "'broker' contains no standalone verb");
assert.equal(looksMutating("ajaxfiles/get_address_book.php"), false, "'address' must not match 'add'");

console.log("GM read-only tests passed: mutating endpoints refused, reads still allowed, no false positives");
