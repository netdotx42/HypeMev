// Node 24+ executes this TypeScript directly. Public data only; never sends orders.
import { pathToFileURL } from 'node:url';

type Level = { px: string; sz: string };
export type Book = { coin: string; time: number; levels: [Level[], Level[]] };
type SpotMeta = { tokens: { name: string; index: number; szDecimals: number }[];
  universe: { name: string; index: number; tokens: number[] }[] };
const endpoint = 'https://api.hyperliquid.xyz/info';
async function info<T>(body: object): Promise<T> {
  const response = await fetch(endpoint, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Info API HTTP ${response.status}`);
  return await response.json() as T;
}
function setting(name: string, fallback: number, min: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(n) || n < min) throw new Error(`Invalid ${name}`);
  return n;
}
export function touch(levels: Level[], side: 'buy' | 'sell'): number {
  const prices = levels.map(l => ({ px: Number(l.px), sz: Number(l.sz) }));
  if (prices.some(l => !Number.isFinite(l.px) || !Number.isFinite(l.sz) || l.px <= 0 || l.sz < 0))
    throw new Error('Invalid order-book level');
  const shown = prices.filter(l => l.sz > 0).map(l => l.px);
  if (!shown.length) throw new Error('Insufficient displayed depth');
  return side === 'buy' ? Math.min(...shown) : Math.max(...shown);
}
export function vwap(levels: Level[], quantity: number, side: 'buy' | 'sell'): number {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Invalid quantity');
  const rows = levels.map(l => ({ px: Number(l.px), sz: Number(l.sz) }));
  if (rows.some(l => !Number.isFinite(l.px) || !Number.isFinite(l.sz) || l.px <= 0 || l.sz < 0))
    throw new Error('Invalid order-book level');
  rows.sort((a, b) => side === 'buy' ? a.px - b.px : b.px - a.px);
  let remaining = quantity, value = 0;
  for (const row of rows) {
    const fill = Math.min(remaining, row.sz);
    value += fill * row.px;
    remaining -= fill;
    if (remaining <= quantity * 1e-12) return value / quantity;
  }
  throw new Error('Insufficient displayed depth');
}
export function evaluate(spot: Book, perp: Book, quantity: number,
  costs: { spotFeeBps: number; perpFeeBps: number; exitBufferBps: number },
  now = Date.now(), maxAge = 5000, maxSkew = 1500) {
  for (const book of [spot, perp]) {
    if (!Number.isFinite(book.time) || now - book.time > maxAge || book.time > now + 1000)
      throw new Error('Stale or invalid book timestamp');
    const bid = vwap(book.levels[0], quantity, 'sell');
    const ask = vwap(book.levels[1], quantity, 'buy');
    if (bid >= ask) throw new Error('Crossed order book');
  }
  if (Math.abs(spot.time - perp.time) > maxSkew) throw new Error('Book timestamp skew');
  if (Object.values(costs).some(n => !Number.isFinite(n) || n < 0)) throw new Error('Invalid costs');
  const spotBuy = vwap(spot.levels[1], quantity, 'buy');
  const perpSell = vwap(perp.levels[0], quantity, 'sell');
  const notional = spotBuy * quantity;
  const entryFees = quantity * (spotBuy * costs.spotFeeBps + perpSell * costs.perpFeeBps) / 10000;
  // Exit fees approximate entry fees; buffer covers assumed exit spread/slippage.
  const estimatedCosts = 2 * entryFees + notional * costs.exitBufferBps / 10000;
  const basisValue = quantity * (perpSell - spotBuy);
  return { quantity, spotBuy, perpSell, notional, entryBasisBps: basisValue / notional * 10000,
    estimatedCosts, estimatedConvergencePnl: basisValue - estimatedCosts,
    estimatedNetBps: (basisValue - estimatedCosts) / notional * 10000 };
}
async function main() {
  const asset = process.env.ASSET ?? 'HYPE';
  const budget = setting('NOTIONAL_USDC', 100, 1);
  const threshold = setting('MIN_NET_BPS', 20, 0);
  const interval = setting('POLL_MS', 5000, 2000);
  const costs = { spotFeeBps: setting('SPOT_FEE_BPS', 10, 0),
    perpFeeBps: setting('PERP_FEE_BPS', 5, 0), exitBufferBps: setting('EXIT_BUFFER_BPS', 15, 0) };
  const [spotMeta, perpMeta] = await Promise.all([
    info<SpotMeta>({ type: 'spotMeta' }),
    info<{ universe: { name: string; szDecimals: number }[] }>({ type: 'meta' })]);
  const matches = spotMeta.universe.filter(pair => {
    const base = spotMeta.tokens.find(t => t.index === pair.tokens[0]);
    const quote = spotMeta.tokens.find(t => t.index === pair.tokens[1]);
    return base?.name === asset && quote?.name === 'USDC';
  });
  if (matches.length !== 1) throw new Error('Expected exactly one matching spot/USDC pair');
  const pair = matches[0]!;
  const base = spotMeta.tokens.find(t => t.index === pair.tokens[0])!;
  const perp = perpMeta.universe.find(t => t.name === asset);
  if (!perp) throw new Error('Matching native perpetual not found');
  const spotCoin = pair.name === 'PURR/USDC' ? pair.name : `@${pair.index}`;
  const decimals = Math.min(base.szDecimals, perp.szDecimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) throw new Error('Invalid size precision');
  console.log(JSON.stringify({ mode: 'PAPER_SCAN', asset, spotCoin, budget, threshold, costs,
    note: 'Independent estimates; no orders, positions, funding accrual or realized PnL.' }));
  let running = true;
  process.once('SIGINT', () => { running = false; });
  process.once('SIGTERM', () => { running = false; });
  do {
    try {
      const [spot, future] = await Promise.all([
        info<Book>({ type: 'l2Book', coin: spotCoin }),
        info<Book>({ type: 'l2Book', coin: asset })]);
      if (spot.coin !== spotCoin || future.coin !== asset) throw new Error('Unexpected book market');
      const bestAsk = touch(spot.levels[1], 'buy');
      let quantity = Math.floor(budget / bestAsk * 10 ** decimals) / 10 ** decimals;
      // Reduce quantity if walking depth takes the spot purchase above the budget.
      for (let attempt = 0; attempt < 10; attempt++) {
        const cost = vwap(spot.levels[1], quantity, 'buy') * quantity;
        if (cost <= budget) break;
        quantity = Math.floor(quantity * budget / cost * 10 ** decimals) / 10 ** decimals;
      }
      const result = evaluate(spot, future, quantity, costs);
      if (result.notional > budget + 1e-8) throw new Error('Budget exceeded');
      console.log(JSON.stringify({ at: new Date().toISOString(),
        signal: result.estimatedNetBps >= threshold ? 'BASIS_CANDIDATE' : 'WAIT', ...result }));
    } catch (error) {
      console.error(JSON.stringify({ at: new Date().toISOString(), error: String(error) }));
    }
    if (process.argv.includes('--once')) break;
    if (running) await new Promise(resolve => setTimeout(resolve, interval));
  } while (running);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(String(error)); process.exitCode = 1; });
