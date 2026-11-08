from __future__ import annotations

import json
import math
import re
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from local_market_data import ROOT, available_futures_contracts


STOCK_CACHE_ROOT = ROOT / "stock_market_cache"
STOCK_CACHE_MAX_AGE = timedelta(hours=24)
STOCK_SYMBOL_PATTERN = re.compile(r"^[A-Z0-9^=.-]{1,15}$")
STOCK_CACHE_LOCK = threading.Lock()
STOCK_SYMBOL_LOCKS: dict[str, threading.Lock] = {}
STOCK_SEARCH_CACHE: dict[str, tuple[float, list[dict]]] = {}
STOCK_UNIVERSE_CACHE: tuple[float, list[dict]] | None = None
STOCK_CACHE_SECONDS = 300
MAX_STOCK_UNIVERSE = 30
MAX_STOCK_HISTORY = 2_700


class StockMarketDataError(Exception):
    """A user-visible stock market data or cache error."""


def _stock_cache_path(symbol: str) -> Path:
    normalized = symbol.upper()
    if not STOCK_SYMBOL_PATTERN.fullmatch(normalized):
        raise StockMarketDataError("Enter a valid stock ticker symbol.")
    return STOCK_CACHE_ROOT / f"{normalized}.json"


def _futures_date_bounds() -> tuple[str, str]:
    contracts = available_futures_contracts()
    start_dates = []
    end_dates = []
    for contract in contracts.values():
        dataset_name = contract["sourceDataset"]
        matches = list(ROOT.glob(f"{dataset_name}_1min_*bars.pkl"))
        if len(matches) != 1:
            continue
        date_match = re.search(r"_1min_(\d{8})_(\d{8})_.*bars\.pkl$", matches[0].name)
        if date_match:
            start_dates.append(datetime.strptime(date_match.group(1), "%Y%m%d").date())
            end_dates.append(datetime.strptime(date_match.group(2), "%Y%m%d").date())
    if not start_dates or not end_dates:
        raise StockMarketDataError("Could not determine the common historical range from the local futures data.")
    return max(start_dates).isoformat(), min(end_dates).isoformat()


def _fetch_yahoo_json(path: str, attempts: int = 2) -> dict:
    last_error: Exception | None = None
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com")[:attempts]:
        request = Request(
            f"https://{host}{path}",
            headers={"User-Agent": "Mozilla/5.0 (compatible; StockDaySimulator/1.0)"},
        )
        try:
            with urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if not isinstance(payload, dict):
                raise StockMarketDataError("Yahoo Finance returned an invalid stock-data response.")
            return payload
        except HTTPError as exc:
            last_error = exc
            if exc.code == 404:
                raise StockMarketDataError("Yahoo Finance did not find that stock symbol.") from exc
        except (URLError, TimeoutError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            last_error = exc
    raise StockMarketDataError(
        "Could not reach Yahoo Finance for stock data. Check your connection and retry."
    ) from last_error


def _read_stock_cache(symbol: str) -> dict | None:
    path = _stock_cache_path(symbol)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise StockMarketDataError(f"Could not read the saved {symbol} stock-data cache: {exc}") from exc
    if (
        not isinstance(payload, dict)
        or payload.get("symbol") != symbol
        or not isinstance(payload.get("bars"), list)
        or not payload["bars"]
        or len(payload["bars"]) > MAX_STOCK_HISTORY
        or not isinstance(payload.get("cachedAt"), str)
    ):
        raise StockMarketDataError(f"The saved {symbol} stock-data cache is invalid. Remove its cache file and retry.")
    previous_date = None
    for bar in payload["bars"]:
        if not isinstance(bar, dict):
            raise StockMarketDataError(f"The saved {symbol} stock-data cache contains an invalid daily bar.")
        try:
            bar_date = date.fromisoformat(bar.get("date", ""))
        except (TypeError, ValueError) as exc:
            raise StockMarketDataError(f"The saved {symbol} stock-data cache contains an invalid bar date.") from exc
        prices = [bar.get(field) for field in ("open", "high", "low", "close")]
        volume = bar.get("volume")
        if (
            previous_date is not None and bar_date <= previous_date
            or any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 for value in prices)
            or prices[2] > min(prices[0], prices[3])
            or prices[1] < max(prices[0], prices[3])
            or isinstance(volume, bool)
            or not isinstance(volume, int)
            or volume < 0
        ):
            raise StockMarketDataError(f"The saved {symbol} stock-data cache contains invalid OHLCV values.")
        previous_date = bar_date
    return payload


def _stock_cache_is_fresh(payload: dict) -> bool:
    try:
        cached_at = datetime.fromisoformat(payload["cachedAt"])
    except ValueError as exc:
        raise StockMarketDataError("A saved stock-data cache has an invalid timestamp.") from exc
    return datetime.now(timezone.utc) - cached_at.astimezone(timezone.utc) < STOCK_CACHE_MAX_AGE


def _fetch_stock_market_data(symbol: str) -> dict:
    encoded_symbol = quote(symbol, safe="")
    start_date, end_date = _futures_date_bounds()
    start_timestamp = int(
        datetime.combine(date.fromisoformat(start_date), datetime.min.time(), timezone.utc).timestamp()
    )
    end_timestamp = int(
        datetime.combine(
            date.fromisoformat(end_date) + timedelta(days=1),
            datetime.min.time(),
            timezone.utc,
        ).timestamp()
    )
    payload = _fetch_yahoo_json(
        f"/v8/finance/chart/{encoded_symbol}?period1={start_timestamp}&period2={end_timestamp}&interval=1d&events=history"
    )
    chart = payload.get("chart")
    if not isinstance(chart, dict):
        raise StockMarketDataError("Yahoo Finance returned an invalid chart response.")
    chart_error = chart.get("error")
    if chart_error:
        message = (
            chart_error.get("description")
            if isinstance(chart_error, dict)
            else str(chart_error)
        ) or "Yahoo Finance could not find that stock symbol."
        raise StockMarketDataError(str(message))
    results = chart.get("result") or []
    if not isinstance(results, list) or not results or not isinstance(results[0], dict):
        raise StockMarketDataError(f"Yahoo Finance returned no daily history for {symbol}.")

    result = results[0]
    meta = result.get("meta", {})
    if not isinstance(meta, dict):
        raise StockMarketDataError(f"Yahoo Finance returned invalid instrument details for {symbol}.")
    if meta.get("symbol", "").upper() != symbol:
        raise StockMarketDataError(f"Yahoo Finance returned data for a different symbol than {symbol}.")
    if meta.get("dataGranularity") not in (None, "1d"):
        raise StockMarketDataError(f"Yahoo Finance did not return daily bars for {symbol}.")
    indicators_root = result.get("indicators", {})
    if not isinstance(indicators_root, dict):
        raise StockMarketDataError(f"Yahoo Finance returned invalid daily bars for {symbol}.")
    indicators = indicators_root.get("quote") or []
    quote_data = indicators[0] if indicators else {}
    if not isinstance(quote_data, dict):
        raise StockMarketDataError(f"Yahoo Finance returned invalid daily bars for {symbol}.")
    arrays = [
        result.get("timestamp") or [],
        quote_data.get("open") or [],
        quote_data.get("high") or [],
        quote_data.get("low") or [],
        quote_data.get("close") or [],
        quote_data.get("volume") or [],
    ]
    if any(not isinstance(values, list) for values in arrays):
        raise StockMarketDataError(f"Yahoo Finance returned invalid daily bar arrays for {symbol}.")
    timezone_name = meta.get("exchangeTimezoneName") or "America/New_York"
    try:
        market_timezone = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise StockMarketDataError(f"Yahoo Finance returned an unsupported exchange timezone for {symbol}.") from exc
    now_market = datetime.now(market_timezone)
    trading_periods = meta.get("currentTradingPeriod", {})
    if not isinstance(trading_periods, dict):
        trading_periods = {}
    regular = trading_periods.get("regular", {})
    if not isinstance(regular, dict):
        regular = {}
    regular_close = regular.get("end")
    if isinstance(regular_close, bool) or not isinstance(regular_close, (int, float)):
        regular_close = None
    bars_by_date: dict[str, dict] = {}
    for index, timestamp in enumerate(arrays[0]):
        if any(index >= len(values) for values in arrays[1:]):
            continue
        if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp):
            continue
        try:
            local_timestamp = datetime.fromtimestamp(timestamp, timezone.utc).astimezone(market_timezone)
        except (OverflowError, OSError, ValueError):
            continue
        session_date = local_timestamp.date().isoformat()
        if session_date < start_date or session_date > end_date:
            continue
        if session_date == now_market.date().isoformat() and (
            regular_close is None or datetime.now(timezone.utc).timestamp() < regular_close
        ):
            continue
        open_price, high, low, close, volume = (values[index] for values in arrays[1:])
        if any(
            value is None or isinstance(value, bool) or not isinstance(value, (int, float))
            for value in (open_price, high, low, close, volume)
        ):
            continue
        if (
            any(not math.isfinite(value) or value <= 0 for value in (open_price, high, low, close))
            or volume < 0
            or low > min(open_price, close)
            or high < max(open_price, close)
        ):
            continue
        bars_by_date[session_date] = {
            "date": session_date,
            "open": float(open_price),
            "high": float(high),
            "low": float(low),
            "close": float(close),
            "volume": int(volume),
        }
    bars = [bars_by_date[session_date] for session_date in sorted(bars_by_date)]
    if len(bars) < 2:
        raise StockMarketDataError(
            f"Yahoo Finance returned fewer than two daily bars for {symbol} within the local futures date range."
        )
    company_name = meta.get("longName") or meta.get("shortName") or symbol
    retained_bars = bars[-MAX_STOCK_HISTORY:]
    data = {
        "symbol": symbol,
        "currency": meta.get("currency") or "USD",
        "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
        "timezone": timezone_name,
        "instrument": {"type": "equity", "name": str(company_name)[:120]},
        "bars": retained_bars,
        "source": "Yahoo Finance",
        "dataStart": retained_bars[0]["date"],
        "dataEnd": retained_bars[-1]["date"],
        "cachedAt": datetime.now(timezone.utc).isoformat(),
    }
    return data


def _save_stock_cache(data: dict) -> None:
    STOCK_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    path = _stock_cache_path(data["symbol"])
    temporary_path = path.with_suffix(".json.tmp")
    encoded = json.dumps(data, separators=(",", ":"), allow_nan=False)
    try:
        temporary_path.write_text(encoded, encoding="utf-8")
        temporary_path.replace(path)
    except OSError as exc:
        raise StockMarketDataError(f"Could not save cached stock data for {data['symbol']}: {exc}") from exc


def get_stock_market_data(symbol: str) -> dict:
    normalized = symbol.upper()
    with STOCK_CACHE_LOCK:
        symbol_lock = STOCK_SYMBOL_LOCKS.setdefault(normalized, threading.Lock())
    with symbol_lock:
        cached = _read_stock_cache(normalized)
        if cached and _stock_cache_is_fresh(cached):
            return cached
        try:
            refreshed = _fetch_stock_market_data(normalized)
        except StockMarketDataError as exc:
            if not cached:
                raise
            stale = dict(cached)
            stale["cacheWarning"] = f"Using saved stock bars; refresh failed: {exc}"
            return stale
        _save_stock_cache(refreshed)
        return refreshed


def _stock_search(query: str) -> list[dict]:
    normalized_query = " ".join(query.split())
    now = time.monotonic()
    key = normalized_query.casefold()
    cached = STOCK_SEARCH_CACHE.get(key)
    if cached and now - cached[0] < STOCK_CACHE_SECONDS:
        return cached[1]
    payload = _fetch_yahoo_json(
        f"/v1/finance/search?q={quote(normalized_query)}&quotesCount=12&newsCount=0"
    )
    suggestions = []
    seen_symbols = set()
    for item in payload.get("quotes", []):
        if not isinstance(item, dict):
            continue
        symbol = item.get("symbol")
        name = item.get("shortname") or item.get("longname")
        if (
            not isinstance(symbol, str)
            or not STOCK_SYMBOL_PATTERN.fullmatch(symbol.upper())
            or symbol.upper() in seen_symbols
            or item.get("quoteType") not in {"EQUITY", "ETF"}
            or not isinstance(name, str)
            or not name.strip()
        ):
            continue
        seen_symbols.add(symbol.upper())
        suggestions.append({
            "symbol": symbol.upper(),
            "name": name.strip()[:120],
            "exchange": str(item.get("exchDisp") or item.get("exchange") or "")[:60],
            "quoteType": item["quoteType"],
        })
        if len(suggestions) >= 8:
            break
    STOCK_SEARCH_CACHE[key] = (now, suggestions)
    return suggestions


def search_stock_companies(query: str) -> list[dict]:
    try:
        return _stock_search(query)
    except StockMarketDataError:
        raise
    except (TypeError, AttributeError) as exc:
        raise StockMarketDataError("Yahoo Finance returned malformed company-search results.") from exc


def get_stock_ai_candidates(limit: int = MAX_STOCK_UNIVERSE) -> list[dict]:
    global STOCK_UNIVERSE_CACHE
    now = time.monotonic()
    if STOCK_UNIVERSE_CACHE and now - STOCK_UNIVERSE_CACHE[0] < STOCK_CACHE_SECONDS:
        return STOCK_UNIVERSE_CACHE[1][:limit]
    payload = _fetch_yahoo_json(
        f"/v1/finance/screener/predefined/saved?formatted=false&count={MAX_STOCK_UNIVERSE}&scrIds=most_actives"
    )
    results = payload.get("finance", {}).get("result") or []
    if not results:
        raise StockMarketDataError("Yahoo Finance returned no stock candidates.")
    candidates = []
    seen_symbols = set()
    for item in results[0].get("quotes", []):
        if not isinstance(item, dict):
            continue
        symbol = item.get("symbol")
        name = item.get("shortName") or item.get("longName") or symbol
        if (
            not isinstance(symbol, str)
            or not STOCK_SYMBOL_PATTERN.fullmatch(symbol.upper())
            or symbol.upper() in seen_symbols
            or item.get("quoteType") != "EQUITY"
            or item.get("region") != "US"
            or item.get("currency") != "USD"
            or not isinstance(name, str)
            or not name.strip()
        ):
            continue
        seen_symbols.add(symbol.upper())
        candidates.append({
            "symbol": symbol.upper(),
            "name": name.strip()[:120],
            "exchange": str(item.get("fullExchangeName") or item.get("exchange") or "")[:60],
            "currency": "USD",
            "quoteType": "EQUITY",
        })
        if len(candidates) >= MAX_STOCK_UNIVERSE:
            break
    if not candidates:
        raise StockMarketDataError("Yahoo Finance returned no eligible US stock candidates.")
    STOCK_UNIVERSE_CACHE = (now, candidates)
    return candidates[:limit]
