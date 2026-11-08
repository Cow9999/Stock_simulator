"""Uncached recent stock candles for the live paper-trading workspace."""
import math
import re
import time
from stock_market_data import _fetch_yahoo_json, StockMarketDataError


def live_stock_data(symbol):
    if not isinstance(symbol, str) or not re.fullmatch(r"[A-Z][A-Z0-9.-]{0,14}", symbol):
        raise ValueError("Enter a US stock ticker.")
    payload = _fetch_yahoo_json(f"/v8/finance/chart/{symbol}?interval=1m&range=5d&includePrePost=false")
    try:
        result = payload["chart"]["result"][0]
        quotes = result["indicators"]["quote"][0]
        now = time.time()
        bars = []
        for i, stamp in enumerate(result["timestamp"]):
            values = [quotes[key][i] for key in ("open", "high", "low", "close")]
            if stamp + 60 > now or any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) or v <= 0 for v in values):
                continue
            volumes = quotes.get("volume", [])
            volume = volumes[i] if i < len(volumes) else 0
            if not isinstance(volume, (int, float)) or isinstance(volume, bool) or not math.isfinite(volume) or volume < 0:
                volume = 0
            bars.append(dict(zip(("open", "high", "low", "close"), values), timestamp=stamp, volume=volume))
        meta = result["meta"]
        price, stamp = meta["regularMarketPrice"], meta["regularMarketTime"]
        if not bars or not math.isfinite(price) or price <= 0:
            raise ValueError()
        session = meta["currentTradingPeriod"]["regular"]
        fresh = 0 <= now - stamp <= 120 and 0 <= now - bars[-1]["timestamp"] <= 180
        return {"symbol": symbol, "bars": bars, "price": price, "timestamp": stamp,
                "tradable": fresh and session["start"] <= now < session["end"],
                "source": "Yahoo Finance (may be delayed)", "interval": "1 minute"}
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise StockMarketDataError("Recent stock candles are unavailable or invalid.") from exc
