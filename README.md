# Hyperliquid TypeScript basis scanner

**Live execution version:** See [LIVE_README.md](LIVE_README.md) for signed orders, setup, risk limits and recovery. The instructions below describe the original public-data scanner.

Public-data paper scanner for buying HYPE spot and shorting an equal quantity of HYPE perpetuals. Node.js 24+, no dependencies or keys. This starter estimates candidate entries only: it does not execute orders or simulate a position lifecycle.

## Run

```bash
npm test
npm start
node bot.ts --once
```

Example configuration (bash):

```bash
ASSET=HYPE NOTIONAL_USDC=100 MIN_NET_BPS=20 SPOT_FEE_BPS=10 PERP_FEE_BPS=5 EXIT_BUFFER_BPS=15 POLL_MS=5000 npm start
```

Fees are illustrative assumptions, not verified account fees. Set them to your actual taker rates. NOTIONAL_USDC limits the spot purchase before fees; additional cash for fees and perpetual margin is required for any eventual trading implementation.

The scanner discovers a matching USDC spot pair from spotMeta and the native perpetual from meta, uses l2Book depth to estimate executable VWAPs, rounds quantity down to shared size precision, and rejects stale/skewed books. Only long-spot/short-perpetual candidates are considered; no spot borrowing is assumed. Check the underlying asset identity before changing ASSET; equal symbols alone do not prove economic equivalence.

Estimated convergence PnL = quantity × (perp sell VWAP − spot buy VWAP) − estimated entry and exit fees − exit buffer. The calculation assumes the basis eventually closes to zero. It excludes funding, borrow costs, collateral opportunity cost, liquidation, changing prices and partial fills. Repeated output lines are independent quotes, not cumulative PnL or paper fills. Funding may help or hurt. Exit fees are approximated using entry notionals.

This is a basis trade, not atomic or guaranteed arbitrage. Before adding real execution, implement exchange size/notional rules, account margin checks, funding estimates, durable positions and fill reconciliation, partial-fill hedging, loss limits, and tested exit/unwind logic. Two legs can fill separately. No live execution switch is included.

## Validation

The package includes calculation and live-engine tests, plus a full TypeScript compiler check. Public mainnet metadata access succeeded; the paper book check rejected a timestamp-skewed snapshot as designed. Signed exchange execution still requires funded testnet verification. See LIVE_README.md for the live implementation and its limits.

## Official references

- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot

The first reference documents l2Book snapshots, timestamps and spot market identifiers; the second documents spot pair/token metadata.
