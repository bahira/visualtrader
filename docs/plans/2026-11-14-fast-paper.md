# Fast paper trading implementation plan

1. Reuse the existing portfolio and fill model in a separate 5-second spot strategy. Track cost, closed cycles, completed minutes and refusals.
2. Connect live, demo, replay, audit and pause. Keep the fast ledger durable and compatible with existing SQLite state.
3. Expose cadence and economics in the native client. Exercise healthy, missing, and stale depth, bookkeeping, pause and restart.
4. Replay captured Binance data, inspect performance and open the updated native client on the running engine.
