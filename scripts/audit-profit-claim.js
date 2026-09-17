"use strict";
// The input below is a transcription of the disputed manual, NOT market data.
const rows = [
  ["ABB FUT",125,6954.45,7090,20121,7140.85], ["BEL FUT",1425,382.74,392.55,13979],
  ["RELIANCE CE",500,21.95,23.93,2415,29.63], ["KAYNES CASH",100,3392,3536.5,15705,3561.6],
  ["TRENT CASH",100,2730,2783.2,5320], ["CDSL CASH",100,1311,1352.9,4190],
  ["DATAPATTNS CASH",100,4358.8,4399.6,4080], ["BANKBARODA FUT",2925,232.7,233.16,1345],
  ["NIFTY CE",65,273.3,263.42,-642], ["DIXON CE",50,310,280.7,-1465],
  ["HDFCBANK CE",650,11.85,6.54,-3451], ["TCS CASH",100,2251,2175,-7600],
  ["BANKNIFTY PE",30,559.95,252.17,-3966]
];
const round = x => Math.round(x * 100) / 100;
function auditClaim() {
  return { status: "UNVERIFIED_HYPOTHETICAL_NOT_ACTUAL_PROFIT", source: "Disputed manual table only; no independent fills/quotes supplied",
    claimedTotalInr: rows.reduce((sum,r) => sum+r[4],0), claimedWinRatePct: round(rows.filter(r=>r[4]>0).length/rows.length*100),
    concurrentRevision: { commit: "d1dffd5", revisedReportedTotalInr: 50031-13979-1345-5629,
      status: "STILL_UNVERIFIED", changes: "BEL replaced by -5629 and BANKBARODA by unfilled0; remaining fill/hedge/cost/timing defects persist" },
    naiveSingleLegGrossMarkArithmeticInr: round(rows.reduce((sum,r)=>sum+(r[3]-r[2])*r[1],0)),
    rows: rows.map(([symbol, quantity, entry, mark, claimed, t1]) => ({ symbol, quantity, entry, mark,
      claimedInr: claimed, singleLegGrossMarkArithmeticInr: round((mark-entry)*quantity),
      hypotheticalHalfExitArithmeticInr: t1 ? round(((t1-entry)+(mark-entry))*quantity/2) : null,
      invalidHalfLot: Boolean(t1 && !symbol.includes("CASH")),
      verifiedNetPnlInr: null })),
    missingEvidence: ["Original pre-entry publication timestamp and immutable signal version", "Valid exchange contract and expiry",
      "Timestamped raw entry and exit fills; all hedge legs", "Whole-lot execution and target/stop chronological path",
      "Actual fees, taxes, funding, margin/capital, open-position bid/ask marks and cash reconciliation"],
    warning: "Even the alternative arithmetic is NOT an estimate of money earned: input marks, fills, timing and costs are unverified." };
}
if (require.main === module) console.log(JSON.stringify(auditClaim(), null, 2));
module.exports = { auditClaim };
