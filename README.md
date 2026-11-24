# VisualTrader

VisualTrader simulates a BTC/USDT spot strategy using Binance **1-second** chart data. The runtime uses public market feeds and a virtual USDT portfolio. It contains no order execution client or exchange API key configuration.

## Getting started

Requirements: Node.js 24.x for the engine, Python 3.10+ with Tk for the client, and access to Binance public HTTPS and WSS endpoints. No additional packages to install.

In a terminal:

```powershell
npm.cmd start
```

Then launch [VisualTrader.cmd](VisualTrader.cmd), or run `python desktop.py` in another terminal. The client uses native Tk controls and a Tk Canvas chart. The connection to the engine remains local. Closing the client does not stop the engine's data capture or paper trading.

**Time** displays up to approximately 16 hours of one-minute closing prices, with volume and live updates. **1 s** displays OHLCV candles. Hover over the chart to inspect a point, and use the mouse wheel or duration menu to change the scale. Ctrl+1, Ctrl+2 and Ctrl+3 switch views. **Capital** shows simulated liquidatable equity in USDT. Tabs provide access to the order book, trades, executions, optimizer, statistics and decisions. Launch `VisualTrader.cmd --port 8788` to view the demo below.

The **Pause entrées** (Pause entries) button suspends new purchases in the active portfolio. Exits continue. With an uninterrupted feed, indicators require 99 candles, followed by two 15-minute windows before the first possible activation. The portfolio remains in cash until validation. Even with a healthy feed, the engine may remain in cash indefinitely.

```powershell
# Accelerated synthetic demo, isolated from the live portfolio
npm.cmd run demo -- --port 8788

# Accelerated price and order-book replay of a captured session
node app.mjs --mode replay --session 1 --speed 50 --port 8789

# Non-interactive replay and throughput measurements
node app.mjs --mode replay --session 1 --batch
npm.cmd run benchmark
npm.cmd test

# Isolate an alternative execution-cost scenario
node app.mjs --mode live --port 8790 --db data/scenario.sqlite --fee-bps 10 --slip-bps 2 --latency-ms 400
```

`--fee-bps`, `--slip-bps` and `--latency-ms` configure execution assumptions. One basis point (bp) equals 0.01%. By default, the model applies **10 bps in taker fees per side**, **1 bp of adverse slippage per side**, order-book prices and a minimum latency of **250 ms**. See the [Binance fee schedule](https://www.binance.com/en/fee/trading) for account- and pair-specific rates. Changing the live configuration requires a separate data file.

## Cadence portfolio and leverage study

**Cadence** and **Fills rapides** (Fast fills) track a separate simulated portfolio. It attempts a spot long purchase in each 5-second slot, commits up to 250 USDT, and seeks to exit above costs after 1 second or at the 2.6-second deadline. The target is 10 round trips per 60 seconds. Order-book conditions, spreads, latency, interruptions and rejections can reduce throughput. The pause control covers both portfolios. The journal identifies cadence events with `wallet: "Rapide"`.

```powershell
node leverage-study.mjs --session 3 --end-seq 335859 --interest-bps-hour 1
```

The offline scenario replays the spot order book at position sizes of 250, 500, 750, 1,250 and 2,500 USDT. It also calculates the average return per cycle if exposure remained at 250 USDT and only the initial margin decreased. Assumptions are 10 bps taker fees and 1 bp slippage per side, with a hypothetical prorated borrowing interest rate. The replay uses the spot order book and does not simulate liquidation rules, margin calls or perpetual contracts. See [results and scope](docs/LEVERAGE.md).

## Operations

- `GET /health` reports feed status and counters. `marketReady=true` requires fresh order-book data and closing prices.
- `GET /api/state` returns the full state. The client loads `/api/client` approximately once per second and `/api/time` only when the latest historical timestamp changes. API timestamps use Unix milliseconds. The client displays local Windows time.
- The export link downloads the latest 10,000 audit events from the current session in NDJSON format. The database retains raw data and the complete audit trail.
- When running in the foreground, stop with Ctrl+C to flush buffers and close the database. On restart, the journal retains the active portfolio and its recent history. Pending virtual orders and candidates are reset.
- Monitor disk space. All data from subscribed feeds is captured. Storage growth varies with trade throughput. Rotation is manual, by changing the `--db` file. To back up an active database, use the SQLite backup API or copy the database after a clean shutdown.
- Keep the listener bound to loopback. Pause commands validate the local HTTP origin.

See [architecture and model](docs/ARCHITECTURE.md) for equations, the optimization protocol and simulator limitations.

## ERRF Phoenix

The **Phoenix** and **Archive 4 h** tabs provide the spot comparison and imported futures backtest. See [integration and replay](docs/PHOENIX.md).

The **Étude 4 h** (4-hour study) tab presents the [independent Pine-rule replay and robustness test](docs/PHOENIX_RESEARCH.md).

## Market microstructure research

The [HFT replay benchmark](docs/MICROSTRUCTURE.md) compares order-book data, executed trades, fees and latency across fixed sessions. The [maker entry and exit study](docs/MAKER_STUDY.md) also measures forced-exit costs.

The [two-sided quoting replay](docs/TWO_SIDED.md) compares results against passive inventory and documents the differential data collector.

The [reconstructed differential order book](docs/DEPTH_REPLAY.md) enables replay of frozen settings on new captures.

The [multi-day paper-trading campaign](docs/PAPER_CAMPAIGN.md) freezes settings and aggregates new out-of-sample blocks.

The [Polymarket BTC Up/Down paper mode](docs/POLYMARKET.md) tests momentum and semivariance in an independent worker. Launch [Polymarket.cmd](Polymarket.cmd) to open the native preview. The [reproducible test bench](docs/POLY_EDGE.md) documents variants, replays and cohort-level results.

