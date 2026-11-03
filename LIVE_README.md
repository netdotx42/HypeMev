# Hyperliquid TypeScript live basis bot

Node.js 24+. Includes the original paper scanner and a live HYPE spot / HYPE perpetual basis strategy. Live execution uses the community-maintained `@nktkas/hyperliquid` SDK, pinned with a lockfile, for signing.

## Setup

```bash
npm ci
cp .env.example .env
chmod 600 .env
npm test
npm run typecheck
```

Edit `.env` locally. Use a dedicated funded master account with **separate spot and perp balances**. `userAbstraction` must be `disabled` or `default` (an account that has never changed mode). Unified, portfolio-margin, and dex-abstraction modes are rejected because spot balances would be mixed into perp equity. Entry requires no HYPE inventory, no native perpetual positions, no open orders (including triggers), and no nonzero spot assets apart from USDC. Before entry, and about once a minute while a position is open, the bot also rejects positions or orders on builder-deployed perp dexs (HIP-3). Do not trade manually, run another bot, deposit or withdraw while this bot manages a cycle.

Approve a **named API wallet** for this account in Hyperliquid's interface on the selected network. Put its key in `AGENT_PRIVATE_KEY` and the funded master address in `ACCOUNT_ADDRESS`. The bot verifies the named agent's approval and expiration. It rejects a key matching the master address. It does not create/approve agents or transfer funds. Never paste keys into chat or commit `.env`.

Fund spot USDC and perpetual margin separately. With separate balances, HYPE you buy does **not** collateralize the short. A rally can liquidate the perp while the spot leg is still a gain in the other wallet. The bot requires free spot USDC >= 102% of the configured spot cap and withdrawable perpetual margin >= 110% of that cap, sets HYPE to 1x cross, and reads the account back to confirm that leverage before it enters. While open, it exits if the mark gets within `LIQ_BUFFER_BPS` of the exchange liquidation price. That is an attempt, not a guarantee. Testnet liquidity and markets may differ; missing HYPE markets cause a clean halt.

## Run

Start with `NETWORK=testnet` and `LIVE_TRADING=false`, as in `.env.example`. Read-only preflight:

```bash
npm run check
```

Set `LIVE_TRADING=true` for signed testnet orders, then:

```bash
npm run live
```

For real funds, set `NETWORK=mainnet` and `CONFIRM_MAINNET=true`, configure the approved mainnet API agent and funded master account, and choose your limits in `.env`. Both flags are required before a mainnet order is signed. `npm run check` stays read-only on either network. No live trades were submitted while building this package.

Close using the original journal:

```bash
npm run close
```

`npm start` still runs the original public-data scanner, which always uses mainnet. `npm run check/live/close` run the separate live implementation and automatically load `.env`.

## Strategy and risk controls

Live mode supports HYPE only. It buys spot, reads the actual acquired balance (spot fees may be charged in HYPE), then shorts an approximately equal quantity of perpetuals. Each leg uses an independent IOC limit order. Profit depends on basis convergence; this is not atomic or guaranteed arbitrage.

Entry checks book age, depth, timestamp skew, size/price precision, cash, margin, existing exposure, and conservative net edge at the worst allowed IOC prices. It reads taker fee rates from `userFees` and estimates entry and exit fees. Token-specific adjustments and subsequent fee changes are not modeled. Funding is not predicted for entries. Settled funding and perpetual unrealized PnL enter the open-position equity estimate.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `NETWORK` | testnet | testnet or mainnet |
| `LIVE_TRADING` | false | Must be true for signed actions |
| `NOTIONAL_USDC` | 25 | Spot purchase cap before fees for this cycle |
| `MAX_NOTIONAL_USDC` | 50 | Configuration ceiling for the spot cap, maximum supported 1,000 |
| `MIN_NET_BPS` | 30 | Required estimated convergence edge after costs |
| `CONFIRM_MAINNET` | false | Required as well as `LIVE_TRADING=true` before mainnet orders |
| `SLIPPAGE_BPS` | 10 | Entry IOC distance from best bid/ask, rounded inward to a legal tick |
| `EXIT_SLIPPAGE_BPS` | 50 | Wider IOC distance used only for closes and unwinds |
| `EXIT_BUFFER_BPS` | 15 | Extra allowance for exit costs in entry estimate |
| `EXIT_BASIS_BPS` | 5 | Close when executable perp-buy minus spot-sell spread reaches threshold |
| `LIQ_BUFFER_BPS` | 1000 | Exit when mark is this close to the short's liquidation price |
| `MAX_LOSS_USDC` | 2 | Exit trigger for estimated loss at executable close prices inside the exit limit |
| `MAX_HOLD_SECONDS` | 3600 | Maximum holding time before an exit attempt |
| `POLL_MS` | 5000 | Poll interval, minimum 2 seconds |
| `STATE_FILE` | account/network filename | Optional absolute journal path in a private durable directory |

The spot cap does not cap perpetual value as prices move. Additional funds cover fees and margin. The bot manages **one position per journal**, closes it and stops. It does not compound or repeatedly re-enter. Archive a completed journal deliberately before another cycle; resolve remaining HYPE dust first.

Ctrl+C or SIGTERM requests a close. A second signal, SIGKILL, host crash or lost connectivity may leave positions open. Exits are client-side: there is no exchange-hosted stop. The loss setting triggers an attempt; it cannot guarantee the final loss. Basis widening, funding, liquidation and slippage can cause larger losses.

## Partial fills and recovery

Orders have unique client IDs and five-second server expirations. The full intent is fsynced to a private journal before submission. A lock blocks simultaneous use of that same journal; it does not coordinate other journals or hosts. Run only one instance per account/API wallet.

- A spot IOC that fills nothing leaves the journal flat so a later poll can try again. Any purchased inventory that cannot be hedged is sold back.
- Partial spot fills are hedged using net acquired inventory. The hedge limit keeps the more conservative of the pre-entry and refreshed sell floors, without reformatting that price.
- Partial/rejected hedges trigger a full unwind attempt after account reconciliation.
- Closing covers the short with a reduce-only order before selling spot. A partial perp close halts before selling spot. Exit orders use the wider slippage cap and are still sent when the visible book is thinner than the position; entry orders are not.
- A balance read that fails before an order is sent does not change an `open` journal into `closing`.
- While flat or open, stale books and transport errors are retried with backoff. A pending order, or an `opening` / `closing` journal, is never retried in place.
- A timeout preserves a pending intent and halts. No ambiguous write is blindly retried.
- Run `npm run close` with the same account, network and journal after a failure. Pending orders must expire and have a known terminal `orderStatus` before more orders are allowed. Recovery closes exposure; it does not re-enter.
- Unknown/nonterminal order status, inconsistent balances, unavailable depth, API errors or rejected closes halt recovery. Inspect the exchange account and journal/client ID. Resolve/cancel orders and manage exposure through Hyperliquid's interface if needed. Never delete the journal to bypass reconciliation.
- After a crash, remove a stale `.lock` only after verifying the original process is no longer running. Keep the journal.
- Dust below the spot lot step can remain and is recorded. Minimum order values may prevent small residual sales; handle these manually. Failed closes remain in `closing` rather than being marked complete.

Read failures while flat or open are retried with backoff. They are not orders. A pending order, a half-finished entry, or a close that has already started still stops the process and can leave a position open. Restore connectivity and use `npm run live` to resume a known open position or `npm run close` to unwind. There are no automatic process restarts. Store the journal durably; losing it removes automatic recovery context.

## Verification

Tests cover calculations, order sequencing, cash/notional/edge guards, partial spot and hedge fills, hedge rejection, a missed entry that stays flat, timeout/restart recovery without duplicates, unknown and rejected order statuses, stale account reconciliation, partial closes, tick/lot formatting, journal round trips, liquidation and stop decisions, and the live-trading and mainnet CLI guards. Run `npm test` and `npm run typecheck`.

The SDK signing path is tested with a generated ephemeral key and mocked transport; no signed request is sent to an exchange by the tests. The live path has not been tested with a funded exchange account. Test the full lifecycle on testnet before using funds. This implementation has simulated exchange tests, not a production trading audit.

## Primary references

- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot
- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
- https://github.com/nktkas/hyperliquid

Mainnet/testnet asset IDs are discovered independently. Private keys and raw signed API errors are not printed. Journals contain account details and order IDs, not the private key.
