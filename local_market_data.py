from __future__ import annotations

import pickle
import threading
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DATASET_PREFIXES = {
    "MES=F": "ES",
    "MNQ=F": "NQ",
    "MYM=F": "YM",
    "M2K=F": "RTY",
}
FUTURES_CONTRACTS = {
    "MES=F": {"name": "Micro E-mini S&P 500", "multiplier": 5, "initialMargin": 2_000, "sourceDataset": "ES"},
    "MNQ=F": {"name": "Micro E-mini Nasdaq-100", "multiplier": 2, "initialMargin": 3_000, "sourceDataset": "NQ"},
    "MYM=F": {"name": "Micro E-mini Dow", "multiplier": 0.5, "initialMargin": 1_500, "sourceDataset": "YM"},
    "M2K=F": {"name": "Micro E-mini Russell 2000", "multiplier": 5, "initialMargin": 1_500, "sourceDataset": "RTY"},
}
DATA_CACHE: dict[str, dict] = {}
INTRADAY_DATA_CACHE: dict[str, object] = {}
INTRADAY_ATR_CACHE: dict[str, tuple] = {}
INTRADAY_SWING_CACHE: dict[str, tuple] = {}
DATA_LOCK = threading.Lock()
REQUIRED_COLUMNS = ("open", "high", "low", "close", "volume")


class MarketDataError(Exception):
    """A user-facing error while loading local market data."""


def _dataset_path(symbol: str) -> Path:
    prefix = DATASET_PREFIXES.get(symbol)
    if prefix is None:
        raise MarketDataError(
            f"{symbol} is not available in the local bars.pkl datasets. Choose MES=F, MNQ=F, MYM=F, or M2K=F."
        )
    matches = list(ROOT.glob(f"{prefix}_1min_*bars.pkl"))
    if not matches:
        raise MarketDataError(f"No local {prefix} 1-minute bars.pkl file was found.")
    if len(matches) != 1:
        raise MarketDataError(f"Found multiple local {prefix} bars.pkl files; keep exactly one dataset per contract.")
    return matches[0]


def available_futures_contracts() -> dict[str, dict]:
    available = {}
    for symbol, metadata in FUTURES_CONTRACTS.items():
        prefix = DATASET_PREFIXES[symbol]
        matches = list(ROOT.glob(f"{prefix}_1min_*bars.pkl"))
        if len(matches) > 1:
            raise MarketDataError(f"Found multiple local {prefix} bars.pkl files; keep exactly one dataset per contract.")
        if not matches:
            continue
        available[symbol] = metadata
    if not available:
        raise MarketDataError("No supported local 1-minute bars.pkl datasets were found in the app folder.")
    return available


def local_ai_candidates(limit: int) -> list[dict]:
    return [
        {
            "symbol": symbol,
            "name": metadata["name"],
            "exchange": "CME",
            "currency": "USD",
            "quoteType": "FUTURE",
            "sourceDataset": metadata["sourceDataset"],
        }
        for symbol, metadata in available_futures_contracts().items()
    ][:limit]


def search_local_instruments(query: str) -> list[dict]:
    normalized = " ".join(query.split()).casefold()
    if not normalized:
        return []
    return [
        candidate
        for candidate in local_ai_candidates(len(FUTURES_CONTRACTS))
        if normalized in candidate["name"].casefold()
        or normalized in candidate["symbol"].casefold()
        or normalized in candidate["sourceDataset"].casefold()
    ][:8]


def _aggregate_daily_bars(frame, symbol: str) -> list[dict]:
    import pandas as pd

    if not isinstance(frame, pd.DataFrame):
        raise MarketDataError(f"The local {symbol} pickle does not contain a pandas DataFrame.")
    missing = [column for column in REQUIRED_COLUMNS if column not in frame.columns]
    if missing:
        raise MarketDataError(f"The local {symbol} dataset is missing columns: {', '.join(missing)}.")
    if not isinstance(frame.index, pd.DatetimeIndex) or frame.index.tz is None:
        raise MarketDataError(f"The local {symbol} dataset must have a timezone-aware timestamp index.")

    bars = frame.loc[:, REQUIRED_COLUMNS].copy()
    for column in REQUIRED_COLUMNS:
        bars[column] = pd.to_numeric(bars[column], errors="coerce")
    valid = bars.notna().all(axis=1)
    import numpy as np

    valid &= pd.Series(
        np.isfinite(bars[["open", "high", "low", "close"]].to_numpy(dtype="float64")).all(axis=1),
        index=bars.index,
    )
    valid &= (bars[["open", "high", "low", "close"]] > 0).all(axis=1)
    valid &= bars["volume"].notna() & (bars["volume"] >= 0)
    bars = bars.loc[valid].sort_index()
    if bars.empty:
        raise MarketDataError(f"The local {symbol} dataset contains no valid OHLCV rows.")

    chicago_time = bars.index.tz_convert("America/Chicago")
    next_session = (chicago_time.hour >= 17).astype("int64")
    session_labels = (
        chicago_time.normalize() + pd.to_timedelta(next_session, unit="D")
    ).strftime("%Y-%m-%d")
    bars["_session"] = pd.Categorical(session_labels)
    daily = bars.groupby("_session", sort=True, observed=True).agg(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("volume", "sum"),
        count=("close", "size"),
    )
    if len(daily) > 1:
        typical_session_count = daily["count"].iloc[-21:-1].median()
        if typical_session_count and daily["count"].iloc[-1] < typical_session_count * 0.5:
            daily = daily.iloc[:-1]
    result = []
    for session_date, row in daily.iterrows():
        result.append({
            "date": session_date,
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": int(row["volume"]),
        })
    if len(result) < 2:
        raise MarketDataError(f"The local {symbol} dataset contains fewer than two complete sessions.")
    return result


def load_market_data(symbol: str) -> dict:
    cache_key = symbol.upper()
    if cache_key not in FUTURES_CONTRACTS:
        raise MarketDataError(
            f"{cache_key} is not available in the local bars.pkl datasets. Choose MES=F, MNQ=F, MYM=F, or M2K=F."
        )
    with DATA_LOCK:
        cached = DATA_CACHE.get(cache_key)
        if cached is not None:
            return cached

        path = _dataset_path(cache_key)
        try:
            import pandas as pd

            frame = pd.read_pickle(path)
        except ModuleNotFoundError as exc:
            dependency = exc.name or "a pickle dependency"
            raise MarketDataError(
                f"Cannot read the local bars.pkl file because Python package '{dependency}' is missing. "
                "Install the app dependencies with: python -m pip install -r requirements.txt"
            ) from exc
        except (OSError, EOFError, pickle.UnpicklingError, ValueError, TypeError) as exc:
            raise MarketDataError(f"Could not read local market data from {path.name}: {exc}") from exc

        bars = _aggregate_daily_bars(frame, cache_key)
        instrument = {"type": "future", **FUTURES_CONTRACTS[cache_key]}
        data = {
            "symbol": cache_key,
            "currency": "USD",
            "exchange": "CME",
            "timezone": "America/Chicago",
            "instrument": instrument,
            "bars": bars,
            "source": path.name,
            "dataStart": bars[0]["date"],
            "dataEnd": bars[-1]["date"],
        }
        DATA_CACHE[cache_key] = data
        return data


def load_intraday_sessions(symbol: str, session_dates: list[str]) -> dict[str, list[dict]]:
    import pandas as pd

    cache_key = symbol.upper()
    if cache_key not in FUTURES_CONTRACTS:
        raise MarketDataError(f"{cache_key} is not available in the local bars.pkl futures datasets.")
    try:
        requested_dates = sorted(set(pd.Timestamp(session_date).date().isoformat() for session_date in session_dates))
    except (TypeError, ValueError) as exc:
        raise MarketDataError("An ORB session date is invalid.") from exc
    if not requested_dates:
        return {}

    with DATA_LOCK:
        frame = INTRADAY_DATA_CACHE.get(cache_key)
        if frame is None:
            path = _dataset_path(cache_key)
            try:
                frame = pd.read_pickle(path)
            except ModuleNotFoundError as exc:
                dependency = exc.name or "a pickle dependency"
                raise MarketDataError(
                    f"Cannot read the local {path.name} bars because package '{dependency}' is missing."
                ) from exc
            except (OSError, EOFError, pickle.UnpicklingError, ValueError, TypeError) as exc:
                raise MarketDataError(f"Could not read local intraday bars from {path.name}: {exc}") from exc
            if (
                not isinstance(frame, pd.DataFrame)
                or any(column not in frame.columns for column in REQUIRED_COLUMNS)
                or not isinstance(frame.index, pd.DatetimeIndex)
                or frame.index.tz is None
            ):
                raise MarketDataError(f"The local {path.name} file has invalid minute-bar columns or timestamps.")
            frame = frame.loc[:, REQUIRED_COLUMNS].copy()
            for column in REQUIRED_COLUMNS:
                frame[column] = pd.to_numeric(frame[column], errors="coerce")
            valid = frame.notna().all(axis=1)
            import numpy as np

            valid &= pd.Series(
                np.isfinite(frame.to_numpy(dtype="float64")).all(axis=1),
                index=frame.index,
            )
            valid &= (frame[["open", "high", "low", "close"]] > 0).all(axis=1)
            valid &= frame["volume"] >= 0
            frame = frame.loc[valid]
            if not frame.index.is_monotonic_increasing:
                frame = frame.sort_index()
            if frame.index.has_duplicates:
                frame = frame.loc[~frame.index.duplicated(keep="last")]
            if frame.empty:
                raise MarketDataError(f"The local {path.name} file contains no valid minute bars.")
            INTRADAY_DATA_CACHE[cache_key] = frame

    index = frame.index
    start = pd.Timestamp(requested_dates[0], tz="America/New_York").tz_convert(index.tz)
    end = (
        pd.Timestamp(requested_dates[-1], tz="America/New_York") + pd.Timedelta(days=1)
    ).tz_convert(index.tz)
    start_position = max(0, index.searchsorted(start, side="left") - 25)
    end_position = index.searchsorted(end, side="left")
    minute_slice = frame.iloc[start_position:end_position].copy()
    for column in REQUIRED_COLUMNS:
        minute_slice[column] = pd.to_numeric(minute_slice[column], errors="coerce")
    valid = minute_slice.loc[:, REQUIRED_COLUMNS].notna().all(axis=1)
    import numpy as np

    valid &= pd.Series(
        np.isfinite(minute_slice.loc[:, REQUIRED_COLUMNS].to_numpy(dtype="float64")).all(axis=1),
        index=minute_slice.index,
    )
    valid &= (minute_slice[["open", "high", "low", "close"]] > 0).all(axis=1)
    valid &= minute_slice["volume"] >= 0
    minute_slice = minute_slice.loc[valid]
    new_york_index = minute_slice.index.tz_convert("America/New_York")
    minute_of_day = new_york_index.hour * 60 + new_york_index.minute
    minute_slice = minute_slice.assign(
        _date=new_york_index.strftime("%Y-%m-%d"),
        _minute=minute_of_day,
        _vol_avg20=minute_slice["volume"].rolling(20, min_periods=20).mean(),
        _hi11=minute_slice["high"].rolling(11, min_periods=11).max(),
        _lo11=minute_slice["low"].rolling(11, min_periods=11).min(),
    )
    minute_slice["_pivot_high"] = (
        minute_slice["high"].shift(5) >= minute_slice["_hi11"]
    )
    minute_slice["_pivot_low"] = (
        minute_slice["low"].shift(5) <= minute_slice["_lo11"]
    )
    swing_cache = INTRADAY_SWING_CACHE.get(cache_key)
    if swing_cache is None:
        with DATA_LOCK:
            swing_cache = INTRADAY_SWING_CACHE.get(cache_key)
            if swing_cache is None:
                high = frame["high"]
                low = frame["low"]
                last_swing_high = high.shift(5).where(high.shift(5) >= high.rolling(11, min_periods=11).max()).ffill()
                last_swing_low = low.shift(5).where(low.shift(5) <= low.rolling(11, min_periods=11).min()).ffill()
                swing_cache = (
                    last_swing_high.to_numpy(dtype="float64"),
                    last_swing_low.to_numpy(dtype="float64"),
                )
                INTRADAY_SWING_CACHE[cache_key] = swing_cache
    row_positions = index.searchsorted(minute_slice.index)
    minute_slice["_pivot_high_value"] = swing_cache[0][row_positions]
    minute_slice["_pivot_low_value"] = swing_cache[1][row_positions]
    minute_slice["_swing_high_previous"] = minute_slice["_pivot_high_value"].shift(1)
    minute_slice["_swing_low_previous"] = minute_slice["_pivot_low_value"].shift(1)
    minute_slice["_block"] = minute_slice.index.asi8 // (15 * 60 * 1_000_000_000)

    atr_cache = INTRADAY_ATR_CACHE.get(cache_key)
    if atr_cache is None:
        with DATA_LOCK:
            atr_cache = INTRADAY_ATR_CACHE.get(cache_key)
            if atr_cache is None:
                full_block_ids = index.asi8 // (15 * 60 * 1_000_000_000)
                blocks = frame.groupby(full_block_ids, sort=True).agg(
                    high=("high", "max"),
                    low=("low", "min"),
                    close=("close", "last"),
                )
                previous_close = blocks["close"].shift(1)
                true_range = pd.concat(
                    [
                        blocks["high"] - blocks["low"],
                        (blocks["high"] - previous_close).abs(),
                        (blocks["low"] - previous_close).abs(),
                    ],
                    axis=1,
                ).max(axis=1)
                atr_values = [None] * len(blocks)
                true_ranges = true_range.to_numpy(dtype="float64")
                atr = None
                tr_sum = 0.0
                tr_count = 0
                for index_position, true_range_value in enumerate(true_ranges):
                    if tr_count < 14:
                        tr_sum += true_range_value
                        tr_count += 1
                        if tr_count == 14:
                            atr = tr_sum / 14
                    else:
                        atr = (atr * 13 + true_range_value) / 14
                    atr_values[index_position] = atr
                atr_cache = (
                    blocks.index.to_numpy(),
                    atr_values,
                    blocks["close"].to_numpy(dtype="float64"),
                )
                INTRADAY_ATR_CACHE[cache_key] = atr_cache
    block_ids, atr_values, block_closes = atr_cache
    row_block_ids = minute_slice.index.asi8 // (15 * 60 * 1_000_000_000)
    block_positions = np.searchsorted(block_ids, row_block_ids, side="right") - 2
    previous_atr = [atr_values[position] if position >= 0 else None for position in block_positions]
    previous_block_close = [float(block_closes[position]) if position >= 0 else None for position in block_positions]
    minute_slice["_atr15"] = previous_atr
    minute_slice["_prev_block_close"] = previous_block_close
    minute_slice["_partial_high"] = minute_slice.groupby("_block", sort=False)["high"].cummax()
    minute_slice["_partial_low"] = minute_slice.groupby("_block", sort=False)["low"].cummin()

    requested = set(requested_dates)
    sessions: dict[str, list[dict]] = {session_date: [] for session_date in requested_dates}
    for timestamp, row in minute_slice.iterrows():
        session_date = row["_date"]
        if session_date not in requested:
            continue
        partial_range = float(row["_partial_high"] - row["_partial_low"])
        previous_block_close_value = row["_prev_block_close"]
        if previous_block_close_value is not None and not pd.isna(previous_block_close_value):
            partial_range = max(
                partial_range,
                abs(float(row["_partial_high"]) - float(previous_block_close_value)),
                abs(float(row["_partial_low"]) - float(previous_block_close_value)),
            )
        atr15 = row["_atr15"]
        atr_if_closed = (float(atr15) * 13 + partial_range) / 14 if atr15 is not None and not pd.isna(atr15) else None
        minute = int(row["_minute"])
        atr_for_next = atr_if_closed if (minute + 1) % 15 == 0 else atr15
        sessions[session_date].append({
            "time": minute,
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": float(row["volume"]),
            "volumeRatio": (
                float(row["volume"] / row["_vol_avg20"])
                if not pd.isna(row["_vol_avg20"]) and row["_vol_avg20"] > 0
                else None
            ),
            "pivotHigh": bool(row["_pivot_high"]) if not pd.isna(row["_pivot_high"]) else False,
            "pivotLow": bool(row["_pivot_low"]) if not pd.isna(row["_pivot_low"]) else False,
            "pivotHighValue": (
                float(row["_pivot_high_value"]) if not pd.isna(row["_pivot_high_value"]) else None
            ),
            "pivotLowValue": (
                float(row["_pivot_low_value"]) if not pd.isna(row["_pivot_low_value"]) else None
            ),
            "swingHighPrevious": float(row["_swing_high_previous"]) if not pd.isna(row["_swing_high_previous"]) else None,
            "swingLowPrevious": float(row["_swing_low_previous"]) if not pd.isna(row["_swing_low_previous"]) else None,
            "atr15": float(atr15) if atr15 is not None and not pd.isna(atr15) else None,
            "atrForNext": float(atr_for_next) if atr_for_next is not None and not pd.isna(atr_for_next) else None,
        })
    return sessions
