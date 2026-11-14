# VisualTrader Implementation Plan

**Goal** · Run BTC/USDT Spot paper trading from the Binance 1-second public feed.

**Architecture** · Archive the combined WebSocket in SQLite. Generate signals from closed candles and trade flow, then simulate execution against a later depth snapshot. Compare shadow portfolios through chronological selection and forward testing. Serve live state from a loopback dashboard.

**Tech stack** · Node 24, SQLite, browser Canvas and HTTP.

1. Implement and test Binance decoding, source freshness, execution accounting and trading gates in  engine.mjs .
2. Add a rolling shadow tournament with forward validation, flat cash as a benchmark and an audit trail. Cover the promotion boundaries with a regression test.
3. Add Binance reconnection, market event journaling, deterministic demo and capture replay in  app.mjs  and  market.mjs . Test an accelerated session end to end.
4. Render candles, net equity, simulated fills, feed health and optimizer evidence in  public/ . Verify the browser and collect evidence from public live data.
