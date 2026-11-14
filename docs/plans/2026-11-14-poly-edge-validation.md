# Polymarket Edge Validation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal** — Test additional paper strategies against observable execution and expose the evidence in the native app.

**Architecture** — Run a separate prospective protocol over the existing REST signal and CLOB archives. Keep the previous prospective run available for comparison. Replay the order book once per market and persist first execution observations before raw retention expires.

**Tech stack** — Node.js, SQLite, Python and Tkinter.

1. Add compact CLOB replay with tests for disconnections, latency, frame atomicity and synchronous Up/Down execution.
2. Freeze a second protocol with opening/current 60-second Binance averages, a market-consensus model, and a paired Up/Down strategy. Report missing evidence, performance net of costs and uncertainty at a fixed endpoint.
3. Show prospective results in the native app. Verify on the live archives, run the regression suites and record the remaining work in the report.
