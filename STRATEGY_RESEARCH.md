# Strategy library and evidence

Research reviewed October 26, 2026. These presets are alternatives for evaluation, not demonstrated improvements in returns.

## Daily 12-month momentum

[Moskowitz, Ooi & Pedersen (2012), Time Series Momentum](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum) reports evidence across 58 futures/forward markets for momentum based on prior 12-month excess returns. Our [implementation](examples/time_series_momentum.py) uses 252-session **raw-price** momentum and reviews every 21 completed bars. It goes long on positive momentum and exits on non-positive momentum. At least 253 prices are required.

This is a simplified long-only adaptation. It does not replicate the paper's excess returns, short positions, cross-asset diversification, or volatility scaling. The simulator's saved risk sizing, stops, and costs still apply. Reviews are anchored to the loaded history, not calendar month-end; changing the warm-up window can shift review dates. Equities and micro-futures here are different universes from the paper. No parameters were optimized against the user's saved portfolios.

## Daily SMA 50/200 baseline

[QuantConnect's asset-class trend-following implementation](https://www.quantconnect.com/research/15339/asset-class-trend-following/) illustrates exposure when price is above a ten-month moving average. Our 50/200 daily crossover is a related **baseline**, not that strategy or a published result from that source. It waits for completed-bar crosses, enters on the next historical open, and exits on the opposite cross. It can remain flat until a new crossing occurs even in an already-rising market.

## Live minute demo

The separate 20/50 **minute** SMA crossover is an experimental plumbing/demo preset. Daily or monthly evidence does not validate minute trading. The library's daily presets are blocked in the live upload selector by their library names. Editing/renaming an uploaded strategy remains the user's responsibility. Quote polling every 15 seconds is not a real-time exchange stream; Yahoo prices may be delayed. Paper fills stop when data is stale or the regular session is closed. Repeated polling of a candle cannot create repeat fills.

## Evaluation guidance

Compare presets over identical date ranges, instruments, sizing, and costs. Reserve later dates for evaluation, examine drawdown and turnover as well as return, and avoid selecting parameters using the evaluation period. Existing automated checks cover warm-up, review cadence, signal direction, live duplicate-bar handling, and runtime failure handling. They do not establish profitability. Native algorithms restart per symbol/run, and the live runner recomputes from recent history each poll.
