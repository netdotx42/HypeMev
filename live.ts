import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { ApiRequestError } from '@nktkas/hyperliquid/api/exchange';
import { privateKeyToAccount } from 'viem/accounts';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BotError, Engine, closePnl, conservativeNetBps, down, exitReason, limitPrice,
  liquidationDistanceBps, mustHaltAfterError, requireSnapshot, retryableReadError, selectHypePair,
  standardAbstraction } from './live-core.ts';
import type { Market, Order, Port, QuotePurpose, Snapshot, State } from './live-core.ts';
import { touch, vwap } from './bot.ts';

function num(name: string, fallback: number, min: number, max = Infinity) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new BotError(`Invalid ${name}`);
  return value;
}
function n(value: string | number): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new BotError('Invalid API numeric field');
  return result;
}
export function saveJournal(file: string, state: State) {
  const temp = `${file}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(state, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  const parent = openSync(dirname(file), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
async function main() {
  const command = process.argv[2] ?? '--check';
  if (!['--check', '--run', '--close'].includes(command)) throw new BotError('Use --check, --run or --close');
  if (command !== '--check' && process.env.LIVE_TRADING !== 'true')
    throw new BotError('Set LIVE_TRADING=true to enable signed orders');
  const network = process.env.NETWORK ?? 'testnet';
  if (!['mainnet', 'testnet'].includes(network)) throw new BotError('NETWORK must be mainnet or testnet');
  if (network === 'mainnet' && command !== '--check' && process.env.CONFIRM_MAINNET !== 'true')
    throw new BotError('Set CONFIRM_MAINNET=true to allow mainnet orders');
  const user = process.env.ACCOUNT_ADDRESS;
  if (!user || !/^0x[0-9a-fA-F]{40}$/.test(user)) throw new BotError('Set ACCOUNT_ADDRESS to the funded master account');
  const address = user as `0x${string}`;
  const transport = new HttpTransport({ isTestnet: network === 'testnet', timeout: 10000 });
  const info = new InfoClient({ transport });
  const maxNotional = num('MAX_NOTIONAL_USDC', 50, 12, 1000);
  const notional = num('NOTIONAL_USDC', 25, 12, maxNotional);
  const minNetBps = num('MIN_NET_BPS', 30, 0, 10000);
  const exitBasisBps = num('EXIT_BASIS_BPS', 5, -10000, 10000);
  const slippageBps = num('SLIPPAGE_BPS', 10, 1, 100);
  const exitSlippageBps = num('EXIT_SLIPPAGE_BPS', 50, 1, 500);
  const exitBufferBps = num('EXIT_BUFFER_BPS', 15, 0, 10000);
  const liqBufferBps = num('LIQ_BUFFER_BPS', 1000, 0, 5000);
  const stopLoss = num('MAX_LOSS_USDC', 2, 0.01, 1000);
  const maxHold = num('MAX_HOLD_SECONDS', 3600, 10, 86400) * 1000;
  const poll = num('POLL_MS', 5000, 2000, 60000);
  const [spotMeta, meta, abstraction, fees] = await Promise.all([
    info.spotMeta(), info.meta(), info.userAbstraction({ user: address }), info.userFees({ user: address })]);
  // Unified and portfolio-margin modes pool balances, so the equity and margin checks would be wrong.
  if (!standardAbstraction(abstraction))
    throw new BotError(`Unsupported account abstraction ${abstraction}; requires default or disabled (separate spot and perp balances)`);
  // HYPE is marked isCanonical=false in spotMeta. Identify it by token ID on mainnet,
  // not the canonical flag; discover asset indices independently on each network.
  const { pair, token } = selectHypePair(spotMeta,
    network === 'mainnet' ? '0x0d01dc56dcaaca66ad901c959b4011ec' : undefined);
  const perpId = meta.universe.findIndex(p => p.name === 'HYPE');
  const perpMeta = meta.universe[perpId];
  if (!perpMeta || perpMeta.isDelisted || perpMeta.onlyIsolated) throw new BotError('Supported HYPE perpetual not found');
  const market: Market = { spotId: 10000 + pair.index, perpId, spotCoin: `@${pair.index}`,
    token: token.index, spotDecimals: token.szDecimals, perpDecimals: perpMeta.szDecimals };
  const sharedDecimals = Math.min(market.spotDecimals, market.perpDecimals);
  const costs = { minNetBps, spotFeeBps: Math.max(0, n(fees.userSpotCrossRate) * 10000),
    perpFeeBps: Math.max(0, n(fees.userCrossRate) * 10000), exitBufferBps };
  const quote: Port['quote'] = async (spot, buy, size, purpose: QuotePurpose = 'entry') => {
    const coin = spot ? market.spotCoin : 'HYPE';
    const book = await info.l2Book({ coin });
    if (!book || book.coin !== coin || !Number.isFinite(book.time) ||
      Date.now() - book.time > 3000 || book.time > Date.now() + 1000) throw new BotError('Stale or invalid book');
    let bid: number, ask: number;
    try { bid = touch(book.levels[0], 'sell'); ask = touch(book.levels[1], 'buy'); }
    catch (error) { throw new BotError(error instanceof Error ? error.message : 'Invalid book'); }
    if (!(bid > 0) || !(ask > 0) || bid >= ask) throw new BotError('Crossed book');
    const slippage = purpose === 'exit' ? exitSlippageBps : slippageBps;
    const limit = limitPrice((buy ? ask : bid) * (1 + (buy ? 1 : -1) * slippage / 10000),
      spot ? market.spotDecimals : market.perpDecimals, spot, buy);
    const limitN = n(limit);
    const eligible = book.levels[buy ? 1 : 0].filter(l => buy ? n(l.px) <= limitN : n(l.px) >= limitN);
    let average: number;
    try { average = vwap(eligible, size, buy ? 'buy' : 'sell'); }
    catch (error) {
      // Entry refuses to cross a book that cannot fill inside the slippage cap.
      // Exit still sends the capped IOC: a thin book should not trap the position.
      if (purpose === 'entry') throw new BotError(error instanceof Error ? error.message : 'Insufficient displayed depth');
      const shown = eligible.reduce((sum, level) => sum + n(level.sz), 0);
      if (!(shown > 0)) throw new BotError('Insufficient displayed depth');
      average = vwap(eligible, Math.min(size, shown), buy ? 'buy' : 'sell');
    }
    return { vwap: average, limit, at: book.time };
  };
  const snapshot: Port['snapshot'] = async () => {
    const [spot, perp, orders] = await Promise.all([info.spotClearinghouseState({ user: address }),
      info.clearinghouseState({ user: address }), info.frontendOpenOrders({ user: address })]);
    if (spot.portfolioMarginEnabled) throw new BotError('Portfolio margin accounts are not supported');
    if (Date.now() - perp.time > 10000 || perp.time > Date.now() + 1000) throw new BotError('Stale account snapshot');
    const balance = spot.balances.find(b => 'token' in b && b.token === token.index);
    const cash = spot.balances.find(b => 'token' in b && b.token === pair.tokens[1]);
    const position = perp.assetPositions.find(p => p.position.coin === 'HYPE')?.position;
    const total = balance ? n(balance.total) : 0;
    const spotFree = total - (balance ? n(balance.hold) : 0);
    const perpSize = position ? n(position.szi) : 0;
    const mark = position && perpSize !== 0 ? n(position.positionValue) / Math.abs(perpSize) : 0;
    const liquidationPx = position?.liquidationPx ? n(position.liquidationPx) : null;
    const spotUsdc = cash ? n(cash.total) : 0;
    const perpEquity = n(perp.marginSummary.accountValue);
    // Spot HYPE is marked by the caller. A stale book cannot block a balance read.
    const s: Snapshot = { spot: total, spotFree, cash: cash ? spotUsdc - n(cash.hold) : 0, spotUsdc,
      perp: perpSize, perpEquity, equity: perpEquity + spotUsdc, marginFree: n(perp.withdrawable),
      perpMark: mark, liquidationPx, openOrders: orders.length,
      otherPositions: perp.assetPositions.some(p => p.position.coin !== 'HYPE' && n(p.position.szi) !== 0) ||
        spot.balances.some(b => (!('token' in b) || (b.token !== token.index && b.token !== pair.tokens[1])) && n(b.total) !== 0) };
    requireSnapshot(s); return s;
  };
  let builderCheckedAt = 0;
  const assertNoBuilderDexExposure = async (force = false) => {
    if (!force && Date.now() - builderCheckedAt < 60_000) return;
    const names = (await info.perpDexs()).flatMap(dex => dex?.name ? [dex.name] : []);
    const exposed = await Promise.all(names.map(async name => {
      const [state, orders] = await Promise.all([
        info.clearinghouseState({ user: address, dex: name }),
        info.frontendOpenOrders({ user: address, dex: name })]);
      return orders.length > 0 || state.assetPositions.some(p => n(p.position.szi) !== 0);
    }));
    builderCheckedAt = Date.now();
    if (exposed.some(Boolean)) throw new BotError('Dedicated account required: builder-dex positions or orders');
  };
  console.log(JSON.stringify({ network, account: address, asset: 'HYPE', market, notional, maxNotional,
    costs, slippageBps, exitSlippageBps, liqBufferBps, stopLoss, maxHoldSeconds: maxHold / 1000 }));
  if (command === '--check') {
    const check = await snapshot();
    await assertNoBuilderDexExposure(true);
    console.log(JSON.stringify({ check, builderDexes: 'clear', trading: 'disabled; no orders submitted' })); return;
  }
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new BotError('Set AGENT_PRIVATE_KEY locally; never share it in chat');
  const wallet = privateKeyToAccount(key as `0x${string}`);
  if (wallet.address.toLowerCase() === user.toLowerCase()) throw new BotError('Use an approved API agent key, not a master wallet key');
  const agents = await info.extraAgents({ user: address });
  if (!agents.some(a => a.address.toLowerCase() === wallet.address.toLowerCase() &&
    (a.validUntil === null || a.validUntil > Date.now() + 60000)))
    throw new BotError('Approve this named API agent for the account on the selected network first');
  const exchange = new ExchangeClient({ transport, wallet });
  const file = resolve(process.env.STATE_FILE ?? `state-${network}-${user.toLowerCase()}.json`);
  const lock = `${file}.lock`;
  const lockFd = openSync(lock, 'wx', 0o600);
  try {
    writeFileSync(lockFd, String(process.pid)); fsyncSync(lockFd);
    let state: State;
    if (existsSync(file)) {
      state = JSON.parse(readFileSync(file, 'utf8')) as State;
      if (state.version !== 1 || state.network !== network || state.user !== user.toLowerCase() ||
        JSON.stringify(state.market) !== JSON.stringify(market) || !Array.isArray(state.events) ||
        !['flat', 'opening', 'open', 'closing', 'closed'].includes(state.phase) ||
        !Number.isFinite(state.entryEquity) || !Number.isFinite(state.startedAt)) throw new BotError('Journal identity/schema mismatch');
    } else {
      if (command === '--close') throw new BotError('Close requires the original trade journal');
      state = { version: 1, network, user: user.toLowerCase(), market, phase: 'flat',
        startedAt: 0, entryEquity: 0, events: [] };
      saveJournal(file, state);
    }
    const port: Port = { snapshot, quote, save: state => saveJournal(file, state),
      status: async cloid => {
        const response = await info.orderStatus({ user: address, oid: cloid });
        return response.status === 'order' ? response.order.status : 'unknownOid';
      },
      submit: async (order: Order, expiresAt) => {
        let response;
        try {
          response = await exchange.order({ orders: [order], grouping: 'na' }, { expiresAfter: expiresAt });
        } catch (error) {
          if (error instanceof ApiRequestError) {
            const raw = error.response as { status?: string; response?: { type?: string; data?: { statuses?: unknown[] } } };
            const statuses = raw.response?.data?.statuses;
            // Only an explicit single-order rejection is safely a zero fill.
            if (raw.status === 'ok' && raw.response?.type === 'order' && statuses?.length === 1 &&
              typeof statuses[0] === 'object' && statuses[0] !== null && 'error' in statuses[0])
              return { filledSize: 0, avgPx: 0, raw: error.response };
          }
          throw error;
        }
        // The SDK throws on exchange errors. IOC should return filled; never accept a resting order.
        const statuses = response.response.data.statuses;
        if (statuses.length !== 1 || typeof statuses[0] !== 'object' || !('filled' in statuses[0]))
          throw new BotError('Unexpected IOC response; reconcile journal before continuing');
        const filled = statuses[0].filled;
        return { filledSize: n(filled.totalSz), avgPx: n(filled.avgPx), raw: response };
      } };
    const engine = new Engine(port, state);
    if (command === '--close') { await engine.reconcilePending(); await engine.close(); return; }
    if (state.pending || state.phase === 'opening' || state.phase === 'closing')
      throw new BotError('Incomplete operation in journal. Use --close for recovery; do not delete state.');
    if (state.phase === 'closed') throw new BotError('This cycle is complete. Archive journal before starting another.');
    let stop = false;
    process.once('SIGINT', () => { stop = true; });
    process.once('SIGTERM', () => { stop = true; });
    const isClosed = () => engine.state.phase === 'closed';
    let failures = 0;
    while (!isClosed()) {
      try {
        if (state.phase === 'flat') {
          if (stop) return;
          const spotBook = await info.l2Book({ coin: market.spotCoin });
          if (!spotBook || spotBook.coin !== market.spotCoin || !Number.isFinite(spotBook.time) ||
            Date.now() - spotBook.time > 3000 || spotBook.time > Date.now() + 1000)
            throw new BotError('Stale or invalid book');
          let bestAsk: number;
          try { bestAsk = touch(spotBook.levels[1], 'buy'); }
          catch (error) { throw new BotError(error instanceof Error ? error.message : 'Invalid book'); }
          const ceiling = bestAsk * (1 + slippageBps / 10000);
          const size = down(notional / ceiling, sharedDecimals);
          if (size * ceiling < 11) throw new BotError('Increase notional: rounded trade below minimum buffer');
          const [s, p] = await Promise.all([quote(true, true, size, 'entry'), quote(false, false, size, 'entry')]);
          const estimate = conservativeNetBps(n(s.limit), n(p.limit), costs);
          console.log(JSON.stringify({ phase: 'flat', conservativeNetBps: estimate }));
          if (estimate >= minNetBps && !stop) {
            const before = await snapshot();
            if (before.spot !== 0 || before.perp !== 0) throw new BotError('Entry requires an empty dedicated account');
            await assertNoBuilderDexExposure(true);
            await exchange.updateLeverage({ asset: perpId, isCross: true, leverage: 1 });
            const active = await info.activeAssetData({ user: address, coin: 'HYPE' });
            if (active.leverage.type !== 'cross' || active.leverage.value !== 1)
              throw new BotError('HYPE leverage is not 1x cross');
            await engine.enter(size, Math.min(notional, maxNotional), costs);
          }
        } else if (state.phase === 'open') {
          await assertNoBuilderDexExposure();
          const held = await snapshot();
          if (held.perp >= 0 || Math.abs(held.spot + held.perp) > 10 ** -market.perpDecimals + 1e-8) {
            engine.record('Exposure mismatch; unwind'); await engine.close(); continue;
          }
          const q = Math.abs(held.perp);
          const [s, p] = await Promise.all([quote(true, false, q, 'exit'), quote(false, true, q, 'exit')]);
          if (Math.abs(s.at - p.at) > 1500) throw new BotError('Exit book skew');
          const closeBasisBps = (p.vwap - s.vwap) / s.vwap * 10000;
          // Quotes already ignore prices beyond the exit limit, so this VWAP is a fill the IOC can reach.
          const estimatedPnl = closePnl({ perpEquity: held.perpEquity, spotUsdc: held.spotUsdc, spotQty: held.spot,
            spotExitPx: s.vwap, perpQty: q, perpMark: held.perpMark, perpExitPx: p.vwap,
            spotFeeBps: costs.spotFeeBps, perpFeeBps: costs.perpFeeBps, entryEquity: state.entryEquity });
          const reason = exitReason({ stopRequested: stop, closeBasisBps, exitBasisBps, estimatedPnl, stopLoss,
            heldMs: Date.now() - state.startedAt, maxHoldMs: maxHold,
            liquidationDistanceBps: liquidationDistanceBps(held.perpMark, held.liquidationPx), liqBufferBps });
          console.log(JSON.stringify({ phase: 'open', closeBasisBps, estimatedPnl, liquidationPx: held.liquidationPx, reason, stop }));
          if (reason) await engine.close();
        } else throw new BotError(`Cannot resume phase ${state.phase}`);
        failures = 0;
        if (!isClosed()) await new Promise(resolve => setTimeout(resolve, poll));
      } catch (error) {
        if (mustHaltAfterError(engine.state) || !retryableReadError(error)) throw error;
        failures += 1;
        const wait = Math.min(60_000, poll * Math.min(failures, 8));
        console.error(JSON.stringify({ at: new Date().toISOString(), retryInMs: wait,
          error: error instanceof BotError ? error.message : 'Read failed; will retry' }));
        if (stop && engine.state.phase === 'flat') return;
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  } finally { closeSync(lockFd); unlinkSync(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => {
    // SDK errors can contain signed payloads. Do not log the raw error or private key.
    console.error(error instanceof BotError ? error.message : 'Stopped: API or filesystem operation failed. Inspect journal and account; use --check or --close.');
    process.exitCode = 1;
  });
