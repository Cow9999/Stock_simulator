# Session — Stock and Futures Portfolio Simulator

## Research library and Live Paper Trading workspace

The Algorithm page now includes **Daily 12-month momentum** and **Daily SMA 50/200** presets. Select one and choose **Use selected strategy**, then review/run it. The momentum adaptation requires the Python trust checkbox. See [research notes](STRATEGY_RESEARCH.md) for sources, rule differences, timeframes, and evaluation limitations. These are researched alternatives, not established improvements in returns.

The third sidebar tab, **Live Paper Trading**, separates streaming-style quote monitoring from historical replay. It polls Yahoo every 15 seconds while visible (not an exchange streaming feed), shows a recent-minute chart, quote age, cash, equity, P&L, and fills. You can monitor without trading. The built-in 20/50-minute crossover is an experimental demo; the daily library strategies are blocked from the minute runner. Choose an active Stock Trading upload for custom minute rules. Running paper sessions remain pinned and continue when moving between workspaces; a RUNNING badge marks the tab. Stop explicitly to end the loop. Browser throttling or closing the page interrupts updates.

A local paper-trading research app with independent **Futures Trading** and **Stock Trading** workspaces. Each workspace keeps its own cash, holdings, history, strategy settings, and reports.

## Run

Install dependencies once in the Python environment used by the launcher:

```powershell
python -m pip install -r requirements.txt
```

Double-click `run_simulator.bat`, or run `python app.py` in PowerShell and visit <http://127.0.0.1:8765>. Keep the server window open while using the app. Restart the server after changing a source file or replacing a futures data file.

## Market data

### Futures Trading

Futures Trading currently offers Nasdaq MNQ only, using the local NQ reference data:

| Simulated instrument | Local source prefix | Multiplier |
| --- | --- | ---: |
| MNQ=F — Micro E-mini Nasdaq-100 | `NQ_1min_*bars.pkl` | 2 |

The default **ORB NQ Trio** Futures Trading engine runs the supplied NQ Opening Range Breakout strategy on the original MNQ/NQ one-minute bars in New York time. Its preset, sizing mode, fixed quantity, and risk-sized cap controls mirror the Pine script's exposed inputs; the active preset's resolved opening range, trading window, stop/target, volume-ratio gate, ATR trail, breakeven, and risk-sizing values are displayed and exported in the versioned ORB JSON. The ORB Pine analyzer parses these supported literal preset tables and controls; it never executes Pine code. Starting capital defaults to the script's $50,000, and simulations retain its one-tick ($0.25) slippage, $0.61 commission per contract per fill, and $48,000–$50,000 daily equity floor. When a one-minute candle touches both OR boundaries, the simulator uses the OHLC path heuristic (the side closer to the bar's open is first); an exact tie is skipped because the underlying intrabar order cannot be known from OHLC data.

ORB sessions are simulated server-side in batches of at most 20 days; the full minute dataset is never sent to the browser. Stock Trading continues to use the separate daily quant engine.

### Stock Trading

Stock search, the US active-stock candidate list, and daily OHLCV history use Yahoo Finance. Per-ticker daily bars are stored as JSON in `stock_market_cache` and reused for 24 hours before a refresh is attempted; stock bars are not downloaded again on every simulation run. If a refresh fails and a valid saved cache exists, the backtest continues with that cache and shows a stale-data warning in the workspace and daily report. Without a usable cache, data errors are surfaced and no simulation starts.

Stock bars are clipped to the shared date range covered by the local futures datasets. The company search supports name-to-ticker lookup. Quant ranking uses a small liquid-stock universe and only fetches the chosen universe when a simulation begins.

## Simulations and saved portfolios

The **01 Portfolio**, **02 Strategy**, and **03 Import** setup steps work within the selected side tab. Enter the number of sessions directly (1–2,500). The simulator uses prior completed closes for signals and the next session's open for entries. Futures support long and short positions; stock positions are long-only. Positions persist across runs in their own workspace.

The futures workspace uses `portfolio.json` by default; Stock Trading uses `portfolio-stock.json`. If `PORTFOLIO_PATH` is set, the stock file uses the same base name with `-stock` appended. Do not edit saved portfolio files while the server is running. The app checkpoints replay progress every 20 sessions, yields between chunks, and updates charts/reports at chunk boundaries instead of for every day. ORB replays use the same bounded chunk size and persist each server-side batch. Market history lookups use bounded indexed slices. Up to 25,000 equity snapshots and the latest 25,000 closed trades are retained; an omitted-trade count is shown when older trade rows have been dropped. The latest 200 daily reports are retained.

The built-in deterministic quant ranker scores risk-adjusted momentum, pullback rank, and lower volatility. It is a signal model, not a generative AI or investment adviser. Futures margin and stock/futures transaction costs are illustrative; corporate actions, dividends, taxes, micro-contract rolls, and market impact are not modeled.

## Strategies and Pine Script

- **Local slider strategy** runs the built-in quant model.
- **Imported JSON** saves validated slider settings. JSON does not execute code.
- **Python and C++ uploads** execute locally through the `on_bar` interface described below. Their returned signals drive entries and exits; they are not converted into slider settings.
- The supplied **ORB NQ Trio** Pine strategy is implemented as a dedicated, Futures-only MNQ engine over local 1-minute NQ bars. Uploading the supported script parses its three preset tables and exposed inputs into the MNQ controls. ORB JSON exports contain both the Pine inputs and resolved preset table, so import/export and simulation use the same values. Stock Trading remains on its existing daily quant strategy.
- Other **Pine Script** imports are interpreted only through a deliberately small, validated subset. Supported source declares one or more `ta.sma(close, length)`, `ta.ema(close, length)`, or `ta.rsi(close, length)` indicators; defines `ta.crossover(left, right)` / `ta.crossunder(left, right)` conditions over those indicators; and uses exactly one conditional named `strategy.entry("id", strategy.long|strategy.short)` plus one matching `strategy.close("id")`. Indicator lengths are 2–500. Other statements, order types, parameters, and Pine features are rejected. Entry and exit use prior completed daily bars. Pine program signals choose entries/exits; portfolio risk sizing, stops, slippage, and commission still use the simulator's controls. Stock strategies must be long-only.

This is a paper-trading research tool, not investment advice, and it never places orders. Backtest results do not guarantee future performance. Pickle files can execute code when deserialized; only use trusted local futures data files.

## Direct uploads and live stock paper trading

Choose **Upload an algorithm** on the first setup screen to skip sliders. Validate your Pine file, then choose **Use this algorithm**. It becomes active immediately in either workspace; imported strategies hide the slider controls. JSON uploads activate their saved settings immediately. Supported Pine signals drive entries/exits instead of the built-in quant signals. Historical replay retains the saved risk and execution settings.

In Stock Trading, the **Live stock paper trading** panel runs the active long-only uploaded algorithm on completed **one-minute** candles. This changes the indicator timeframe from daily replay: EMA(12), for example, measures 12 minutes here. Start explicitly after activating an import. The strategy is pinned until stopped. The first poll establishes a baseline; only new completed candles can trade. Polling runs every 30 seconds while the tab remains open. Background browser throttling can delay polls; missed signals are not replayed.

The feed fetches recent Yahoo candles independently of the historical cache and futures date limits. Quotes may be delayed. The app pauses fills outside regular trading hours, when quotes exceed two minutes old, or completed candles exceed three minutes old. Data/storage errors stop the loop. No brokerage orders are sent.

The separate browser-local paper account starts with $100,000, supports one stock at a time, allocates 10% of available cash per buy, exits the full holding on the algorithm's exit cross, and models 5 bps slippage plus 1 bp commission per fill. It does not apply historical slider stops or sizing. Holdings persist in this browser's local storage, which must remain available; the latest 1,000 fills are retained. Stopping retains holdings. Web Locks prevent two tabs from trading the same paper ledger simultaneously. Clearing browser storage deletes that ledger. Real brokerage execution requires a broker-specific integration and credentials; it is not enabled.
## Two setup paths and executable uploads

After Portfolio, choose **Sliders → Simulate strategy** or **Algorithm → Run algorithm**. The slider route never sends you through uploads. Run algorithm validates and activates the currently edited source before replaying; invalid source stops the run. JSON settings are in an optional expandable section. A checked **Fresh backtest** on the Algorithm page archives the previous saved portfolio in `portfolio-archives` beside its save file, then replays the requested sessions from starting capital. Uncheck it to continue existing holdings. Saved imports are retained in a fresh run. Archives are JSON backups and are not served by the web server.

Python uploads define `def on_bar(bars):` and return `"buy"`, `"sell"`, or `"hold"`. `bars` is the growing history of completed bars, each with `open`, `high`, `low`, `close`, and `volume`. C++ uploads define `std::string on_bar(const std::vector<Bar>& bars)` using the same signals; the runner supplies `Bar` (five double fields), standard vector/string headers, and `main()`. C++17 compilation requires `g++` on the server PATH. Download runnable examples from the upload screen or [Python](examples/algorithm.py), [C++](examples/algorithm.cpp), and [Pine](examples/algorithm.pine).

Native algorithms are long-only signal generators. A buy opens a position if none is held; sell closes it; hold does nothing. Historical signals execute at the following session's open, using existing risk sizing, stops, and costs. Daily histories include up to 500 warm-up bars before the requested replay; algorithm state restarts for each symbol and run. They do not receive account balances or fill callbacks. Framework-specific files, standalone C++ `main()` programs, and arbitrary Pine scripts need adaptation to the supported interfaces.

Python/C++ also work in the live paper panel after activation. Each new eligible minute candle recomputes signals from the available recent history, then uses the latest signal. Native state is not persistent between polls. Pine remains interpreted through the supported crossover subset.

**Only execute source you trust.** Check the trust box explicitly for Python/C++. The code runs as a local subprocess with the server user's permissions; this is not a security sandbox. Runs have a 10-second limit, C++ compilation a 30-second limit, and output is capped at 1 MB. Standard output is reserved for runner signals; send debug logging to stderr. Missing compilers, compile/runtime errors, invalid returns, and timeouts stop the run instead of falling back to sliders. The native execution endpoint requires a same-origin custom header and a local Host value.
