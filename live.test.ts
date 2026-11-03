import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BotError, Engine, closePnl, down, exitReason, higherLimit, limitPrice, liquidationDistanceBps,
  mustHaltAfterError, retryableReadError, selectHypePair, standardAbstraction, terminalOrderStatus,
  wireSize } from './live-core.ts';
import type { Order, Port, Snapshot, State } from './live-core.ts';
import { saveJournal } from './live.ts';
const costs = { minNetBps: 30, spotFeeBps: 10, perpFeeBps: 5, exitBufferBps: 15 };
function fixture() {
  const state: State = { version: 1, network: 'testnet', user: '0xaccount', market: {
    spotId: 10107, perpId: 5, spotCoin: '@107', token: 150, spotDecimals: 2, perpDecimals: 2 },
    phase: 'flat', entryEquity: 0, startedAt: 0, events: [] };
  const account: Snapshot = { spot: 0, spotFree: 0, cash: 100, spotUsdc: 100, perp: 0,
    perpEquity: 100, equity: 200, marginFree: 100, perpMark: 102, liquidationPx: null,
    openOrders: 0, otherPositions: false };
  const orders: Order[] = [];
  const saved: State[] = [];
  const port: Port = {
    snapshot: async () => ({ ...account }),
    quote: async (spot, buy) => ({ vwap: spot ? 100 : 102,
      limit: spot ? (buy ? '100.1' : '99.9') : (buy ? '102.1' : '101.9'), at: Date.now() }),
    save: s => { saved.push(structuredClone(s)); },
    status: async () => 'filled',
    submit: async (o) => {
      // Verify durable intent exists before a signed request is made.
      assert.equal(saved.at(-1)?.pending?.order.c, o.c);
      orders.push(o);
      const size = Number(o.s);
      if (o.a === state.market.spotId) {
        account.spot += o.b ? size : -size; account.spotFree = account.spot;
      } else account.perp += o.b ? size : -size;
      return { filledSize: size, avgPx: o.a === state.market.spotId ? 100 : 102 };
    }
  };
  return { state, account, orders, saved, port, engine: new Engine(port, state) };
}
test('entry then close: spot buy, perp short, reduce-only cover, spot sell', async () => {
  const f = fixture();
  await f.engine.enter(0.2, 25, costs);
  assert.equal(f.state.phase, 'open'); assert.equal(f.account.perp, -0.2);
  await f.engine.close(); assert.equal(f.state.phase, 'closed');
  assert.deepEqual(f.orders.map(o => [o.a, o.b, o.r]),
    [[10107, true, false], [5, false, false], [5, true, true], [10107, false, false]]);
  await assert.rejects(() => f.engine.enter(0.2, 25, costs), /One position/);
});
test('no order when cash, worst-case notional, or net edge fails', async () => {
  const f = fixture(); f.account.cash = 1;
  await assert.rejects(() => f.engine.enter(0.2, 25, costs), /guard/);
  f.account.cash = 100;
  await assert.rejects(() => f.engine.enter(0.3, 25, costs), /guard/);
  await assert.rejects(() => f.engine.enter(0.2, 25, { ...costs, minNetBps: 300 }), /edge/);
  assert.equal(f.orders.length, 0);
});
test('partial spot fill hedges actual inventory', async () => {
  const f = fixture(), original = f.port.submit;
  f.port.submit = async (o, t) => original(o.a === 10107 && o.b ? { ...o, s: '0.10' } : o, t);
  await f.engine.enter(0.2, 25, costs);
  assert.equal(f.orders[1]?.s, '0.1'); assert.equal(f.state.phase, 'open');
});
test('partial hedge triggers full unwind', async () => {
  const f = fixture(), original = f.port.submit;
  f.port.submit = async (o, t) => original(o.a === 5 && !o.b ? { ...o, s: '0.10' } : o, t);
  await f.engine.enter(0.2, 25, costs);
  assert.equal(f.state.phase, 'closed'); assert.equal(f.account.perp, 0); assert.equal(f.account.spot, 0);
});
test('explicit zero-fill hedge rejection unwinds purchased spot', async () => {
  const f = fixture(), original = f.port.submit;
  f.port.submit = async (o, t) => o.a === 5 && !o.b ? { filledSize: 0, avgPx: 0 } : original(o, t);
  await f.engine.enter(0.2, 25, costs);
  assert.equal(f.state.phase, 'closed'); assert.equal(f.account.spot, 0);
});
test('timeout after accepted spot order persists pending and forbids retry', async () => {
  const f = fixture(), original = f.port.submit;
  f.port.submit = async (o, t) => { await original(o, t); throw new Error('timeout'); };
  await assert.rejects(() => f.engine.enter(0.2, 25, costs), /timeout/);
  assert.equal(f.account.spot, 0.2); assert.ok(f.state.pending);
  await assert.rejects(() => f.engine.close(), /Reconcile/);
  assert.equal(f.orders.length, 1);
  f.state.pending!.expiresAt = Date.now() - 3000;
  f.port.submit = original;
  const restarted = new Engine(f.port, structuredClone(f.state));
  await restarted.reconcilePending(); await restarted.close();
  assert.equal(f.orders.filter(o => o.a === 10107 && o.b).length, 1);
  assert.equal(restarted.state.phase, 'closed');
});
test('unknown order status blocks recovery', async () => {
  const f = fixture();
  f.state.pending = { order: { a: 5, b: false, p: '100', s: '0.2', r: false,
    t: { limit: { tif: 'Ioc' } }, c: '0x00000000000000000000000000000001' }, expiresAt: 0 };
  f.port.status = async () => 'unknownOid';
  await assert.rejects(() => f.engine.reconcilePending(), /Unresolved/);
  assert.ok(f.state.pending); assert.equal(f.orders.length, 0);
});
test('inconsistent fill/account snapshot halts without selling spot or duplicating hedge', async () => {
  const f = fixture(), original = f.port.submit;
  f.port.submit = async (o, t) => {
    const result = await original(o, t);
    if (o.a === 5 && !o.b) f.account.perp = 0; // stale account view
    return result;
  };
  await assert.rejects(() => f.engine.enter(0.2, 25, costs), /not reconciled/);
  assert.equal(f.orders.length, 2); assert.equal(f.state.phase, 'opening');
});
test('partial perp close does not sell spot; a later close resumes from balances', async () => {
  const f = fixture(), original = f.port.submit;
  await f.engine.enter(0.2, 25, costs);
  f.port.submit = async (o, t) => original(o.a === 5 && o.b ? { ...o, s: '0.10' } : o, t);
  await assert.rejects(() => f.engine.close(), /incomplete/);
  assert.equal(f.account.spot, 0.2); assert.equal(f.state.phase, 'closing');
  f.port.submit = original; await f.engine.close();
  assert.equal(f.state.phase, 'closed');
});
test('price/size formatting stays inside slippage limits and exchange tick rules', () => {
  assert.equal(down(1.2399, 2), 1.23);
  assert.equal(wireSize(1.239, 2), '1.23');
  assert.equal(wireSize(0.2, 2), '0.2');
  for (const p of [0.000123456, 0.123456, 12.3456, 999.999, 123456.78]) {
    for (const buy of [true, false]) {
      const wire = limitPrice(p, 2, true, buy);
      assert.match(wire, /^[0-9]+(\.[0-9]*[1-9])?$/);
      const n = Number(wire);
      assert.ok(buy ? n <= p + 1e-9 : n >= p - 1e-9);
      if (wire.includes('.')) {
        const figures = wire.replace('.', '').replace(/^0+/, '').length;
        assert.ok(figures <= 5);
      }
    }
  }
  // Official examples: 1234.5 is valid and 1234.56 is not; integers above 1e5 are valid.
  assert.equal(limitPrice(1234.56, 0, false, true), '1234.5');
  assert.equal(limitPrice(1234.56, 0, false, false), '1234.6');
  assert.equal(limitPrice(0.0012345, 0, false, true), '0.001234');
  assert.equal(limitPrice(0.0012345, 0, false, false), '0.001235');
  assert.equal(limitPrice(123456.7, 0, false, true), '123456');
  assert.equal(limitPrice(123456.7, 0, false, false), '123457');
  assert.equal(higherLimit('101.90', '101.8'), '101.90');
  assert.equal(higherLimit('101.8', '102'), '102');
});
test('journal round trip preserves pending client order ID and phase', () => {
  const f = fixture(); const dir = mkdtempSync(join(tmpdir(), 'hl-journal-'));
  try {
    f.state.phase = 'opening';
    const file = join(dir, 'state.json'); saveJournal(file, f.state);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), f.state);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('a failed balance read does not mark an open position as closing', async () => {
  const f = fixture();
  await f.engine.enter(0.2, 25, costs);
  f.port.snapshot = async () => { throw new BotError('Stale or invalid book'); };
  await assert.rejects(() => f.engine.close(), /Stale/);
  assert.equal(f.state.phase, 'open');
  assert.equal(f.state.pending, undefined);
});
test('missed spot IOC stays flat and can be attempted again', async () => {
  const f = fixture();
  f.port.submit = async () => ({ filledSize: 0, avgPx: 0 });
  await f.engine.enter(0.2, 25, costs);
  assert.equal(f.state.phase, 'flat');
  assert.equal(f.state.entryEquity, 0);
  assert.equal(f.account.spot, 0);
  assert.equal(f.state.pending, undefined);
});
test('positive fill without a price halts for reconciliation', async () => {
  const f = fixture();
  f.port.submit = async () => ({ filledSize: 0.2, avgPx: 0 });
  await assert.rejects(() => f.engine.enter(0.2, 25, costs), /Invalid filled/);
  assert.equal(f.state.phase, 'opening');
  assert.ok(f.state.pending);
});
test('exit, liquidation, and recovery helpers', () => {
  const base = { stopRequested: false, closeBasisBps: 20, exitBasisBps: 5, estimatedPnl: 1,
    stopLoss: 2, heldMs: 0, maxHoldMs: 1000, liquidationDistanceBps: 5000, liqBufferBps: 1000 };
  assert.equal(exitReason(base), null);
  assert.equal(exitReason({ ...base, liquidationDistanceBps: 500 }), 'liquidation');
  assert.equal(exitReason({ ...base, closeBasisBps: 5 }), 'basis');
  assert.equal(exitReason({ ...base, estimatedPnl: -2 }), 'loss');
  assert.equal(exitReason({ ...base, heldMs: 1000 }), 'hold');
  assert.equal(exitReason({ ...base, stopRequested: true, closeBasisBps: 5 }), 'stop');
  assert.equal(liquidationDistanceBps(100, 110), 1000);
  assert.equal(liquidationDistanceBps(100, null), null);
  const pnl = closePnl({ perpEquity: 100, spotUsdc: 75, spotQty: 0.25, spotExitPx: 100, perpQty: 0.25,
    perpMark: 100, perpExitPx: 110, spotFeeBps: 0, perpFeeBps: 0, entryEquity: 200 });
  assert.ok(Math.abs(pnl + 2.5) < 1e-9);
  assert.equal(standardAbstraction('default'), true);
  assert.equal(standardAbstraction('disabled'), true);
  assert.equal(standardAbstraction('unifiedAccount'), false);
  assert.equal(standardAbstraction('portfolioMargin'), false);
  for (const status of ['filled', 'canceled', 'rejected', 'scheduledCancel', 'minTradeNtlRejected', 'iocCancelRejected'])
    assert.equal(terminalOrderStatus(status), true);
  assert.equal(terminalOrderStatus('open'), false);
  assert.equal(terminalOrderStatus('triggered'), false);
  assert.equal(terminalOrderStatus('unknownOid'), false);
  const open = fixture().state;
  open.phase = 'open';
  assert.equal(mustHaltAfterError(open), false);
  open.phase = 'closing';
  assert.equal(mustHaltAfterError(open), true);
  assert.equal(retryableReadError(new BotError('Stale or invalid book')), true);
  assert.equal(retryableReadError(new BotError('Notional or cash/margin guard failed')), false);
  assert.equal(retryableReadError(new Error('socket hang up')), true);
});
test('CLI live command fails before network access unless explicitly enabled', () => {
  const result = spawnSync(process.execPath, ['live.ts', '--run'], {
    cwd: new URL('.', import.meta.url), env: { ...process.env, LIVE_TRADING: 'false' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set LIVE_TRADING=true/);
});
test('mainnet orders require a second explicit confirmation and do not reach the network', () => {
  const result = spawnSync(process.execPath, ['live.ts', '--run'], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, LIVE_TRADING: 'true', NETWORK: 'mainnet', CONFIRM_MAINNET: 'false' },
    encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CONFIRM_MAINNET=true/);
  assert.equal(result.stdout, '');
});
test('SDK signs an IOC with client ID and server expiry using a mocked transport', async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const transport = new HttpTransport({ isTestnet: true });
  const expiresAfter = Date.now() + 5000;
  const order: Order = { a: 5, b: false, p: '100', s: '0.2', r: false,
    t: { limit: { tif: 'Ioc' } }, c: '0x00000000000000000000000000000001' };
  let called = false;
  transport.request = async <T>(endpoint: string, payload: unknown): Promise<T> => {
    called = true; assert.equal(endpoint, 'exchange');
    const signed = payload as { action: { type: string; orders: Order[] }; expiresAfter: number;
      signature: { r: string; s: string; v: number } };
    assert.equal(signed.action.type, 'order'); assert.deepEqual(signed.action.orders, [order]);
    assert.equal(signed.expiresAfter, expiresAfter); assert.match(signed.signature.r, /^0x[0-9a-f]{64}$/);
    return { status: 'ok', response: { type: 'order', data: { statuses: [
      { filled: { totalSz: '0.2', avgPx: '100', oid: 123 } }] } } } as T;
  };
  const exchange = new ExchangeClient({ transport, wallet });
  const result = await exchange.order({ orders: [order], grouping: 'na' }, { expiresAfter });
  assert.equal(result.status, 'ok'); assert.equal(called, true);
});
test('discovers noncanonical HYPE/USDC and rejects ambiguous markets or wrong token identity', () => {
  const meta = { tokens: [
    { name: 'HYPE', index: 150, szDecimals: 2, tokenId: '0x123', isCanonical: false },
    { name: 'USDC', index: 0, szDecimals: 8, tokenId: '0x456', isCanonical: true }],
    universe: [{ name: '@107', index: 107, tokens: [150, 0], isCanonical: false }] };
  assert.equal(selectHypePair(meta, '0x123').pair.index, 107);
  assert.throws(() => selectHypePair(meta, '0x999'), /uniquely/);
  meta.universe.push({ ...meta.universe[0]!, index: 108 });
  assert.throws(() => selectHypePair(meta), /uniquely/);
});
