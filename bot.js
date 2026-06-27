/*
 * BTC SENTINEL — cloud engine (paper trading only, no real money)
 * ---------------------------------------------------------------
 * This script runs ONCE each time GitHub Actions invokes it (every 5 min).
 * It remembers everything between runs by reading and writing state.json.
 * No API key needed — Bitcoin price comes from Coinbase's free public API.
 */

"use strict";
const fs = require("fs");
const PATH = "state.json";

/* ---- settings you can tweak ---- */
const START_CASH = 10000;   // pretend dollars
const FAST_PERIOD = 6;      // fast EMA length (in 5-min ticks → 30 min)
const SLOW_PERIOD = 15;     // slow EMA length (in 5-min ticks → 75 min)
const FEE_PCT = 0.1;        // simulated exchange fee per trade, %
const MAX_HISTORY = 600;    // price points kept for the dashboard
const MAX_LOG = 200;        // activity lines kept

/* ---- helpers ---- */
const nowISO = () => new Date().toISOString();
const fee = amt => amt * (FEE_PCT / 100);

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(PATH, "utf8"));
  } catch {
    return {
      cash: START_CASH, btc: 0,
      emaFast: null, emaSlow: null,
      lastSignal: null, lastBuyCost: null,
      ticks: 0, trades: [], history: [], log: []
    };
  }
}

function ema(prev, value, period) {
  if (prev == null) return value;
  const k = 2 / (period + 1);
  return value * k + prev * (1 - k);
}

function logLine(s, msg) {
  s.log.unshift({ t: nowISO(), msg });
  if (s.log.length > MAX_LOG) s.log.length = MAX_LOG;
  console.log(`[${nowISO()}] ${msg}`);
}

async function getPrice() {
  // primary: Coinbase, fallback: CoinGecko
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
    const j = await r.json();
    const p = parseFloat(j.data.amount);
    if (isFinite(p) && p > 0) return p;
    throw new Error("bad coinbase value");
  } catch {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
    const j = await r.json();
    const p = j.bitcoin && j.bitcoin.usd;
    if (isFinite(p) && p > 0) return p;
    throw new Error("no price from either source");
  }
}

/* ---- trading ---- */
function buyAll(s, price, reason) {
  if (s.cash < 1) return;
  const f = fee(s.cash);
  const qty = (s.cash - f) / price;
  s.lastBuyCost = s.cash;
  s.btc += qty;
  s.trades.push({ side: "BUY", price, qty, t: nowISO() });
  logLine(s, `BUY ${qty.toFixed(6)} BTC @ $${price.toFixed(2)} ${reason} (fee $${f.toFixed(2)})`);
  s.cash = 0;
}

function sellAll(s, price, reason) {
  if (s.btc <= 0) return;
  const gross = s.btc * price;
  const net = gross - fee(gross);
  const pnl = s.lastBuyCost != null ? net - s.lastBuyCost : 0;
  s.trades.push({ side: "SELL", price, qty: s.btc, t: nowISO(), pnl });
  logLine(s, `SELL ${s.btc.toFixed(6)} BTC @ $${price.toFixed(2)} ${reason} → ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
  s.cash += net;
  s.btc = 0;
  s.lastBuyCost = null;
}

/* ---- main ---- */
(async () => {
  const s = loadState();

  let price;
  try {
    price = await getPrice();
  } catch (e) {
    logLine(s, `Price fetch failed (${e.message}) — skipping this run`);
    fs.writeFileSync(PATH, JSON.stringify(s, null, 2));
    return; // don't corrupt state on a network blip
  }

  s.ticks++;
  s.emaFast = ema(s.emaFast, price, FAST_PERIOD);
  s.emaSlow = ema(s.emaSlow, price, SLOW_PERIOD);

  // decide once enough data exists
  if (s.ticks > SLOW_PERIOD) {
    const sig = s.emaFast > s.emaSlow ? "above" : "below";
    if (s.lastSignal && sig !== s.lastSignal) {
      if (sig === "above" && s.cash > 1) buyAll(s, price, "· crossover ↑");
      if (sig === "below" && s.btc > 0) sellAll(s, price, "· crossover ↓");
    }
    s.lastSignal = sig;
  } else if (s.ticks === SLOW_PERIOD) {
    logLine(s, "Warm-up complete — now watching for crossovers");
  } else {
    logLine(s, `Warming up averages (${s.ticks}/${SLOW_PERIOD})`);
  }

  // record snapshot
  const equity = s.cash + s.btc * price;
  s.history.push({ t: nowISO(), p: price, equity, f: s.emaFast, sl: s.emaSlow });
  if (s.history.length > MAX_HISTORY) s.history.shift();
  if (s.trades.length > MAX_LOG) s.trades.splice(0, s.trades.length - MAX_LOG);

  // summary to the Actions log
  const pnl = equity - START_CASH;
  console.log(`PRICE $${price.toFixed(2)} | EQUITY $${equity.toFixed(2)} | P/L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${s.btc > 0 ? "HOLDING BTC" : "IN CASH"} | trades ${s.trades.length}`);

  s.updated = nowISO();
  fs.writeFileSync(PATH, JSON.stringify(s, null, 2));
})();
