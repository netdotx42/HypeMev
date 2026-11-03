import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, touch, vwap } from './bot.ts';
import type { Book } from './bot.ts';
const book = (coin: string, bid: number, ask: number, time = 10000): Book =>
  ({ coin, time, levels: [[{ px: String(bid), sz: '10' }], [{ px: String(ask), sz: '10' }]] });
const costs = { spotFeeBps: 10, perpFeeBps: 5, exitBufferBps: 15 };
test('best price ignores zero-size levels and book order', () => {
  assert.equal(touch([{ px: '10', sz: '0' }, { px: '9', sz: '1' }], 'sell'), 9);
  assert.equal(touch([{ px: '3', sz: '1' }, { px: '2', sz: '2' }], 'buy'), 2);
  assert.throws(() => touch([{ px: '1', sz: '0' }], 'buy'), /depth/);
});
test('walks depth and rejects insufficient liquidity', () => {
  const levels = [{ px: '100', sz: '1' }, { px: '102', sz: '2' }];
  assert.equal(vwap(levels, 2, 'buy'), 101);
  assert.throws(() => vwap(levels, 4, 'buy'), /depth/);
});
test('deducts both legs fees twice plus exit buffer', () => {
  const r = evaluate(book('@107', 99, 100), book('HYPE', 102, 103), 2, costs, 10000);
  assert.ok(Math.abs(r.estimatedConvergencePnl - 3.096) < 1e-9);
});
test('rejects stale, skewed and crossed books', () => {
  assert.throws(() => evaluate(book('s', 99, 100, 0), book('p', 102, 103), 1, costs, 10000), /Stale/);
  assert.throws(() => evaluate(book('s', 99, 100, 8000), book('p', 102, 103), 1, costs, 10000), /skew/);
  assert.throws(() => evaluate(book('s', 101, 100), book('p', 102, 103), 1, costs, 10000), /Crossed/);
});
test('fees can eliminate a positive gross basis', () => {
  assert.ok(evaluate(book('s', 99, 100), book('p', 100.1, 101), 1, costs, 10000).estimatedNetBps < 0);
});
