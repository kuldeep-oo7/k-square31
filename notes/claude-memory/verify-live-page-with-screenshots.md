---
name: verify-live-page-with-screenshots
description: "User rule 2026-09-27: after EVERY push, open the live public page in a real browser, screenshot every tab, and LOOK at the images before saying it is done"
metadata:
  type: feedback
---

After every push that changes the desk, before reporting it as done: open
https://kuldeep-oo7.github.io/k2-desk/ in a real browser (Playwright + Edge on
this laptop: `node scripts/shoot-live-page.js <expected build stamp>`), wait for
the new build stamp, screenshot EVERY tab (FUTURES, CALLS, PUTS, TRACK) at the
top and scrolled, then Read the PNGs and check them by eye: prices, labels,
times, wrapping, signs, totals, notes. Report what the screenshots show.

**Why:** the user, 2026-09-27: "whenever you push you need to always verify with
screen ... open the site take the screenshot and then verify not from the
backend -- every time I pasted the screenshot you are saying I found the bug".
Backend checks (data.json, grep of the HTML) passed while the page showed
"NOT live at 06:55", symbols broken mid-word ("BAJ AJ-AUTO..."), "0 h" for no
targets, "₹-3,725.8", and a totals row missing the futures -- all found only in
the user's screenshots.

**How to apply:** the screenshot pass is part of "done", not optional; if the
browser cannot open the page, say so plainly instead of reporting success. Do
not rely on the user to find visual defects. See [[k2-find-defects-by-distribution]].

**Screens (27 Sep):** the user reads the desk MOSTLY ON A PHONE -- Samsung Galaxy
M32 4G (6.4", 1080x2400, ~411 ppi; a ~412 px CSS page at 2.625x). The laptop
(1920x1080 at Windows 125% = a 1536 px page) is for development. Check the PHONE
first. `scripts/shoot-live-page.js` shoots phone (412x915 @2.625, isMobile) then
laptop (1536x864 @1.25) and flags any page/table wider than the screen. Shooting
at a plain 1920 missed a TRACK table that hid its money column on the user's
screen; below 720 px every table row renders as a labelled card (labelCells +
a media query in publish-static-desk.js).


**FOLDER OF PHOTOS (user rule, 29 Sep 2026):** after EVERY push, and whenever the user says "audit" or "simulation", photograph the live site in CHROME (phone + laptop, every tab) and save date-wise so the user can open them: `node scripts/shoot-live-page.js "<build stamp>" <label>` writes to `C:\Users\kulde\Downloads\K2-screenshots\<IST date>\<HHMM>-<label>\` with README.txt (build, checks, row offsets). Simulated pages get photographed into the same tree. And "always verify against the live internet": run `node scripts/audit-live-vs-nse.js` too and keep its output with the photos.
