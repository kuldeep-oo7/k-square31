"use strict";

// Synthetic examples exercise software paths, not historical trading performance.
const start = Date.parse("2026-10-28T09:15:00+05:30");
const demoNow = start + 33 * 300000 + 20000;
function fixture(symbol = "DEMO-UP", sign = 1, family = "STRUCTURE_BREAKOUT") {
  const expiry = "2026-11-23";
  let raw = Array.from({ length: 33 }, (_, i) => {
    const c = 100 + 0.5 * Math.sin(i * Math.PI / 6), p = i ? 100 + 0.5 * Math.sin((i - 1) * Math.PI / 6) : c;
    return { open:p, high:Math.max(p,c)+0.08, low:Math.min(p,c)-0.08, close:c, volume:100 };
  });
  if (family === "STRUCTURE_BREAKOUT") raw[32] = { open:100.55,high:100.9,low:100.45,close:100.8,volume:250 };
  if (family === "FAILED_BREAKOUT") { raw[31]={open:99.4,high:99.5,low:99.2,close:99.45,volume:180}; raw[32]={open:99.45,high:99.6,low:99.4,close:99.55,volume:150}; }
  if (family === "RANGE_BOUNCE") { raw[31]={open:99.7,high:99.75,low:99.4,close:99.45,volume:100}; raw[32]={open:99.45,high:99.65,low:99.25,close:99.6,volume:120}; }
  if (family === "TREND_PULLBACK") {
    raw = raw.map((_,i)=>({open:94+i*0.18-0.07,high:94+i*0.18+0.15,low:94+i*0.18-0.15,close:94+i*0.18,volume:100}));
    raw[30]={open:99,high:99.5,low:98,close:98.25,volume:100}; raw[31]={open:98.25,high:98.3,low:98.1,close:98.15,volume:100}; raw[32]={open:98.2,high:98.5,low:98.15,close:98.45,volume:140};
  }
  const reflect = n => Number((sign > 0 ? n : 200-n).toFixed(8));
  const bars = raw.map((b,i)=>({symbol,expiry,at:new Date(start+i*300000).toISOString(),open:reflect(b.open),close:reflect(b.close),high:reflect(sign>0?b.high:b.low),low:reflect(sign>0?b.low:b.high),volume:b.volume}));
  const close=bars.at(-1).close;
  return {symbol,expiry,market:"NSE_FUTURES",currency:"INR",tickSize:0.05,source:"ANGELONE_NFO",intervalMinutes:5,volumeKind:"EXCHANGE_VOLUME",bars,
    eligibility:{session:"2026-10-28",state:"CLEAR",source:"SYNTHETIC_TEST_ONLY"},quote:{symbol,expiry,at:new Date(demoNow-10000).toISOString(),bid:Number((close-0.05).toFixed(8)),ask:Number((close+0.05).toFixed(8))}};
}
function cases() { return ["STRUCTURE_BREAKOUT","TREND_PULLBACK","FAILED_BREAKOUT","RANGE_BOUNCE"].flatMap((f)=>[fixture("DEMO-"+f.replace(/_/g,"-")+"-UP",1,f),fixture("DEMO-"+f.replace(/_/g,"-")+"-DOWN",-1,f)]); }
module.exports={fixture,cases,demoNow};
