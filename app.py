from __future__ import annotations

import json
import ast
import math
import os
import re
import threading
import webbrowser
import uuid
from live_market_data import live_stock_data
from algorithm_runtime import validate_native_program, run_algorithm
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from local_market_data import (
    FUTURES_CONTRACTS,
    MarketDataError,
    available_futures_contracts,
    load_market_data,
    local_ai_candidates,
    search_local_instruments,
)
from orb_strategy import ORB_PRESETS, orb_default_settings, simulate_orb_sessions, validate_orb_settings
from stock_market_data import (
    MAX_STOCK_UNIVERSE,
    StockMarketDataError,
    get_stock_ai_candidates,
    get_stock_market_data,
    search_stock_companies,
)

ROOT = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8765"))
PORTFOLIO_PATH = Path(os.environ.get("PORTFOLIO_PATH", str(ROOT / "portfolio.json"))).resolve()
SYMBOL_PATTERN = re.compile(r"^[A-Za-z0-9^=.-]{1,15}$")
MAX_RANKED_CANDIDATES = 100
MAX_DAILY_REPORTS = 200
MAX_REQUEST_BYTES = 10_000_000
MAX_ALGORITHM_SOURCE_BYTES = 100_000
MAX_PORTFOLIO_SYMBOLS = 200
MAX_PORTFOLIO_TRADES = 25_000
MAX_PORTFOLIO_EQUITY_ROWS = 25_000
MAX_IMPORTED_STRATEGIES = 20
STRATEGY_RANGES = {
    "lookbackDays": (5, 60),
    "entryZ": (0.5, 3.0),
    "exitZ": (-0.5, 1.0),
    "riskPct": (0.1, 2.0),
    "maxAllocationPct": (10, 100),
    "stopVolMultiplier": (0.5, 3.0),
    "maxAiPicks": (1, MAX_RANKED_CANDIDATES),
    "momentumDays": (5, 120),
    "momentumWeight": (0, 100),
    "pullbackWeight": (0, 100),
    "lowVolWeight": (0, 100),
    "slippageBps": (0, 25),
    "commissionBps": (0, 25),
}
portfolio_lock = threading.Lock()


def compile_pine_subset(source: str) -> dict:
    indicator_pattern = re.compile(
        r"^([A-Za-z_]\w*)\s*=\s*ta\.(sma|ema|rsi)\(\s*close\s*,\s*(\d{1,3})\s*\)$",
        re.IGNORECASE,
    )
    condition_pattern = re.compile(
        r"^([A-Za-z_]\w*)\s*=\s*ta\.(crossover|crossunder)\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)$",
        re.IGNORECASE,
    )
    action_pattern = re.compile(r"^strategy\.(entry|close)\s*\((.*)\)\s*$", re.IGNORECASE)
    indicators: dict[str, dict] = {}
    conditions: dict[str, dict] = {}
    actions: list[dict] = []
    active_condition: str | None = None
    active_indent = -1

    def call_arguments(raw: str) -> list[str]:
        return [argument.strip() for argument in raw.split(",")]

    for line_number, raw_line in enumerate(source.splitlines(), 1):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("//") or stripped.startswith("/*") or stripped.startswith("*"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip())
        if indent <= active_indent:
            active_condition = None
            active_indent = -1
        if stripped.startswith("@version=") or re.fullmatch(r"strategy\s*\(.*\)", stripped, re.IGNORECASE):
            continue
        indicator = indicator_pattern.fullmatch(stripped)
        if indicator:
            name, kind, length_text = indicator.groups()
            length = int(length_text)
            if not 2 <= length <= 500:
                raise ValueError(f"Pine indicator length on line {line_number} must be between 2 and 500.")
            if name in indicators or name in conditions:
                raise ValueError(f"Pine variable '{name}' is declared more than once.")
            indicators[name] = {"kind": kind.lower(), "length": length}
            continue
        condition = condition_pattern.fullmatch(stripped)
        if condition:
            name, cross, left, right = condition.groups()
            if name in indicators or name in conditions:
                raise ValueError(f"Pine variable '{name}' is declared more than once.")
            conditions[name] = {"cross": cross.lower(), "left": left, "right": right}
            continue
        if_match = re.fullmatch(r"if\s+([A-Za-z_]\w*)", stripped)
        if if_match and if_match.group(1) in conditions:
            active_condition = if_match.group(1)
            active_indent = indent
            continue
        action = action_pattern.fullmatch(stripped)
        if action:
            kind, arguments_text = action.groups()
            args = call_arguments(arguments_text)
            if kind.lower() == "entry":
                if len(args) != 2 or not re.fullmatch(r"""["'][A-Za-z0-9 _-]{1,40}["']""", args[0]):
                    raise ValueError(f"Only named Pine strategy.entry calls with direction on line {line_number} are supported.")
                direction_match = re.fullmatch(r"strategy\.(long|short)", args[1], re.IGNORECASE)
                if not direction_match:
                    raise ValueError(f"Pine entry direction on line {line_number} must be strategy.long or strategy.short.")
                action_id = args[0][1:-1]
                direction = direction_match.group(1).lower()
            else:
                if len(args) != 1 or not re.fullmatch(r"""["'][A-Za-z0-9 _-]{1,40}["']""", args[0]):
                    raise ValueError(f"Only named Pine strategy.close calls on line {line_number} are supported.")
                action_id = args[0][1:-1]
                direction = None
            if active_condition is None:
                raise ValueError(f"Pine strategy actions on line {line_number} must be inside a supported 'if condition' block.")
            actions.append({
                "kind": kind.lower(),
                "id": action_id,
                "direction": direction,
                "condition": active_condition,
            })
            continue
        raise ValueError(
            f"Pine statement on line {line_number} is outside the executable subset. "
            "Supported code uses ta.sma/ta.ema/ta.rsi(close, length), ta.crossover/ta.crossunder, "
            "and conditional strategy.entry/strategy.close."
        )

    if not indicators or not conditions:
        raise ValueError("Pine strategy must declare at least one supported indicator and crossover condition.")
    for condition in conditions.values():
        if condition["left"] not in indicators or condition["right"] not in indicators:
            raise ValueError("Pine crossover conditions must compare two declared supported indicators.")
    entries = [action for action in actions if action["kind"] == "entry"]
    closes = [action for action in actions if action["kind"] == "close"]
    if len(entries) != 1 or len(closes) != 1:
        raise ValueError("The supported Pine strategy requires exactly one conditional strategy.entry and one strategy.close.")
    entry, close = entries[0], closes[0]
    if entry["id"] != close["id"]:
        raise ValueError("Pine strategy.entry and strategy.close must use the same order ID.")
    return {
        "version": 1,
        "indicators": indicators,
        "entry": conditions[entry["condition"]],
        "exit": conditions[close["condition"]],
        "direction": entry["direction"],
    }


def compile_orb_pine_inputs(source: str) -> dict:
    if not re.search(r'strategy\s*\(\s*"ORB NQ Trio Presets"', source):
        raise ValueError("Pine source is not the supported ORB NQ Trio Presets strategy.")
    preset_match = re.search(
        r'PRESET\s*=\s*input\.string\(\s*"([^"]+)"\s*,[^)]*options\s*=\s*\[([^\]]+)\]',
        source,
        re.IGNORECASE,
    )
    if not preset_match:
        raise ValueError("The ORB script must expose its three named presets as a Pine input.")
    preset_names = re.findall(r'"([^"]+)"', preset_match.group(2))
    if preset_names != list(ORB_PRESETS):
        raise ValueError("The ORB script must expose the supported NQ sortino, NQ calmar, and NQ payouts presets.")
    preset_default = preset_match.group(1)
    if preset_default not in preset_names:
        raise ValueError("The ORB script has an unsupported default preset.")

    def pick_values(variable: str, kind: str) -> list:
        match = re.search(
            rf"\b{variable}\s*=\s*pick{kind}\s*\(\s*pIdx\s*,\s*([^)]+)\)",
            source,
            re.IGNORECASE,
        )
        if not match:
            raise ValueError(f"The ORB script is missing the supported preset setting {variable}.")
        raw_values = [part.strip() for part in match.group(1).split(",")]
        if len(raw_values) != 3:
            raise ValueError(f"The ORB script setting {variable} must define one value for each preset.")
        try:
            if kind.upper() == "B":
                if any(value.lower() not in {"true", "false"} for value in raw_values):
                    raise ValueError
                return [value.lower() == "true" for value in raw_values]
            values = [float(value) for value in raw_values]
            if not all(math.isfinite(value) for value in values):
                raise ValueError
            return [int(value) if kind.upper() == "I" else value for value in values]
        except ValueError as exc:
            raise ValueError(f"The ORB script setting {variable} must use literal supported values.") from exc

    def pick_bool(variable: str, index: int, expected: bool) -> None:
        if pick_values(variable, "B")[index] is not expected:
            raise ValueError(f"The ORB script uses unsupported {variable} behavior in {preset_names[index]}.")

    starts = pick_values("P_OR_START", "I")
    durations = pick_values("P_OR_DUR", "I")
    delays = pick_values("P_DELAY", "I")
    trading_durations = pick_values("P_DURATION", "I")
    stop_modes = pick_values("P_STOP_MODE", "I")
    target_modes = pick_values("P_TP_MODE", "I")
    ratio_enabled = pick_values("P_USE_RATIO_GATE", "B")
    ratio_min = pick_values("P_RATIO_MIN", "F")
    ratio_max = pick_values("P_RATIO_MAX", "F")
    trail_enabled = pick_values("P_USE_TRAIL", "B")
    trail_values = pick_values("P_TRAIL_ATR_MULT", "F")
    breakeven_enabled = pick_values("P_USE_BE", "B")
    breakeven_pct = pick_values("P_BE_PCT", "F")
    breakeven_offset = pick_values("P_BE_OFFSET", "F")
    risk_budget = pick_values("P_SIZER_R", "F")
    risk_factor = pick_values("P_SIZER_F", "F")
    entry_modes = pick_values("P_ENTRY_MODE", "I")
    trail_types = pick_values("P_TRAIL_TYPE", "I")
    breakeven_types = pick_values("P_BE_TYPE", "I")
    for index in range(3):
        pick_bool("P_USE_ATR_GATE", index, False)
        pick_bool("P_USE_RANGE_GATE", index, False)
        pick_bool("P_USE_DELTA_GATE", index, False)
        if (
            entry_modes[index] != 0
            or stop_modes[index] not in {0, 2}
            or target_modes[index] not in {0, 2}
            or (trail_enabled[index] and trail_types[index] != 1)
            or (breakeven_enabled[index] and breakeven_types[index] != 3)
        ):
            raise ValueError(f"The ORB script uses unsupported stop or target behavior in {preset_names[index]}.")
        if ratio_enabled[index] and ratio_min[index] > ratio_max[index]:
            raise ValueError(f"The ORB script has an invalid volume-ratio gate in {preset_names[index]}.")

    table = {}
    for index, name in enumerate(preset_names):
        table[name] = {
            "orStart": starts[index],
            "orDuration": durations[index],
            "delay": delays[index],
            "tradingDuration": trading_durations[index],
            "stopMode": "swing" if stop_modes[index] == 2 else "opening_range",
            "targetMode": "swing" if target_modes[index] == 2 else "none",
            "volumeRatioEnabled": ratio_enabled[index],
            "volumeRatioMin": ratio_min[index],
            "volumeRatioMax": ratio_max[index],
            "atrTrailEnabled": trail_enabled[index],
            "atrTrail": trail_values[index],
            "breakevenEnabled": breakeven_enabled[index],
            "breakevenPct": breakeven_pct[index],
            "breakevenOffset": breakeven_offset[index],
            "riskBudget": risk_budget[index],
            "riskFactor": risk_factor[index],
        }
    fixed_quantity_match = re.search(
        r"QTY_FIXED\s*=\s*input\.int\(\s*(\d+)\s*,[^\n]*?\bminval\s*=\s*(\d+)",
        source,
    )
    quantity_cap_match = re.search(
        r"QTY_CAP\s*=\s*input\.int\(\s*(\d+)\s*,[^\n]*?\bminval\s*=\s*(\d+)\s*,\s*maxval\s*=\s*(\d+)",
        source,
    )
    if not fixed_quantity_match or not quantity_cap_match:
        raise ValueError("The ORB script must expose fixed quantity and risk-sized contract cap inputs.")
    if fixed_quantity_match.group(2) != "1" or quantity_cap_match.group(2, 3) != ("1", "40"):
        raise ValueError("The ORB sizing input limits must match the supported Pine minimums and 40-contract cap.")
    mode_match = re.search(
        r'SIZE_MODE\s*=\s*input\.string\(\s*"([^"]+)"\s*,[^)]*options\s*=\s*\[([^\]]+)\]',
        source,
    )
    if not mode_match or re.findall(r'"([^"]+)"', mode_match.group(2)) != [
        "Fixed quantity", "Risk-sized (approximate)"
    ]:
        raise ValueError("The ORB script must expose its supported fixed and approximate-risk sizing modes.")
    source_settings = {
        "preset": preset_default,
        "sizing": "fixed" if mode_match.group(1) == "Fixed quantity" else "risk",
        "quantity": int(fixed_quantity_match.group(1)),
        "quantityCap": int(quantity_cap_match.group(1)),
        "presetTable": table,
    }
    return {
        "name": "ORB NQ Trio Presets",
        "settings": source_settings,
        "presets": table,
        "detected": ["NQ 1-minute ORB", "three Pine preset tables", "fixed/risk-sized MNQ inputs"],
    }


def analyze_custom_algorithm(language: str, source: str) -> dict:
    if language not in {"python", "cpp", "pine"}:
        raise ValueError("Choose Python, C++, or Pine Script source code.")
    if not isinstance(source, str) or not source.strip():
        raise ValueError("Algorithm source must contain 1–100,000 UTF-8 bytes.")
    try:
        source_bytes = len(source.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise ValueError("Algorithm source must be valid UTF-8 text.") from exc
    if source_bytes > MAX_ALGORITHM_SOURCE_BYTES:
        raise ValueError("Algorithm source must contain 1–100,000 UTF-8 bytes.")
    if language == "python":
        try:
            ast.parse(source)
        except (SyntaxError, RecursionError) as exc:
            if isinstance(exc, RecursionError):
                raise ValueError("Python source is too deeply nested for static analysis.") from exc
            raise ValueError(f"Python syntax error on line {exc.lineno}: {exc.msg}") from exc
    if language == "pine":
        if 'strategy("ORB NQ Trio Presets"' in source:
            orb_program = compile_orb_pine_inputs(source)
            return {
                "settings": {},
                "detected": orb_program["detected"],
                "warnings": [
                    "Pine code is not executed. The supported ORB preset table and exposed Pine inputs are parsed into the local MNQ simulator."
                ],
                "orbProgram": orb_program,
            }
        program = compile_pine_subset(source)
        indicators = [
            f"{name} = {indicator['kind'].upper()}({indicator['length']})"
            for name, indicator in program["indicators"].items()
        ]
        return {
            "settings": {},
            "detected": indicators,
            "warnings": [
                "Pine entry and exit signals will execute through this safe crossover subset; other Pine features are rejected."
            ],
            "program": program,
        }

    text = source.casefold()
    rsi_names = {"rsi"}
    rsi_names.update(
        match.group(1)
        for match in re.finditer(r"\b([a-z_]\w*)\s*=\s*[^\n]*\brsi\b", text)
    )
    rsi_name_pattern = "|".join(re.escape(name) for name in sorted(rsi_names, key=len, reverse=True))
    settings = {}
    detected = []
    warnings = [
        "This is a heuristic source scan, not code execution or a faithful conversion. Review every proposed setting before applying it."
    ]

    def add_detection(label: str, description: str) -> None:
        if label not in detected:
            detected.append(label)
            warnings.append(description)

    rsi_match = re.search(
        r"\brsi\b[^\n]{0,50}?(?:\(\s*[^,()]+,\s*|length\s*[:=]\s*|period\s*[:=]\s*)(\d{1,3})",
        text,
    )
    if re.search(r"\brsi\b", text):
        add_detection("RSI", "RSI logic may not be recognized if it is wrapped in custom functions or computed indirectly.")
        settings.update({"momentumWeight": 30, "pullbackWeight": 60, "lowVolWeight": 10})
    if rsi_match and 2 <= int(rsi_match.group(1)) <= 100:
        settings["lookbackDays"] = max(5, min(60, int(rsi_match.group(1))))
        detected.append(f"RSI period {int(rsi_match.group(1))}")

    oversold = re.search(rf"\b(?:{rsi_name_pattern})\b\s*<\s*(\d{{1,2}}(?:\.\d+)?)", text)
    if oversold:
        settings["entryZ"] = round(max(0.5, min(3, 0.5 + (50 - float(oversold.group(1))) / 20)), 2)
        add_detection(f"RSI oversold threshold {oversold.group(1)}", "RSI thresholds are mapped approximately to the simulator's z-score entry setting.")
    overbought = re.search(rf"\b(?:{rsi_name_pattern})\b\s*>\s*(\d{{1,2}}(?:\.\d+)?)", text)
    if overbought:
        settings["exitZ"] = round(max(-0.5, min(1, (float(overbought.group(1)) - 50) / 100)), 2)
        add_detection(f"RSI overbought threshold {overbought.group(1)}", "RSI exit thresholds are mapped approximately to the simulator's mean-reversion exit setting.")

    for indicator, label, weights in (
        (r"\bmacd\b", "MACD", (65, 20, 15)),
        (r"\b(?:ema|exponential moving average)\b", "EMA", (60, 25, 15)),
        (r"\b(?:sma|simple moving average)\b", "SMA", (55, 30, 15)),
        (r"\b(?:roc|rate.of.change|momentum)\b", "Momentum", (70, 20, 10)),
        (r"\b(?:bollinger|bbands?)\b", "Bollinger Bands", (35, 55, 10)),
    ):
        if re.search(indicator, text):
            settings.update(dict(zip(("momentumWeight", "pullbackWeight", "lowVolWeight"), weights)))
            add_detection(label, f"{label} was recognized by name only; its exact signal and parameters are not interpreted.")

    atr_multiple = re.search(r"(\d+(?:\.\d+)?)\s*\*?\s*atr\b|\batr\b\s*\*?\s*(\d+(?:\.\d+)?)", text)
    if atr_multiple:
        multiple = float(next(value for value in atr_multiple.groups() if value))
        settings["stopVolMultiplier"] = round(max(0.5, min(3, multiple)), 1)
        add_detection("ATR-based stop", "ATR stop distance is approximated as the simulator's recent-volatility stop multiplier.")
    elif re.search(r"\batr\b", text):
        add_detection("ATR", "ATR was detected, but no numeric stop multiple could be mapped.")

    risk_match = re.search(r"\brisk(?:_pct| per trade| per position)?\s*[:=]\s*(\d+(?:\.\d+)?)\s*(%|percent)?", text)
    if risk_match:
        risk_pct = float(risk_match.group(1))
        if not risk_match.group(2) and risk_pct <= 0.02:
            risk_pct *= 100
        settings["riskPct"] = round(max(0.1, min(2, risk_pct)), 1)
        add_detection("Explicit per-trade risk", "Risk sizing is mapped to the simulator's target equity risk per trade.")

    if not detected:
        warnings.append("No supported indicator or numeric risk/stop pattern was recognized. No settings are proposed.")
    if re.search(r"\b(?:short|options?|futures?|leverage|machine learning|neural|news|order book|dividend|portfolio optimization)\b", text):
        warnings.append("The source mentions logic outside this importer's supported mapping; that logic will not be reproduced.")
    return {"settings": settings, "detected": detected, "warnings": warnings}


def _read_bounded_json_body(handler: SimpleHTTPRequestHandler) -> dict:
    content_length = handler.headers.get("Content-Length", "")
    if not content_length.isdecimal() or int(content_length) > MAX_REQUEST_BYTES:
        raise ValueError("Request is too large.")
    try:
        body = handler.rfile.read(int(content_length))
        payload = json.loads(body.decode("utf-8"), parse_constant=_reject_json_constant)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Request body must be valid UTF-8 JSON.") from exc
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object.")
    return payload


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON number: {value}")


def _validate_finite_numbers(value: object) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Portfolio numbers must be finite.")
    if isinstance(value, dict):
        for child in value.values():
            _validate_finite_numbers(child)
    elif isinstance(value, list):
        for child in value:
            _validate_finite_numbers(child)


def validate_portfolio(portfolio: object, market: str = "futures") -> dict:
    if not isinstance(portfolio, dict) or portfolio.get("version") != 1:
        raise ValueError("Portfolio data is not in a supported format.")
    portfolio.setdefault("aiEnabled", False)
    portfolio.setdefault("manualSymbols", portfolio.get("watchlist", []))
    portfolio.setdefault("companyNames", {})
    portfolio.setdefault("dailyReports", [])
    portfolio.setdefault("aiFocus", "")
    portfolio.setdefault("strategyMode", "local")
    portfolio.setdefault(
        "strategyEngine",
        "quant" if market == "stock" or portfolio.get("strategyMode") == "imported" else "orb_nq_trio",
    )
    portfolio.setdefault("orbSettings", orb_default_settings())
    portfolio.setdefault("localStrategy", dict(portfolio.get("strategy") or {}))
    portfolio.setdefault("importedStrategies", [])
    portfolio.setdefault("selectedImportedStrategyId", None)
    portfolio.setdefault("omittedTrades", 0)

    def valid_number(name: str, minimum: float, maximum: float) -> None:
        value = portfolio.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not minimum <= value <= maximum:
            raise ValueError(f"Portfolio field '{name}' is outside its allowed range.")

    valid_number("initialCapital", 100, 100_000_000)
    valid_number("cash", -1_000_000_000, 1_000_000_000)
    if not re.fullmatch(r"[A-Z]{3}", str(portfolio.get("currency", ""))):
        raise ValueError("Select symbols that use the portfolio's three-letter quote currency.")

    watchlist = portfolio.get("watchlist")
    manual_symbols = portfolio.get("manualSymbols")
    positions = portfolio.get("positions")
    trades = portfolio.get("trades")
    daily_equity = portfolio.get("dailyEquity")
    daily_reports = portfolio.get("dailyReports")
    company_names = portfolio.get("companyNames")
    proposals = portfolio.get("proposals")
    if not isinstance(watchlist, list) or not watchlist or len(watchlist) > MAX_PORTFOLIO_SYMBOLS or not all(
        isinstance(symbol, str) and SYMBOL_PATTERN.fullmatch(symbol) for symbol in watchlist
    ):
        raise ValueError("Add one or more valid ticker symbols.")
    if len(set(watchlist)) != len(watchlist):
        raise ValueError("Add unique ticker symbols.")
    if (
        not isinstance(portfolio.get("aiEnabled"), bool)
        or not isinstance(manual_symbols, list)
        or not all(isinstance(symbol, str) and SYMBOL_PATTERN.fullmatch(symbol) for symbol in manual_symbols)
        or len(set(manual_symbols)) != len(manual_symbols)
        or not set(manual_symbols).issubset(watchlist)
    ):
        raise ValueError("Portfolio AI selection settings are not valid.")
    if (
        not isinstance(company_names, dict)
        or not set(company_names).issubset(watchlist)
        or any(not isinstance(name, str) or not name.strip() or len(name) > 120 for name in company_names.values())
    ):
        raise ValueError("Portfolio company names are not valid.")
    ai_focus = portfolio.get("aiFocus", "")
    if not isinstance(ai_focus, str) or len(ai_focus) > 1_000:
        raise ValueError("AI focus notes must be text of at most 1,000 characters.")
    portfolio.pop("customAlgorithm", None)
    if not isinstance(positions, dict) or not isinstance(trades, list) or len(trades) > MAX_PORTFOLIO_TRADES:
        raise ValueError("Portfolio positions or trade history is not valid.")
    if (
        isinstance(portfolio["omittedTrades"], bool)
        or not isinstance(portfolio["omittedTrades"], int)
        or portfolio["omittedTrades"] < 0
    ):
        raise ValueError("The omitted trade-history count is not valid.")
    if portfolio["cash"] < 0 and not (
        any(
            isinstance(position, dict) and position.get("assetType") == "future"
            for position in positions.values()
        )
        or any(
            isinstance(trade, dict) and trade.get("assetType") == "future"
            for trade in trades
        )
    ):
        raise ValueError("Negative cash is only valid after simulated futures losses.")
    if not isinstance(daily_equity, list) or len(daily_equity) > MAX_PORTFOLIO_EQUITY_ROWS:
        raise ValueError("Portfolio history is not valid.")
    if not isinstance(daily_reports, list) or len(daily_reports) > MAX_DAILY_REPORTS:
        raise ValueError("Portfolio decision reports are not valid.")
    if not isinstance(proposals, list) or len(proposals) > 20:
        raise ValueError("Portfolio can store at most 20 strategy proposals.")
    if any(not isinstance(proposal, str) or len(proposal) > 4_000 for proposal in proposals):
        raise ValueError("A strategy proposal cannot exceed 4,000 characters.")
    if not set(positions).issubset(watchlist):
        raise ValueError("Keep every ticker with an open holding in the portfolio watchlist.")

    last_prices = portfolio.get("lastPrices")
    if not isinstance(last_prices, dict) or not set(last_prices).issubset(watchlist):
        raise ValueError("Portfolio market prices are not valid.")
    for symbol, position in positions.items():
        if not SYMBOL_PATTERN.fullmatch(symbol) or not isinstance(position, dict):
            raise ValueError("A portfolio holding is not valid.")
        shares = position.get("shares")
        if isinstance(shares, bool) or not isinstance(shares, int) or shares < 1:
            raise ValueError("A holding must have a positive whole-share count.")
        for key in ("entryPrice", "stopPrice"):
            amount = position.get(key)
            if isinstance(amount, bool) or not isinstance(amount, (int, float)) or amount <= 0:
                raise ValueError(f"A holding's '{key}' must be greater than zero.")
        entry_fee = position.get("entryFee")
        if isinstance(entry_fee, bool) or not isinstance(entry_fee, (int, float)) or entry_fee < 0:
            raise ValueError("A holding's entry fee cannot be negative.")
        if position.get("assetType", "equity") == "future":
            contract = FUTURES_CONTRACTS.get(symbol)
            if (
                contract is None
                or position.get("multiplier") != contract["multiplier"]
                or position.get("initialMargin") != contract["initialMargin"]
                or isinstance(position.get("direction"), bool)
                or position.get("direction") not in (-1, 1)
                or isinstance(position.get("marginReserved"), bool)
                or not isinstance(position.get("marginReserved"), (int, float))
                or position["marginReserved"] != shares * contract["initialMargin"]
            ):
                raise ValueError("A futures holding's contract and reserved margin are not valid.")
        elif position.get("assetType", "equity") != "equity":
            raise ValueError("A holding instrument type is not supported.")
        try:
            date.fromisoformat(position.get("entryDate", ""))
        except (TypeError, ValueError) as exc:
            raise ValueError("A holding's entry date is not valid.") from exc
    for symbol, price in last_prices.items():
        if (
            not isinstance(symbol, str)
            or not SYMBOL_PATTERN.fullmatch(symbol)
            or isinstance(price, bool)
            or not isinstance(price, (int, float))
            or price <= 0
        ):
            raise ValueError("A portfolio market price is not valid.")

    for trade in trades:
        if (
            not isinstance(trade, dict)
            or not isinstance(trade.get("symbol"), str)
            or not SYMBOL_PATTERN.fullmatch(trade["symbol"])
        ):
            raise ValueError("Portfolio trade history is not valid.")
        shares = trade.get("shares")
        if isinstance(shares, bool) or not isinstance(shares, int) or shares < 1:
            raise ValueError("A trade must have a positive whole-share count.")
        for key in ("entryPrice", "exitPrice", "entryFee", "exitFee", "pnl"):
            amount = trade.get(key)
            if isinstance(amount, bool) or not isinstance(amount, (int, float)):
                raise ValueError(f"A trade's '{key}' amount is not valid.")
        for key in ("entryDate", "exitDate"):
            try:
                date.fromisoformat(trade.get(key, ""))
            except (TypeError, ValueError) as exc:
                raise ValueError("A trade date is not valid.") from exc
    previous_day = None
    for day in daily_equity:
        if not isinstance(day, dict):
            raise ValueError("A portfolio equity snapshot is not valid.")
        try:
            snapshot_date = date.fromisoformat(day.get("date", ""))
        except (TypeError, ValueError) as exc:
            raise ValueError("A portfolio equity date is not valid.") from exc
        if previous_day is not None and snapshot_date <= previous_day:
            raise ValueError("Portfolio equity dates must be in ascending order.")
        previous_day = snapshot_date
        for key in ("value", "cash", "dailyPnl"):
            if isinstance(day.get(key), bool) or not isinstance(day.get(key), (int, float)):
                raise ValueError(f"An equity snapshot's '{key}' amount is not valid.")

    previous_report_day = None
    for report in daily_reports:
        if not isinstance(report, dict) or not isinstance(report.get("aiEnabled"), bool):
            raise ValueError("A daily decision report is not valid.")
        try:
            report_date = date.fromisoformat(report.get("date", ""))
        except (TypeError, ValueError) as exc:
            raise ValueError("A daily decision report date is not valid.") from exc
        if previous_report_day is not None and report_date <= previous_report_day:
            raise ValueError("Decision report dates must be in ascending order.")
        previous_report_day = report_date
        if (
            not isinstance(report.get("summary"), str)
            or len(report["summary"]) > 1_000
            or any(
                isinstance(report.get(key), bool) or not isinstance(report.get(key), (int, float))
                for key in ("equity", "dailyPnl")
            )
        ):
            raise ValueError("A daily decision report summary is not valid.")
        report_strategy = report.get("strategy")
        if report_strategy is not None:
            if not isinstance(report_strategy, dict) or set(report_strategy) != set(STRATEGY_RANGES):
                raise ValueError("A daily decision report's strategy settings are not valid.")
            for key, (minimum, maximum) in STRATEGY_RANGES.items():
                value = report_strategy.get(key)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not minimum <= value <= maximum:
                    raise ValueError(f"A report strategy setting '{key}' is outside its allowed range.")
            if sum(report_strategy[key] for key in ("momentumWeight", "pullbackWeight", "lowVolWeight")) == 0:
                raise ValueError("A report must use at least one candidate-ranking weight.")
        ranked = report.get("ranked")
        actions = report.get("actions")
        if not isinstance(ranked, list) or len(ranked) > MAX_PORTFOLIO_SYMBOLS:
            raise ValueError("A daily candidate ranking is not valid.")
        if not isinstance(actions, list) or len(actions) > MAX_PORTFOLIO_SYMBOLS:
            raise ValueError("A daily trade decision list is not valid.")
        for candidate in ranked:
            if (
                not isinstance(candidate, dict)
                or not isinstance(candidate.get("symbol"), str)
                or not SYMBOL_PATTERN.fullmatch(candidate["symbol"])
                or not isinstance(candidate.get("company"), str)
                or len(candidate["company"]) > 120
                or not isinstance(candidate.get("selected"), bool)
                or not isinstance(candidate.get("decision"), str)
                or len(candidate["decision"]) > 200
                or any(
                    isinstance(candidate.get(key), bool) or not isinstance(candidate.get(key), (int, float))
                    for key in ("score", "momentum", "volatility", "zScore")
                )
                or abs(candidate["score"]) > 1_000_000
                or candidate["volatility"] < 0
            ):
                raise ValueError("A candidate's factor data is not valid.")
        for action in actions:
            if (
                not isinstance(action, dict)
                or not isinstance(action.get("symbol"), str)
                or not SYMBOL_PATTERN.fullmatch(action["symbol"])
                or not isinstance(action.get("action"), str)
                or len(action["action"]) > 40
                or not isinstance(action.get("reason"), str)
                or len(action["reason"]) > 500
            ):
                raise ValueError("A daily trade decision is not valid.")

    processed_date = portfolio.get("processedThroughDate")
    if processed_date is not None:
        try:
            date.fromisoformat(processed_date)
        except (TypeError, ValueError) as exc:
            raise ValueError("The last processed trading date is not valid.") from exc

    strategy = portfolio.get("strategy")
    if not isinstance(strategy, dict):
        raise ValueError("Portfolio strategy settings are not valid.")
    strategy_defaults = {
        "stopVolMultiplier": 2,
        "maxAiPicks": 4,
        "momentumDays": 20,
        "momentumWeight": 45,
        "pullbackWeight": 30,
        "lowVolWeight": 25,
        "slippageBps": 5,
        "commissionBps": 1,
    }
    for key, value in strategy_defaults.items():
        strategy.setdefault(key, value)
    for key, (minimum, maximum) in STRATEGY_RANGES.items():
        value = strategy.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not minimum <= value <= maximum:
            raise ValueError(f"Strategy setting '{key}' is outside its allowed range.")
    if strategy["momentumWeight"] + strategy["pullbackWeight"] + strategy["lowVolWeight"] == 0:
        raise ValueError("At least one candidate-ranking weight must be greater than zero.")

    local_strategy = portfolio.get("localStrategy")
    if not isinstance(local_strategy, dict):
        raise ValueError("Local strategy settings are not valid.")
    normalized_local_strategy = {**strategy_defaults, **local_strategy}
    if set(normalized_local_strategy) != set(STRATEGY_RANGES):
        raise ValueError("Local strategy settings contain unsupported fields.")
    for key, (minimum, maximum) in STRATEGY_RANGES.items():
        value = normalized_local_strategy[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not minimum <= value <= maximum:
            raise ValueError(f"Local strategy setting '{key}' is outside its allowed range.")
    if sum(normalized_local_strategy[key] for key in ("momentumWeight", "pullbackWeight", "lowVolWeight")) == 0:
        raise ValueError("Local strategy must use at least one candidate-ranking weight.")
    portfolio["localStrategy"] = normalized_local_strategy

    imported_strategies = portfolio.get("importedStrategies")
    if not isinstance(imported_strategies, list) or len(imported_strategies) > MAX_IMPORTED_STRATEGIES:
        raise ValueError(f"Portfolio can store at most {MAX_IMPORTED_STRATEGIES} imported strategies.")
    imported_ids = set()
    for imported in imported_strategies:
        if (
            not isinstance(imported, dict)
            or not isinstance(imported.get("id"), str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", imported["id"])
            or imported["id"] in imported_ids
            or not isinstance(imported.get("name"), str)
            or not imported["name"].strip()
            or len(imported["name"]) > 100
            or not isinstance(imported.get("strategy"), dict)
            or set(imported["strategy"]) != set(STRATEGY_RANGES)
        ):
            raise ValueError("An imported strategy preset is not valid.")
        imported_ids.add(imported["id"])
        if imported.get("nativeProgram") is not None:
            imported["nativeProgram"] = validate_native_program(imported["nativeProgram"])
            if imported.get("pineProgram") is not None:
                raise ValueError("Select only one executable program per imported strategy.")
        pine_program = imported.get("pineProgram")
        if pine_program is not None:
            if (
                not isinstance(pine_program, dict)
                or set(pine_program) != {"version", "indicators", "entry", "exit", "direction"}
                or pine_program.get("version") != 1
                or pine_program.get("direction") not in {"long", "short"}
                or not isinstance(pine_program.get("indicators"), dict)
                or not 1 <= len(pine_program["indicators"]) <= 20
            ):
                raise ValueError("An imported Pine program is not valid.")
            indicator_names = set(pine_program["indicators"])
            for name, indicator in pine_program["indicators"].items():
                if (
                    not isinstance(name, str)
                    or not re.fullmatch(r"[A-Za-z_]\w*", name)
                    or not isinstance(indicator, dict)
                    or set(indicator) != {"kind", "length"}
                    or indicator.get("kind") not in {"sma", "ema", "rsi"}
                    or isinstance(indicator.get("length"), bool)
                    or not isinstance(indicator.get("length"), int)
                    or not 2 <= indicator["length"] <= 500
                ):
                    raise ValueError("An imported Pine indicator is not valid.")
            for condition_name in ("entry", "exit"):
                condition = pine_program[condition_name]
                if (
                    not isinstance(condition, dict)
                    or set(condition) != {"cross", "left", "right"}
                    or condition.get("cross") not in {"crossover", "crossunder"}
                    or condition.get("left") not in indicator_names
                    or condition.get("right") not in indicator_names
                ):
                    raise ValueError("An imported Pine crossover condition is not valid.")
        for key, (minimum, maximum) in STRATEGY_RANGES.items():
            value = imported["strategy"][key]
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not minimum <= value <= maximum:
                raise ValueError(f"Imported strategy setting '{key}' is outside its allowed range.")
        if sum(imported["strategy"][key] for key in ("momentumWeight", "pullbackWeight", "lowVolWeight")) == 0:
            raise ValueError("An imported strategy must use at least one candidate-ranking weight.")

    strategy_mode = portfolio.get("strategyMode")
    strategy_engine = portfolio.get("strategyEngine")
    selected_import_id = portfolio.get("selectedImportedStrategyId")
    if not isinstance(strategy_mode, str) or strategy_mode not in {"local", "imported"}:
        raise ValueError("Choose either the local or an imported strategy.")
    if not isinstance(strategy_engine, str) or strategy_engine not in {"quant", "orb_nq_trio"}:
        raise ValueError("Choose a supported futures strategy engine.")
    portfolio["orbSettings"] = validate_orb_settings(portfolio["orbSettings"])
    if market == "stock" and strategy_engine != "quant":
        raise ValueError("Stock Trading uses the existing daily quant strategy.")
    if strategy_mode == "imported" and strategy_engine == "orb_nq_trio":
        raise ValueError("Choose either the local ORB strategy or an imported strategy, not both.")
    if strategy_mode == "local":
        if selected_import_id is not None and (
            not isinstance(selected_import_id, str) or selected_import_id not in imported_ids
        ):
            raise ValueError("The selected imported strategy does not exist.")
        if portfolio["strategy"] != normalized_local_strategy:
            portfolio["strategy"] = dict(normalized_local_strategy)
    else:
        selected = next(
            (item for item in imported_strategies if item["id"] == selected_import_id),
            None,
        )
        if selected is None:
            raise ValueError("Choose an imported strategy before using imported mode.")
        portfolio["strategy"] = dict(selected["strategy"])

    _validate_finite_numbers(portfolio)
    return portfolio


def portfolio_path(market: str = "futures") -> Path:
    if market not in {"futures", "stock"}:
        raise ValueError("Choose Futures Trading or Stock Trading.")
    if market == "futures":
        return PORTFOLIO_PATH
    return PORTFOLIO_PATH.with_name(f"{PORTFOLIO_PATH.stem}-stock{PORTFOLIO_PATH.suffix}")


def read_portfolio(market: str = "futures") -> dict | None:
    if market not in {"futures", "stock"}:
        raise ValueError("Choose Futures Trading or Stock Trading.")
    path = portfolio_path(market)
    with portfolio_lock:
        if not path.exists():
            return None
        try:
            raw = path.read_text(encoding="utf-8")
            portfolio = json.loads(raw, parse_constant=_reject_json_constant)
            return validate_portfolio(portfolio, market)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise ValueError(f"Could not read the saved portfolio: {exc}") from exc


def write_portfolio(portfolio: object, market: str = "futures") -> dict:
    validated = validate_portfolio(portfolio, market)
    encoded = json.dumps(validated, separators=(",", ":"), allow_nan=False)
    if len(encoded.encode("utf-8")) > MAX_REQUEST_BYTES:
        raise ValueError("The saved portfolio is too large.")
    path = portfolio_path(market)
    with portfolio_lock:
        temporary_path = path.with_suffix(".json.tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path.write_text(encoded, encoding="utf-8")
            temporary_path.replace(path)
        except OSError as exc:
            raise ValueError("Could not save the portfolio to disk.") from exc
    return validated


def archive_portfolio(market: str) -> str | None:
    path = portfolio_path(market)
    with portfolio_lock:
        if not path.exists():
            return None
        try:
            archive_dir = path.parent / "portfolio-archives"
            archive_dir.mkdir(parents=True, exist_ok=True)
            archive = archive_dir / f"{path.stem}-{uuid.uuid4().hex}.json"
            archive.write_bytes(path.read_bytes())
            return archive.name
        except OSError as exc:
            raise ValueError("Could not archive the previous portfolio. The fresh backtest was not started.") from exc


class SimulatorHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/live-stock":
            try:
                symbol = parse_qs(urlsplit(self.path).query).get("symbol", [""])[0].upper()
                self._send_json(200, live_stock_data(symbol))
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            except StockMarketDataError as exc:
                self._send_json(502, {"error": str(exc)})
            return
        protected_paths = set()
        for market in ("futures", "stock"):
            portfolio_file = portfolio_path(market)
            protected_paths.update({
                f"/{portfolio_file.name}".casefold(),
                f"/{portfolio_file.with_suffix('.json.tmp').name}".casefold(),
            })
        if unquote(path).casefold() in protected_paths or "portfolio-archives" in Path(unquote(path).casefold()).parts:
            self.send_error(404, "Not found")
            return
        if path == "/api/portfolio":
            market = parse_qs(urlsplit(self.path).query).get("market", ["futures"])[0]
            try:
                self._send_json(200, {"portfolio": read_portfolio(market)})
            except ValueError as exc:
                self._send_json(500, {"error": str(exc)})
            return
        if path == "/api/futures":
            try:
                contracts = available_futures_contracts()
                self._send_json(200, {
                    "contracts": {"MNQ=F": contracts["MNQ=F"]},
                    "orbSettings": orb_default_settings(),
                })
            except MarketDataError as exc:
                self._send_json(500, {"error": str(exc)})
            return
        if path == "/api/search":
            params = parse_qs(urlsplit(self.path).query)
            query = params.get("q", [""])[0].strip()
            market = params.get("market", ["futures"])[0]
            if len(query) < 2:
                self._send_json(400, {"error": "Type at least two characters to search for a company or futures dataset."})
                return
            if len(query) > 80 or not re.fullmatch(r"[\w .&'()=/\-]+", query, re.UNICODE):
                self._send_json(400, {"error": "Searches can contain letters, numbers, spaces, and basic punctuation."})
                return
            try:
                if market == "stock":
                    self._send_json(200, {"suggestions": search_stock_companies(query)})
                elif market == "futures":
                    suggestions = search_local_instruments(query)
                    self._send_json(200, {
                        "suggestions": [item for item in suggestions if item.get("symbol") == "MNQ=F"]
                    })
                else:
                    raise ValueError("Choose Futures Trading or Stock Trading.")
            except StockMarketDataError as exc:
                self._send_json(502, {"error": str(exc)})
            except MarketDataError as exc:
                self._send_json(500, {"error": str(exc)})
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            return
        if path == "/api/ai-candidates":
            market = parse_qs(urlsplit(self.path).query).get("market", ["futures"])[0]
            try:
                if market == "stock":
                    self._send_json(200, {
                        "candidates": get_stock_ai_candidates(MAX_STOCK_UNIVERSE),
                        "source": "Yahoo Finance US active stocks",
                    })
                elif market == "futures":
                    self._send_json(200, {
                        "candidates": [
                            candidate for candidate in local_ai_candidates(MAX_RANKED_CANDIDATES)
                            if candidate.get("symbol") == "MNQ=F"
                        ],
                        "source": "Local NQ 1-minute bars.pkl dataset (MNQ only)",
                    })
                else:
                    raise ValueError("Choose Futures Trading or Stock Trading.")
            except StockMarketDataError as exc:
                self._send_json(502, {"error": str(exc)})
            except MarketDataError as exc:
                self._send_json(500, {"error": str(exc)})
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            return
        if path != "/api/market":
            if path == "/":
                self.path = "/index.html"
            return super().do_GET()

        params = parse_qs(urlsplit(self.path).query)
        symbol = params.get("symbol", [""])[0].strip().upper()
        market = params.get("market", ["futures"])[0]
        if not SYMBOL_PATTERN.fullmatch(symbol):
            self._send_json(400, {"error": "Choose a valid stock ticker or local futures symbol."})
            return
        try:
            if market == "stock":
                data = get_stock_market_data(symbol)
                after = params.get("after", [""])[0]
                days_value = params.get("days", ["2500"])[0]
                warmup_value = params.get("warmup", ["125"])[0]
                if not days_value.isdecimal() or not 1 <= int(days_value) <= 2_500:
                    raise ValueError("Replay days must be between 1 and 2,500.")
                if not warmup_value.isdecimal() or not 1 <= int(warmup_value) <= 2_500:
                    raise ValueError("Strategy warm-up history must be between 1 and 2,500 bars.")
                bars = data["bars"]
                processed = [index for index, bar in enumerate(bars) if not after or bar["date"] > after]
                if processed:
                    last_index = processed[-1]
                    first_index = max(processed[0], last_index - int(days_value) + 1)
                    warmup_start = max(0, first_index - int(warmup_value))
                    data = {**data, "bars": bars[warmup_start:last_index + 1]}
                else:
                    data = {**data, "bars": bars[-int(warmup_value):]}
                self._send_json(200, data)
            elif market == "futures":
                self._send_json(200, load_market_data(symbol))
            else:
                raise ValueError("Choose Futures Trading or Stock Trading.")
        except StockMarketDataError as exc:
            self._send_json(502, {"error": str(exc)})
        except MarketDataError as exc:
            self._send_json(400, {"error": str(exc)})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/portfolio-archive":
            try:
                market = parse_qs(urlsplit(self.path).query).get("market", ["futures"])[0]
                self._send_json(200, {"archive": archive_portfolio(market)})
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            return
        if path == "/api/algorithm-run":
            # A custom header prevents cross-origin simple form requests from running code.
            host = self.headers.get("Host", "")
            if (self.headers.get("X-Algorithm-Run") != "trusted-local-source"
                or host not in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
                or self.headers.get("Origin", f"http://{host}") != f"http://{host}"
                or self.headers.get("Sec-Fetch-Site") == "cross-site"):
                self._send_json(403, {"error": "Run trusted algorithms from this app only."})
                return
            try:
                payload = _read_bounded_json_body(self)
                signals = run_algorithm(payload.get("program"), payload.get("bars"), payload.get("trusted"))
                self._send_json(200, {"signals": signals})
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            return
        if path == "/api/algorithm-analyze":
            try:
                payload = _read_bounded_json_body(self)
                if payload.get("language") in {"python", "cpp"}:
                    program = validate_native_program({"language": payload["language"], "source": payload.get("source"), "direction": "long"})
                    result = {"settings": {}, "detected": ["on_bar strategy interface"],
                              "warnings": ["This code runs locally with your account permissions. Only run source you trust."],
                              "nativeProgram": program}
                else:
                    result = analyze_custom_algorithm(payload.get("language"), payload.get("source"))
                self._send_json(200, result)
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            return
        if path == "/api/orb-simulate":
            try:
                payload = _read_bounded_json_body(self)
                market = payload.get("market", "futures")
                if market != "futures":
                    raise ValueError("ORB simulations are available only in Futures Trading.")
                session_dates = payload.get("sessionDates")
                if (
                    not isinstance(session_dates, list)
                    or not 1 <= len(session_dates) <= 20
                    or any(not isinstance(item, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", item) for item in session_dates)
                    or len(set(session_dates)) != len(session_dates)
                ):
                    raise ValueError("Choose one to 20 unique New York trading-session dates.")
                portfolio = validate_portfolio(payload.get("portfolio"), "futures")
                if portfolio.get("strategyEngine") != "orb_nq_trio" or portfolio.get("strategyMode") != "local":
                    raise ValueError("Select the local ORB NQ Trio engine before running this simulation.")
                settings = validate_orb_settings(payload.get("settings"))
                simulate_orb_sessions(portfolio, session_dates, settings)
                self._send_json(200, {"portfolio": write_portfolio(portfolio, "futures")})
            except MarketDataError as exc:
                self._send_json(400, {"error": str(exc)})
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            return
        if path != "/api/portfolio":
            self._send_json(404, {"error": "Not found."})
            return
        content_length = self.headers.get("Content-Length", "")
        if not content_length.isdecimal() or int(content_length) > MAX_REQUEST_BYTES:
            self._send_json(413, {"error": "Portfolio request is too large."})
            return
        try:
            body = self.rfile.read(int(content_length))
            portfolio = json.loads(body.decode("utf-8"), parse_constant=_reject_json_constant)
            market = parse_qs(urlsplit(self.path).query).get("market", ["futures"])[0]
            self._send_json(200, {"portfolio": write_portfolio(portfolio, market)})
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            self._send_json(400, {"error": str(exc)})

    def do_DELETE(self) -> None:
        if urlsplit(self.path).path != "/api/portfolio":
            self._send_json(404, {"error": "Not found."})
            return
        market = parse_qs(urlsplit(self.path).query).get("market", ["futures"])[0]
        try:
            path = portfolio_path(market)
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
            return
        with portfolio_lock:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                self._send_json(500, {"error": "Could not remove the saved portfolio."})
                return
        self._send_json(200, {"portfolio": None})

    def _send_json(self, status: int, data: dict) -> None:
        body = json.dumps(data, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self) -> None:
        if not urlsplit(self.path).path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, format: str, *args) -> None:
        print(f"{self.log_date_time_string()} {format % args}")


if __name__ == "__main__":
    try:
        server = ThreadingHTTPServer((HOST, PORT), SimulatorHandler)
    except OSError as exc:
        raise SystemExit(f"Could not start on {HOST}:{PORT}. Is another simulator already running?") from exc
    print(f"Stock Day Simulator is running at http://{HOST}:{PORT}")
    print("Press Ctrl+C to stop the server.")
    if os.environ.get("SESSION_OPEN_BROWSER") == "1":
        webbrowser.open(f"http://{HOST}:{PORT}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()
