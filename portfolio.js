"use strict";

const REPORT_LIMIT = 200;
const MAX_REPORTED_ITEMS = 200;
const MAX_PORTFOLIO_SYMBOLS = 200;
const MAX_IMPORTED_STRATEGIES = 20;
const MIN_LOOKBACK = 5;
const MIN_STOP = 0.0025;
const MAX_STOP = 0.05;
const PLAYBACK_CHUNK_SIZE = 20;
const PORTFOLIO_CHECKPOINT_INTERVAL = 20;
const DEFAULT_STRATEGY = {
  lookbackDays: 20,
  entryZ: 1.25,
  exitZ: 0,
  riskPct: 0.5,
  maxAllocationPct: 80,
  stopVolMultiplier: 2,
  maxAiPicks: 4,
  momentumDays: 20,
  momentumWeight: 45,
  pullbackWeight: 30,
  lowVolWeight: 25,
  slippageBps: 5,
  commissionBps: 1,
};
const STRATEGY_KEYS = Object.keys(DEFAULT_STRATEGY);

const form = document.querySelector("#portfolio-form");
const symbolsInput = document.querySelector("#symbols-input");
const aiPickerInput = document.querySelector("#ai-picker-enabled");
const aiPickerBadge = document.querySelector(".ai-toggle-badge");
const companySearchInput = document.querySelector("#company-search-input");
const companySuggestions = document.querySelector("#company-suggestions");
const companySearchStatus = document.querySelector("#company-search-status");
const cashInput = document.querySelector("#cash-input");
const daysInput = document.querySelector("#days-input");
const runButton = document.querySelector("#run-button");
const resetButton = document.querySelector("#reset-button");
const statusNode = document.querySelector("#status-message");
const priceCanvas = document.querySelector("#price-chart");
const equityCanvas = document.querySelector("#equity-chart");
const equityOverlay = document.querySelector("#equity-overlay");
const symbolSelect = document.querySelector("#chart-symbol");
const tradeBody = document.querySelector("#trades-body");
const holdingBody = document.querySelector("#holdings-body");
const playbackStatus = document.querySelector("#playback-status");
const dailyReportList = document.querySelector("#daily-report-list");
const strategyJsonInput = document.querySelector("#strategy-json");
const strategyJsonStatus = document.querySelector("#strategy-json-status");
const resultsSection = document.querySelector("#results");
const numberFormatter = new Intl.NumberFormat("en-US");

let portfolio = null;
let marketBySymbol = new Map();
let sessionDates = [];
let replayIndex = 0;
let timer = null;
let playbackRunning = false;
let advancing = false;
let companySearchTimer = null;
let companySearchVersion = 0;
let selectedSuggestion = -1;
let strategySaveTimer = null;
let portfolioSaveQueue = Promise.resolve();
let companyNameBySymbol = {};
let activeSetupStep = 1;
let strategyJsonDirty = false;
let aiFocusDraft = "";
let pendingStrategySuggestion = null;
let customAnalysis = null;
let lastAppliedAlgorithm = null;
let setupSubmitting = false;
let freshAlgorithmBacktest = false;
let uploadKind = "source";
let appliedJsonConfiguration = false;
let futuresContracts = {};
let activeMarket = "futures";
let marketSwitching = false;
let strategyMode = "local";
let strategyEngine = "orb_nq_trio";
let orbSettings = { preset: "NQ sortino", sizing: "fixed", quantity: 1, quantityCap: 20, presetTable: {} };
let orbDefaults = null;
let localStrategy = { ...DEFAULT_STRATEGY };
let importedStrategies = [];
let selectedImportedStrategyId = null;
let controlsBusy = false;
let moneyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function formatMoney(value, currency = portfolio?.currency ?? "USD") {
  if (moneyFormatter.resolvedOptions().currency !== currency) {
    moneyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
  }
  return moneyFormatter.format(value);
}

function setCurrency(currency) {
  moneyFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
  const currencyPart = moneyFormatter.formatToParts(0).find((part) => part.type === "currency");
  document.querySelector("#cash-currency-symbol").textContent = currencyPart.value;
}

function formatSignedMoney(value) {
  return `${value >= 0 ? "+" : "−"}${formatMoney(Math.abs(value))}`;
}

function formatPercent(value) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function setStatus(message, kind = "") {
  statusNode.textContent = message;
  statusNode.className = `form-message${kind ? ` ${kind}` : ""}`;
}

function setActiveSetupStep(step) {
  activeSetupStep = Math.max(1, Math.min(3, step));
  for (const panel of document.querySelectorAll(".setup-panel")) {
    panel.hidden = Number(panel.dataset.panel) !== activeSetupStep;
  }
  for (const tab of document.querySelectorAll(".setup-tab")) {
    const active = Number(tab.dataset.step) === activeSetupStep;
    tab.classList.toggle("is-active", active);
    if (active) tab.setAttribute("aria-current", "step");
    else tab.removeAttribute("aria-current");
  }
  if (activeSetupStep === 3 && !strategyJsonDirty) {
    strategyJsonInput.value = strategyConfigText(readStrategyControls());
  }
}

function setPlaybackStatus(message, kind = "") {
  playbackStatus.className = `playback-status${kind ? ` is-${kind}` : ""}`;
  playbackStatus.replaceChildren();
  const dot = document.createElement("span");
  dot.className = "status-dot";
  playbackStatus.append(dot, document.createTextNode(` ${message}`));
}

function updateRunNextStockDayButton() {
  const button = document.querySelector("#run-next-stock-day");
  button.hidden = activeMarket !== "stock" || !portfolio || playbackRunning;
  button.disabled = controlsBusy || marketSwitching;
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`The local server returned an invalid response (${response.status}).`);
  }
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

async function savePortfolio() {
  const snapshot = JSON.stringify(portfolio);
  const operation = portfolioSaveQueue.catch(() => {}).then(() => requestJson(`/api/portfolio?market=${activeMarket}`, {
    method: "POST",
    body: snapshot,
  }));
  portfolioSaveQueue = operation;
  const response = await operation;
  if (JSON.stringify(portfolio) === snapshot) portfolio = response.portfolio;
}

function updateActiveStrategy(strategy) {
  const snapshot = { ...strategy };
  if (!portfolio) {
    if (strategyMode === "local") localStrategy = snapshot;
    else {
      const selected = importedStrategies.find((item) => item.id === selectedImportedStrategyId);
      if (selected) selected.strategy = snapshot;
    }

    return;
  }
  portfolio.strategy = snapshot;
  if (strategyMode === "local") {
    portfolio.localStrategy = snapshot;
    localStrategy = snapshot;
  } else {
    const selected = importedStrategies.find((item) => item.id === selectedImportedStrategyId);
    if (selected) selected.strategy = snapshot;
    portfolio.importedStrategies = importedStrategies;
  }
}

function activeAlgorithmProgram() {
  if (strategyMode !== "imported") return null;
  const selected = importedStrategies.find((item) => item.id === selectedImportedStrategyId);
  return selected?.nativeProgram ?? selected?.pineProgram ?? null;
}

function usesOrbStrategy() {
  return activeMarket === "futures" && strategyMode === "local" && strategyEngine === "orb_nq_trio";
}

function readOrbSettings() {
  return {
    preset: document.querySelector("#orb-preset").value,
    sizing: document.querySelector("#orb-sizing").value,
    quantity: Number(document.querySelector("#orb-quantity").value),
    quantityCap: Number(document.querySelector("#orb-cap").value),
    presetTable: orbSettings.presetTable,
  };
}

function renderOrbPresetDetails() {
  const preset = orbSettings.presetTable?.[orbSettings.preset];
  const details = document.querySelector("#orb-preset-details");
  if (!preset || !details) return;
  const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const orEnd = preset.orStart + preset.orDuration;
  const tradeStart = orEnd + preset.delay;
  const tradeEnd = tradeStart + preset.tradingDuration;
  const stop = preset.stopMode === "swing" ? "5/5 swing pivot, OR fallback" : "opposite opening-range boundary";
  const target = preset.targetMode === "swing" ? "5/5 swing pivot" : "none";
  const gate = preset.volumeRatioEnabled
    ? `${preset.volumeRatioMin.toFixed(6)}–${preset.volumeRatioMax.toFixed(6)} volume ratio`
    : "off";
  const breakeven = preset.breakevenEnabled
    ? `${preset.breakevenPct}% plus ${preset.breakevenOffset} points`
    : "off";
  details.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = `Resolved Pine preset · ${orbSettings.preset}`;
  const summary = document.createElement("p");
  summary.textContent = `Opening range ${clock(preset.orStart)}–${clock(orEnd)} ET · trades ${clock(tradeStart)}–${clock(tradeEnd)} ET · ${preset.orDuration}-minute range`;
  const rules = document.createElement("p");
  rules.textContent = `Stop: ${stop} · Target: ${target} · Volume gate: ${gate} · ATR trail: ${preset.atrTrailEnabled ? `ATR15 × ${preset.atrTrail}` : "off"} · Breakeven: ${breakeven}`;
  const sizing = document.createElement("p");
  sizing.textContent = `Risk placeholders: R ${preset.riskBudget} · factor ${preset.riskFactor}.`;
  details.append(heading, summary, rules, sizing);
}

function setOrbSettings(settings = {}, defaults = orbDefaults) {
  if (!settings) settings = {};
  const baseline = defaults?.presetTable ? defaults : {
    preset: "NQ sortino",
    sizing: "fixed",
    quantity: 1,
    quantityCap: 20,
    presetTable: orbSettings.presetTable ?? {},
  };
  orbSettings = {
    ...baseline,
    preset: settings.preset ?? baseline.preset ?? "NQ sortino",
    sizing: settings.sizing ?? baseline.sizing ?? "fixed",
    quantity: settings.quantity ?? baseline.quantity ?? 1,
    quantityCap: settings.quantityCap ?? baseline.quantityCap ?? 20,
    presetTable: settings.presetTable ?? baseline.presetTable,
  };
  const presetValues = orbSettings.presetTable?.[orbSettings.preset];
  if (presetValues) Object.assign(orbSettings, presetValues);
  document.querySelector("#orb-preset").value = orbSettings.preset;
  document.querySelector("#orb-sizing").value = orbSettings.sizing;
  document.querySelector("#orb-quantity").value = String(orbSettings.quantity);
  document.querySelector("#orb-cap").value = String(orbSettings.quantityCap);
  document.querySelector("#orb-quantity-value").value = String(orbSettings.quantity);
  document.querySelector("#orb-cap-value").value = String(orbSettings.quantityCap);
  renderOrbPresetDetails();
}

function renderStrategySourcePicker() {
  const modeSelect = document.querySelector("#strategy-mode");
  const localOption = modeSelect.querySelector('option[value="local"]');
  const importedSelect = document.querySelector("#imported-strategy-select");
  const importedPicker = document.querySelector("#imported-strategy-picker");
  const enginePicker = document.querySelector("#strategy-engine-picker");
  const engineSelect = document.querySelector("#strategy-engine");
  const isStock = activeMarket === "stock";
  if (isStock) {
    strategyEngine = "quant";
  }
  const useOrb = usesOrbStrategy();
  localOption.textContent = useOrb ? "Local ORB NQ Trio" : "Local slider strategy";
  const importedOption = modeSelect.querySelector('option[value="imported"]');
  importedOption.disabled = importedStrategies.length === 0;
  importedPicker.hidden = strategyMode !== "imported";
  enginePicker.hidden = isStock;
  engineSelect.value = strategyEngine;
  engineSelect.disabled = controlsBusy || playbackRunning || strategyMode !== "local";
  document.querySelector("#orb-settings").hidden = !useOrb;
  document.querySelector("#quant-strategy-controls").hidden = useOrb || strategyMode === "imported";
  importedSelect.replaceChildren();
  for (const item of importedStrategies) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    importedSelect.append(option);
  }
  importedSelect.disabled = importedStrategies.length === 0;
  modeSelect.disabled = controlsBusy || playbackRunning;
  importedSelect.disabled = controlsBusy || playbackRunning || importedStrategies.length === 0;
  if (!importedStrategies.some((item) => item.id === selectedImportedStrategyId)) {
    selectedImportedStrategyId = importedStrategies[0]?.id ?? null;
  }
  importedSelect.value = selectedImportedStrategyId ?? "";
  modeSelect.value = strategyMode;
  const removeButton = document.querySelector("#remove-imported-strategy");
  removeButton.hidden = !selectedImportedStrategyId;
  removeButton.disabled = playbackRunning;
  const selectedStrategy = importedStrategies.find((item) => item.id === selectedImportedStrategyId);
  document.querySelector("#strategy-source-status").textContent = useOrb
      ? "The attached ORB NQ Trio strategy runs locally on MNQ 1-minute bars. The selected preset and sizing mode are applied by the futures simulator."
    : strategyMode === "local"
    ? "The local daily quant slider strategy is active. Imported presets remain saved separately."
    : selectedStrategy?.nativeProgram
      ? `Executable ${selectedStrategy.nativeProgram.language} algorithm active: ${selectedStrategy.name}. Its buy/sell signals drive trades.`
    : selectedStrategy?.pineProgram
      ? `Executable Pine program active: ${selectedStrategy.name}. Its entry/exit signals run directly; sliders control risk, stops, and costs.`
      : `Imported strategy in use: ${selectedStrategy?.name ?? "Select a preset"}.`;
}

async function saveImportedStrategy(name, strategy, pineProgram = null, nativeProgram = null) {
  if (activeMarket === "stock" && pineProgram?.direction === "short") throw new Error("Stock algorithms must be long-only.");
  if (importedStrategies.length >= MAX_IMPORTED_STRATEGIES) {
    throw new Error(`You can save up to ${MAX_IMPORTED_STRATEGIES} imported strategy presets. Remove an existing preset before adding another.`);
  }
  const imported = {
    id: crypto.randomUUID(),
    name: name.trim().slice(0, 100) || "Imported strategy",
    strategy: { ...strategy },
    ...(pineProgram ? { pineProgram } : {}),
    ...(nativeProgram ? { nativeProgram } : {}),
  };
  updateActiveStrategy(readStrategyControls());
  const previousSelectedId = selectedImportedStrategyId;
  importedStrategies = [...importedStrategies, imported];
  selectedImportedStrategyId = imported.id;
  if (portfolio) {
    portfolio.importedStrategies = importedStrategies;
    portfolio.selectedImportedStrategyId = selectedImportedStrategyId;
    portfolio.updatedAt = new Date().toISOString();
    try {
      await savePortfolio();
      importedStrategies = portfolio.importedStrategies;
    } catch (error) {
      importedStrategies = importedStrategies.filter((item) => item.id !== imported.id);
      selectedImportedStrategyId = previousSelectedId;
      portfolio.importedStrategies = importedStrategies;
      portfolio.selectedImportedStrategyId = selectedImportedStrategyId;
      throw error;
    }
  }
  await selectStrategyMode("imported", false);
  return imported;
}

async function selectStrategyMode(mode, preserveControls = true) {
  if (!["local", "imported"].includes(mode)) return;
  if (mode === "imported" && !importedStrategies.length) {
    strategyMode = "local";
    renderStrategySourcePicker();
    setStatus("Import a JSON or source-based strategy before selecting imported mode.", "error");
    return;
  }
  if (preserveControls) updateActiveStrategy(readStrategyControls());
  strategyMode = mode;
  if (mode === "imported") strategyEngine = "quant";
  if (mode === "imported" && !importedStrategies.some((item) => item.id === selectedImportedStrategyId)) {
    selectedImportedStrategyId = importedStrategies[0].id;
  }
  const selected = importedStrategies.find((item) => item.id === selectedImportedStrategyId);
  const nextStrategy = mode === "local" ? localStrategy : selected?.strategy;
  if (!nextStrategy) {
    strategyMode = "local";
    renderStrategySourcePicker();
    throw new Error("The selected imported strategy is no longer available.");
  }
  setStrategyControls(nextStrategy);
  updateActiveStrategy(readStrategyControls());
  renderStrategySourcePicker();
  updateAiPickerDisplay();
  updateMarketLabels();
  if (portfolio) {
    portfolio.strategyMode = strategyMode;
    portfolio.strategyEngine = strategyEngine;
    portfolio.localStrategy = { ...localStrategy };
    portfolio.importedStrategies = importedStrategies;
    portfolio.selectedImportedStrategyId = selectedImportedStrategyId;
    portfolio.updatedAt = new Date().toISOString();
    await savePortfolio();
  }
}

async function selectImportedStrategy(id) {
  const selected = importedStrategies.find((item) => item.id === id);
  if (!selected) {
    renderStrategySourcePicker();
    setStatus("Choose a saved imported strategy.", "error");
    return;
  }
  const previousSelectedId = selectedImportedStrategyId;
  const previousMode = strategyMode;
  const previousControls = readStrategyControls();
  const previousImportedStrategies = importedStrategies.map((item) => ({ ...item, strategy: { ...item.strategy } }));
  updateActiveStrategy(previousControls);
  selectedImportedStrategyId = id;
  if (strategyMode === "imported") {
    setStrategyControls(selected.strategy);
    if (portfolio) portfolio.strategy = { ...selected.strategy };
  }
  renderStrategySourcePicker();
  if (portfolio) {
    portfolio.importedStrategies = importedStrategies;
    portfolio.selectedImportedStrategyId = selectedImportedStrategyId;
    portfolio.strategyMode = strategyMode;
    portfolio.updatedAt = new Date().toISOString();
    try {
      await savePortfolio();
    } catch (error) {
      selectedImportedStrategyId = previousSelectedId;
      importedStrategies = previousImportedStrategies;
      strategyMode = previousMode;
      setStrategyControls(previousControls);
      if (portfolio) {
        portfolio.strategy = { ...previousControls };
        portfolio.importedStrategies = importedStrategies;
        portfolio.selectedImportedStrategyId = previousSelectedId;
        portfolio.strategyMode = previousMode;
      }
      renderStrategySourcePicker();
      setStatus(error instanceof Error ? error.message : "Could not save the selected strategy.", "error");
    }
  }
}

async function removeSelectedImportedStrategy() {
  const removed = importedStrategies.find((item) => item.id === selectedImportedStrategyId);
  if (!removed || !window.confirm(`Remove imported strategy “${removed.name}”?`)) return;
  if (strategyMode === "imported") await selectStrategyMode("local");
  const previous = importedStrategies;
  importedStrategies = importedStrategies.filter((item) => item.id !== removed.id);
  selectedImportedStrategyId = importedStrategies[0]?.id ?? null;
  if (portfolio) {
    portfolio.importedStrategies = importedStrategies;
    portfolio.selectedImportedStrategyId = selectedImportedStrategyId;
    portfolio.updatedAt = new Date().toISOString();
    try {
      await savePortfolio();
      importedStrategies = portfolio.importedStrategies;
    } catch (error) {
      importedStrategies = previous;
      selectedImportedStrategyId = removed.id;
      portfolio.importedStrategies = importedStrategies;
      portfolio.selectedImportedStrategyId = selectedImportedStrategyId;
      renderStrategySourcePicker();
      setStatus(error instanceof Error ? error.message : "Could not remove the imported strategy.", "error");
      return;
    }
  }
  renderStrategySourcePicker();
  setStatus(`Removed imported strategy “${removed.name}”. The local strategy remains active.`, "success");
}

function updateStrategySummary(strategy) {
  document.querySelector("#strategy-summary").textContent =
    `${strategy.lookbackDays}-day signal · ${strategy.momentumDays}-day momentum · ${strategy.maxAiPicks} picks · ${strategy.riskPct}% risk · ${strategy.maxAllocationPct}% capital allocation`;
}

function persistStrategySoon() {
  if (!portfolio) return;
  updateActiveStrategy(readStrategyControls());
  portfolio.strategyMode = strategyMode;
  portfolio.localStrategy = { ...localStrategy };
  portfolio.importedStrategies = importedStrategies;
  portfolio.selectedImportedStrategyId = selectedImportedStrategyId;
  portfolio.updatedAt = new Date().toISOString();
  updateStrategySummary(portfolio.strategy);
  if (strategySaveTimer !== null) window.clearTimeout(strategySaveTimer);
  strategySaveTimer = window.setTimeout(async () => {
    strategySaveTimer = null;
    try {
      await savePortfolio();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save strategy settings.", "error");
    }
  }, 350);
}

function applyStrategyValues(values) {
  for (const [key, value] of Object.entries(values)) {
    const input = document.querySelector(`#${key}`);
    const min = Number(input.min);
    const max = Number(input.max);
    const step = Number(input.step);
    const clamped = Math.max(min, Math.min(max, value));
    const stepped = Math.round((clamped - min) / step) * step + min;
    input.value = String(Number(stepped.toFixed(6)));
    updateSliderLabel(input);
  }
  const applied = readStrategyControls();
  updateActiveStrategy(applied);
  if (portfolio) portfolio.updatedAt = new Date().toISOString();
  updateStrategySummary(applied);
  return applied;
}

function closeCompanySuggestions() {
  companySuggestions.hidden = true;
  companySearchInput.setAttribute("aria-expanded", "false");
  companySearchInput.removeAttribute("aria-activedescendant");
  selectedSuggestion = -1;
}

function renderCompanySuggestions(suggestions) {
  companySuggestions.replaceChildren();
  selectedSuggestion = -1;
  if (!suggestions.length) {
    closeCompanySuggestions();
    companySearchStatus.textContent = activeMarket === "stock"
      ? "No matching companies found. Try a company name or ticker."
      : "No matching local futures datasets found. Try ES, Nasdaq, Dow, or Russell.";
    return;
  }

  for (const suggestion of suggestions) {
    const item = document.createElement("li");
    item.setAttribute("role", "presentation");
    const option = document.createElement("button");
    option.type = "button";
    option.id = `company-option-${companySuggestions.childElementCount}`;
    option.className = "company-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    const name = document.createElement("span");
    name.className = "company-option-name";
    const title = document.createElement("strong");
    title.textContent = suggestion.name;
    const details = document.createElement("small");
    details.textContent = `${suggestion.exchange || "Market"} · ${suggestion.quoteType === "FUTURE" ? "Local futures dataset" : suggestion.quoteType === "ETF" ? "ETF" : "Stock"}`;
    name.append(title, details);
    const symbol = document.createElement("span");
    symbol.className = "company-option-symbol";
    symbol.textContent = suggestion.symbol;
    option.append(name, symbol);
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => addCompany(suggestion));
    item.append(option);
    companySuggestions.append(item);
  }
  companySuggestions.hidden = false;
  companySearchInput.setAttribute("aria-expanded", "true");
  companySearchStatus.textContent = activeMarket === "stock"
    ? "Select a company to add its ticker to the backtest."
    : "Select a local futures dataset to add it to the candidate list.";
}

function addCompany(company) {
  const symbols = symbolsInput.value.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  if (symbols.includes(company.symbol)) {
    companySearchStatus.textContent = `${company.name} (${company.symbol}) is already selected.`;
    closeCompanySuggestions();
    return;
  }
  symbols.push(company.symbol);
  symbolsInput.value = symbols.join(", ");
  companyNameBySymbol[company.symbol] = company.name;
  companySearchInput.value = "";
  companySearchStatus.className = "company-search-status";
  companySearchStatus.textContent = `Added ${company.name} (${company.symbol}) to the ${activeMarket === "stock" ? "stock" : "futures"} backtest.`;
  closeCompanySuggestions();
}

function highlightSuggestion(index) {
  const options = [...companySuggestions.querySelectorAll('[role="option"]')];
  if (!options.length) return;
  selectedSuggestion = (index + options.length) % options.length;
  options.forEach((option, optionIndex) => {
    option.setAttribute("aria-selected", String(optionIndex === selectedSuggestion));
  });
  companySearchInput.setAttribute("aria-activedescendant", options[selectedSuggestion].id);
  options[selectedSuggestion].scrollIntoView({ block: "nearest" });
}

function selectHighlightedSuggestion() {
  if (companySuggestions.hidden || selectedSuggestion < 0) return false;
  companySuggestions.querySelectorAll('[role="option"]')[selectedSuggestion]?.click();
  return true;
}

function scheduleCompanySearch() {
  if (companySearchTimer !== null) window.clearTimeout(companySearchTimer);
  const query = companySearchInput.value.trim();
  const version = ++companySearchVersion;
  companySearchStatus.className = "company-search-status";
  if (query.length < 2) {
    closeCompanySuggestions();
    companySearchStatus.textContent = query ? "Type at least two letters to search." : "";
    return;
  }
  companySearchStatus.textContent = activeMarket === "stock"
    ? "Searching Yahoo Finance companies…"
    : "Searching local futures datasets…";
  companySearchTimer = window.setTimeout(async () => {
    companySearchTimer = null;
    try {
      const response = await requestJson(`/api/search?market=${activeMarket}&q=${encodeURIComponent(query)}`);
      if (version === companySearchVersion) renderCompanySuggestions(response.suggestions);
    } catch (error) {
      if (version !== companySearchVersion) return;
      closeCompanySuggestions();
      companySearchStatus.className = "company-search-status error";
      companySearchStatus.textContent = error instanceof Error ? error.message : "Instrument search failed.";
    }
  }, 250);
}

function setBusy(isBusy) {
  controlsBusy = isBusy;
  runButton.disabled = isBusy;
  document.querySelector("#run-sliders").disabled = isBusy;
  runButton.textContent = isBusy ? "Preparing simulation…" : "Run algorithm →";
  document.querySelector("#run-sliders").textContent = isBusy ? "Preparing simulation…" : "Simulate strategy →";
  symbolsInput.disabled = isBusy;
  aiPickerInput.disabled = isBusy;
  cashInput.disabled = isBusy || Boolean(portfolio);
  daysInput.disabled = isBusy;
  for (const input of document.querySelectorAll("#algorithm-source, #algorithm-language, #algorithm-file, #strategy-json, #strategy-file, #trust-algorithm, #fresh-algorithm-backtest, .setup-tab, .step-next, .step-back, #apply-analysis, #import-strategy")) {
    input.disabled = isBusy || playbackRunning;
  }
  for (const input of document.querySelectorAll('input[type="range"]:not(#days-input)')) {
    input.disabled = isBusy || playbackRunning;
  }
  updateRunNextStockDayButton();
  renderStrategySourcePicker();
}

function updateAiPickerDisplay() {
  const orb = usesOrbStrategy();
  const enabled = !orb && aiPickerInput.checked;
  document.querySelector(".ai-picker-toggle").hidden = orb;
  document.querySelector(".company-search").hidden = orb;
  symbolsInput.closest(".symbols-field").hidden = orb;
  aiPickerBadge.textContent = enabled ? "QUANT RANKING ON" : "MANUAL SELECTION";
  const marketName = activeMarket === "stock" ? "stocks" : "Nasdaq MNQ futures";
  document.querySelector("#symbols-label").textContent = enabled
    ? `OPTIONAL ${activeMarket === "stock" ? "STOCK" : "FUTURES"} SYMBOLS TO ADD`
    : `${activeMarket === "stock" ? "STOCK" : "FUTURES"} SYMBOLS · SEPARATED BY COMMAS`;
  symbolsInput.placeholder = activeMarket === "stock"
    ? enabled ? "Optional: AAPL, MSFT" : "AAPL, MSFT, NVDA"
    : enabled ? "Optional: MNQ=F" : "MNQ=F";
  symbolsInput.setAttribute("aria-label", enabled
    ? `Optional ${marketName} symbols for AI selection`
    : `Comma-separated ${marketName} symbols`);
  document.querySelector("#ai-picker-help").textContent = activeMarket === "stock"
    ? "Ranks liquid US stocks daily using momentum, pullback, and volatility factors."
    : "Ranks the local Nasdaq micro futures dataset using momentum, pullback, and volatility factors.";
}

function updateMarketLabels() {
  const stocks = activeMarket === "stock";
  const orb = usesOrbStrategy();
  document.querySelector("#market-intro-copy").textContent = stocks
    ? "Backtest cached Yahoo Finance stock data over the same historical date range as the local futures datasets."
    : orb
      ? "Run the supplied NQ Opening Range Breakout strategy on local one-minute data, then review its trades, daily equity, and report."
      : "Backtest the local Nasdaq micro futures dataset with the daily quant model, then review trades and performance.";
  document.querySelector("#data-source-label").innerHTML = stocks
    ? '<span class="source-dot"></span><span>YAHOO FINANCE</span><span class="source-separator">·</span><span>daily bars · 24h local cache</span>'
    : '<span class="source-dot"></span><span>LOCAL NQ bars.pkl</span><span class="source-separator">·</span><span>Nasdaq MNQ contract</span>';
  document.querySelector("#step-one-heading").textContent = stocks ? "Choose stock instruments" : "Choose futures instruments";
  document.querySelector("#market-selection-help").textContent = stocks
    ? "Search by company name or ticker. Yahoo Finance daily bars are cached on this device and clipped to the local futures datasets' historical date range."
    : orb
      ? "The ORB engine uses local NQ 1-minute bars.pkl data and simulates MNQ only."
      : "New Futures Trading entries are limited to Nasdaq MNQ=F, using the local NQ 1-minute bars.pkl file.";
  document.querySelector("#company-search-label").textContent = stocks ? "FIND A COMPANY OR STOCK TICKER" : "FIND NASDAQ FUTURES";
  companySearchInput.placeholder = stocks
    ? "Try Apple, Microsoft, or AAPL"
    : "Try Nasdaq or MNQ";
  document.querySelector(".futures-picker").hidden = stocks || orb;
  document.querySelector("#stock-picker").hidden = !stocks;
  document.querySelector("#days-help").textContent = stocks
    ? "Choose up to 2,500 daily sessions. Available history is limited to the local futures date range; positions carry forward."
    : orb
      ? "Choose up to 2,500 complete New York sessions. The local 1-minute MNQ ORB engine processes sessions in server-side batches and ends each day flat."
      : "Choose up to 2,500 of the latest complete sessions. Positions carry forward between sessions.";
  document.querySelector("#portfolio-caption").textContent = stocks ? "Stock portfolio · Yahoo Finance historical bars" : "Futures portfolio · Nasdaq MNQ local bars";
}

async function selectMarket(market) {
  if (!["futures", "stock"].includes(market) || market === activeMarket || playbackRunning || controlsBusy || marketSwitching) return;
  const previousMarket = activeMarket;
  marketSwitching = true;
  for (const button of document.querySelectorAll(".market-tab")) button.disabled = true;
  try {
    if (strategySaveTimer !== null) {
      window.clearTimeout(strategySaveTimer);
      strategySaveTimer = null;
      if (portfolio) await savePortfolio();
    }
    await portfolioSaveQueue;
    activeMarket = market;
    updateMarketLabels();
    for (const button of document.querySelectorAll(".market-tab")) {
      const selected = button.dataset.market === market;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = false;
    }
    setStatus(`Loading the saved ${market === "stock" ? "stock" : "futures"} workspace…`);
    const response = await requestJson(`/api/portfolio?market=${market}`);
    portfolio = response.portfolio;
    marketBySymbol = new Map();
    if (portfolio) {
      strategyMode = portfolio.strategyMode ?? "local";
      strategyEngine = market === "stock" ? "quant" : portfolio.strategyEngine ?? "quant";
      setOrbSettings(portfolio.orbSettings);
      importedStrategies = Array.isArray(portfolio.importedStrategies) ? portfolio.importedStrategies : [];
      localStrategy = { ...DEFAULT_STRATEGY, ...(portfolio.localStrategy ?? portfolio.strategy) };
      selectedImportedStrategyId = portfolio.selectedImportedStrategyId ?? importedStrategies[0]?.id ?? null;
      companyNameBySymbol = { ...(portfolio.companyNames ?? {}) };
      aiFocusDraft = portfolio.aiFocus ?? "";
      aiPickerInput.checked = Boolean(portfolio.aiEnabled);
      symbolsInput.value = portfolio.aiEnabled
        ? portfolio.manualSymbols.filter((symbol) => activeMarket === "stock" || !futuresContracts[symbol]).join(", ")
        : portfolio.watchlist.filter((symbol) => activeMarket === "stock" || !futuresContracts[symbol]).join(", ");
      cashInput.value = String(portfolio.initialCapital);
      cashInput.disabled = true;
      setCurrency(portfolio.currency);
      setStrategyControls({
        ...DEFAULT_STRATEGY,
        ...portfolio.strategy,
      });
      resultsSection.hidden = !portfolio.dailyEquity.length;
      setPlaybackStatus("PORTFOLIO RESTORED", "done");
      renderAll();
    } else {
      strategyMode = "local";
      strategyEngine = market === "stock" ? "quant" : "orb_nq_trio";
      setOrbSettings();
      localStrategy = { ...DEFAULT_STRATEGY };
      importedStrategies = [];
      selectedImportedStrategyId = null;
      companyNameBySymbol = {};
      aiFocusDraft = "";
      aiPickerInput.checked = true;
      symbolsInput.value = "";
      cashInput.value = market === "stock" ? "100000" : "50000";
      cashInput.disabled = false;
      setStrategyControls(DEFAULT_STRATEGY);
      resultsSection.hidden = true;
      setPlaybackStatus("READY", "");
    }
    for (const input of document.querySelectorAll(".future-contract")) {
      input.checked = Boolean(portfolio?.manualSymbols?.includes(input.value));
    }
    updateAiPickerDisplay();
    renderStrategySourcePicker();
    updateMarketLabels();
    setStatus("");
  } catch (error) {
    activeMarket = previousMarket;
    updateMarketLabels();
    for (const button of document.querySelectorAll(".market-tab")) {
      button.disabled = false;
      const selected = button.dataset.market === previousMarket;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    setStatus(error instanceof Error ? error.message : "Could not switch trading workspaces.", "error");
  } finally {
    marketSwitching = false;
    for (const button of document.querySelectorAll(".market-tab")) button.disabled = false;
    updateRunNextStockDayButton();
  }
}

function setStrategyControls(strategy) {
  for (const key of STRATEGY_KEYS) {
    const input = document.querySelector(`#${key}`);
    input.value = String(strategy[key] ?? DEFAULT_STRATEGY[key]);
    updateSliderLabel(input);
  }
  updateStrategySummary({ ...DEFAULT_STRATEGY, ...strategy });
}

function readStrategyControls() {
  return Object.fromEntries(STRATEGY_KEYS.map((key) => [
    key,
    Number(document.querySelector(`#${key}`).value),
  ]));
}

function updateSliderLabel(input) {
  const output = document.querySelector(`#${input.id}-value`);
  if (!output) return;
  const value = Number(input.value);
  if (["entryZ", "exitZ"].includes(input.id)) {
    output.textContent = `${value.toFixed(2)}σ`;
  } else if (["riskPct", "maxAllocationPct", "momentumWeight", "pullbackWeight", "lowVolWeight"].includes(input.id)) {
    output.textContent = `${value}%`;
  } else if (input.id === "stopVolMultiplier") {
    output.textContent = `${value.toFixed(1)}×`;
  } else if (["slippageBps", "commissionBps"].includes(input.id)) {
    output.textContent = `${value} bps`;
  } else if (["lookbackDays", "momentumDays"].includes(input.id)) {
    output.textContent = `${value} days`;
  } else {
    output.textContent = String(value);
  }
}

function makeNewPortfolio(cash, currency, symbols, strategy, aiEnabled, manualSymbols, aiFocus) {
  return {
    version: 1,
    initialCapital: cash,
    cash,
    currency,
    watchlist: symbols,
    aiEnabled,
    manualSymbols,
    aiFocus,
    companyNames: {},
    positions: {},
    lastPrices: {},
    trades: [],
    omittedTrades: 0,
    dailyEquity: [],
    dailyReports: [],
    processedThroughDate: null,
    strategy,
    strategyMode,
    strategyEngine: activeMarket === "stock" ? "quant" : strategyEngine,
    orbSettings: readOrbSettings(),
    localStrategy: { ...localStrategy },
    importedStrategies: importedStrategies.map((item) => ({
      ...item,
      strategy: { ...item.strategy },
    })),
    selectedImportedStrategyId,
    proposals: [],
    updatedAt: new Date().toISOString(),
  };
}

function strategyConfigText(strategy = readStrategyControls()) {
  if (usesOrbStrategy()) {
    return JSON.stringify({
      schemaVersion: 1,
      name: "ORB NQ Trio Presets",
      engine: "orb_nq_trio",
      settings: readOrbSettings(),
    }, null, 2);
  }
  return JSON.stringify({
    schemaVersion: 1,
    name: "My quant strategy",
    strategy,
  }, null, 2);
}

function strategyLabel(key) {
  return ({
    lookbackDays: "Signal lookback",
    entryZ: "Entry z-score",
    exitZ: "Exit z-score",
    riskPct: "Risk per trade",
    maxAllocationPct: "Maximum capital allocation",
    momentumWeight: "Momentum weight",
    pullbackWeight: "Pullback weight",
    lowVolWeight: "Low-volatility weight",
    stopVolMultiplier: "Stop multiplier",
    maxAiPicks: "Maximum quant picks",
    momentumDays: "Momentum window",
    slippageBps: "Slippage",
    commissionBps: "Commission",
  })[key] || key;
}

function suggestStrategyFromSentence(sentence) {
  const idea = sentence.toLowerCase();
  const values = {};
  const notes = [];
  const focusSectors = [
    ["Technology", /\btech(?:nology)?\b|\bsoftware\b|\bsemiconductors?\b/],
    ["Healthcare", /\bhealth(?:care)?\b|\bbiotech\b|\bpharma(?:ceutical)?s?\b/],
    ["Energy", /\benergy\b|\boil\b|\brenewables?\b/],
    ["Financials", /\bfinancials?\b|\bbanks?\b|\bfintech\b/],
    ["Consumer", /\bconsumer\b|\bretail\b/],
  ];
  const sectors = focusSectors.filter(([, pattern]) => pattern.test(idea)).map(([name]) => name);
  if (sectors.length) {
    notes.push(`The ${sectors.join(", ")} industry preference cannot be applied to broad index futures. The local files contain no company or sector data.`);
  }
  if (/\b(risky|riskier|aggressive|aggressively|high[- ]risk)\b/.test(idea)) {
    const current = readStrategyControls();
    values.riskPct = Math.min(2, current.riskPct + 0.3);
    values.maxAllocationPct = Math.min(100, current.maxAllocationPct + 10);
    values.stopVolMultiplier = Math.min(3, current.stopVolMultiplier + 0.3);
    values.lowVolWeight = Math.max(0, current.lowVolWeight - 10);
    notes.push("Riskier profile: higher per-trade risk and exposure, with less ranking preference for low volatility. This can increase losses as well as returns.");
  } else if (/\b(safe|safer|conservative|cautious|lower[- ]risk)\b/.test(idea)) {
    const current = readStrategyControls();
    values.riskPct = Math.max(0.1, current.riskPct - 0.2);
    values.maxAllocationPct = Math.max(10, current.maxAllocationPct - 15);
    values.stopVolMultiplier = Math.max(0.5, current.stopVolMultiplier - 0.2);
    values.lowVolWeight = Math.min(100, current.lowVolWeight + 15);
    notes.push("More conservative profile: lower per-trade risk and exposure, with more preference for lower-volatility instruments.");
  }
  if (/\b(momentum|growth|trending)\b/.test(idea)) {
    const current = readStrategyControls();
    values.momentumWeight = Math.min(100, current.momentumWeight + 15);
    notes.push("Increased the ranking emphasis on risk-adjusted momentum.");
  }
  if (/\b(pullback|mean[- ]reversion|reversion)\b/.test(idea)) {
    const current = readStrategyControls();
    values.pullbackWeight = Math.min(100, current.pullbackWeight + 15);
    notes.push("Increased the ranking emphasis on mean-reversion pullbacks.");
  }
  if (/\bmore (?:instruments|picks)|\bdiversif(?:y|ied|ication)\b/.test(idea)) {
    const current = readStrategyControls();
    values.maxAiPicks = Math.min(100, current.maxAiPicks + 2);
    notes.push("Raised the maximum daily quant picks by two.");
  }
  if (!Object.keys(values).length && !sectors.length) {
    throw new Error("I couldn't map that sentence to a supported strategy control. Try “aggressive”, “more conservative”, or “emphasize momentum”.");
  }
  const nextWeights = { ...readStrategyControls(), ...values };
  if (nextWeights.momentumWeight + nextWeights.pullbackWeight + nextWeights.lowVolWeight === 0) {
    values.lowVolWeight = 5;
  }
  return {
    values,
    focus: "",
    notes,
  };
}

document.querySelector("#suggest-strategy").addEventListener("click", () => {
  const sentence = document.querySelector("#strategy-sentence").value.trim();
  const suggestionNode = document.querySelector("#strategy-suggestions");
  const applyButton = document.querySelector("#apply-suggestions");
  try {
    if (!sentence) throw new Error("Describe a trading style first, for example “follow momentum and be moderately risky”.");
    pendingStrategySuggestion = suggestStrategyFromSentence(sentence);
    suggestionNode.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = "Suggested adjustments";
    const list = document.createElement("ul");
    for (const key of Object.keys(pendingStrategySuggestion.values)) {
      const item = document.createElement("li");
      item.textContent = `${strategyLabel(key)}: ${pendingStrategySuggestion.values[key]}${key.endsWith("Pct") || key.endsWith("Weight") ? "%" : key === "stopVolMultiplier" ? "×" : ""}`;
      list.append(item);
    }
    for (const note of pendingStrategySuggestion.notes) {
      const item = document.createElement("li");
      item.textContent = note;
      list.append(item);
    }
    suggestionNode.append(title, list);
    suggestionNode.hidden = false;
    applyButton.hidden = false;
    setStatus("");
  } catch (error) {
    pendingStrategySuggestion = null;
    suggestionNode.hidden = true;
    applyButton.hidden = true;
    setStatus(error instanceof Error ? error.message : "Could not interpret that strategy idea.", "error");
  }
});

document.querySelector("#apply-suggestions").addEventListener("click", async () => {
  if (!pendingStrategySuggestion) return;
  const previousStrategy = portfolio ? { ...portfolio.strategy } : null;
  const previousFocus = portfolio?.aiFocus ?? aiFocusDraft;
  const updated = applyStrategyValues(pendingStrategySuggestion.values);
  if (pendingStrategySuggestion.focus) aiFocusDraft = pendingStrategySuggestion.focus;
  if (portfolio) {
    portfolio.strategy = { ...portfolio.strategy, ...updated };
    portfolio.aiFocus = aiFocusDraft;
    portfolio.updatedAt = new Date().toISOString();
    try {
      await savePortfolio();
      setStatus("Applied and saved the suggested slider settings and AI focus note.", "success");
    } catch (error) {
      portfolio.strategy = previousStrategy;
      portfolio.aiFocus = previousFocus;
      aiFocusDraft = previousFocus;
      setStrategyControls({ ...DEFAULT_STRATEGY, ...previousStrategy });
      setStatus(error instanceof Error ? error.message : "Could not save the strategy suggestions.", "error");
      return;
    }
  } else {
    setStatus("Suggested settings applied. Run the simulation to use them.", "success");
  }
  if (activeSetupStep === 3) {
    strategyJsonDirty = false;
    strategyJsonInput.value = strategyConfigText(readStrategyControls());
  }
});

function parseStrategyJson(text) {
  const config = JSON.parse(text);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Strategy JSON must be an object.");
  }
  const allowedEnvelopeKeys = ["schemaVersion", "name", "strategy"];
  if (config.engine === "orb_nq_trio") {
    if (Object.keys(config).some((key) => !["schemaVersion", "name", "engine", "settings"].includes(key))) {
      throw new Error("The ORB configuration contains unsupported top-level fields.");
    }
    if (config.schemaVersion !== 1) {
      throw new Error("Unsupported ORB configuration version. Export a new version 1 configuration.");
    }
    const settings = config.settings;
    const allowedSettings = ["preset", "sizing", "quantity", "quantityCap", "presetTable"];
    if (!settings || typeof settings !== "object" || Array.isArray(settings)
      || Object.keys(settings).some((key) => !allowedSettings.includes(key))) {
      throw new Error("ORB JSON must contain only the Pine preset, sizing, quantity, cap, and resolved preset table.");
    }
    if (!orbDefaults?.presetTable || !settings.presetTable
      || Object.keys(settings.presetTable).sort().join("|") !== Object.keys(orbDefaults.presetTable).sort().join("|")) {
      throw new Error("ORB JSON must include all three supported Pine preset definitions.");
    }
    if (typeof settings.preset !== "string" || !orbDefaults.presetTable[settings.preset]
      || !["fixed", "risk"].includes(settings.sizing)
      || !Number.isInteger(settings.quantity) || settings.quantity < 1 || settings.quantity > 100
      || !Number.isInteger(settings.quantityCap) || settings.quantityCap < 1 || settings.quantityCap > 40) {
      throw new Error("ORB preset or sizing inputs are outside the supported Pine input options.");
    }
    return {
      name: typeof config.name === "string" ? config.name.trim() : "ORB NQ Trio Presets",
      engine: "orb_nq_trio",
      settings,
    };
  }
  if (config.strategy && Object.keys(config).some((key) => !allowedEnvelopeKeys.includes(key))) {
    throw new Error("The strategy file contains unsupported top-level fields.");
  }
  if (config.schemaVersion !== undefined && config.schemaVersion !== 1) {
    throw new Error("Unsupported strategy file version. Export a new version 1 configuration.");
  }
  if (config.name !== undefined && (typeof config.name !== "string" || config.name.length > 100)) {
    throw new Error("Strategy name must be text with at most 100 characters.");
  }
  const values = config.strategy ?? config;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Add a strategy object containing the supported numeric settings.");
  }
  const unknownKeys = Object.keys(values).filter((key) => !STRATEGY_KEYS.includes(key));
  if (unknownKeys.length) {
    throw new Error(`Unsupported strategy setting${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`);
  }
  if (!Object.keys(values).length) {
    throw new Error("The strategy object does not contain any supported settings.");
  }

  const merged = { ...DEFAULT_STRATEGY, ...readStrategyControls() };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`'${key}' must be a finite number.`);
    }
    const input = document.querySelector(`#${key}`);
    const minimum = Number(input.min);
    const maximum = Number(input.max);
    const step = Number(input.step);
    const stepPosition = (value - minimum) / step;
    if (value < minimum || value > maximum || Math.abs(stepPosition - Math.round(stepPosition)) > 1e-7) {
      throw new Error(`'${key}' must be within ${minimum}–${maximum} and match its ${step} step size.`);
    }
    merged[key] = value;
  }

  if (merged.momentumWeight + merged.pullbackWeight + merged.lowVolWeight === 0) {
    throw new Error("At least one AI ranking weight must be greater than zero.");
  }
  return {
    name: config.name?.trim() || "Imported strategy",
    strategy: merged,
  };
}

async function loadMarketData(symbol) {
  const after = freshAlgorithmBacktest ? "" : portfolio?.processedThroughDate ?? "";
  const program = activeAlgorithmProgram();
  const warmup = program?.language ? 500 : program
    ? Math.min(2500, Math.max(...Object.values(program.indicators).map((indicator) => indicator.length * 5)) + 2)
    : MIN_LOOKBACK + 1;
  const data = await requestJson(`/api/market?market=${activeMarket}&symbol=${encodeURIComponent(symbol)}&after=${encodeURIComponent(after)}&days=${encodeURIComponent(daysInput.value)}&warmup=${warmup}`);
  if (!Array.isArray(data.bars) || data.bars.length < MIN_LOOKBACK + 1) {
    throw new Error(`${symbol}: not enough daily history for the selected strategy.`);
  }
  return data;
}

async function loadMarketDataBatch(symbols, concurrency = 6) {
  const result = [];
  for (let start = 0; start < symbols.length; start += concurrency) {
    const batch = symbols.slice(start, start + concurrency);
    result.push(...await Promise.all(batch.map(loadMarketData)));
  }
  return result;
}

function historyBefore(market, date, maximum) {
  let low = 0;
  let high = market.bars.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (market.bars[middle].date < date) low = middle + 1;
    else high = middle;
  }
  const start = Math.max(0, low - maximum);
  return market.bars.slice(start, low);
}

function portfolioEquity(prices = portfolio.lastPrices) {
  return portfolio.cash + Object.entries(portfolio.positions).reduce(
    (sum, [symbol, position]) => {
      const mark = prices[symbol] ?? position.entryPrice;
      if (position.assetType === "future") {
        return sum + position.marginReserved
          + position.direction * position.shares * position.multiplier * (mark - position.entryPrice);
      }
      return sum + position.shares * mark;
    },
    0,
  );
}

function portfolioEquityAtOpen(bars) {
  const prices = { ...portfolio.lastPrices };
  for (const [symbol, bar] of bars) prices[symbol] = bar.open;
  return portfolioEquity(prices);
}

function meanAndDeviation(values) {
  if (!values.length) return { mean: 0, deviation: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, deviation: Math.sqrt(variance) };
}

function signalFor(symbol, date) {
  const market = marketBySymbol.get(symbol);
  const program = activeAlgorithmProgram();
  const pineLookback = program ? 25 : 0;
  const history = historyBefore(market, date, Math.max(portfolio.strategy.lookbackDays, pineLookback));
  if (program?.language) return signalForNativeProgram(market, date, history);
  if (program) return signalForPineProgram(program, market, date, history);
  const lookback = portfolio.strategy.lookbackDays;
  if (history.length < lookback) return null;
  const closes = history.slice(-lookback).map((bar) => bar.close);
  const { mean, deviation } = meanAndDeviation(closes);
  const returns = closes.slice(1).map((close, index) => close / closes[index] - 1);
  const dailyVolatility = meanAndDeviation(returns).deviation;
  return {
    zScore: deviation === 0 ? 0 : (closes[closes.length - 1] - mean) / deviation,
    stopFraction: Math.min(
      MAX_STOP,
      Math.max(MIN_STOP, dailyVolatility * portfolio.strategy.stopVolMultiplier),
    ),
  };
}

async function executeNativeAlgorithm(program, bars) {
  const trusted = document.querySelector("#trust-algorithm").checked;
  if (!trusted) throw new Error("Check 'I trust this source' before running local Python/C++ code.");
  const result = await requestJson("/api/algorithm-run", {
    method: "POST",
    headers: { "X-Algorithm-Run": "trusted-local-source" },
    body: JSON.stringify({ program, bars, trusted }),
  });
  if (!Array.isArray(result.signals) || result.signals.length !== bars.length
      || result.signals.some(signal => !["buy", "sell", "hold"].includes(signal))) {
    throw new Error("The algorithm returned an invalid signal sequence.");
  }
  return result.signals;
}

function signalForNativeProgram(market, date, history) {
  const index = (market.indexByDate.get(date) ?? 0) - 1;
  const action = market.nativeSignals?.[index] ?? "hold";
  const closes = history.map(bar => bar.close);
  const returns = closes.slice(1).map((close, i) => close / closes[i] - 1);
  return {
    zScore: 0,
    stopFraction: Math.min(MAX_STOP, Math.max(MIN_STOP, meanAndDeviation(returns).deviation * portfolio.strategy.stopVolMultiplier)),
    programEntry: action === "buy",
    programExit: action === "sell",
    programDirection: 1,
  };
}

function pineIndicatorSeries(kind, length, closes) {
  if (kind === "sma") {
    let rollingTotal = 0;
    return closes.map((close, index) => {
      rollingTotal += close;
      if (index >= length) rollingTotal -= closes[index - length];
      return index < length - 1 ? null : rollingTotal / length;
    });
  }
  if (kind === "ema") {
    let previous = null;
    const multiplier = 2 / (length + 1);
    return closes.map((close) => {
      previous = previous === null ? close : close * multiplier + previous * (1 - multiplier);
      return previous;
    });
  }
  const result = closes.map(() => null);
  if (closes.length <= length) return result;
  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= length; index += 1) {
    const change = closes[index] - closes[index - 1];
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }
  averageGain /= length;
  averageLoss /= length;
  result[length] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let index = length + 1; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    averageGain = (averageGain * (length - 1) + Math.max(change, 0)) / length;
    averageLoss = (averageLoss * (length - 1) + Math.max(-change, 0)) / length;
    result[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}

function preparePineMarketData(program, market) {
  const closes = market.bars.map((bar) => bar.close);
  market.pineIndicatorValues = Object.fromEntries(Object.entries(program.indicators).map(([name, indicator]) => [
    name,
    pineIndicatorSeries(indicator.kind, indicator.length, closes),
  ]));
}

function signalForPineProgram(program, market, date, history) {
  const currentIndex = (market.indexByDate.get(date) ?? 0) - 1;
  const previousIndex = currentIndex - 1;
  const indicatorValues = market.pineIndicatorValues;
  const crossed = (condition) => {
    if (previousIndex < 0) return false;
    const left = indicatorValues[condition.left];
    const right = indicatorValues[condition.right];
    const previousLeft = left[previousIndex];
    const previousRight = right[previousIndex];
    const currentLeft = left[currentIndex];
    const currentRight = right[currentIndex];
    if ([previousLeft, previousRight, currentLeft, currentRight].some((value) => value === null || !Number.isFinite(value))) {
      return false;
    }
    return condition.cross === "crossover"
      ? currentLeft > currentRight && previousLeft <= previousRight
      : currentLeft < currentRight && previousLeft >= previousRight;
  };
  const closes = history.map((bar) => bar.close);
  const returns = closes.slice(1).map((close, index) => close / closes[index] - 1);
  const volatility = meanAndDeviation(returns).deviation;
  return {
    zScore: 0,
    stopFraction: Math.min(MAX_STOP, Math.max(MIN_STOP, volatility * portfolio.strategy.stopVolMultiplier)),
    programEntry: crossed(program.entry),
    programExit: crossed(program.exit),
    programDirection: program.direction === "short" ? -1 : 1,
  };
}

async function rankCandidates(date) {
  const candidates = [];
  for (const symbol of portfolio.watchlist) {
    const market = marketBySymbol.get(symbol);
    const history = historyBefore(market, date, Math.max(
      portfolio.strategy.momentumDays + 1,
      portfolio.strategy.lookbackDays,
    ));
    const signal = signalFor(symbol, date);
    if (!signal || history.length < portfolio.strategy.momentumDays + 1) continue;
    const closes = history.slice(-(portfolio.strategy.momentumDays + 1)).map((bar) => bar.close);
    const momentum = closes[closes.length - 1] / closes[0] - 1;
    const returns = closes.slice(1).map((close, index) => close / closes[index] - 1);
    const volatility = meanAndDeviation(returns).deviation;
    candidates.push({
      symbol,
      company: portfolio.companyNames?.[symbol] || symbol,
      assetType: market?.instrument?.type ?? "equity",
      programEntry: Boolean(signal.programEntry),
      momentum,
      volatility,
      riskAdjustedMomentum: momentum / Math.max(volatility, 0.001),
      zScore: signal.zScore,
      score: 0,
      selected: false,
      decision: "",
    });
  }

  const percentileBy = (field, reverse = false) => {
    const ordered = [...candidates].sort((a, b) =>
      (reverse ? a[field] - b[field] : b[field] - a[field]) || a.symbol.localeCompare(b.symbol));
    return new Map(ordered.map((candidate, index) => [
      candidate.symbol,
      ordered.length <= 1 ? 1 : (ordered.length - index - 1) / (ordered.length - 1),
    ]));
  };
  const rawWeights = [
    portfolio.strategy.momentumWeight,
    portfolio.strategy.pullbackWeight,
    portfolio.strategy.lowVolWeight,
  ];
  const weightTotal = rawWeights.reduce((total, weight) => total + weight, 0);
  const weights = weightTotal
    ? rawWeights.map((weight) => weight / weightTotal)
    : [1 / 3, 1 / 3, 1 / 3];
  const momentumRanks = percentileBy("riskAdjustedMomentum");
  const pullbackRanks = percentileBy("zScore", true);
  const volatilityRanks = percentileBy("volatility", true);
  for (const candidate of candidates) {
    candidate.score = 100 * (
      weights[0] * momentumRanks.get(candidate.symbol)
      + weights[1] * pullbackRanks.get(candidate.symbol)
      + weights[2] * volatilityRanks.get(candidate.symbol)
    );
  }
  candidates.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  const selected = activeAlgorithmProgram()
    ? candidates
    : portfolio.aiEnabled ? candidates.slice(0, portfolio.strategy.maxAiPicks) : candidates;
  const selectedSymbols = new Set(selected.map((candidate) => candidate.symbol));
  for (const candidate of candidates) {
    candidate.selected = selectedSymbols.has(candidate.symbol);
    if (activeAlgorithmProgram()) {
      candidate.decision = candidate.programEntry
        ? "Imported algorithm entry condition confirmed"
        : "Waiting for the imported algorithm entry signal";
    } else if (!candidate.selected) {
      candidate.decision = `Outside the top ${portfolio.strategy.maxAiPicks} today`;
    } else if (portfolio.positions[candidate.symbol]) {
      candidate.decision = "Already held; manage the existing position without a duplicate entry";
    } else if (candidate.assetType === "future"
      ? Math.abs(candidate.zScore) >= portfolio.strategy.entryZ
      : candidate.zScore <= -portfolio.strategy.entryZ) {
      candidate.decision = "Ranked pick; entry signal confirmed";
    } else {
      candidate.decision = candidate.assetType === "future"
        ? `Ranked pick; waiting for an absolute z-score of ${portfolio.strategy.entryZ.toFixed(2)}σ`
        : `Ranked pick; waiting for pullback to −${portfolio.strategy.entryZ.toFixed(2)}σ`;
    }
  }
  return candidates;
}

function entryReasonFor(signal, candidate) {
  if (activeAlgorithmProgram()) {
    return `Imported algorithm ${activeAlgorithmProgram().direction} entry signal confirmed; ${candidate?.company ?? "instrument"} passed the imported strategy signal.`;
  }
  return `Entry signal confirmed at ${signal.zScore.toFixed(2)}σ; ${candidate?.company ?? "ranked instrument"} passed the built-in quant ranking.`;
}

function closePosition(symbol, bar, rawPrice, reason, exitDate = bar.date) {
  const position = portfolio.positions[symbol];
  if (!position) return;
  const isFuture = position.assetType === "future";
  const fill = rawPrice * (1 + (isFuture && position.direction < 0 ? 1 : -1)
    * portfolio.strategy.slippageBps / 10_000);
  const notional = position.shares * fill * (isFuture ? position.multiplier : 1);
  const exitFee = notional * portfolio.strategy.commissionBps / 10_000;
  const grossPnl = isFuture
    ? position.direction * position.shares * position.multiplier * (fill - position.entryPrice)
    : position.shares * (fill - position.entryPrice);
  if (isFuture) {
    portfolio.cash += position.marginReserved + grossPnl - exitFee;
  } else {
    portfolio.cash += position.shares * fill - exitFee;
  }
  portfolio.trades.push({
    symbol,
    shares: position.shares,
    assetType: position.assetType ?? "equity",
    direction: position.direction ?? 1,
    entryPrice: position.entryPrice,
    exitPrice: fill,
    entryFee: position.entryFee,
    exitFee,
    entryDate: position.entryDate,
    exitDate,
    pnl: grossPnl - position.entryFee - exitFee,
    reason,
  });
  delete portfolio.positions[symbol];
}

async function processTradingDay(date) {
  const bars = new Map();
  for (const symbol of portfolio.watchlist) {
    const bar = marketBySymbol.get(symbol)?.byDate.get(date);
    if (bar) {
      bars.set(symbol, bar);
    }
  }
  if (!bars.size) return;

  const rankings = await rankCandidates(date);
  const rankedBySymbol = new Map(rankings.map((candidate) => [candidate.symbol, candidate]));
  const selectedSymbols = new Set(rankings.filter((candidate) => candidate.selected).map((candidate) => candidate.symbol));
  const signals = new Map([...bars.keys()].map((symbol) => [symbol, signalFor(symbol, date)]));
  const exitedSymbols = new Set();
  const actions = [];
  const initialTradeCount = portfolio.trades.length;
  for (const [symbol, position] of Object.entries(portfolio.positions)) {
    const bar = bars.get(symbol);
    if (!bar) continue;
    const signal = signals.get(symbol);
    const isFuture = position.assetType === "future";
    const stopTriggered = isFuture && position.direction < 0
      ? bar.high >= position.stopPrice
      : bar.low <= position.stopPrice;
    if (stopTriggered) {
      const stopFill = isFuture && position.direction < 0
        ? Math.max(bar.open, position.stopPrice)
        : Math.min(bar.open, position.stopPrice);
      closePosition(symbol, bar, stopFill, "Stop loss");
      exitedSymbols.add(symbol);
      actions.push({ symbol, action: isFuture && position.direction < 0 ? "COVER" : "SELL", reason: "The daily range reached the protective stop." });
    } else if (signal && (activeAlgorithmProgram()
      ? signal.programExit && position.direction === signal.programDirection
      : isFuture
      ? position.direction > 0
        ? signal.zScore >= portfolio.strategy.exitZ
        : signal.zScore <= -portfolio.strategy.exitZ
      : signal.zScore >= portfolio.strategy.exitZ)) {
      closePosition(symbol, bar, bar.open, activeAlgorithmProgram() ? "Imported algorithm exit signal" : "Mean reverted");
      exitedSymbols.add(symbol);
      actions.push({
        symbol,
        action: isFuture && position.direction < 0 ? "COVER" : "SELL",
        reason: activeAlgorithmProgram()
          ? "The imported algorithm exit condition crossed."
          : `The prior-close z-score reached ${signal.zScore.toFixed(2)}σ; the position's mean-reversion exit condition was met.`,
      });
    } else {
      actions.push({ symbol, action: "HOLD", reason: signal
        ? `No stop or exit signal; prior-close z-score was ${signal.zScore.toFixed(2)}σ.`
        : "No completed-close signal was available; keep managing the open position." });
    }
  }

  const candidates = [...bars.keys()].filter((symbol) => {
    const signal = signals.get(symbol);
    const isFuture = marketBySymbol.get(symbol)?.instrument?.type === "future";
    return !portfolio.positions[symbol] && !exitedSymbols.has(symbol)
      && selectedSymbols.has(symbol)
      && signal && (activeAlgorithmProgram()
        ? signal.programEntry
        : isFuture
        ? Math.abs(signal.zScore) >= portfolio.strategy.entryZ
        : signal.zScore <= -portfolio.strategy.entryZ);
  }).sort((a, b) => activeAlgorithmProgram()
    ? a.localeCompare(b)
    : (rankedBySymbol.get(b)?.score ?? 0) - (rankedBySymbol.get(a)?.score ?? 0) || a.localeCompare(b));
  const entries = [];
  for (const symbol of candidates) {
    const bar = bars.get(symbol);
    const signal = signals.get(symbol);
    const instrument = marketBySymbol.get(symbol).instrument ?? { type: "equity" };
    const direction = activeAlgorithmProgram()
      ? signal.programDirection
      : instrument.type === "future" && signal.zScore > 0 ? -1 : 1;
    const fill = bar.open * (1 + direction * portfolio.strategy.slippageBps / 10_000);
    const stopPrice = fill * (1 - direction * signal.stopFraction);
    const commissionRate = portfolio.strategy.commissionBps / 10_000;
    const sharesForRisk = Math.floor(
      (portfolioEquityAtOpen(bars) * (portfolio.strategy.riskPct / 100) / candidates.length)
      / (
        fill * signal.stopFraction * (instrument.multiplier ?? 1)
        + fill * (instrument.multiplier ?? 1) * commissionRate * 2
      ),
    );
    entries.push({
      symbol,
      bar,
      fill,
      stopPrice,
      sharesForRisk,
      direction,
      instrument,
      action: {
        symbol,
        action: instrument.type === "future" ? "NO TRADE" : "NO BUY",
        reason: `${entryReasonFor(signal, rankedBySymbol.get(symbol))} but portfolio risk, margin, exposure, or available cash did not allow a whole position.`,
      },
    });
    actions.push(entries[entries.length - 1].action);
  }

  for (const entry of entries) {
    const equity = portfolioEquityAtOpen(bars);
    const existingExposure = Object.entries(portfolio.positions).reduce((total, [symbol, position]) => {
      const price = bars.get(symbol)?.open ?? portfolio.lastPrices[symbol] ?? position.entryPrice;
      return total + (position.assetType === "future"
        ? position.marginReserved
        : position.shares * price);
    }, 0);
    const maxExposure = equity * portfolio.strategy.maxAllocationPct / 100;
    const remainingAllocation = Math.max(0, maxExposure - existingExposure);
    const feeRate = portfolio.strategy.commissionBps / 10_000;
    const isFuture = entry.instrument.type === "future";
    const marginPerContract = isFuture ? entry.instrument.initialMargin : 0;
    const contractNotional = entry.fill * (isFuture ? entry.instrument.multiplier : 1);
    const shares = Math.min(
      entry.sharesForRisk,
      Math.floor(remainingAllocation / (isFuture ? marginPerContract : entry.fill * (1 + feeRate))),
      Math.floor(portfolio.cash / (isFuture ? marginPerContract + contractNotional * feeRate : entry.fill * (1 + feeRate))),
    );
    if (shares < 1) continue;

    const entryFee = shares * contractNotional * feeRate;
    const marginReserved = shares * marginPerContract;
    portfolio.cash -= (isFuture ? marginReserved : shares * entry.fill) + entryFee;
    portfolio.positions[entry.symbol] = {
      shares,
      assetType: entry.instrument.type,
      direction: entry.direction,
      multiplier: entry.instrument.multiplier ?? 1,
      initialMargin: entry.instrument.initialMargin ?? 0,
      marginReserved,
      entryPrice: entry.fill,
      entryDate: date,
      entryFee,
      stopPrice: entry.stopPrice,
    };
    entry.action.action = isFuture
      ? entry.direction < 0 ? "SELL SHORT" : "BUY FUTURE"
      : "BUY";
    entry.action.reason = `${entryReasonFor(signals.get(entry.symbol), rankedBySymbol.get(entry.symbol))} ${isFuture ? `Opened ${shares} ${shares === 1 ? "contract" : "contracts"} ${entry.direction < 0 ? "short" : "long"} at the next open; estimated initial margin reserved was ${formatMoney(marginReserved)}.` : `Bought ${shares} share${shares === 1 ? "" : "s"} at the next open, sized to the risk and exposure limits.`}`;

    const entryStopTriggered = entry.instrument.type === "future" && entry.direction < 0
      ? entry.bar.high >= entry.stopPrice
      : entry.bar.low <= entry.stopPrice;
    if (entryStopTriggered) {
      const stopFill = entry.instrument.type === "future" && entry.direction < 0
        ? Math.max(entry.bar.open, entry.stopPrice)
        : Math.min(entry.bar.open, entry.stopPrice);
      closePosition(entry.symbol, entry.bar, stopFill, "Stop loss");
      entry.action.action = entry.instrument.type === "future" ? "OPEN, THEN STOP" : "BUY, THEN STOP";
      entry.action.reason += " The same day's low then reached the protective stop.";
    }
  }

  for (const [symbol, bar] of bars) portfolio.lastPrices[symbol] = bar.close;
  const equity = portfolioEquity();
  const previousEquity = portfolio.dailyEquity.length
    ? portfolio.dailyEquity[portfolio.dailyEquity.length - 1].value
    : portfolio.initialCapital;
  const dailyPnl = equity - previousEquity;
  portfolio.dailyEquity.push({
    date,
    value: equity,
    cash: portfolio.cash,
    dailyPnl,
  });
  if (portfolio.dailyEquity.length > 25_000) {
    portfolio.dailyEquity.splice(0, portfolio.dailyEquity.length - 25_000);
  }
  const closedToday = portfolio.trades.slice(initialTradeCount);
  for (const action of actions) {
    const closedTrade = closedToday.find((trade) => trade.symbol === action.symbol);
    if (closedTrade) {
      action.reason += ` Net realized P&L after costs: ${formatSignedMoney(closedTrade.pnl)}.`;
    }
  }
  const picks = rankings.filter((candidate) => candidate.selected);
  const pickNames = picks.map((candidate) => candidate.company);
  const pineProgram = activeAlgorithmProgram();
  const summary = pineProgram
    ? `Imported ${pineProgram.language ?? "Pine"} ${pineProgram.direction} strategy processed ${bars.size} instruments. Its entry and exit signals drove the trades; the portfolio finished at ${formatMoney(equity)} (${formatSignedMoney(dailyPnl)} today).`
    : portfolio.aiEnabled
    ? picks.length
      ? `Quant AI ranked ${rankings.length} instruments using a ${portfolio.strategy.momentumDays}-day momentum window and selected ${pickNames.join(", ")}. It opened positions only when the configured entry signal was met; the portfolio finished at ${formatMoney(equity)} (${formatSignedMoney(dailyPnl)} today).`
      : `Quant AI could not rank enough instruments with the required completed history. No new positions were selected; the portfolio finished at ${formatMoney(equity)} (${formatSignedMoney(dailyPnl)} today).`
    : `Manual watchlist strategy processed ${bars.size} instruments. Portfolio finished at ${formatMoney(equity)} (${formatSignedMoney(dailyPnl)} today).`;
  const focusSummary = portfolio.aiFocus ? ` AI focus note: ${portfolio.aiFocus}` : "";
  portfolio.dailyReports ??= [];
  portfolio.dailyReports.push({
    date,
    equity,
    dailyPnl,
    aiEnabled: Boolean(portfolio.aiEnabled && !pineProgram),
    strategyType: pineProgram ? pineProgram.language ?? "pine" : "quant",
    strategyName: pineProgram
      ? importedStrategies.find((item) => item.id === selectedImportedStrategyId)?.name ?? "Imported algorithm strategy"
      : "Quant strategy",
    strategy: { ...portfolio.strategy },
    summary: `${summary}${focusSummary}${portfolio.marketDataWarning ? ` Market-data warning: ${portfolio.marketDataWarning}` : ""}`.slice(0, 1_000),
    ranked: rankings.slice(0, MAX_REPORTED_ITEMS).map((candidate) => ({
      symbol: candidate.symbol,
      company: candidate.company,
      momentum: candidate.momentum,
      volatility: candidate.volatility,
      zScore: candidate.zScore,
      score: candidate.score,
      selected: candidate.selected,
      decision: candidate.decision.slice(0, 200),
    })),
    omittedRankings: Math.max(0, rankings.length - MAX_REPORTED_ITEMS),
    actions: actions.slice(0, MAX_REPORTED_ITEMS),
    omittedActions: Math.max(0, actions.length - MAX_REPORTED_ITEMS),
  });
  if (portfolio.dailyReports.length > REPORT_LIMIT) {
    portfolio.dailyReports.splice(0, portfolio.dailyReports.length - REPORT_LIMIT);
  }
  if (portfolio.trades.length > 25_000) {
    const excess = portfolio.trades.length - 25_000;
    portfolio.trades.splice(0, excess);
    portfolio.omittedTrades = (portfolio.omittedTrades ?? 0) + excess;
  }
  portfolio.processedThroughDate = date;
  portfolio.updatedAt = new Date().toISOString();
}

function formatDate(isoDate) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function setMetric(id, value, detail, sentiment = "") {
  const node = document.querySelector(`#${id}`);
  node.textContent = value;
  node.className = `metric-value${sentiment ? ` ${sentiment}` : ""}`;
  const detailNode = document.querySelector(`#${id}-detail`);
  if (detailNode) detailNode.textContent = detail;
}

function updateDashboard() {
  if (!portfolio) return;
  const equity = portfolioEquity();
  const totalPnl = equity - portfolio.initialCapital;
  const days = portfolio.dailyEquity;
  const lastDay = days[days.length - 1];
  const wins = portfolio.trades.filter((trade) => trade.pnl > 0).length;
  const currency = portfolio.currency;
  setMetric("metric-equity", formatMoney(equity, currency), `${portfolio.cash < 0 ? "Cash balance" : "Cash"} ${formatMoney(portfolio.cash, currency)}`);
  setMetric("metric-total-pnl", formatSignedMoney(totalPnl), formatPercent(totalPnl / portfolio.initialCapital), totalPnl > 0 ? "positive" : totalPnl < 0 ? "negative" : "neutral");
  setMetric("metric-daily-pnl", lastDay ? formatSignedMoney(lastDay.dailyPnl) : "—", lastDay ? `${formatDate(lastDay.date)} · ${portfolio.dailyEquity.length} sessions` : "No sessions simulated", (lastDay?.dailyPnl ?? 0) > 0 ? "positive" : (lastDay?.dailyPnl ?? 0) < 0 ? "negative" : "neutral");
  setMetric("metric-holdings", String(Object.keys(portfolio.positions).length), `${portfolio.trades.length} closed trades · ${wins} wins`);
  document.querySelector("#portfolio-caption").textContent = `${portfolio.watchlist.join(" · ")} · ${currency} · ${portfolio.processedThroughDate ? `last simulated ${formatDate(portfolio.processedThroughDate)}` : "ready for first session"}`;
  if (portfolio.processedThroughDate && !playbackRunning) {
    document.querySelector("#replay-day-label").textContent = `Last session · ${formatDate(portfolio.processedThroughDate)}`;
  }
  document.querySelector("#starting-capital-label").textContent = formatMoney(portfolio.initialCapital, currency);
  document.querySelector("#trade-count-pill").textContent = `${portfolio.trades.length} closed`;
  document.querySelector("#trade-history-footnote").textContent = portfolio.omittedTrades
    ? `Showing the latest ${portfolio.trades.length.toLocaleString()} closed trades. ${portfolio.omittedTrades.toLocaleString()} earlier trades were omitted to keep long simulations responsive.`
    : `The portfolio is paper-only and saved separately for each trading workspace. Historical simulations are illustrative, not financial advice.`;
  updateHoldings();
  updateTrades();
  updateDailyReports();
  drawEquityChart();
  drawPriceChart();
}

function updateDailyReports() {
  const reports = portfolio.dailyReports ?? [];
  document.querySelector("#report-count").textContent = `${reports.length} simulated day${reports.length === 1 ? "" : "s"}`;
  document.querySelector("#report-history-count").textContent = `${Math.min(reports.length, 30)} of ${reports.length} days`;
  const equity = portfolioEquity();
  const totalPnl = equity - portfolio.initialCapital;
  const wins = portfolio.trades.filter((trade) => trade.pnl > 0).length;
  const latest = reports[reports.length - 1];
  const summary = document.querySelector("#report-summary");
  summary.textContent = latest
    ? `${latest.summary} Across ${portfolio.dailyEquity.length} simulated days, the portfolio is ${formatSignedMoney(totalPnl)} (${formatPercent(totalPnl / portfolio.initialCapital)}) from its starting capital.`
    : "Run a simulation to see the portfolio outcome, trade record, and a concise explanation of its latest decisions.";
  const summaryMetrics = document.querySelector("#report-summary-metrics");
  summaryMetrics.replaceChildren();
  for (const [label, value] of [
    ["Total return", `${formatSignedMoney(totalPnl)} · ${formatPercent(totalPnl / portfolio.initialCapital)}`],
    ["Closed trades", `${portfolio.trades.length} · ${wins} wins`],
    ["Open positions", String(Object.keys(portfolio.positions).length)],
  ]) {
    const item = document.createElement("div");
    item.className = "report-summary-metric";
    const title = document.createElement("span");
    title.textContent = label;
    const result = document.createElement("strong");
    result.textContent = value;
    item.append(title, result);
    summaryMetrics.append(item);
  }
  dailyReportList.replaceChildren();
  if (!reports.length) {
    const empty = document.createElement("p");
    empty.className = "empty-report";
    empty.textContent = "Day-by-day picks and decisions will appear here after simulation.";
    dailyReportList.append(empty);
    return;
  }

  for (const report of [...reports].reverse().slice(0, 30)) {
    const details = document.createElement("details");
    details.className = "daily-report";
    const heading = document.createElement("summary");
    const dayLabel = document.createElement("span");
    dayLabel.textContent = `${formatDate(report.date)} · ${report.strategyType === "orb" ? "NQ ORB" : report.strategyType === "pine" ? "IMPORTED PINE" : report.aiEnabled ? "QUANT AI" : "MANUAL STRATEGY"}`;
    const pnlLabel = document.createElement("span");
    pnlLabel.className = report.dailyPnl > 0 ? "positive" : report.dailyPnl < 0 ? "negative" : "neutral";
    pnlLabel.textContent = formatSignedMoney(report.dailyPnl);
    heading.append(dayLabel, pnlLabel);
    details.append(heading);

    const summary = document.createElement("p");
    summary.className = "daily-report-summary";
    summary.textContent = report.summary;
    details.append(summary);

    if (report.strategy) {
      const strategyHeading = document.createElement("h4");
      strategyHeading.textContent = report.strategyType === "orb"
        ? "Opening-range breakout settings"
        : report.strategyType === "pine" ? "Imported algorithm program and risk controls" : "Tested strategy settings";
      const strategySummary = document.createElement("p");
      strategySummary.className = "daily-report-note";
      const strategy = report.strategy;
      strategySummary.textContent = report.strategyType === "orb"
        ? `${report.strategyName}; ${report.orbSettings?.sizing === "risk" ? "approximate risk-sized" : "fixed"} quantity${report.orbSettings?.sizing === "risk" ? ` · cap ${report.orbSettings.quantityCap}` : ` · ${report.orbSettings?.quantity ?? 1} contract(s)`} · New York-time 1-minute entries · $0.61/contract/side commission · one tick slippage.`
        : report.strategyType === "pine"
        ? `${report.strategyName}: direct Pine entry/exit crossover signals · ${strategy.riskPct}% risk · ${strategy.maxAllocationPct}% max exposure · ${strategy.slippageBps} bps slippage / ${strategy.commissionBps} bps commission.`
        : `${strategy.lookbackDays}-day signal · ${strategy.momentumDays}-day momentum · ${strategy.maxAiPicks} quant picks · ranking weights ${strategy.momentumWeight}/${strategy.pullbackWeight}/${strategy.lowVolWeight} · ${strategy.riskPct}% risk · ${strategy.maxAllocationPct}% max exposure · ${strategy.slippageBps} bps slippage / ${strategy.commissionBps} bps commission.`;
      details.append(strategyHeading, strategySummary);
    }

    if (report.ranked?.length) {
      const rankingTitle = document.createElement("h4");
      rankingTitle.textContent = report.strategyType === "pine"
        ? "Market context (not used to select Pine entry or exit signals)"
        : "Candidate ranking (uses only prior completed closes)";
      details.append(rankingTitle);
      const rankings = document.createElement("ol");
      rankings.className = "daily-ranking-list";
      for (const candidate of report.ranked) {
        const item = document.createElement("li");
        const name = document.createElement("strong");
        name.textContent = `${candidate.company} (${candidate.symbol})`;
        const metrics = document.createElement("span");
        metrics.textContent = report.strategyType === "pine"
          ? `${report.strategy?.momentumDays ?? 20}-day return ${formatPercent(candidate.momentum)} · daily vol ${(candidate.volatility * 100).toFixed(2)}%`
          : `Score ${candidate.score.toFixed(1)} · ${report.strategy?.momentumDays ?? 20}-day return ${formatPercent(candidate.momentum)} · daily vol ${(candidate.volatility * 100).toFixed(2)}% · pullback ${candidate.zScore.toFixed(2)}σ`;
        const decision = document.createElement("small");
        decision.textContent = candidate.decision;
        item.append(name, metrics, decision);
        rankings.append(item);
      }
      details.append(rankings);
    } else {
      const noRankings = document.createElement("p");
      noRankings.className = "daily-report-note";
      noRankings.textContent = report.strategyType === "orb"
        ? "The ORB strategy trades MNQ directly and does not rank a candidate universe."
        : "No candidate had enough completed price history for factor ranking.";
      details.append(noRankings);
    }

    const actionsHeading = document.createElement("h4");
    actionsHeading.textContent = "Trades and position decisions";
    details.append(actionsHeading);
    if (report.actions?.length) {
      const actions = document.createElement("ul");
      actions.className = "daily-action-list";
      for (const action of report.actions) {
        const item = document.createElement("li");
        const title = document.createElement("strong");
        title.textContent = `${action.action} · ${action.symbol}`;
        const reason = document.createElement("span");
        reason.textContent = action.reason;
        item.append(title, reason);
        actions.append(item);
      }
      details.append(actions);
    } else {
      const noActions = document.createElement("p");
      noActions.className = "daily-report-note";
      noActions.textContent = "No entries, exits, or open positions required action today.";
      details.append(noActions);
    }
    const closeValue = document.createElement("p");
    closeValue.className = "daily-report-close";
    closeValue.textContent = `End-of-day portfolio value: ${formatMoney(report.equity)}.`;
    details.append(closeValue);
    dailyReportList.append(details);
  }
}

function updateHoldings() {
  holdingBody.replaceChildren();
  const positions = Object.entries(portfolio.positions);
  document.querySelector("#holdings-count").textContent = `${positions.length} holding${positions.length === 1 ? "" : "s"}`;
  if (!positions.length) {
    const row = holdingBody.insertRow();
    row.className = "empty-row";
    const cell = row.insertCell();
    cell.colSpan = 6;
    cell.textContent = "No open holdings. The strategy will hold positions across simulated days.";
    return;
  }
  for (const [symbol, position] of positions) {
    const mark = portfolio.lastPrices[symbol] ?? position.entryPrice;
    const isFuture = position.assetType === "future";
    const pnl = isFuture
      ? position.direction * position.shares * position.multiplier * (mark - position.entryPrice) - position.entryFee
      : position.shares * (mark - position.entryPrice) - position.entryFee;
    const row = holdingBody.insertRow();
    row.insertCell().textContent = symbol;
    row.insertCell().textContent = `${numberFormatter.format(position.shares)}${isFuture ? ` ${position.direction < 0 ? "short" : "long"}` : ""}`;
    row.insertCell().textContent = formatMoney(mark);
    row.insertCell().textContent = formatMoney(isFuture ? position.marginReserved : position.shares * mark);
    row.insertCell().textContent = formatDate(position.entryDate);
    const pnlCell = row.insertCell();
    pnlCell.className = pnl > 0 ? "positive" : pnl < 0 ? "negative" : "neutral";
    pnlCell.textContent = formatSignedMoney(pnl);
  }
}

function updateTrades() {
  tradeBody.replaceChildren();
  const trades = portfolio.trades.slice(-50).reverse();
  if (!trades.length) {
    const row = tradeBody.insertRow();
    row.className = "empty-row";
    const cell = row.insertCell();
    cell.colSpan = 8;
    cell.textContent = "Closed trades will appear here. Open positions remain in the holdings table above.";
    return;
  }
  for (const trade of trades) {
    const row = tradeBody.insertRow();
    row.insertCell().textContent = trade.symbol;
    row.insertCell().textContent = formatDate(trade.entryDate);
    row.insertCell().textContent = formatDate(trade.exitDate);
    row.insertCell().textContent = `${numberFormatter.format(trade.shares)}${trade.assetType === "future" ? ` ${trade.direction < 0 ? "short" : "long"}` : ""}`;
    row.insertCell().textContent = formatMoney(trade.entryPrice);
    row.insertCell().textContent = formatMoney(trade.exitPrice);
    const pnlCell = row.insertCell();
    pnlCell.className = trade.pnl > 0 ? "positive" : trade.pnl < 0 ? "negative" : "neutral";
    pnlCell.textContent = formatSignedMoney(trade.pnl);
    row.insertCell().textContent = trade.reason;
  }
}

function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function drawEquityChart() {
  const fitted = fitCanvas(equityCanvas);
  if (!fitted || !portfolio) return;
  const { ctx, width, height } = fitted;
  ctx.clearRect(0, 0, width, height);
  const values = [
    { date: "start", value: portfolio.initialCapital },
    ...portfolio.dailyEquity,
  ];
  equityOverlay.classList.toggle("is-hidden", values.length >= 2);
  if (values.length < 2) return;
  const left = 91;
  const right = width - 12;
  const top = 12;
  const bottom = height - 29;
  const rawValues = values.map((point) => point.value);
  const minimum = Math.min(...rawValues);
  const maximum = Math.max(...rawValues);
  const padding = Math.max((maximum - minimum) * 0.2, portfolio.initialCapital * 0.002);
  const min = minimum - padding;
  const max = maximum + padding;
  const xAt = (index) => left + (right - left) * index / Math.max(values.length - 1, 1);
  const yAt = (value) => bottom - (value - min) / (max - min) * (bottom - top);
  ctx.font = '9px "DM Mono", Consolas, monospace';
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let line = 0; line <= 3; line += 1) {
    const y = top + (bottom - top) * line / 3;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.strokeStyle = "#202a35";
    ctx.stroke();
    const value = max - (max - min) * line / 3;
    ctx.fillStyle = "#74808e";
    ctx.fillText(formatMoney(value), left - 9, y);
  }
  ctx.beginPath();
  values.forEach((point, index) => {
    const x = xAt(index);
    const y = yAt(point.value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = rawValues[rawValues.length - 1] >= portfolio.initialCapital ? "#71dfa2" : "#ff8083";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const firstDate = portfolio.dailyEquity[0]?.date;
  const lastDate = portfolio.dailyEquity[portfolio.dailyEquity.length - 1]?.date;
  if (firstDate) ctx.fillText(formatDate(firstDate), left, bottom + 10);
  if (lastDate) {
    ctx.textAlign = "right";
    ctx.fillText(formatDate(lastDate), right, bottom + 10);
  }
}

function drawPriceChart() {
  const fitted = fitCanvas(priceCanvas);
  const symbol = symbolSelect.value || portfolio?.watchlist[0];
  const market = marketBySymbol.get(symbol);
  if (!fitted || !portfolio || !market?.bars.length) return;
  const { ctx, width, height } = fitted;
  ctx.clearRect(0, 0, width, height);
  const currentDate = sessionDates[Math.max(0, replayIndex - 1)] ?? portfolio.processedThroughDate;
  const firstSession = sessionDates[0];
  const bars = market.bars.filter((bar) => (
    (!firstSession || bar.date >= firstSession) && (!currentDate || bar.date <= currentDate)
  ));
  if (!bars.length) return;
  const left = 60;
  const right = width - 12;
  const top = 11;
  const bottom = height - 29;
  const prices = bars.map((bar) => bar.close);
  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const padding = Math.max((rawMax - rawMin) * 0.12, rawMax * 0.002);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const xAt = (index) => left + (right - left) * index / Math.max(bars.length - 1, 1);
  const yAt = (value) => bottom - (value - min) / (max - min) * (bottom - top);
  ctx.font = '9px "DM Mono", Consolas, monospace';
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let line = 0; line <= 3; line += 1) {
    const y = top + (bottom - top) * line / 3;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.strokeStyle = "#202a35";
    ctx.stroke();
    ctx.fillStyle = "#74808e";
    ctx.fillText(formatMoney(max - (max - min) * line / 3), left - 8, y);
  }
  ctx.beginPath();
  bars.forEach((bar, index) => {
    const x = xAt(index);
    const y = yAt(bar.close);
    if (!index) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#80bfff";
  ctx.lineWidth = 1.7;
  ctx.stroke();
  const barIndexByDate = new Map(bars.map((bar, index) => [bar.date, index]));
  for (const trade of portfolio.trades) {
    if (trade.symbol !== symbol) continue;
    for (const [tradeDate, isBuy] of [[trade.entryDate, true], [trade.exitDate, false]]) {
      const index = barIndexByDate.get(tradeDate);
      if (index === undefined) continue;
      const x = xAt(index);
      const y = yAt(isBuy ? trade.entryPrice : trade.exitPrice);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = isBuy ? "#71dfa2" : "#ff8083";
      ctx.fill();
    }
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#74808e";
  ctx.fillText(formatDate(bars[0].date), left, bottom + 9);
  ctx.textAlign = "right";
  ctx.fillText(formatDate(bars[bars.length - 1].date), right, bottom + 9);
}

function renderAll() {
  if (!portfolio) return;
  const previous = symbolSelect.value;
  symbolSelect.replaceChildren();
  for (const symbol of portfolio.watchlist) {
    const option = document.createElement("option");
    option.value = symbol;
    option.textContent = symbol;
    symbolSelect.append(option);
  }
  if (portfolio.watchlist.includes(previous)) symbolSelect.value = previous;
  updateStrategySummary(portfolio.strategy);
  document.querySelector("#session-count").textContent = `${portfolio.dailyEquity.length} simulated day${portfolio.dailyEquity.length === 1 ? "" : "s"}`;
  updateRunNextStockDayButton();
  updateDashboard();
}

function stopPlayback() {
  playbackRunning = false;
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  updateRunNextStockDayButton();
  for (const input of document.querySelectorAll('input[type="range"]:not(#days-input)')) {
    input.disabled = false;
  }
  renderStrategySourcePicker();
}

async function advancePlayback() {
  if (!playbackRunning || advancing) return;
  advancing = true;
  try {
    const chunkEnd = Math.min(replayIndex + (usesOrbStrategy() ? 20 : PLAYBACK_CHUNK_SIZE), sessionDates.length);
    if (usesOrbStrategy() && replayIndex < chunkEnd) {
      const response = await requestJson("/api/orb-simulate", {
        method: "POST",
        body: JSON.stringify({
          portfolio,
          sessionDates: sessionDates.slice(replayIndex, chunkEnd),
          settings: readOrbSettings(),
        }),
      });
      portfolio = response.portfolio;
      replayIndex = chunkEnd;
    } else {
      while (playbackRunning && replayIndex < chunkEnd) {
        const date = sessionDates[replayIndex];
        await processTradingDay(date);
        replayIndex += 1;
      }
    }
    const date = sessionDates[Math.max(0, replayIndex - 1)];
    renderAll();
    document.querySelector("#replay-day-label").textContent = `${formatDate(date)} · ${replayIndex} / ${sessionDates.length}`;
    if (replayIndex && replayIndex % PORTFOLIO_CHECKPOINT_INTERVAL === 0 || replayIndex >= sessionDates.length) {
      await savePortfolio();
    }
    if (replayIndex >= sessionDates.length) {
      stopPlayback();
      setPlaybackStatus("SESSION COMPLETE", "done");
      runButton.disabled = false;
      runButton.textContent = "Run algorithm →";
      setStatus(usesOrbStrategy()
        ? "Portfolio saved. ORB positions were flattened at each trading-window close; cash, trades, and reports are ready."
        : "Portfolio saved. Open holdings and trade history will carry into the next simulation.", "success");
    }
  } catch (error) {
    stopPlayback();
    runButton.disabled = false;
    setPlaybackStatus("SAVE FAILED", "error");
    setStatus(error instanceof Error ? error.message : "Could not save the portfolio.", "error");
  } finally {
    advancing = false;
    if (playbackRunning) timer = window.setTimeout(advancePlayback, 0);
  }
}

async function startSimulation() {
  if (playbackRunning) {
    stopPlayback();
    setPlaybackStatus("PAUSED", "done");
    runButton.disabled = false;
    runButton.textContent = "Resume simulation";
    return;
  }

  setStatus("");
  freshAlgorithmBacktest = activeSetupStep === 3 && document.querySelector("#fresh-algorithm-backtest").checked;
  setBusy(true);
  try {
    const orbRun = usesOrbStrategy();
    const aiEnabled = orbRun ? false : aiPickerInput.checked;
    const requestedSymbols = orbRun ? ["MNQ=F"] : [...new Set([
      ...symbolsInput.value.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean),
      ...(activeMarket === "futures"
        ? [...document.querySelectorAll(".future-contract:checked")].map((input) => input.value)
        : []),
    ])];
    const dayLimit = Number(daysInput.value);
    if (!Number.isInteger(dayLimit) || dayLimit < 1 || dayLimit > 2500) {
      throw new Error("Days to replay must be a whole number between 1 and 2,500.");
    }
    if ((!aiEnabled && !requestedSymbols.length)
      || requestedSymbols.some((symbol) => !/^[A-Z0-9^=.-]{1,15}$/.test(symbol))) {
      throw new Error(aiEnabled
        ? activeMarket === "stock"
          ? "Enter stock symbols such as AAPL or MSFT, or leave the field blank."
          : "Enter MNQ=F, the Nasdaq micro futures contract, or leave the field blank."
        : activeMarket === "stock"
          ? "Choose or enter one or more stock tickers, such as AAPL or MSFT."
          : "Choose or enter MNQ=F, the Nasdaq micro futures contract.");
    }
    if (activeMarket === "futures" && !orbRun
      && requestedSymbols.some((symbol) => symbol !== "MNQ=F" && !portfolio?.watchlist?.includes(symbol))) {
      throw new Error("Only Nasdaq MNQ=F can be added to new Futures Trading simulations.");
    }
    if (requestedSymbols.length > MAX_PORTFOLIO_SYMBOLS) {
      throw new Error(`Add no more than ${MAX_PORTFOLIO_SYMBOLS} ${activeMarket === "stock" ? "stock" : "futures"} symbols.`);
    }
    const cash = Number(cashInput.value);
    if (!portfolio && (!Number.isFinite(cash) || cash < 100 || cash > 100_000_000)) {
      throw new Error("Starting capital must be between 100 and 100,000,000.");
    }

    const strategy = readStrategyControls();
    const selectedProgram = activeAlgorithmProgram();
    if (activeMarket === "stock" && selectedProgram?.direction === "short") {
      throw new Error("The stock paper portfolio supports long-only positions; use a long-only Pine strategy for Stock Trading.");
    }
    const selectedFutures = activeMarket === "futures"
      ? [...document.querySelectorAll(".future-contract:checked")].map((input) => input.value)
      : [];
    if (orbRun && !freshAlgorithmBacktest && Object.keys(portfolio?.positions ?? {}).length) {
      throw new Error("Close or reset existing holdings before switching to ORB; the NQ ORB strategy trades MNQ intraday and ends each session flat.");
    }
    const symbols = [...new Set([
      ...Object.keys(freshAlgorithmBacktest ? {} : portfolio?.positions ?? {}),
      ...requestedSymbols,
    ])];
    const companyNames = { ...companyNameBySymbol };
    if (aiEnabled) {
      setStatus(activeMarket === "stock"
        ? "Loading Yahoo Finance's stock candidate universe…"
        : "Loading available local futures datasets for quant ranking…");
      const response = await requestJson(`/api/ai-candidates?market=${activeMarket}`);
      const candidatePool = selectedFutures.length
        ? response.candidates.filter((candidate) => selectedFutures.includes(candidate.symbol))
        : response.candidates;
      if (!candidatePool.length) {
        throw new Error(`No ${activeMarket === "stock" ? "stock candidates" : "local futures datasets"} are available for the backtest.`);
      }
      for (const candidate of candidatePool) {
        if (symbols.includes(candidate.symbol)) continue;
        symbols.push(candidate.symbol);
        companyNames[candidate.symbol] = candidate.name;
      }
    }
    if (!symbols.length) {
      throw new Error(`No instruments were selected. Choose ${activeMarket === "stock" ? "a stock ticker" : "a futures dataset"} or enable quant ranking.`);
    }
    if (symbols.length > MAX_PORTFOLIO_SYMBOLS) {
      throw new Error(`The selected instruments and AI candidate universe exceed ${MAX_PORTFOLIO_SYMBOLS} symbols. Reduce manual tickers or disable quant ranking.`);
    }
    setStatus(activeMarket === "stock"
      ? `Loading cached Yahoo Finance daily bars for ${symbols.length} stock${symbols.length === 1 ? "" : "s"}…`
      : `Loading local 1-minute bars and aggregating futures sessions for ${symbols.length} instrument${symbols.length === 1 ? "" : "s"}…`);
    const marketData = await loadMarketDataBatch(symbols);
    const currency = marketData[0].currency;
    if (marketData.some((market) => market.currency !== currency)) {
      throw new Error("Keep all instruments in the same quote currency. Currency conversion is not simulated.");
    }
    if (portfolio && !freshAlgorithmBacktest && portfolio.currency !== currency) {
      throw new Error(`This portfolio uses ${portfolio.currency}. Reset it to start a ${currency} portfolio.`);
    }
    setCurrency(currency);
    const stockCacheWarning = marketData.find((market) => market.cacheWarning)?.cacheWarning;
    if (activeMarket === "stock") {
      document.querySelector("#stock-data-status").textContent = stockCacheWarning
        ? `STALE DATA — ${stockCacheWarning}`
        : `Stock data cached locally. Yahoo Finance refreshes after 24 hours; selected history is aligned to the futures data range.`;
      document.querySelector("#stock-data-status").classList.toggle("is-stale", Boolean(stockCacheWarning));
    }
    marketBySymbol = new Map(marketData.map((market, index) => [
      market.symbol || symbols[index],
      {
        ...market,
        byDate: new Map(market.bars.map((bar) => [bar.date, bar])),
        indexByDate: new Map(market.bars.map((bar, barIndex) => [bar.date, barIndex])),
      },
    ]));
    const pineProgram = activeAlgorithmProgram();
    if (pineProgram) {
      for (const market of marketBySymbol.values()) {
        if (pineProgram.language) market.nativeSignals = await executeNativeAlgorithm(pineProgram, market.bars);
        else preparePineMarketData(pineProgram, market);
      }
    }

    if (!portfolio || freshAlgorithmBacktest) {
      if (portfolio) {
        await portfolioSaveQueue;
        await requestJson(`/api/portfolio-archive?market=${activeMarket}`, { method: "POST" });
      }
      portfolio = makeNewPortfolio(
        cash,
        currency,
        symbols,
        strategy,
        aiEnabled,
        requestedSymbols,
        portfolio?.aiFocus ?? aiFocusDraft,
      );
    } else {
      portfolio.watchlist = symbols;
      portfolio.aiEnabled = aiEnabled;
      portfolio.manualSymbols = requestedSymbols;
      portfolio.strategy = { ...strategy };
    }
    portfolio.marketDataWarning = stockCacheWarning ?? null;
    updateActiveStrategy(strategy);
    portfolio.aiEnabled = aiEnabled;
    portfolio.manualSymbols = requestedSymbols;
    portfolio.aiFocus = portfolio.aiFocus ?? aiFocusDraft;
    portfolio.strategy = { ...DEFAULT_STRATEGY, ...portfolio.strategy, ...strategy };
    portfolio.strategyMode = strategyMode;
    portfolio.strategyEngine = activeMarket === "stock" ? "quant" : strategyEngine;
    portfolio.orbSettings = activeMarket === "futures" ? readOrbSettings() : portfolio.orbSettings;
    portfolio.localStrategy = { ...localStrategy };
    portfolio.importedStrategies = importedStrategies;
    portfolio.selectedImportedStrategyId = selectedImportedStrategyId;
    portfolio.lastPrices = Object.fromEntries(
      Object.entries(portfolio.lastPrices).filter(([symbol]) => symbols.includes(symbol)),
    );
    portfolio.companyNames = Object.fromEntries(
      symbols.filter((symbol) => companyNames[symbol] || portfolio.companyNames?.[symbol] || marketBySymbol.get(symbol)?.instrument?.name)
        .map((symbol) => [symbol, companyNames[symbol] || portfolio.companyNames[symbol] || marketBySymbol.get(symbol)?.instrument?.name || symbol]),
    );
    const allDates = [...new Set(marketData.flatMap((market) => market.bars.map((bar) => bar.date)))].sort();
    const unprocessedDates = portfolio.processedThroughDate
      ? allDates.filter((date) => date > portfolio.processedThroughDate)
      : allDates;
    sessionDates = unprocessedDates.slice(-dayLimit);
    if (!sessionDates.length) {
      resultsSection.hidden = false;
      renderAll();
      setBusy(false);
      setStatus(stockCacheWarning || "You are up to date. There are no new completed market sessions to simulate.", stockCacheWarning ? "error" : "success");
      setPlaybackStatus("UP TO DATE", "done");
      await savePortfolio();
      resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    cashInput.value = String(portfolio.initialCapital);
    symbolsInput.value = portfolio.aiEnabled
      ? portfolio.manualSymbols.filter((symbol) => !futuresContracts[symbol]).join(", ")
      : portfolio.watchlist.filter((symbol) => !futuresContracts[symbol]).join(", ");
    const firstSession = sessionDates[0];
    document.querySelector("#replay-day-label").textContent = `${formatDate(firstSession)} · 0 / ${sessionDates.length}`;
    document.querySelector("#session-count").textContent = `${sessionDates.length} day${sessionDates.length === 1 ? "" : "s"} queued`;
    replayIndex = 0;
    symbolSelect.value = portfolio.watchlist[0];
    resultsSection.hidden = false;
    await savePortfolio();
    renderAll();
    setPlaybackStatus("REPLAYING SESSIONS", "running");
    setStatus(stockCacheWarning
      ? `${sessionDates.length} session${sessionDates.length === 1 ? "" : "s"} loaded using saved but stale market data. ${stockCacheWarning}`
      : orbRun
        ? `${sessionDates.length} New York sessions queued for the local 1-minute MNQ ORB engine. Results are checkpointed in batches of 20.`
        : `${sessionDates.length} completed ${activeMarket === "stock" ? "stock trading day" : "futures session"}${sessionDates.length === 1 ? "" : "s"} loaded. Positions carry forward.`);
    setBusy(false);
    runButton.textContent = "Pause simulation";
    playbackRunning = true;
    renderStrategySourcePicker();
    for (const input of document.querySelectorAll('input[type="range"]:not(#days-input)')) {
      input.disabled = true;
    }
    timer = window.setTimeout(advancePlayback, 0);
    resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setBusy(false);
    setPlaybackStatus("DATA ERROR", "error");
    setStatus(error instanceof Error ? error.message : "Could not start the simulation.", "error");
  }
}

async function runNextStockDay() {
  if (activeMarket !== "stock" || !portfolio || playbackRunning || controlsBusy) return;
  daysInput.value = "1";
  setActiveSetupStep(1);
  setStatus("Loading the latest available stock data for the next unprocessed trading session…");
  await startSimulation();
}

async function prepareUploadedAlgorithm() {
  if (uploadKind === "json") {
    if (strategyJsonDirty) {
      if (!await applyStrategyJson()) throw new Error(strategyJsonStatus.textContent);
    } else if (!appliedJsonConfiguration && strategyMode !== "imported") {
      throw new Error("Import a JSON configuration or upload an algorithm first.");
    }
    return;
  }
  const source = document.querySelector("#algorithm-source").value;
  const language = document.querySelector("#algorithm-language").value;
  const key = JSON.stringify([activeMarket, language, source]);
  if (!source.trim()) {
    if (activeAlgorithmProgram()) return;
    throw new Error("Upload or paste an algorithm before running it.");
  }
  if (lastAppliedAlgorithm?.key === key && lastAppliedAlgorithm.id === selectedImportedStrategyId
      && lastAppliedAlgorithm.mode === strategyMode && lastAppliedAlgorithm.engine === strategyEngine) return;
  const result = await analyzeAlgorithm();
  if (!result) throw new Error(document.querySelector("#custom-algorithm-status").textContent);
  if (source !== document.querySelector("#algorithm-source").value || language !== document.querySelector("#algorithm-language").value) {
    throw new Error("Source changed during validation. Run again to use the edited source.");
  }
  if (!await applyAnalyzedAlgorithm()) throw new Error(statusNode.textContent || "Could not activate this algorithm.");
  lastAppliedAlgorithm = { key, id: selectedImportedStrategyId, mode: strategyMode, engine: strategyEngine };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (document.activeElement === companySearchInput && selectHighlightedSuggestion()) return;
  if (setupSubmitting || controlsBusy || marketSwitching) return;
  if (activeSetupStep === 1) {
    setActiveSetupStep(2);
    return;
  }
  setupSubmitting = true;
  try {
    setBusy(true);
    if (activeSetupStep === 3) await prepareUploadedAlgorithm();
    await startSimulation();
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setupSubmitting = false;
    setBusy(false);
  }
});

aiPickerInput.addEventListener("change", async () => {
  updateAiPickerDisplay();
  if (!portfolio) return;
  portfolio.aiEnabled = aiPickerInput.checked;
  portfolio.updatedAt = new Date().toISOString();
  try {
    await savePortfolio();
    setStatus(`Quant ranking ${portfolio.aiEnabled ? "enabled" : "disabled"}.`, "success");
  } catch (error) {
    aiPickerInput.checked = !aiPickerInput.checked;
    portfolio.aiEnabled = aiPickerInput.checked;
    updateAiPickerDisplay();
    setStatus(error instanceof Error ? error.message : "Could not save the quant ranking setting.", "error");
  }
});

companySearchInput.addEventListener("input", scheduleCompanySearch);
companySearchInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" && !companySuggestions.hidden) {
    event.preventDefault();
    highlightSuggestion(selectedSuggestion + 1);
  } else if (event.key === "ArrowUp" && !companySuggestions.hidden) {
    event.preventDefault();
    highlightSuggestion(selectedSuggestion < 0
      ? companySuggestions.querySelectorAll('[role="option"]').length - 1
      : selectedSuggestion - 1);
  } else if (event.key === "Enter" && selectHighlightedSuggestion()) {
    event.preventDefault();
  } else if (event.key === "Escape") {
    closeCompanySuggestions();
  }
});
companySearchInput.addEventListener("blur", () => {
  window.setTimeout(closeCompanySuggestions, 150);
});

for (const input of document.querySelectorAll('input[type="range"]:not(#days-input):not(#orb-quantity):not(#orb-cap)')) {
  input.addEventListener("input", () => {
    if (
      ["momentumWeight", "pullbackWeight", "lowVolWeight"].includes(input.id)
      && ["momentumWeight", "pullbackWeight", "lowVolWeight"]
        .every((key) => Number(document.querySelector(`#${key}`).value) === 0)
    ) {
      input.value = "5";
      setStatus("At least one ranking factor needs a non-zero weight; weights are normalized automatically.", "error");
    }
    updateSliderLabel(input);
    updateStrategySummary(readStrategyControls());
    if (portfolio) persistStrategySoon();
    if (!strategyJsonDirty && activeSetupStep === 3) {
      strategyJsonInput.value = strategyConfigText(readStrategyControls());
    }
  });
}

daysInput.addEventListener("change", () => {
  const parsed = Number(daysInput.value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2500) {
    setStatus("Days to replay must be a whole number between 1 and 2,500.", "error");
    daysInput.focus();
    return;
  }
  daysInput.value = String(parsed);
  setStatus("");
});

symbolSelect.addEventListener("change", drawPriceChart);
for (const tab of document.querySelectorAll(".setup-tab")) {
  tab.addEventListener("click", () => setActiveSetupStep(Number(tab.dataset.step)));
}
for (const button of document.querySelectorAll(".step-next")) {
  button.addEventListener("click", () => setActiveSetupStep(Number(button.dataset.next)));
}
for (const button of document.querySelectorAll(".step-back")) {
  button.addEventListener("click", () => setActiveSetupStep(Number(button.dataset.previous)));
}
document.querySelector("#strategy-mode").addEventListener("change", async (event) => {
  const previousMode = strategyMode;
  const previousEngine = strategyEngine;
  const previousSelectedId = selectedImportedStrategyId;
  const previousControls = readStrategyControls();
  const previousImportedStrategies = importedStrategies.map((item) => ({ ...item, strategy: { ...item.strategy } }));
  try {
    await selectStrategyMode(event.currentTarget.value);
  } catch (error) {
    strategyMode = previousMode;
    strategyEngine = previousEngine;
    selectedImportedStrategyId = previousSelectedId;
    importedStrategies = previousImportedStrategies;
    setStrategyControls(previousControls);
    updateActiveStrategy(previousControls);
    if (portfolio) {
      portfolio.strategyMode = previousMode;
      portfolio.strategyEngine = previousEngine;
      portfolio.strategy = { ...previousControls };
      portfolio.localStrategy = { ...localStrategy };
      portfolio.importedStrategies = importedStrategies;
      portfolio.selectedImportedStrategyId = selectedImportedStrategyId;
    }
    renderStrategySourcePicker();
    updateAiPickerDisplay();
    updateMarketLabels();
    setStatus(error instanceof Error ? error.message : "Could not change the active strategy.", "error");
  }
});
document.querySelector("#strategy-engine").addEventListener("change", async (event) => {
  const previousEngine = strategyEngine;
  const previousUniverse = portfolio ? {
    watchlist: [...portfolio.watchlist],
    manualSymbols: [...portfolio.manualSymbols],
    aiEnabled: portfolio.aiEnabled,
  } : null;
  if (event.currentTarget.value === "orb_nq_trio" && Object.keys(portfolio?.positions ?? {}).length) {
    event.currentTarget.value = previousEngine;
    setStatus("Close or reset existing holdings before selecting the intraday MNQ ORB strategy.", "error");
    return;
  }
  strategyEngine = event.currentTarget.value;
  renderStrategySourcePicker();
  updateAiPickerDisplay();
  updateMarketLabels();
  if (!portfolio) return;
  portfolio.strategyEngine = strategyEngine;
  portfolio.orbSettings = readOrbSettings();
  if (strategyEngine === "orb_nq_trio") {
    portfolio.watchlist = ["MNQ=F"];
    portfolio.manualSymbols = ["MNQ=F"];
    portfolio.aiEnabled = false;
    aiPickerInput.checked = false;
    symbolsInput.value = "";
    updateAiPickerDisplay();
  }
  portfolio.updatedAt = new Date().toISOString();
  try {
    await savePortfolio();
  } catch (error) {
    strategyEngine = previousEngine;
    portfolio.strategyEngine = previousEngine;
    if (previousUniverse) {
      portfolio.watchlist = previousUniverse.watchlist;
      portfolio.manualSymbols = previousUniverse.manualSymbols;
      portfolio.aiEnabled = previousUniverse.aiEnabled;
      aiPickerInput.checked = previousUniverse.aiEnabled;
    }
    renderStrategySourcePicker();
    updateAiPickerDisplay();
    updateMarketLabels();
    setStatus(error instanceof Error ? error.message : "Could not save the selected futures strategy.", "error");
  }
});
for (const input of document.querySelectorAll("#orb-preset, #orb-sizing, #orb-quantity, #orb-cap")) {
  input.addEventListener("change", async () => {
    const previousSettings = { ...orbSettings };
    try {
      const nextSettings = readOrbSettings();
      if (!Number.isInteger(nextSettings.quantity) || nextSettings.quantity < 1 || nextSettings.quantity > 100
        || !Number.isInteger(nextSettings.quantityCap) || nextSettings.quantityCap < 1 || nextSettings.quantityCap > 40) {
        throw new Error("Fixed quantity must be 1–100 and the risk-sized cap must be 1–40 contracts.");
      }
      setOrbSettings(nextSettings);
      if (portfolio) {
        portfolio.orbSettings = { ...nextSettings };
        portfolio.updatedAt = new Date().toISOString();
        await savePortfolio();
      }
      renderOrbPresetDetails();
      setStatus("Pine ORB inputs and the selected preset values were saved.", "success");
    } catch (error) {
      setOrbSettings(previousSettings);
      if (portfolio) portfolio.orbSettings = previousSettings;
      setStatus(error instanceof Error ? error.message : "Could not save the ORB settings.", "error");
    }
  });
}
for (const [inputId, outputId] of [["orb-quantity", "orb-quantity-value"], ["orb-cap", "orb-cap-value"]]) {
  document.querySelector(`#${inputId}`).addEventListener("input", (event) => {
    document.querySelector(`#${outputId}`).value = event.currentTarget.value;
  });
}
document.querySelector("#imported-strategy-select").addEventListener("change", async (event) => {
  await selectImportedStrategy(event.currentTarget.value);
});
document.querySelector("#remove-imported-strategy").addEventListener("click", () => {
  void removeSelectedImportedStrategy().catch((error) => {
    setStatus(error instanceof Error ? error.message : "Could not remove the imported strategy.", "error");
  });
});

strategyJsonInput.addEventListener("input", () => {
  uploadKind = "json";
  strategyJsonDirty = true;
  strategyJsonStatus.className = "strategy-json-status";
  strategyJsonStatus.textContent = "JSON edited. Validate and apply it before running the simulation.";
});
document.querySelector("#strategy-file").addEventListener("change", async (event) => {
  const [file] = event.currentTarget.files;
  if (!file) return;
  if (file.size > 100_000) {
    strategyJsonStatus.className = "strategy-json-status is-error";
    strategyJsonStatus.textContent = "Strategy files must be 100 KB or smaller.";
    event.currentTarget.value = "";
    return;
  }
  try {
    uploadKind = "json";
    strategyJsonInput.value = await file.text();
    strategyJsonDirty = true;
    strategyJsonStatus.className = "strategy-json-status";
    strategyJsonStatus.textContent = `${file.name} loaded. Validate the JSON to apply its settings.`;
  } catch (error) {
    strategyJsonStatus.className = "strategy-json-status is-error";
    strategyJsonStatus.textContent = error instanceof Error ? error.message : "Could not read that strategy file.";
  }
});
document.querySelector("#algorithm-file").addEventListener("change", async (event) => {
  const [file] = event.currentTarget.files;
  if (!file) return;
  if (file.size > 100_000) {
    const status = document.querySelector("#custom-algorithm-status");
    status.className = "custom-algorithm-status is-error";
    status.textContent = "Program files must be 100 KB or smaller.";
    event.currentTarget.value = "";
    return;
  }
  try {
    uploadKind = "source";
    const source = await file.text();
    const extension = file.name.toLowerCase().split(".").pop();
    const language = { py: "python", cpp: "cpp", pine: "pine", pinescript: "pine", txt: document.querySelector("#algorithm-language").value }[extension];
    if (!language) {
      throw new Error("Upload a .py, .cpp, .pine, or plain-text source file. Use the JSON importer above for JSON settings.");
    }
    document.querySelector("#trust-algorithm").checked = false;
    document.querySelector("#algorithm-language").value = language;
    document.querySelector("#algorithm-source").value = source;
    customAnalysis = null;
    document.querySelector("#custom-analysis-result").hidden = true;
    document.querySelector("#apply-analysis").hidden = true;
    const status = document.querySelector("#custom-algorithm-status");
    status.className = "custom-algorithm-status";
    status.textContent = `${file.name} loaded. Analyze it to see supported settings and limitations.`;
  } catch (error) {
    const status = document.querySelector("#custom-algorithm-status");
    status.className = "custom-algorithm-status is-error";
    status.textContent = error instanceof Error ? error.message : "Could not read this program file.";
  }
});
document.querySelector("#algorithm-source").addEventListener("input", () => {
  uploadKind = "source";
  document.querySelector("#trust-algorithm").checked = false;
  customAnalysis = null;
  document.querySelector("#custom-analysis-result").hidden = true;
  document.querySelector("#apply-analysis").hidden = true;
  const status = document.querySelector("#custom-algorithm-status");
  status.className = "custom-algorithm-status";
  status.textContent = "Source changed. Analyze it again before saving an imported strategy.";
});
document.querySelector("#algorithm-language").addEventListener("change", () => {
  uploadKind = "source";
  customAnalysis = null;
  document.querySelector("#custom-analysis-result").hidden = true;
  document.querySelector("#apply-analysis").hidden = true;
  document.querySelector("#apply-analysis").textContent = "Apply recognized settings";
});
async function analyzeAlgorithm() {
  customAnalysis = null;
  const status = document.querySelector("#custom-algorithm-status");
  const source = document.querySelector("#algorithm-source").value;
  const language = document.querySelector("#algorithm-language").value;
  if (!source.trim()) {
    status.className = "custom-algorithm-status is-error";
    status.textContent = "Upload or paste a Python, C++, or Pine Script program first.";
    return;
  }
  const checkButton = document.querySelector("#check-algorithm");
  checkButton.disabled = true;
  status.className = "custom-algorithm-status";
  status.textContent = language === "pine"
    ? "Reading supported Pine inputs and validating the strategy rules…"
    : "Validating the on_bar interface for local execution…";
  try {
    customAnalysis = await requestJson("/api/algorithm-analyze", {
      method: "POST",
      body: JSON.stringify({ language, source }),
    });
    const resultNode = document.querySelector("#custom-analysis-result");
    resultNode.replaceChildren();
    const settingList = document.createElement("ul");
    for (const [key, value] of Object.entries(customAnalysis.settings)) {
      const item = document.createElement("li");
      item.textContent = `${strategyLabel(key)}: ${value}`;
      settingList.append(item);
    }
    if (!settingList.childElementCount && !customAnalysis.program && !customAnalysis.nativeProgram && !customAnalysis.orbProgram) {
      const empty = document.createElement("p");
      empty.textContent = "No slider changes could be mapped from the recognized patterns.";
      resultNode.append(empty);
    } else if (settingList.childElementCount) {
      const heading = document.createElement("strong");
      heading.textContent = "Proposed slider changes";
      resultNode.append(heading, settingList);
    }
    if (customAnalysis.detected.length) {
      const detected = document.createElement("p");
      detected.textContent = `Recognized patterns: ${customAnalysis.detected.join(", ")}.`;
      resultNode.append(detected);
    }
    if (customAnalysis.nativeProgram) {
      const summary = document.createElement("p");
      summary.textContent = `Executable ${customAnalysis.nativeProgram.language}: on_bar receives completed OHLCV history and returns buy, sell, or hold. Compilation/runtime errors stop the run.`;
      resultNode.append(summary);
    }
    if (customAnalysis.program) {
      const indicators = Object.entries(customAnalysis.program.indicators)
        .map(([name, indicator]) => `${name} = ${indicator.kind.toUpperCase()}(${indicator.length})`)
        .join(", ");
      const programSummary = document.createElement("p");
      programSummary.textContent = `Executable Pine strategy: ${indicators}; ${customAnalysis.program.direction} entry on ${customAnalysis.program.entry.cross} and exit on ${customAnalysis.program.exit.cross}.`;
      resultNode.append(programSummary);
    }
    if (customAnalysis.orbProgram) {
      const orbSummary = document.createElement("p");
      const settings = customAnalysis.orbProgram.settings;
      orbSummary.textContent = `Supported ORB Pine input: ${settings.preset}, ${settings.sizing === "fixed" ? "fixed" : "approximate risk"} sizing, ${settings.quantity} fixed contracts, risk cap ${settings.quantityCap}. Preset tables for all three NQ variants are loaded into the MNQ controls and JSON.`;
      resultNode.append(orbSummary);
    }
    const warningList = document.createElement("ul");
    warningList.className = "analysis-warnings";
    for (const warning of customAnalysis.warnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      warningList.append(item);
    }
    resultNode.append(warningList);
    resultNode.hidden = false;
    const applyButton = document.querySelector("#apply-analysis");
    applyButton.hidden = !customAnalysis.program && !customAnalysis.nativeProgram && !customAnalysis.orbProgram;
    applyButton.textContent = customAnalysis.orbProgram ? "Apply Pine inputs to Futures Trading" : "Use this algorithm";
    status.className = "custom-algorithm-status is-success";
    status.textContent = customAnalysis.orbProgram
      ? "ORB Pine inputs validated. Apply them to configure the MNQ Futures workspace."
      : customAnalysis.program || customAnalysis.nativeProgram
      ? "Algorithm validated. Run algorithm will activate it and simulate its signals."
      : "This source cannot run as an algorithm. Upload a supported Pine crossover strategy instead. Python/C++ execution is not supported.";
  } catch (error) {
    status.className = "custom-algorithm-status is-error";
    status.textContent = error instanceof Error ? error.message : "Could not analyze this source.";
  } finally {
    checkButton.disabled = false;
  }
  return customAnalysis;
}
document.querySelector("#check-algorithm").addEventListener("click", () => void analyzeAlgorithm());
async function applyAnalyzedAlgorithm() {
  if (!customAnalysis?.program && !customAnalysis?.nativeProgram && !customAnalysis?.orbProgram) throw new Error("Upload a supported Pine strategy or a Python/C++ algorithm using the on_bar interface.");
  if (customAnalysis.orbProgram) {
    if (activeMarket !== "futures") throw new Error("ORB algorithms run in Futures Trading. Switch workspaces before running this file.");
    if (activeMarket !== "futures") return;
    if (Object.keys(portfolio?.positions ?? {}).length) {
      setStatus("Close or reset existing holdings before applying the intraday MNQ ORB strategy.", "error");
      return;
    }
    const previous = {
      strategyMode,
      strategyEngine,
      orbSettings: { ...orbSettings },
    };
    try {
      strategyMode = "local";
      strategyEngine = "orb_nq_trio";
      setOrbSettings(customAnalysis.orbProgram.settings, orbDefaults);
      if (portfolio) {
        portfolio.strategyMode = strategyMode;
        portfolio.strategyEngine = strategyEngine;
        portfolio.watchlist = ["MNQ=F"];
        portfolio.manualSymbols = ["MNQ=F"];
        portfolio.aiEnabled = false;
        portfolio.orbSettings = readOrbSettings();
        portfolio.updatedAt = new Date().toISOString();
        await savePortfolio();
      }
      renderStrategySourcePicker();
      strategyJsonInput.value = strategyConfigText();
      strategyJsonDirty = false;
      strategyJsonStatus.textContent = "JSON now reflects the applied Pine inputs and preset values.";
      setStatus("Applied the parsed Pine inputs and all three preset tables to Futures Trading (MNQ).", "success");
      return true;
    } catch (error) {
      strategyMode = previous.strategyMode;
      strategyEngine = previous.strategyEngine;
      if (portfolio) {
        portfolio.strategyMode = previous.strategyMode;
        portfolio.strategyEngine = previous.strategyEngine;
        portfolio.orbSettings = previous.orbSettings;
      }
      setOrbSettings(previous.orbSettings, orbDefaults);
      renderStrategySourcePicker();
      setStatus(error instanceof Error ? error.message : "Could not apply the Pine inputs.", "error");
    }
    return;
  }
  const strategy = { ...readStrategyControls(), ...customAnalysis.settings };
  const filename = document.querySelector("#algorithm-file").files[0]?.name ?? "";
  const suggestedName = filename.replace(/\.(py|cpp|pine|pinescript)$/i, "").slice(0, 100);
  try {
    const imported = await saveImportedStrategy(
      suggestedName || "Analyzed source strategy",
      strategy,
      customAnalysis.program ?? null,
      customAnalysis.nativeProgram ?? null,
    );
    document.querySelector("#strategy-mode").value = strategyMode;
    setStatus(customAnalysis.program || customAnalysis.nativeProgram
      ? `Saved “${imported.name}” with executable algorithm signals. It is active and ready to run.`
      : `Saved “${imported.name}” as an imported slider preset. Python/C++ are analysis-only. It is active and ready to run.`, "success");
    return true;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not save the imported strategy.", "error");
  }
}
document.querySelector("#apply-analysis").addEventListener("click", () => void prepareUploadedAlgorithm().catch(error => setStatus(error.message, "error")));

document.querySelector("#clear-algorithm").addEventListener("click", () => {
  document.querySelector("#algorithm-source").value = "";
  document.querySelector("#algorithm-file").value = "";
  customAnalysis = null;
  document.querySelector("#custom-analysis-result").replaceChildren();
  document.querySelector("#custom-analysis-result").hidden = true;
  document.querySelector("#apply-analysis").hidden = true;
  const status = document.querySelector("#custom-algorithm-status");
  status.className = "custom-algorithm-status";
  status.textContent = "Source cleared. Select a saved imported algorithm program or use the built-in quant model.";
});
async function applyStrategyJson() {
  uploadKind = "json";
  try {
    const parsed = parseStrategyJson(strategyJsonInput.value);
    if (parsed.engine === "orb_nq_trio") {
      if (activeMarket !== "futures") throw new Error("ORB JSON runs in Futures Trading. Switch workspaces before applying it.");
      if (Object.keys(portfolio?.positions ?? {}).length) {
        throw new Error("Close or reset existing holdings before switching to the intraday MNQ ORB strategy.");
      }
      const previousSettings = { ...orbSettings };
      const previousEngine = strategyEngine;
      const previousMode = strategyMode;
      try {
        strategyMode = "local";
        strategyEngine = "orb_nq_trio";
        setOrbSettings(parsed.settings, orbDefaults);
        if (portfolio) {
          portfolio.strategyMode = strategyMode;
          portfolio.strategyEngine = strategyEngine;
          portfolio.watchlist = ["MNQ=F"];
          portfolio.manualSymbols = ["MNQ=F"];
          portfolio.aiEnabled = false;
          portfolio.orbSettings = readOrbSettings();
          portfolio.updatedAt = new Date().toISOString();
          await savePortfolio();
        }
      } catch (error) {
        strategyMode = previousMode;
        strategyEngine = previousEngine;
        setOrbSettings(previousSettings, orbDefaults);
        renderStrategySourcePicker();
        throw error;
      }
      renderStrategySourcePicker();
      strategyJsonDirty = false;
      strategyJsonInput.value = strategyConfigText();
      strategyJsonStatus.className = "strategy-json-status is-success";
      strategyJsonStatus.textContent = `Applied “${parsed.name}” as the active Futures Trading ORB configuration.`;
      appliedJsonConfiguration = true;
      return true;
    }
    const imported = await saveImportedStrategy(parsed.name, parsed.strategy);
    strategyJsonDirty = false;
    strategyJsonInput.value = strategyConfigText(parsed.strategy);
    strategyJsonStatus.className = "strategy-json-status is-success";
    strategyJsonStatus.textContent = `Saved “${imported.name}” as an imported preset. It is active and ready to run.`;
    appliedJsonConfiguration = true;
    return true;
  } catch (error) {
    strategyJsonStatus.className = "strategy-json-status is-error";
    strategyJsonStatus.textContent = error instanceof Error ? error.message : "Could not import strategy JSON.";
  }
}
document.querySelector("#import-strategy").addEventListener("click", () => void applyStrategyJson());

document.querySelector("#export-strategy").addEventListener("click", () => {
  const isOrb = usesOrbStrategy();
  const content = strategyConfigText();
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = isOrb ? "orb-nq-trio.json" : "quant-strategy.json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  strategyJsonInput.value = content;
  strategyJsonDirty = false;
  strategyJsonStatus.className = "strategy-json-status is-success";
  strategyJsonStatus.textContent = `Active strategy exported as ${link.download}.`;
});
document.querySelector("#edit-setup").addEventListener("click", () => {
  setActiveSetupStep(1);
  document.querySelector("#setup").scrollIntoView({ behavior: "smooth", block: "start" });
});
document.querySelector("#run-next-stock-day").addEventListener("click", () => {
  void runNextStockDay();
});

window.addEventListener("resize", () => {
  drawPriceChart();
  drawEquityChart();
});

async function initialize() {
  try {
    const [portfolioResponse, futuresResponse] = await Promise.all([
      requestJson("/api/portfolio"),
      requestJson("/api/futures"),
    ]);
    portfolio = portfolioResponse.portfolio;
    updateMarketLabels();
    futuresContracts = futuresResponse.contracts ?? {};
    orbDefaults = futuresResponse.orbSettings ?? null;
    const futuresNode = document.querySelector("#futures-contract-list");
    futuresNode.replaceChildren();
    for (const [symbol, contract] of Object.entries(futuresContracts)) {
      const label = document.createElement("label");
      label.className = "future-contract-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "future-contract";
      checkbox.value = symbol;
      checkbox.checked = Boolean(portfolio?.manualSymbols?.includes(symbol));
      const name = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = `${contract.name} · ${symbol}`;
      const detail = document.createElement("small");
      detail.textContent = `${contract.sourceDataset} reference bars · ×${contract.multiplier} multiplier · estimated initial margin ${formatMoney(contract.initialMargin)}`;
      name.append(title, detail);
      label.append(checkbox, name);
      futuresNode.append(label);
    }
    if (portfolio) {
      strategyMode = portfolio.strategyMode ?? "local";
      strategyEngine = portfolio.strategyEngine ?? "quant";
      setOrbSettings(portfolio.orbSettings);
      importedStrategies = Array.isArray(portfolio.importedStrategies) ? portfolio.importedStrategies : [];
      localStrategy = { ...DEFAULT_STRATEGY, ...(portfolio.localStrategy ?? portfolio.strategy) };
      selectedImportedStrategyId = portfolio.selectedImportedStrategyId
        ?? importedStrategies[0]?.id
        ?? null;
      portfolio.aiEnabled ??= false;
      portfolio.manualSymbols ??= [...portfolio.watchlist];
      portfolio.companyNames ??= {};
      portfolio.dailyReports ??= [];
      portfolio.aiFocus ??= "";
      companyNameBySymbol = { ...portfolio.companyNames };
      aiFocusDraft = portfolio.aiFocus;
      aiPickerInput.checked = portfolio.aiEnabled;
      updateAiPickerDisplay();
      symbolsInput.value = portfolio.aiEnabled
        ? portfolio.manualSymbols.filter((symbol) => !futuresContracts[symbol]).join(", ")
        : portfolio.watchlist.filter((symbol) => !futuresContracts[symbol]).join(", ");
      cashInput.value = String(portfolio.initialCapital);
      cashInput.disabled = true;
      setCurrency(portfolio.currency);
      setStrategyControls({ ...DEFAULT_STRATEGY, ...portfolio.strategy });
      renderStrategySourcePicker();
      resultsSection.hidden = !portfolio.dailyEquity.length;
      setPlaybackStatus("PORTFOLIO RESTORED", "done");
      renderAll();
    } else {
      strategyMode = "local";
      strategyEngine = "orb_nq_trio";
      setOrbSettings();
      localStrategy = { ...DEFAULT_STRATEGY };
      importedStrategies = [];
      selectedImportedStrategyId = null;
      updateAiPickerDisplay();
      setStrategyControls(DEFAULT_STRATEGY);
      cashInput.value = "50000";
      renderStrategySourcePicker();
      resultsSection.hidden = true;
    }
    strategyJsonInput.value = strategyConfigText(readStrategyControls());
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not restore your portfolio.", "error");
    setPlaybackStatus("PORTFOLIO LOAD FAILED", "error");
  }
}

void initialize();

for (const button of document.querySelectorAll(".market-tab")) {
  button.addEventListener("click", () => void selectMarket(button.dataset.market));
}

resetButton.addEventListener("click", async () => {
  if (!window.confirm("Reset this portfolio and permanently delete its cash, open holdings, trades, and saved strategy history?")) {
    return;
  }
  resetButton.disabled = true;
  stopPlayback();
  while (advancing) await new Promise((resolve) => window.setTimeout(resolve, 25));
  try {
      if (strategySaveTimer !== null) {
        window.clearTimeout(strategySaveTimer);
        strategySaveTimer = null;
      }
      await portfolioSaveQueue.catch(() => {});
      await requestJson(`/api/portfolio?market=${activeMarket}`, { method: "DELETE" });
    window.location.reload();
  } catch (error) {
    resetButton.disabled = false;
    setStatus(error instanceof Error ? error.message : "Could not reset the portfolio.", "error");
  }
});
