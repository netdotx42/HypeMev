import { randomBytes } from 'node:crypto';
export class BotError extends Error {}
export type Fill = { filledSize: number; avgPx: number; raw?: unknown };
export function selectHypePair(meta: {
  tokens: { name: string; index: number; szDecimals: number; tokenId: string }[];
  universe: { name: string; index: number; tokens: number[] }[];
}, expectedTokenId?: string) {
  const pairs = meta.universe.filter(pair => {
    const base = meta.tokens.find(t => t.index === pair.tokens[0]);
    const quote = meta.tokens.find(t => t.index === pair.tokens[1]);
    return base?.name === 'HYPE' && quote?.name === 'USDC' &&
      (!expectedTokenId || base.tokenId.toLowerCase() === expectedTokenId.toLowerCase());
  });
  if (pairs.length !== 1) throw new BotError('HYPE/USDC pair not uniquely found');
  const pair = pairs[0]!;
  return { pair, token: meta.tokens.find(t => t.index === pair.tokens[0])! };
}

export type Order = { a: number; b: boolean; p: string; s: string; r: boolean;
  t: { limit: { tif: 'Ioc' } }; c: `0x${string}` };
export type Market = { spotId: number; perpId: number; spotCoin: string; token: number;
  spotDecimals: number; perpDecimals: number };
export type Snapshot = { spot: number; spotFree: number; cash: number; spotUsdc: number; perp: number;
  perpEquity: number; equity: number; marginFree: number; perpMark: number;
  liquidationPx: number | null; openOrders: number; otherPositions: boolean };
export type QuotePurpose = 'entry' | 'exit';
export type State = { version: 1; network: string; user: string; market: Market;
  phase: 'flat' | 'opening' | 'open' | 'closing' | 'closed'; startedAt: number;
  entryEquity: number; pending?: { order: Order; expiresAt: number }; events: unknown[] };
export type Port = {
  snapshot(): Promise<Snapshot>;
  quote(spot: boolean, buy: boolean, size: number, purpose?: QuotePurpose): Promise<{ vwap: number; limit: string; at: number }>;
  submit(order: Order, expiresAt: number): Promise<Fill>;
  status(cloid: `0x${string}`): Promise<string>;
  save(state: State): void;
};
const SCALE = 18;
function scaled(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new BotError('Invalid size/precision');
  if (value === 0) return 0n;
  const match = /^(\d)\.(\d+)e([+-]\d+)$/.exec(value.toExponential(15));
  if (!match) throw new BotError('Invalid size/precision');
  const digits = match[1] + match[2];
  const pow = BigInt(Number(match[3]) - digits.length + 1 + SCALE);
  const base = BigInt(digits);
  return pow >= 0n ? base * 10n ** pow : base / 10n ** -pow;
}
function snapTicks(value: number, decimalPlaces: number, mode: 'floor' | 'ceil'): bigint {
  const unit = 10n ** BigInt(SCALE - decimalPlaces);
  const raw = scaled(value);
  const rem = raw % unit;
  return mode === 'ceil' && rem > 0n ? raw / unit + 1n : raw / unit;
}
function formatTicks(ticks: bigint, decimalPlaces: number): string {
  const raw = ticks.toString().padStart(decimalPlaces + 1, '0');
  if (decimalPlaces === 0) return raw.replace(/^0+(?=\d)/, '') || '0';
  const whole = raw.slice(0, -decimalPlaces).replace(/^0+(?=\d)/, '') || '0';
  const frac = raw.slice(-decimalPlaces).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
export function wireSize(size: number, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new BotError('Invalid size/precision');
  const ticks = snapTicks(size, decimals, 'floor');
  if (ticks <= 0n) throw new BotError('Order size rounds to zero');
  return formatTicks(ticks, decimals);
}
export function down(size: number, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new BotError('Invalid size/precision');
  return Number(formatTicks(snapTicks(size, decimals, 'floor'), decimals));
}
function significantFigures(wire: string): number {
  if (!wire.includes('.')) return 0;
  return wire.replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length;
}
export function limitPrice(price: number, szDecimals: number, spot: boolean, buy: boolean): string {
  if (!Number.isFinite(price) || price <= 0) throw new BotError('Invalid price');
  if (!Number.isInteger(szDecimals) || szDecimals < 0 || szDecimals > 8) throw new BotError('Invalid price precision');
  const maxDecimals = (spot ? 8 : 6) - szDecimals;
  if (maxDecimals < 0) throw new BotError('Invalid price precision');
  // 5 significant figures, then the spot/perp decimal cap. Integers are always legal,
  // including prices at or above 1e5 whose sig-fig grid would otherwise be coarser than 1.
  const exponent = Number(price.toExponential(10).split('e')[1]);
  const sigDecimals = 4 - exponent;
  const decimalPlaces = price >= 100_000 ? 0 : Math.max(0, Math.min(maxDecimals, sigDecimals));
  let ticks = snapTicks(price, decimalPlaces, buy ? 'floor' : 'ceil');
  if (ticks <= 0n) throw new BotError('Price rounds to zero');
  let wire = formatTicks(ticks, decimalPlaces);
  const drifted = buy ? Number(wire) > price + 1e-9 : Number(wire) < price - 1e-9;
  if (drifted) {
    ticks += buy ? -1n : 1n;
    if (ticks <= 0n) throw new BotError('Price rounds to zero');
    wire = formatTicks(ticks, decimalPlaces);
  }
  if (wire.includes('.') && significantFigures(wire) > 5) throw new BotError('Price exceeds significant figures');
  return wire;
}
export function higherLimit(a: string, b: string): string {
  const [x, y] = [Number(a), Number(b)];
  if (!(x > 0) || !(y > 0)) throw new BotError('Invalid price');
  return x >= y ? a : b;
}
export function standardAbstraction(mode: string): boolean {
  // "default" is an account that has never changed mode. Both keep spot and perp balances apart.
  return mode === 'disabled' || mode === 'default';
}
export function terminalOrderStatus(status: string): boolean {
  return status === 'filled' || status === 'canceled' || status === 'rejected' ||
    /(?:Canceled|Rejected|Cancel)$/.test(status);
}
export function liquidationDistanceBps(mark: number, liquidationPx: number | null): number | null {
  if (liquidationPx === null || !(mark > 0) || !(liquidationPx > 0)) return null;
  return (liquidationPx - mark) / mark * 10000;
}
export function conservativeNetBps(spotLimit: number, perpLimit: number,
  costs: { spotFeeBps: number; perpFeeBps: number; exitBufferBps: number }): number {
  if (!(spotLimit > 0) || !(perpLimit > 0)) throw new BotError('Invalid price');
  return (perpLimit - spotLimit) / spotLimit * 10000 -
    2 * (costs.spotFeeBps + costs.perpFeeBps * perpLimit / spotLimit) - costs.exitBufferBps;
}
export function closePnl(input: { perpEquity: number; spotUsdc: number; spotQty: number; spotExitPx: number;
  perpQty: number; perpMark: number; perpExitPx: number; spotFeeBps: number; perpFeeBps: number; entryEquity: number }): number {
  const fees = input.spotQty * input.spotExitPx * input.spotFeeBps / 10000 +
    input.perpQty * input.perpExitPx * input.perpFeeBps / 10000;
  // Perp equity is already marked. The last term replaces that mark with the worst IOC cover.
  const equity = input.perpEquity + input.spotUsdc + input.spotQty * input.spotExitPx +
    input.perpQty * (input.perpMark - input.perpExitPx);
  return equity - fees - input.entryEquity;
}
export type ExitReason = 'stop' | 'liquidation' | 'basis' | 'loss' | 'hold';
export function exitReason(input: { stopRequested: boolean; closeBasisBps: number; exitBasisBps: number;
  estimatedPnl: number; stopLoss: number; heldMs: number; maxHoldMs: number;
  liquidationDistanceBps: number | null; liqBufferBps: number }): ExitReason | null {
  if (input.stopRequested) return 'stop';
  if (input.liquidationDistanceBps !== null && input.liquidationDistanceBps <= input.liqBufferBps) return 'liquidation';
  if (input.closeBasisBps <= input.exitBasisBps) return 'basis';
  if (input.estimatedPnl <= -input.stopLoss) return 'loss';
  if (input.heldMs >= input.maxHoldMs) return 'hold';
  return null;
}
export function retryableReadError(error: unknown): boolean {
  if (!(error instanceof BotError)) return true;
  return /stale|skew|crossed|depth|empty spot|quote expired|invalid book|invalid order-book/i.test(error.message);
}
export function mustHaltAfterError(state: State): boolean {
  return state.pending !== undefined || state.phase === 'opening' || state.phase === 'closing';
}
export function requireSnapshot(s: Snapshot) {
  if (Object.values(s).some(x => typeof x === 'number' && !Number.isFinite(x)))
    throw new BotError('Invalid account numbers');
  if (s.liquidationPx !== null && !(s.liquidationPx > 0)) throw new BotError('Invalid liquidation price');
  if (s.spot < 0 || s.spotFree < 0 || s.spotFree > s.spot + 1e-9 || s.perp > 0 || s.cash < -1e-9 || s.spotUsdc < -1e-9)
    throw new BotError('Unexpected account exposure');
  if (s.otherPositions || s.openOrders) throw new BotError('Dedicated account required: other positions/open orders');
}
export class Engine {
  port: Port; state: State;
  constructor(port: Port, state: State) { this.port = port; this.state = state; }
  record(event: unknown) {
    this.state.events.push({ time: Date.now(), event });
    this.port.save(this.state);
  }
  async reconcilePending() {
    const pending = this.state.pending;
    if (!pending) return;
    if (Date.now() < pending.expiresAt + 2000) throw new BotError('Wait for pending order expiration before recovery');
    const status = await this.port.status(pending.order.c);
    if (!terminalOrderStatus(status))
      throw new BotError(`Unresolved order ${pending.order.c}: ${status}. Inspect exchange before recovery.`);
    this.state.pending = undefined;
    this.record({ reconciled: pending.order.c, status });
  }
  async send(spot: boolean, buy: boolean, size: number, reduceOnly = false,
    prepared?: { vwap: number; limit: string; at: number }, purpose: QuotePurpose = 'entry') {
    if (this.state.pending) throw new BotError('Pending order must be reconciled first');
    const decimals = spot ? this.state.market.spotDecimals : this.state.market.perpDecimals;
    const sizeWire = wireSize(size, decimals);
    const rounded = Number(sizeWire);
    const quote = prepared ?? await this.port.quote(spot, buy, rounded, purpose);
    if (Date.now() - quote.at > 3000 || quote.at > Date.now() + 1000) throw new BotError('Order quote expired');
    const order: Order = { a: spot ? this.state.market.spotId : this.state.market.perpId,
      b: buy, p: quote.limit, s: sizeWire, r: reduceOnly,
      t: { limit: { tif: 'Ioc' } }, c: `0x${randomBytes(16).toString('hex')}` };
    const expiresAt = Date.now() + 5000;
    this.state.pending = { order, expiresAt };
    this.record({ intent: order, expiresAt }); // durable BEFORE network submission
    // On ANY error keep pending and halt. Never retry an ambiguous exchange write.
    const response = await this.port.submit(order, expiresAt);
    if (!Number.isFinite(response.filledSize) || response.filledSize < 0 || response.filledSize > rounded + 1e-8 ||
      (response.filledSize > 0 && !(response.avgPx > 0)))
      throw new BotError('Invalid filled size; reconcile before continuing');
    this.state.pending = undefined;
    this.record({ response });
    return response;
  }
  async enter(size: number, maxNotional: number, costs: {
    minNetBps: number; spotFeeBps: number; perpFeeBps: number; exitBufferBps: number }) {
    if (this.state.phase !== 'flat') throw new BotError('One position per journal');
    const before = await this.port.snapshot(); requireSnapshot(before);
    if (before.spot !== 0 || before.perp !== 0) throw new BotError('Entry requires zero HYPE holdings and position');
    const [q, pq] = await Promise.all([this.port.quote(true, true, size), this.port.quote(false, false, size)]);
    if (Math.abs(q.at - pq.at) > 1500) throw new BotError('Entry book skew');
    // Cap worst-case spot purchase, not merely displayed VWAP. Reserve cash for fees.
    if (size * Number(q.limit) > maxNotional + 1e-9 || before.cash < maxNotional * 1.02 ||
      before.marginFree < maxNotional * 1.1) throw new BotError('Notional or cash/margin guard failed');
    const conservativeNet = conservativeNetBps(Number(q.limit), Number(pq.limit), costs);
    if (conservativeNet < costs.minNetBps) throw new BotError('Entry edge disappeared at IOC limit prices');
    this.state.entryEquity = before.equity;
    this.state.startedAt = Date.now(); this.state.phase = 'opening'; this.record('opening');
    const spotFill = await this.send(true, true, size, false, q);
    const bought = await this.port.snapshot(); requireSnapshot(bought);
    if (bought.perp !== 0 || bought.spot > spotFill.filledSize + 1e-8 ||
      bought.spot + 1e-8 < spotFill.filledSize * 0.98) throw new BotError('Spot fill/balance not reconciled; halt');
    const hedge = down(bought.spotFree, this.state.market.perpDecimals);
    if (hedge <= 0) {
      // A missed IOC must not consume the journal. Dust that cannot be hedged is sold back.
      if (bought.spot === 0 && bought.perp === 0 && spotFill.filledSize === 0) {
        this.state.phase = 'flat'; this.state.startedAt = 0; this.state.entryEquity = 0;
        this.record('entry missed; still flat'); return;
      }
      await this.close(); return;
    }
    // Refresh the book but keep the more conservative of the two sell floors, as a wire string.
    const freshHedge = await this.port.quote(false, false, hedge, 'entry');
    const hedgeFill = await this.send(false, false, hedge, false,
      { ...freshHedge, limit: higherLimit(pq.limit, freshHedge.limit) });
    const held = await this.port.snapshot(); requireSnapshot(held);
    if (Math.abs(held.perp + hedgeFill.filledSize) > 1e-8)
      throw new BotError('Perp fill/position not reconciled; halt');
    if (held.spot > size + 1e-8 || Math.abs(held.spot + held.perp) > 10 ** -this.state.market.perpDecimals + 1e-8 ||
      held.perp >= 0) {
      this.record('Partial hedge; attempting complete unwind'); await this.close(); return;
    }
    this.state.phase = 'open'; this.record({ opened: held });
  }
  async close() {
    if (this.state.pending) throw new BotError('Reconcile pending order before closing');
    if (this.state.phase === 'closed') return;
    // Read balances before committing to closing, so a stale book does not strand an open position.
    let s = await this.port.snapshot(); requireSnapshot(s);
    this.state.phase = 'closing'; this.record('closing');
    // One bounded attempt per leg. Failed/partial closes leave a durable closing state.
    const short = Math.abs(s.perp);
    if (short > 0) {
      await this.send(false, true, short, true, undefined, 'exit');
      s = await this.port.snapshot(); requireSnapshot(s);
      if (Math.abs(s.perp) > 1e-9) throw new BotError('Perp close incomplete. Keep journal; run close again.');
    }
    const sale = down(s.spotFree, this.state.market.spotDecimals);
    if (sale > 0) await this.send(true, false, sale, false, undefined, 'exit');
    const after = await this.port.snapshot(); requireSnapshot(after);
    if (after.perp !== 0 || down(after.spot, this.state.market.spotDecimals) > 0)
      throw new BotError('Spot close incomplete. Keep journal; inspect dust/minimum order and run close again.');
    this.state.phase = 'closed'; this.record({ closed: after, residualSpotDust: after.spot });
  }
}
