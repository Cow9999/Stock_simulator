// Explicit timeframes: daily research adaptations are not live-minute presets.
function crossoverProgram(fast, slow) {
  return { version: 1, direction: "long", indicators: {
    fast: {kind: "sma", length: fast}, slow: {kind: "sma", length: slow},
  }, entry: {cross: "crossover", left: "fast", right: "slow"},
  exit: {cross: "crossunder", left: "fast", right: "slow"} };
}

document.querySelector("#load-research-strategy").addEventListener("click", async () => {
  if (controlsBusy || playbackRunning || setupSubmitting) return;
  const button = document.querySelector("#load-research-strategy");
  const choice = document.querySelector("#research-strategy").value;
  button.disabled = true;
  setBusy(true);
  try {
    const momentum = choice === "momentum252";
    let source;
    const language = momentum ? "python" : "pine";
    if (momentum) {
      const response = await fetch("/examples/time_series_momentum.py", {cache: "no-store"});
      if (!response.ok) throw new Error("Could not load the momentum strategy source.");
      source = await response.text();
    } else {
      source = '//@version=5\nstrategy("Daily SMA 50/200")\nfast = ta.sma(close, 50)\nslow = ta.sma(close, 200)\nenterLong = ta.crossover(fast, slow)\nexitLong = ta.crossunder(fast, slow)\nif enterLong\n    strategy.entry("Long", strategy.long)\nif exitLong\n    strategy.close("Long")\n';
    }
    const name = momentum ? "Daily 12-month momentum · research adaptation" : "Daily SMA 50/200 · trend baseline";
    const imported = await saveImportedStrategy(name, {...DEFAULT_STRATEGY, riskPct: 0.5},
      momentum ? null : crossoverProgram(50, 200),
      momentum ? {language, source, direction: "long"} : null);
    document.querySelector("#algorithm-source").value = source;
    document.querySelector("#algorithm-language").value = language;
    document.querySelector("#algorithm-file").value = "";
    document.querySelector("#trust-algorithm").checked = false;
    document.querySelector("#custom-analysis-result").hidden = true;
    document.querySelector("#apply-analysis").hidden = true;
    customAnalysis = null;
    uploadKind = "source";
    lastAppliedAlgorithm = {key: JSON.stringify([activeMarket, language, source]), id: imported.id, mode: strategyMode, engine: strategyEngine};
    document.querySelector("#custom-algorithm-status").textContent = `${name} selected. Uses daily bars; review the source and run a fresh backtest.${momentum ? " Check the local-code trust box before running Python." : ""}`;
    setStatus(`${name} is active. Performance has not been established on your portfolio.`, "success");
  } catch (error) { setStatus(error.message, "error"); }
  finally { setBusy(false); button.disabled = false; }
});
