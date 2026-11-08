from __future__ import annotations

import math
from datetime import datetime, timezone

from local_market_data import FUTURES_CONTRACTS, MarketDataError, load_intraday_sessions


ORB_PRESETS = {
    "NQ sortino": {
        "orStart": 450,
        "orDuration": 15,
        "delay": 105,
        "tradingDuration": 240,
        "stopMode": "opening_range",
        "targetMode": "none",
        "volumeRatio": None,
        "atrTrail": 0.252343,
        "breakevenPct": 1.296394,
        "breakevenOffset": 2.269851,
        "riskBudget": 1500.0,
        "riskFactor": 0.4,
    },
    "NQ calmar": {
        "orStart": 480,
        "orDuration": 15,
        "delay": 75,
        "tradingDuration": 135,
        "stopMode": "opening_range",
        "targetMode": "swing",
        "volumeRatio": (1.611721, 4.640195),
        "atrTrail": 0.250425,
        "breakevenPct": 0.0,
        "breakevenOffset": 0.0,
        "riskBudget": 1500.0,
        "riskFactor": 0.25,
    },
    "NQ payouts": {
        "orStart": 555,
        "orDuration": 15,
        "delay": 0,
        "tradingDuration": 225,
        "stopMode": "swing",
        "targetMode": "none",
        "volumeRatio": None,
        "atrTrail": 0.251122,
        "breakevenPct": 0.0,
        "breakevenOffset": 0.0,
        "riskBudget": 1500.0,
        "riskFactor": 0.4,
    },
}

def _preset_table_entry(preset: str) -> dict:
    parameters = ORB_PRESETS[preset]
    ratio_bounds = parameters["volumeRatio"] or (0.0, 1_000_000_000_000.0)
    return {
        "orStart": parameters["orStart"],
        "orDuration": parameters["orDuration"],
        "delay": parameters["delay"],
        "tradingDuration": parameters["tradingDuration"],
        "stopMode": parameters["stopMode"],
        "targetMode": parameters["targetMode"],
        "volumeRatioEnabled": parameters["volumeRatio"] is not None,
        "volumeRatioMin": ratio_bounds[0],
        "volumeRatioMax": ratio_bounds[1],
        "atrTrailEnabled": True,
        "atrTrail": parameters["atrTrail"],
        "breakevenEnabled": bool(parameters["breakevenPct"]),
        "breakevenPct": parameters["breakevenPct"],
        "breakevenOffset": parameters["breakevenOffset"],
        "riskBudget": parameters["riskBudget"],
        "riskFactor": parameters["riskFactor"],
    }


def orb_default_settings(preset: str = "NQ sortino") -> dict:
    if preset not in ORB_PRESETS:
        raise ValueError("Choose one of the three supported ORB presets.")
    return {
        "preset": preset,
        "sizing": "fixed",
        "quantity": 1,
        "quantityCap": 20,
        **_preset_table_entry(preset),
        "presetTable": {name: _preset_table_entry(name) for name in ORB_PRESETS},
    }


def _validate_preset_entry(entry: object, name: str) -> dict:
    entry_keys = set(_preset_table_entry("NQ sortino"))
    if not isinstance(entry, dict) or set(entry) != entry_keys:
        raise ValueError(f"ORB Pine preset '{name}' has missing or unsupported settings.")
    normalized = dict(entry)
    for key, (minimum, maximum) in {
        "orStart": (0, 1_380),
        "orDuration": (1, 180),
        "delay": (0, 600),
        "tradingDuration": (1, 600),
    }.items():
        item = normalized.get(key)
        if isinstance(item, bool) or not isinstance(item, int) or not minimum <= item <= maximum:
            raise ValueError(f"ORB setting '{key}' must be a whole number between {minimum} and {maximum}.")
    for key, (minimum, maximum) in {
        "volumeRatioMin": (0, 1_000_000_000_000),
        "volumeRatioMax": (0, 1_000_000_000_000),
        "atrTrail": (0, 100),
        "breakevenPct": (0, 100),
        "breakevenOffset": (0, 1_000_000),
        "riskBudget": (0, 1_000_000),
        "riskFactor": (0, 100),
    }.items():
        item = normalized.get(key)
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) or not minimum <= item <= maximum:
            raise ValueError(f"ORB setting '{key}' is outside its allowed range.")
    if not all(isinstance(normalized.get(key), bool) for key in ("volumeRatioEnabled", "atrTrailEnabled", "breakevenEnabled")):
        raise ValueError("ORB filter and trailing controls must be on or off.")
    if normalized.get("stopMode") not in {"opening_range", "swing"}:
        raise ValueError("ORB stop mode must be the opening range or the 5/5 swing pivot.")
    if normalized.get("targetMode") not in {"none", "swing"}:
        raise ValueError("ORB target mode must be off or the 5/5 swing pivot.")
    if normalized["volumeRatioMin"] > normalized["volumeRatioMax"]:
        raise ValueError("The minimum volume ratio cannot exceed its maximum.")
    return normalized


def validate_orb_settings(value: object) -> dict:
    if not isinstance(value, dict):
        raise ValueError("ORB strategy settings are not valid.")
    preset = value.get("preset")
    sizing = value.get("sizing")
    quantity = value.get("quantity", 1)
    cap = value.get("quantityCap", 20)
    if not isinstance(preset, str) or preset not in ORB_PRESETS:
        raise ValueError("Choose one of the three supported ORB presets.")
    if not isinstance(sizing, str) or sizing not in {"fixed", "risk"}:
        raise ValueError("Choose fixed or approximate risk-based contract sizing.")
    allowed = set(orb_default_settings(preset)) if isinstance(preset, str) and preset in ORB_PRESETS else set()
    unknown = set(value) - allowed
    if unknown:
        raise ValueError(f"Unsupported ORB setting(s): {', '.join(sorted(unknown))}.")
    if isinstance(quantity, bool) or not isinstance(quantity, int) or not 1 <= quantity <= 100:
        raise ValueError("Fixed contract quantity must be between 1 and 100.")
    if isinstance(cap, bool) or not isinstance(cap, int) or not 1 <= cap <= 40:
        raise ValueError("The risk-sized contract cap must be between 1 and 40.")
    result = {**orb_default_settings(preset), **value}
    table = result.get("presetTable")
    if not isinstance(table, dict) or set(table) != set(ORB_PRESETS):
        raise ValueError("ORB preset table must contain exactly the three supported Pine presets.")
    table = {table_name: _validate_preset_entry(entry, table_name) for table_name, entry in table.items()}
    result["presetTable"] = table
    result.update(table[preset])
    result["sizing"] = sizing
    result["quantity"] = quantity
    result["quantityCap"] = cap
    return result


def _close_trade(portfolio: dict, position: dict, exit_price: float, exit_date: str, reason: str) -> dict:
    multiplier = position["multiplier"]
    exit_fee = 0.61 * position["shares"]
    gross = (exit_price - position["entryPrice"]) * position["direction"] * multiplier * position["shares"]
    pnl = gross - position["entryFee"] - exit_fee
    portfolio["cash"] += gross - exit_fee
    trade = {
        "symbol": position["symbol"],
        "company": position["company"],
        "shares": position["shares"],
        "assetType": "future",
        "direction": position["direction"],
        "entryPrice": position["entryPrice"],
        "exitPrice": exit_price,
        "entryFee": position["entryFee"],
        "exitFee": exit_fee,
        "entryDate": position["entryDate"],
        "exitDate": exit_date,
        "pnl": pnl,
        "reason": reason,
    }
    portfolio["trades"].append(trade)
    return trade


def _record_trade(portfolio: dict, date: str, entry_price: float, exit_price: float, quantity: int,
                  direction: int, reason: str) -> dict:
    contract = FUTURES_CONTRACTS["MNQ=F"]
    position = {
        "symbol": "MNQ=F",
        "company": contract["name"],
        "shares": quantity,
        "multiplier": contract["multiplier"],
        "direction": direction,
        "entryPrice": entry_price,
        "entryFee": 0.61 * quantity,
        "entryDate": date,
    }
    portfolio["cash"] -= position["entryFee"]
    return _close_trade(portfolio, position, exit_price, date, reason)


def _trade_day(date: str, bars: list[dict], equity_at_open: float, floor: float,
               settings: dict) -> tuple[dict | None, float, list[dict]]:
    or_start = settings["orStart"]
    or_end = or_start + settings["orDuration"]
    trade_start = or_end + settings["delay"]
    trade_end = trade_start + settings["tradingDuration"]
    or_high = None
    or_low = None
    day_traded = False
    was_in_trading = False
    pending_order = None
    position = None
    last_bar = None
    actions = []
    saw_trading_bar = False
    saw_ratio_pass = False

    for bar in bars:
        minute = bar["time"]
        filled_this_bar = False
        in_or = or_start <= minute < or_end
        in_trading = trade_start <= minute < trade_end
        saw_trading_bar = saw_trading_bar or in_trading
        if in_or:
            or_high = bar["high"] if or_high is None else max(or_high, bar["high"])
            or_low = bar["low"] if or_low is None else min(or_low, bar["low"])

        if position:
            stop_hit = bar["low"] <= position["stop"] if position["direction"] > 0 else bar["high"] >= position["stop"]
            target_hit = position["target"] is not None and (
                bar["high"] >= position["target"] if position["direction"] > 0 else bar["low"] <= position["target"]
            )
            if stop_hit or target_hit:
                if stop_hit:
                    reference = min(bar["open"], position["stop"]) if position["direction"] > 0 else max(bar["open"], position["stop"])
                    reason = "Protective stop"
                else:
                    reference = min(bar["open"], position["target"]) if position["direction"] > 0 else max(bar["open"], position["target"])
                    reason = "Swing target"
                trade = {
                    "entryPrice": position["entry"],
                    "exitPrice": reference - position["direction"] * 0.25,
                    "quantity": position["quantity"],
                    "direction": position["direction"],
                    "reason": reason,
                }
                return trade, equity_at_open, actions

        if position is None and pending_order and in_trading and or_high is not None and or_low is not None:
            long_touched = bar["high"] >= or_high
            short_touched = bar["low"] <= or_low
            direction = 0
            if long_touched and short_touched:
                up_distance = abs(bar["open"] - bar["high"])
                down_distance = abs(bar["open"] - bar["low"])
                if up_distance != down_distance:
                    direction = 1 if up_distance < down_distance else -1
                else:
                    day_traded = True
                    actions.append({
                        "symbol": "MNQ=F",
                        "action": "SKIP BREAKOUT",
                        "reason": "This one-minute bar touched both opening-range boundaries with equal open-distance; intrabar order is ambiguous, so it was skipped conservatively.",
                    })
            elif long_touched:
                direction = 1
            elif short_touched:
                direction = -1
            if direction:
                entry_ref = max(bar["open"], or_high) if direction > 0 else min(bar["open"], or_low)
                entry = entry_ref + direction * 0.25
                stop_mode = settings["stopMode"]
                prior_swing = bar["swingLowPrevious"] if direction > 0 else bar["swingHighPrevious"]
                fallback = or_low if direction > 0 else or_high
                stop = prior_swing if stop_mode == "swing" and prior_swing is not None and (
                    prior_swing < entry if direction > 0 else prior_swing > entry
                ) else fallback
                prior_target = bar["swingHighPrevious"] if direction > 0 else bar["swingLowPrevious"]
                target = prior_target if settings["targetMode"] == "swing" and prior_target is not None and (
                    prior_target > entry if direction > 0 else prior_target < entry
                ) else None
                quantity = pending_order["quantity"]
                position = {
                    "direction": direction,
                    "entry": entry,
                    "entryRef": entry_ref,
                    "quantity": quantity,
                    "stop": stop,
                    "target": target,
                    "hwm": bar["high"],
                    "lwm": bar["low"],
                    "breakeven": False,
                }
                day_traded = True
                pending_order = None
                filled_this_bar = True
                actions.append({
                    "symbol": "MNQ=F",
                    "action": "BUY ORB" if direction > 0 else "SELL SHORT ORB",
                    "reason": f"{settings['preset']} breakout at {entry:.2f}; opening range {or_low:.2f}–{or_high:.2f}, {quantity} MNQ contract{'s' if quantity != 1 else ''}.",
                })
                stop_hit = bar["low"] <= stop if direction > 0 else bar["high"] >= stop
                target_hit = target is not None and (
                    bar["high"] >= target if direction > 0 else bar["low"] <= target
                )
                if stop_hit or target_hit:
                    if stop_hit:
                        reference = min(bar["open"], stop) if direction > 0 else max(bar["open"], stop)
                        reason = "Protective stop on entry bar"
                    else:
                        reference = min(bar["open"], target) if direction > 0 else max(bar["open"], target)
                        reason = "Swing target on entry bar"
                    return {
                        "entryPrice": entry,
                        "exitPrice": reference - direction * 0.25,
                        "quantity": quantity,
                        "direction": direction,
                        "reason": reason,
                    }, equity_at_open, actions

        window_ended = was_in_trading and not in_trading
        if position and window_ended:
            return {
                "entryPrice": position["entry"],
                "exitPrice": bar["close"] - position["direction"] * 0.25,
                "quantity": position["quantity"],
                "direction": position["direction"],
                "reason": "Trading window ended",
            }, equity_at_open, actions

        if position and not filled_this_bar:
            if position["direction"] > 0:
                position["hwm"] = max(position["hwm"], bar["high"])
                stop = position["stop"]
                if settings["breakevenEnabled"] and not position["breakeven"] and bar["high"] >= position["entryRef"] * (1 + settings["breakevenPct"] / 100):
                    stop = max(stop, position["entryRef"] + settings["breakevenOffset"])
                    position["breakeven"] = True
                if bar["atr15"] is not None:
                    if settings["atrTrailEnabled"]:
                        stop = max(stop, position["hwm"] - bar["atr15"] * settings["atrTrail"])
                position["stop"] = stop
                if bar["low"] <= stop:
                    return {
                        "entryPrice": position["entry"],
                        "exitPrice": bar["close"] - 0.25,
                        "quantity": position["quantity"],
                        "direction": 1,
                        "reason": "Same-bar ratchet exit (lab rule C)",
                    }, equity_at_open, actions
            else:
                position["lwm"] = min(position["lwm"], bar["low"])
                stop = position["stop"]
                if settings["breakevenEnabled"] and not position["breakeven"] and bar["low"] <= position["entryRef"] * (1 - settings["breakevenPct"] / 100):
                    stop = min(stop, position["entryRef"] - settings["breakevenOffset"])
                    position["breakeven"] = True
                if bar["atr15"] is not None:
                    if settings["atrTrailEnabled"]:
                        stop = min(stop, position["lwm"] + bar["atr15"] * settings["atrTrail"])
                position["stop"] = stop
                if bar["high"] >= stop:
                    return {
                        "entryPrice": position["entry"],
                        "exitPrice": bar["close"] + 0.25,
                        "quantity": position["quantity"],
                        "direction": -1,
                        "reason": "Same-bar ratchet exit (lab rule C)",
                    }, equity_at_open, actions

        next_minute = minute + 1
        ratio = bar["volumeRatio"]
        ratio_pass = not settings["volumeRatioEnabled"] or (
            ratio is not None and settings["volumeRatioMin"] <= ratio <= settings["volumeRatioMax"]
        )
        saw_ratio_pass = saw_ratio_pass or (in_trading and ratio_pass)
        can_place = (
            position is None
            and pending_order is None
            and not day_traded
            and or_high is not None
            and next_minute >= or_end
            and trade_start <= next_minute < trade_end
            and or_high > or_low
            and ratio_pass
        )
        if can_place:
            if settings["sizing"] == "fixed":
                quantity = settings["quantity"]
            else:
                atr_for_sizing = bar["atrForNext"]
                unit_points = (atr_for_sizing or 0) * FUTURES_CONTRACTS["MNQ=F"]["multiplier"]
                budget = min(settings["riskBudget"], settings["riskFactor"] * max(equity_at_open - floor, 0))
                risk_quantity = math.floor(budget / unit_points) if unit_points > 0 else 1
                quantity = max(1, min(settings["quantityCap"], risk_quantity))
            pending_order = {"quantity": quantity}
        else:
            pending_order = None
        was_in_trading = in_trading
        last_bar = bar

    if position and last_bar:
        return {
            "entryPrice": position["entry"],
            "exitPrice": last_bar["close"] - position["direction"] * 0.25,
            "quantity": position["quantity"],
            "direction": position["direction"],
            "reason": "Session data ended; position flattened",
        }, equity_at_open, actions
    if not actions:
        if or_high is None or or_low is None:
            reason = "No opening-range bars were available at the preset's New York start time."
        elif not saw_trading_bar:
            reason = "No local minute bars were available inside this preset's trading window."
        elif settings["volumeRatioEnabled"] and not saw_ratio_pass:
            reason = (
                f"No entry passed the volume-ratio gate "
                f"({settings['volumeRatioMin']:.6f}–{settings['volumeRatioMax']:.6f})."
            )
        else:
            reason = "The opening range formed, but no eligible breakout triggered during the trading window."
        actions.append({"symbol": "MNQ=F", "action": "NO TRADE", "reason": reason})
    return None, equity_at_open, actions


def simulate_orb_sessions(portfolio: dict, session_dates: list[str], settings: object) -> dict:
    normalized = validate_orb_settings(settings)
    if len(session_dates) > 20:
        raise ValueError("ORB replay is limited to 20 sessions per request.")
    if not session_dates:
        raise ValueError("Choose at least one completed session.")
    if portfolio.get("watchlist") != ["MNQ=F"] or portfolio.get("positions"):
        raise ValueError("The ORB strategy trades MNQ only. Close existing positions and select MNQ=F before switching to ORB.")
    try:
        sessions = load_intraday_sessions("MNQ=F", session_dates)
    except MarketDataError:
        raise

    portfolio["strategyEngine"] = "orb_nq_trio"
    portfolio["orbSettings"] = normalized
    portfolio["aiEnabled"] = False
    portfolio["manualSymbols"] = ["MNQ=F"]
    portfolio["companyNames"] = {"MNQ=F": FUTURES_CONTRACTS["MNQ=F"]["name"]}
    portfolio["lastPrices"] = {"MNQ=F": portfolio.get("lastPrices", {}).get("MNQ=F", 1.0)}
    for date in sorted(session_dates):
        bars = sessions.get(date, [])
        if not bars:
            raise ValueError(f"No local NQ minute bars are available for the requested New York session {date}.")
        equity_before = portfolio["cash"]
        floor = min(50_000.0, max(float(portfolio.get("eodFloor", 48_000.0)), equity_before - 2_000.0))
        portfolio["eodFloor"] = floor
        or_start = normalized["orStart"]
        or_end = or_start + normalized["orDuration"]
        trade_start = or_end + normalized["delay"]
        trade_end = trade_start + normalized["tradingDuration"]

        def clock_time(minute: int) -> str:
            return f"{minute // 60:02d}:{minute % 60:02d}"

        trade, _, actions = _trade_day(date, bars, equity_before, floor, normalized)
        if trade:
            closed = _record_trade(
                portfolio,
                date,
                trade["entryPrice"],
                trade["exitPrice"],
                trade["quantity"],
                trade["direction"],
                trade["reason"],
            )
            actions.append({
                "symbol": "MNQ=F",
                "action": "CLOSE LONG" if trade["direction"] > 0 else "COVER SHORT",
                "reason": f"{trade['reason']}; net P&L after $0.61/contract/side commission: ${closed['pnl']:+,.2f}.",
            })
        portfolio["lastPrices"]["MNQ=F"] = bars[-1]["close"]
        equity = portfolio["cash"]
        prior_equity = portfolio["dailyEquity"][-1]["value"] if portfolio["dailyEquity"] else portfolio["initialCapital"]
        daily_pnl = equity - prior_equity
        portfolio["dailyEquity"].append({"date": date, "value": equity, "cash": portfolio["cash"], "dailyPnl": daily_pnl})
        trade_count = sum(action["action"] in {"BUY ORB", "SELL SHORT ORB"} for action in actions)
        portfolio["dailyReports"].append({
            "date": date,
            "equity": equity,
            "dailyPnl": daily_pnl,
            "aiEnabled": False,
            "strategyType": "orb",
            "strategyName": f"ORB NQ Trio · {normalized['preset']}",
            "strategy": dict(portfolio["strategy"]),
            "summary": (
                f"{normalized['preset']} evaluated local MNQ 1-minute bars. Opening range {clock_time(or_start)}–"
                f"{clock_time(or_end)} ET; trade window {clock_time(trade_start)}–{clock_time(trade_end)} ET. "
                f"{trade_count} trade(s); "
                f"portfolio ended at ${equity:,.2f} ({daily_pnl:+,.2f} today). "
                "Entries use one-tick slippage; exits include one-tick slippage and $0.61/contract/side commission."
            ),
            "ranked": [],
            "omittedRankings": 0,
            "actions": actions,
            "omittedActions": 0,
            "orbSettings": normalized,
        })
        portfolio["processedThroughDate"] = date
    portfolio["dailyEquity"] = portfolio["dailyEquity"][-25_000:]
    portfolio["dailyReports"] = portfolio["dailyReports"][-200:]
    if len(portfolio["trades"]) > 25_000:
        excess = len(portfolio["trades"]) - 25_000
        portfolio["trades"] = portfolio["trades"][-25_000:]
        portfolio["omittedTrades"] = portfolio.get("omittedTrades", 0) + excess
    portfolio["updatedAt"] = datetime.now(timezone.utc).isoformat()
    return portfolio
