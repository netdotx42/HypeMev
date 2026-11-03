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
export type Snapshot = { spot: number; spotFree: number; cash: number; perp: number;
  equity: number; marginFree: number; perpMark: number; openOrders: number; otherPositions: boolean };
export type State = { version: 1; network: string; user: string; market: Market;
  phase: 'flat' | 'opening' | 'open' | 'closing' | 'closed'; startedAt: number;
  entryEquity: number; pending?: { order: Order; expiresAt: number }; events: unknown[] };
export type Port = {
  snapshot(): Promise<Snapshot>;
  quote(spot: boolean, buy: boolean, size: number): Promise<{ vwap: number; limit: string; at: number }>;
  submit(order: Order, expiresAt: number): Promise<Fill>;
  status(cloid: `0x${string}`): Promise<string>;
  save(state: State): void;
};
export function down(size: number, decimals: number): number {
  if (!Number.isFinite(size) || size < 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 8)
    throw new BotError('Invalid size/precision');
  // Decimal conversion avoids rounding a balance upward due to binary multiplication.
  const [whole, fraction = ''] = size.toFixed(12).split('.');
  return Number(`${whole}.${fraction.slice(0, decimals) || '0'}`);
}
export function limitPrice(price: number, szDecimals: number, spot: boolean, buy: boolean): string {
  if (!Number.isFinite(price) || price <= 0) throw new BotError('Invalid price');
  const maxDecimals = (spot ? 8 : 6) - szDecimals;
  if (!Number.isInteger(maxDecimals) || maxDecimals < 0) throw new BotError('Invalid price precision');
  const decimalPlaces = Math.max(0, Math.min(maxDecimals, 4 - Math.floor(Math.log10(price))));
  const unit = 10 ** -decimalPlaces;
  // Round inward, preserving the caller's slippage ceiling/floor.
  const n = (buy ? Math.floor(price / unit) : Math.ceil(price / unit)) * unit;
  if (n <= 0) throw new BotError('Price rounds to zero');
  return n.toFixed(decimalPlaces);
}
export function requireSnapshot(s: Snapshot) {
  if (Object.values(s).some(x => typeof x === 'number' && !Number.isFinite(x)))
    throw new BotError('Invalid account numbers');
  if (s.spot < 0 || s.spotFree < 0 || s.spotFree > s.spot + 1e-9 || s.perp > 0)
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
    if (!(status === 'filled' || status === 'canceled' || status === 'rejected' ||
      /(?:Canceled|Rejected|Cancel)$/.test(status)))
      throw new BotError(`Unresolved order ${pending.order.c}: ${status}. Inspect exchange before recovery.`);
    this.state.pending = undefined;
    this.record({ reconciled: pending.order.c, status });
  }
  async send(spot: boolean, buy: boolean, size: number, reduceOnly = false,
    prepared?: { vwap: number; limit: string; at: number }) {
    if (this.state.pending) throw new BotError('Pending order must be reconciled first');
    const decimals = spot ? this.state.market.spotDecimals : this.state.market.perpDecimals;
    const rounded = down(size, decimals);
    if (rounded <= 0) throw new BotError('Order size rounds to zero');
    const quote = prepared ?? await this.port.quote(spot, buy, rounded);
    if (Date.now() - quote.at > 3000 || quote.at > Date.now() + 1000) throw new BotError('Order quote expired');
    const order: Order = { a: spot ? this.state.market.spotId : this.state.market.perpId,
      b: buy, p: quote.limit, s: rounded.toFixed(decimals), r: reduceOnly,
      t: { limit: { tif: 'Ioc' } }, c: `0x${randomBytes(16).toString('hex')}` };
    const expiresAt = Date.now() + 5000;
    this.state.pending = { order, expiresAt };
    this.record({ intent: order, expiresAt }); // durable BEFORE network submission
    // On ANY error keep pending and halt. Never retry an ambiguous exchange write.
    const response = await this.port.submit(order, expiresAt);
    if (!Number.isFinite(response.filledSize) || response.filledSize < 0 || response.filledSize > rounded + 1e-8)
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
    const spotLimit = Number(q.limit), perpLimit = Number(pq.limit);
    const conservativeNet = (perpLimit - spotLimit) / spotLimit * 10000 -
      2 * (costs.spotFeeBps + costs.perpFeeBps * perpLimit / spotLimit) - costs.exitBufferBps;
    if (conservativeNet < costs.minNetBps) throw new BotError('Entry edge disappeared at IOC limit prices');
    this.state.entryEquity = before.equity;
    this.state.startedAt = Date.now(); this.state.phase = 'opening'; this.record('opening');
    const spotFill = await this.send(true, true, size, false, q);
    const bought = await this.port.snapshot(); requireSnapshot(bought);
    if (bought.perp !== 0 || bought.spot > spotFill.filledSize + 1e-8 ||
      bought.spot + 1e-8 < spotFill.filledSize * 0.98) throw new BotError('Spot fill/balance not reconciled; halt');
    const hedge = down(bought.spotFree, this.state.market.perpDecimals);
    if (hedge <= 0) { await this.close(); return; }
    // Refresh timestamp but retain the pre-entry hedge floor to cap entry slippage.
    const freshHedge = await this.port.quote(false, false, hedge);
    const hedgeFill = await this.send(false, false, hedge, false,
      { ...freshHedge, limit: String(Math.max(Number(pq.limit), Number(freshHedge.limit))) });
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
    this.state.phase = 'closing'; this.record('closing');
    // One bounded attempt per leg. Failed/partial closes leave a durable closing state.
    let s = await this.port.snapshot(); requireSnapshot(s);
    const short = Math.abs(s.perp);
    if (short > 0) {
      await this.send(false, true, short, true);
      s = await this.port.snapshot(); requireSnapshot(s);
      if (Math.abs(s.perp) > 1e-9) throw new BotError('Perp close incomplete. Keep journal; run close again.');
    }
    const sale = down(s.spotFree, this.state.market.spotDecimals);
    if (sale > 0) await this.send(true, false, sale);
    const after = await this.port.snapshot(); requireSnapshot(after);
    if (after.perp !== 0 || down(after.spot, this.state.market.spotDecimals) > 0)
      throw new BotError('Spot close incomplete. Keep journal; inspect dust/minimum order and run close again.');
    this.state.phase = 'closed'; this.record({ closed: after, residualSpotDust: after.spot });
  }
}
