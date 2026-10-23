/**
 * Trading Desk UI server for dreamdex-perps-mcp.
 *
 * Serves the single-page desk in ui/index.html and backs it with real data
 * from the Somnia Hideki testnet:
 *   - Market snapshot: the project's own SDK wrapper (dist/client.js),
 *     indexer reads for markets/candles plus the on-chain perp state for a
 *     live mark price (via the WS bridge when the network needs a proxy).
 *   - Agent sessions: a deterministic, rule-based cast (see the trial spec
 *     in ~/workspace/research) that runs on the real snapshot and streams
 *     its steps to the page over SSE.
 *   - Live mode: execution goes through the existing MCP server over stdio
 *     (the exact tools an MCP client would call). Guards are never
 *     bypassed: missing key, TRADING_ENABLED off, or a zero STT balance
 *     surface as honest blockers and nothing is sent.
 *
 * Paper positions are simulated against the live mark and tracked here so
 * the desk can show unrealized PnL and ROE tick by tick.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uiDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(uiDir);

/* ------------------------------ environment ----------------------------- */

try {
  process.loadEnvFile(path.join(rootDir, ".env"));
} catch {
  // No .env file: rely on the ambient environment only.
}

const PORT = Number(process.env.UI_PORT || 4173);
const SYMBOL = "BTC";
const CANDLE_INTERVAL_SEC = 3600;
const CANDLE_LIMIT = 60;

/**
 * The SDK reaches the chain over a raw WebSocket. Behind an HTTP(S) proxy
 * that socket never connects, so when no WS_RPC_URL is configured we run
 * the project's ws-bridge locally and point the SDK at it (the fix that
 * already ships in scripts/ws-bridge.mjs). Reuses a bridge that is
 * already listening instead of spawning a duplicate.
 */
async function ensureWsBridge() {
  if (process.env.WS_RPC_URL) return { url: process.env.WS_RPC_URL, spawned: false };
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return { url: null, spawned: false };
  const port = Number(process.env.WS_BRIDGE_PORT || 8787);
  const url = `ws://127.0.0.1:${port}/ws`;
  const alreadyUp = await new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
    setTimeout(() => { sock.destroy(); resolve(false); }, 800);
  });
  if (alreadyUp) {
    process.env.WS_RPC_URL = url;
    return { url, spawned: false };
  }
  const child = spawn("node", [path.join(rootDir, "scripts", "ws-bridge.mjs")], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[ws-bridge] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[ws-bridge] ${d}`));
  process.on("exit", () => { try { child.kill(); } catch {} });
  process.env.WS_RPC_URL = url;
  return { url, spawned: true };
}

const bridge = await ensureWsBridge();

const { loadConfig } = await import("../dist/config.js");
const client = await import("../dist/client.js");
const { fundingRate8h } = await import("@somnia-chain/markets-sdk");
const { createPublicClient, http, formatEther } = await import("viem");
const { hidekiTestnet } = await import("@somnia-chain/markets-sdk/chains");

const cfg = loadConfig();
const publicClient = createPublicClient({ chain: hidekiTestnet, transport: http() });

/* ----------------------------- market snapshot -------------------------- */

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0];
  for (const v of values) {
    prev = out.length === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsiWilder(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function macd(closes) {
  if (closes.length < 35) return null;
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const line = closes.map((_, i) => fast[i] - slow[i]);
  const signal = emaSeries(line, 9);
  const i = closes.length - 1;
  return { macd: line[i], signal: signal[i], hist: line[i] - signal[i] };
}

let snapshotCache = null;
let snapshotAt = 0;

async function getSnapshot() {
  if (snapshotCache && Date.now() - snapshotAt < 2500) return snapshotCache;
  const markets = client.getMarkets(cfg);
  const market = await client.resolveMarket(cfg, SYMBOL);
  const qd = market.quoteDecimals;
  const bd = market.baseDecimals;
  const raw = await markets.client.getCandles(market.poolAddress, CANDLE_INTERVAL_SEC, {
    limit: CANDLE_LIMIT,
  });
  const candles = raw.map((c) => ({
    t: Number(c.bucketStart),
    o: Number(client.toHuman(BigInt(c.openPrice), qd)),
    h: Number(client.toHuman(BigInt(c.high), qd)),
    l: Number(client.toHuman(BigInt(c.low), qd)),
    c: Number(client.toHuman(BigInt(c.closePrice), qd)),
    v: Number(client.toHuman(BigInt(c.quoteVolume), qd)),
  }));
  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1];

  let mark = market.markPrice ? Number(client.toHuman(BigInt(market.markPrice), qd)) : null;
  let index = market.indexPrice ? Number(client.toHuman(BigInt(market.indexPrice), qd)) : null;
  let markSource = "indexer (funding-cadence mark)";
  try {
    const st = await markets.client.getPerpState(market.poolAddress);
    if (st && st.markPrice && BigInt(st.markPrice) !== 0n) {
      mark = Number(client.toHuman(BigInt(st.markPrice), qd));
      index = Number(client.toHuman(BigInt(st.indexPrice), qd));
      markSource = st.markPriceOk ? "on-chain perp state" : "on-chain perp state (mark flagged stale)";
    }
  } catch {
    // WS path unavailable: keep the indexer values and say so via markSource.
  }

  let fundingPct = null;
  if (market.fundingRate && market.fundingWindowSec) {
    const rate8h = fundingRate8h(BigInt(market.fundingRate), market.fundingWindowSec);
    fundingPct = Number(rate8h) / 1e16; // 1e18-scaled fraction -> percent
  }
  const oiBtc = market.openInterest
    ? Number(client.toHuman(BigInt(market.openInterest), bd))
    : null;
  const lastPrice = market.lastPrice
    ? Number(client.toHuman(BigInt(market.lastPrice), qd))
    : last;
  const ref24 = closes.length > 24 ? closes[closes.length - 25] : closes[0];
  const change24hPct = ref24 ? ((last - ref24) / ref24) * 100 : null;
  const volume24hUsd = candles.slice(-24).reduce((s, c) => s + c.v, 0);
  const ema20Arr = emaSeries(closes, 20);

  snapshotCache = {
    symbol: SYMBOL,
    pool: market.poolAddress,
    lastPrice,
    markPrice: mark,
    indexPrice: index,
    markSource,
    fundingRate8hPct: fundingPct,
    openInterestBtc: oiBtc,
    change24hPct,
    volume24hUsd,
    rsi: rsiWilder(closes),
    macd: macd(closes),
    ema20: ema20Arr[ema20Arr.length - 1],
    candles,
    capUsd: cfg.maxOrderNotionalUsd,
    lotSizeRaw: market.lotSize,
    minQuantityRaw: market.minQuantity,
    baseDecimals: bd,
    quoteDecimals: qd,
    tickSizeRaw: market.tickSize,
    ts: Date.now(),
  };
  snapshotAt = Date.now();
  return snapshotCache;
}

/* ------------------------------ thin analysts --------------------------- */

async function fetchThin(url, timeoutMs = 4500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "dreamdex-perps-mcp-ui" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function newsSignal() {
  try {
    const xml = await fetchThin("https://www.coindesk.com/arc/outboundfeeds/rss/");
    const titles = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?([^<\]]+)/g)]
      .map((m) => m[1].trim())
      .filter((t) => t && !/coindesk/i.test(t))
      .slice(0, 12);
    if (!titles.length) throw new Error("no headlines parsed");
    const bullWords = /rally|surge|gain|record|high|adopt|approve|inflow|bull|rise|jump|soar/i;
    const bearWords = /fall|drop|crash|hack|fraud|lawsuit|ban|outflow|bear|plunge|risk|warn/i;
    let b = 0, s = 0;
    for (const t of titles) { if (bullWords.test(t)) b++; if (bearWords.test(t)) s++; }
    const tilt = titles.length ? (b - s) / titles.length : 0;
    return {
      ok: true,
      score: Math.max(-0.5, Math.min(0.5, tilt)),
      text: `CoinDesk RSS, latest ${titles.length} headlines: ${b} constructive, ${s} negative, rest neutral. Top headline: "${titles[0].slice(0, 90)}". v1 thin signal, low weight.`,
    };
  } catch (err) {
    return {
      ok: false,
      score: 0,
      text: `News feed unreachable from this server (${err.message}). No weight given. v1 thin by design.`,
    };
  }
}

async function sentimentSignal() {
  try {
    const body = await fetchThin("https://api.alternative.me/fng/?limit=1");
    const parsed = JSON.parse(body);
    const value = Number(parsed?.data?.[0]?.value);
    const label = parsed?.data?.[0]?.value_classification ?? "";
    if (!Number.isFinite(value)) throw new Error("unexpected payload");
    return {
      ok: true,
      value,
      score: Math.max(-1, Math.min(1, (value - 50) / 50)),
      text: `Crypto Fear and Greed index at ${value} (${label}). v1 thin signal, low weight.`,
    };
  } catch (err) {
    return {
      ok: false,
      score: 0,
      text: `Sentiment feed unreachable from this server (${err.message}). No weight given. v1 thin by design.`,
    };
  }
}

/* ------------------------------ session engine -------------------------- */

const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtUsd = (v, dp = 2) =>
  "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtPx = (v) =>
  Number(v).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

let paperPosition = null; // {side, qty, entry, leverage, stop, target, openedAt}
let lastClosedPaper = null;
const sessions = new Map();
let sessionSeq = 0;

function emit(session, event) {
  session.events.push(event);
  for (const res of session.subscribers) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

async function sttBalance() {
  const addr = client.walletAddress(cfg);
  if (!addr) return null;
  const bal = await publicClient.getBalance({ address: addr });
  return { address: addr, stt: Number(formatEther(bal)) };
}

async function preflight(market, isBid, priceRaw) {
  try {
    const markets = client.getMarkets(cfg);
    const account = client.effectiveAccount(cfg);
    if (!account) return { error: "no wallet configured for pre-flight" };
    const max = await markets.client.getMaxPerpOrderSize({
      pool: market.poolAddress,
      marginBank: market.marginBank,
      account,
      isBid,
      price: priceRaw,
      ...(cfg.ownerAddress ? { autoPull: false } : {}),
    });
    return {
      priceable: max.priceable,
      placeable: max.placeable,
      limitedBy: String(max.limitedBy ?? ""),
      maxQuantity: client.toHuman(BigInt(max.maxQuantity), market.baseDecimals),
    };
  } catch (err) {
    return { error: err.message.slice(0, 220) };
  }
}

async function runSession(session, mode) {
  const say = (event) => emit(session, event);
  try {
    say({ type: "status", text: `Session started in ${mode.toUpperCase()} mode. Pulling live Hideki data for BTC-PERP.` });
    const snap = await getSnapshot();
    const market = await client.resolveMarket(cfg, SYMBOL);
    const price = snap.markPrice ?? snap.lastPrice;
    const closes = snap.candles.map((c) => c.c);

    /* Analysts on real signals */
    say({ type: "analyst_start", role: "market" });
    await sleep(900);
    const basisPct = ((snap.markPrice - snap.indexPrice) / snap.indexPrice) * 100;
    const marketText =
      `Funding ${snap.fundingRate8hPct >= 0 ? "+" : ""}${snap.fundingRate8hPct?.toFixed(3)}% per 8h (${snap.fundingRate8hPct >= 0 ? "longs pay shorts" : "shorts pay longs"}). ` +
      `Open interest ${snap.openInterestBtc?.toFixed(1)} BTC. Mark ${fmtPx(snap.markPrice)} vs index ${fmtPx(snap.indexPrice)}, basis ${basisPct >= 0 ? "+" : ""}${basisPct.toFixed(3)}%.`;
    say({ type: "analyst_done", role: "market", text: marketText });

    say({ type: "analyst_start", role: "tech" });
    await sleep(900);
    const techText =
      `Close ${fmtPx(closes[closes.length - 1])} is ${closes[closes.length - 1] >= snap.ema20 ? "above" : "below"} the 20 EMA at ${fmtPx(snap.ema20)}. ` +
      `RSI(14) ${snap.rsi?.toFixed(0)}. MACD histogram ${snap.macd && snap.macd.hist >= 0 ? "positive" : "negative"} at ${snap.macd ? (snap.macd.hist >= 0 ? "+" : "") + snap.macd.hist.toFixed(1) : "n/a"}. ` +
      `24h change ${snap.change24hPct >= 0 ? "+" : ""}${snap.change24hPct?.toFixed(2)}%.`;
    say({ type: "analyst_done", role: "tech", text: techText });

    say({ type: "analyst_start", role: "news" });
    const news = await newsSignal();
    say({ type: "analyst_done", role: "news", text: news.text });

    say({ type: "analyst_start", role: "sent" });
    const sent = await sentimentSignal();
    say({ type: "analyst_done", role: "sent", text: sent.text });

    /* Deterministic scoring over the real signals */
    const trendScore = clamp((((closes[closes.length - 1] - snap.ema20) / snap.ema20) * 100) / 0.8);
    const macdScore = snap.macd ? clamp(((snap.macd.hist / price) * 100) / 0.05) : 0;
    const rsiScore = snap.rsi != null ? clamp((snap.rsi - 50) / 25) : 0;
    const fundingScore = snap.fundingRate8hPct != null ? clamp(-snap.fundingRate8hPct / 0.1) : 0;
    const basisScore = clamp(-basisPct / 0.1);
    const net =
      (0.22 * trendScore + 0.18 * macdScore + 0.1 * rsiScore + 0.2 * fundingScore +
        0.1 * basisScore + 0.1 * sent.score + 0.05 * news.score) / 0.95;

    const factors = [
      { side: trendScore, text: `trend vs the 20 EMA scores ${trendScore >= 0 ? "+" : ""}${trendScore.toFixed(2)}` },
      { side: macdScore, text: `MACD momentum scores ${macdScore >= 0 ? "+" : ""}${macdScore.toFixed(2)}` },
      { side: rsiScore, text: `RSI at ${snap.rsi?.toFixed(0)} scores ${rsiScore >= 0 ? "+" : ""}${rsiScore.toFixed(2)}` },
      { side: fundingScore, text: `funding at ${snap.fundingRate8hPct?.toFixed(3)}% per 8h scores ${fundingScore >= 0 ? "+" : ""}${fundingScore.toFixed(2)} for a long` },
      { side: basisScore, text: `mark/index basis scores ${basisScore >= 0 ? "+" : ""}${basisScore.toFixed(2)}` },
    ];
    const bullFactors = factors.filter((f) => f.side > 0.08).sort((a, b) => b.side - a.side);
    const bearFactors = factors.filter((f) => f.side < -0.08).sort((a, b) => a.side - b.side);

    let side, probe = false;
    if (net >= 0.06) side = "long";
    else if (net <= -0.06) side = "short";
    else {
      side = trendScore + macdScore >= 0 ? "long" : "short";
      probe = true;
    }
    const isBid = side === "long";

    say({ type: "debate", who: isBid ? "bull" : "bear", name: isBid ? "BULL RESEARCHER" : "BEAR RESEARCHER",
      text: `The stack leans ${side}. Net score ${net >= 0 ? "+" : ""}${net.toFixed(2)}. Strongest points: ${(isBid ? bullFactors : bearFactors).map((f) => f.text).join("; ") || "no single dominant factor"}.` });
    await sleep(1200);
    say({ type: "debate", who: isBid ? "bear" : "bull", name: isBid ? "BEAR RESEARCHER" : "BULL RESEARCHER",
      text: `Pushback: ${(isBid ? bearFactors : bullFactors).map((f) => f.text).join("; ") || "no strong counter-signal in the data"}. A ${side} here needs a defined invalidation and size that respects the cap.` });
    await sleep(1200);
    say({ type: "debate", who: isBid ? "bull" : "bear", name: isBid ? "BULL RESEARCHER" : "BEAR RESEARCHER",
      text: probe
        ? `Signals are mixed, so this is a probe, not a conviction trade. Half size, tight stop, let the risk team rule.`
        : `With the stop placed at the recent swing, risk per unit is bounded and the setup is asymmetric enough to take at capped size.` });
    await sleep(1000);
    say({ type: "debate", who: isBid ? "bear" : "bull", name: isBid ? "BEAR RESEARCHER" : "BULL RESEARCHER",
      text: `Acceptable only at small size under the ${fmtUsd(cfg.maxOrderNotionalUsd, 0)} cap. Nothing larger until funding and momentum agree.` });
    await sleep(1000);

    /* Trader proposal */
    const recent = snap.candles.slice(-10);
    const swingLow = Math.min(...recent.map((c) => c.l));
    const swingHigh = Math.max(...recent.map((c) => c.h));
    const stop = isBid ? swingLow : swingHigh;
    const riskPerUnit = Math.abs(price - stop);
    const target = isBid ? price + 2 * riskPerUnit : price - 2 * riskPerUnit;
    const targetNotional = Math.min(cfg.maxOrderNotionalUsd * 0.8, 40) * (probe ? 0.5 : 1);
    const lotRaw = BigInt(market.lotSize);
    let qtyRaw = BigInt(Math.floor((targetNotional / price) * 10 ** snap.baseDecimals));
    qtyRaw = (qtyRaw / lotRaw) * lotRaw;
    if (qtyRaw < BigInt(market.minQuantity)) qtyRaw = BigInt(market.minQuantity);
    const qty = Number(client.toHuman(qtyRaw, snap.baseDecimals));
    const notional = qty * price;
    const leverage = 1;
    const margin = notional / leverage;
    const roeAtTarget = (Math.abs(target - price) / price) * leverage * 100;
    const roeAtStop = -((riskPerUnit / price) * leverage * 100);
    const capPass = notional <= cfg.maxOrderNotionalUsd;
    const ticket = {
      side: side.toUpperCase(), qty, price, notional, leverage, stop, target,
      margin, roeAtTarget, roeAtStop, capPass, probe,
    };
    say({ type: "trader", ticket });
    say({ type: "debate", who: "sys", name: "TRADER",
      text: `Proposal posted: ${side.toUpperCase()} ${qty} BTC, notional ${fmtUsd(notional)} at mark ${fmtPx(price)}, stop ${fmtPx(stop)}, target ${fmtPx(target)}${probe ? " (probe size, mixed signals)" : ""}.` });
    await sleep(900);

    /* Pre-flight: the same read the MCP place_order performs */
    const priceRaw = BigInt(Math.round(price * 10 ** snap.quoteDecimals));
    const pf = await preflight(market, isBid, priceRaw);
    say({ type: "preflight", preflight: pf });

    /* Risk team: deterministic rules over the same signals */
    const votes = [];
    const aggressiveOk = (isBid && trendScore + macdScore > -0.1) || (!isBid && trendScore + macdScore < 0.1) || Math.abs(net) >= 0.25;
    votes.push({ id: "riskA", vote: aggressiveOk, note: aggressiveOk ? "Momentum does not fight the direction." : "Momentum fights this direction." });
    const neutralOk = capPass && riskPerUnit > 0 && (mode === "paper" || pf.placeable === true);
    votes.push({ id: "riskN", vote: neutralOk, note: neutralOk ? "Stop defined, notional inside the cap." : mode === "live" ? "Pre-flight says this account cannot place yet." : "Ticket fails a hard check." });
    const extremeAgainst =
      (isBid && snap.rsi != null && snap.rsi > 78) || (!isBid && snap.rsi != null && snap.rsi < 22) ||
      (isBid && snap.fundingRate8hPct != null && snap.fundingRate8hPct > 0.1) ||
      (!isBid && snap.fundingRate8hPct != null && snap.fundingRate8hPct < -0.1);
    const conservativeOk = Math.abs(net) >= 0.3 && !extremeAgainst;
    votes.push({ id: "riskC", vote: conservativeOk, note: conservativeOk ? "Score is decisive and no extreme fights it." : extremeAgainst ? "An extreme (RSI or funding) fights this direction." : "Score is not decisive enough for a conservative yes." });
    for (const v of votes) {
      await sleep(800);
      say({ type: "risk", id: v.id, vote: v.vote ? "APPROVE" : "REJECT", note: v.note });
    }

    const approvals = votes.filter((v) => v.vote).length;
    const approved = approvals >= 2 && capPass;
    await sleep(900);
    say({ type: "pm", approved,
      text: approved
        ? `PORTFOLIO MANAGER · APPROVED · ${side.toUpperCase()} ${qty} BTC (${fmtUsd(notional)})`
        : `PORTFOLIO MANAGER · REJECTED · ${approvals}/3 risk approvals${capPass ? "" : ", cap check failed"}. No order sent.` });

    if (!approved) {
      say({ type: "done", outcome: "rejected" });
      return;
    }

    /* Execution */
    say({ type: "exec", step: "x1", state: "done", text: "Connected to Hideki data feeds (indexer plus on-chain perp state)" });
    await sleep(500);
    say({ type: "exec", step: "x2", state: pf.error ? "fail" : "done",
      text: pf.error
        ? `Pre-flight unavailable: ${pf.error}`
        : `Pre-flight (getMaxPerpOrderSize): ${pf.placeable ? "account can place" : `not placeable, limited by ${pf.limitedBy || "unknown"}`}${mode === "paper" ? ". Paper mode posts no margin, noted for the live path." : ""}` });
    await sleep(500);
    say({ type: "exec", step: "x3", state: capPass ? "done" : "fail",
      text: `Hard guard: notional ${fmtUsd(notional)} ${capPass ? "under" : "over"} the ${fmtUsd(cfg.maxOrderNotionalUsd, 0)} cap` });
    await sleep(500);

    if (mode === "paper") {
      paperPosition = { side, qty, entry: price, leverage, stop, target, openedAt: Date.now() };
      lastClosedPaper = null;
      say({ type: "exec", step: "x4", state: "done", text: `place_order held: paper mode sends nothing on-chain. Simulated fill at mark ${fmtPx(price)}.` });
      say({ type: "exec", step: "x5", state: "done", text: "Paper position open. PnL and ROE now track the live mark below." });
      say({ type: "position", position: paperPosition });
      say({ type: "done", outcome: "paper-filled" });
      return;
    }

    /* Live mode: honest guard chain, then the real MCP tools over stdio */
    const blockers = [];
    if (!cfg.privateKey) blockers.push("No PRIVATE_KEY configured: the MCP server is read-only.");
    if (!cfg.tradingEnabled) blockers.push("TRADING_ENABLED is not true: the MCP write tools refuse to run.");
    let bal = null;
    try { bal = await sttBalance(); } catch { /* balance read is itself reported below */ }
    if (bal && bal.stt <= 0) blockers.push(`Bot wallet ${bal.address} holds 0 STT: no gas for transactions (drip still pending).`);
    if (blockers.length) {
      say({ type: "exec", step: "x4", state: "fail", text: `place_order blocked: ${blockers.join(" ")}` });
      say({ type: "exec", step: "x5", state: "fail", text: "No transaction sent. Nothing was signed and no hash exists for this run." });
      say({ type: "done", outcome: "blocked", blockers });
      return;
    }
    if (pf.placeable !== true) {
      say({ type: "exec", step: "x4", state: "fail", text: `place_order blocked by pre-flight: account not placeable (limited by ${pf.limitedBy || pf.error || "unknown"}). Claim the voucher or add collateral first.` });
      say({ type: "done", outcome: "blocked", blockers: ["preflight"] });
      return;
    }
    try {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const transport = new StdioClientTransport({
        command: "node",
        args: [path.join(rootDir, "dist", "index.js")],
        env: { ...process.env },
      });
      const mcp = new Client({ name: "trading-desk-ui", version: "0.1.0" });
      await mcp.connect(transport);
      try {
        const claim = await mcp.callTool({ name: "claim_voucher", arguments: {} });
        const claimText = claim.content?.[0]?.text ?? "";
        say({ type: "exec", step: "x4", state: claim.isError ? "fail" : "done", text: `claim_voucher: ${claimText.slice(0, 180)}` });
        const placed = await mcp.callTool({
          name: "place_order",
          arguments: { symbol: SYMBOL, side, type: "market", quantity: String(qty) },
        });
        const placedText = placed.content?.[0]?.text ?? "";
        const hashMatch = placedText.match(/0x[0-9a-fA-F]{64}/);
        say({ type: "exec", step: "x5", state: placed.isError ? "fail" : "done",
          text: placed.isError ? `place_order error: ${placedText.slice(0, 220)}` : placedText.slice(0, 220),
          hash: hashMatch ? hashMatch[0] : null });
        say({ type: "done", outcome: placed.isError ? "error" : "live-filled" });
      } finally {
        await mcp.close().catch(() => {});
      }
    } catch (err) {
      say({ type: "exec", step: "x5", state: "fail", text: `MCP execution failed: ${err.message.slice(0, 220)}` });
      say({ type: "done", outcome: "error" });
    }
  } catch (err) {
    say({ type: "error", message: err.message.slice(0, 300) });
    say({ type: "done", outcome: "error" });
  }
}

/* ------------------------------- position ------------------------------- */

function paperPositionView(mark) {
  if (!paperPosition) return null;
  const dir = paperPosition.side === "long" ? 1 : -1;
  const upnl = dir * (mark - paperPosition.entry) * paperPosition.qty;
  const margin = (paperPosition.entry * paperPosition.qty) / paperPosition.leverage;
  return {
    source: "paper",
    ...paperPosition,
    mark,
    margin,
    upnl,
    roePct: margin > 0 ? (upnl / margin) * 100 : 0,
  };
}

async function livePositionView(mark) {
  try {
    const account = client.effectiveAccount(cfg);
    if (!account) return null;
    const markets = client.getMarkets(cfg);
    const positions = await markets.client.listPerpPositions(account);
    const snap = snapshotCache;
    const open = positions.find(
      (p) => snap && p.pool.toLowerCase() === snap.pool.toLowerCase() && p.size !== "0",
    );
    if (!open) return null;
    const size = Number(client.toHuman(BigInt(open.size), snap.baseDecimals));
    const entry = Number(client.toHuman(BigInt(open.avgEntryPrice), snap.quoteDecimals));
    const dir = size >= 0 ? 1 : -1;
    const qty = Math.abs(size);
    const upnl = dir * (mark - entry) * qty;
    const margin = (entry * qty) / 1; // account leverage not read here; 1x estimate, labeled in UI
    return {
      source: "live",
      side: dir >= 0 ? "long" : "short",
      qty, entry, leverage: 1, marginEstimated: true,
      mark, margin, upnl,
      roePct: margin > 0 ? (upnl / margin) * 100 : 0,
    };
  } catch {
    return null;
  }
}

/* --------------------------------- HTTP --------------------------------- */

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFile(path.join(uiDir, "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (url.pathname === "/api/status") {
      let bal = null;
      try { bal = await sttBalance(); } catch (err) { bal = { error: err.message.slice(0, 160) }; }
      json(res, 200, {
        hasKey: Boolean(cfg.privateKey),
        tradingEnabled: cfg.tradingEnabled,
        capUsd: cfg.maxOrderNotionalUsd,
        wsBridge: bridge,
        wallet: bal,
      });
      return;
    }
    if (url.pathname === "/api/market") {
      const snap = await getSnapshot();
      const mark = snap.markPrice ?? snap.lastPrice;
      const paper = paperPositionView(mark);
      const live = paper ? null : await livePositionView(mark);
      json(res, 200, { ...snap, position: paper ?? live, lastClosedPaper });
      return;
    }
    if (url.pathname === "/api/session" && req.method === "POST") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        let mode = "paper";
        try { mode = JSON.parse(body || "{}").mode === "live" ? "live" : "paper"; } catch {}
        const id = `s${++sessionSeq}`;
        const session = { id, mode, events: [], subscribers: new Set() };
        sessions.set(id, session);
        json(res, 200, { id });
        runSession(session, mode).catch(() => {});
      });
      return;
    }
    const evMatch = url.pathname.match(/^\/api\/session\/(\w+)\/events$/);
    if (evMatch) {
      const session = sessions.get(evMatch[1]);
      if (!session) { json(res, 404, { error: "unknown session" }); return; }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const e of session.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      session.subscribers.add(res);
      req.on("close", () => session.subscribers.delete(res));
      return;
    }
    if (url.pathname === "/api/position/close" && req.method === "POST") {
      if (!paperPosition) { json(res, 400, { error: "no open paper position" }); return; }
      const snap = await getSnapshot();
      const mark = snap.markPrice ?? snap.lastPrice;
      const view = paperPositionView(mark);
      lastClosedPaper = {
        side: view.side, qty: view.qty, entry: view.entry, exit: mark,
        upnl: view.upnl, roePct: view.roePct, closedAt: Date.now(),
      };
      paperPosition = null;
      json(res, 200, { closed: lastClosedPaper });
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 502, { error: err.message.slice(0, 300) });
  }
});

server.listen(PORT, () => {
  console.log(`trading desk UI on http://127.0.0.1:${PORT} (cap $${cfg.maxOrderNotionalUsd}, trading ${cfg.tradingEnabled ? "enabled" : "disabled"}, ws bridge ${bridge.url ?? "not needed"})`);
});
