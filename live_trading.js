/* Live paper trading deliberately keeps a separate ledger from historical replays. */
(() => {
  const status = document.querySelector("#live-status");
  const output = document.querySelector("#live-account");
  const start = document.querySelector("#live-start");
  const stop = document.querySelector("#live-stop");
  let generation = 0;
  let timer;
  let ledger;
  let busy = false;
  let releaseLock;
  let liveWorkspaceOpen = false;
  let previewVersion = 0;
  let previewBusy = false;
  let lastQuoteAt = null;
  let quote = null;
  let ordering = false;
  const quotes = new Map();
  let positionsBusy = false;
  const storageKey = "session-live-paper-v1";
  const selectedSymbol = () => document.querySelector("#live-symbol").value.trim().toUpperCase();
  function readAccount() {
    const account = JSON.parse(localStorage.getItem(storageKey) || "null") || { cash: 100000, quantity: 0, symbol: selectedSymbol(), trades: [] };
    if (!Number.isFinite(account.cash) || account.cash < 0 || !Number.isSafeInteger(account.quantity) || account.quantity < 0 || !Array.isArray(account.trades)) throw new Error("Saved paper account is invalid.");
    if (!account.positions) account.positions = account.quantity ? { [account.symbol]: account.quantity } : {};
    if (typeof account.positions !== "object" || Array.isArray(account.positions) || Object.entries(account.positions).some(([symbol, quantity]) => !/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) || !Number.isSafeInteger(quantity) || quantity <= 0)) throw new Error("Saved positions are invalid.");
    account.quantity = account.positions[selectedSymbol()] || 0;
    account.symbol = selectedSymbol();
    return account;
  }
  function freshQuote(data, symbol = selectedSymbol()) {
    const age = Date.now() - data?.timestamp * 1000;
    return data?.symbol === symbol && data.tradable && Number.isFinite(data.price) && data.price > 0 && age >= 0 && age <= 120000;
  }
  function updateTicket() {
    const buy = document.querySelector("#live-buy"), sell = document.querySelector("#live-sell");
    buy.disabled = sell.disabled = true;
    try {
      const account = readAccount(), quantity = Number(document.querySelector("#live-quantity").value);
      document.querySelector("#live-cash").textContent = `Buying power: $${account.cash.toFixed(2)}`;
      document.querySelector("#live-position").textContent = account.quantity ? `${account.quantity} shares of ${account.symbol}` : "No open position";
      document.querySelector("#live-held-symbol").hidden = !account.quantity || account.symbol === selectedSymbol();
      const same = true;
      const ready = !ordering && stop.disabled && freshQuote(quote) && same;
      const valid = Number.isSafeInteger(quantity) && quantity > 0;
      buy.disabled = !ready || !valid || quantity * quote.price * 1.0005 * 1.0001 > account.cash;
      sell.disabled = !ready || !valid || quantity > account.quantity;
      document.querySelector("#live-max-buy").disabled = !ready;
      document.querySelector("#live-sell-all").disabled = !ready || !account.quantity;
      document.querySelector("#live-estimate").textContent = !stop.disabled ? "Automation is running. Stop it below to trade manually." : !same ? `Close your ${account.symbol} position before trading another ticker.` : !freshQuote(quote) ? "Waiting for a fresh quote during regular market hours." : !valid ? "Enter a positive whole number of shares." : `Estimated buy: $${(quantity * quote.price * 1.0005 * 1.0001).toFixed(2)} · Sell proceeds: $${(quantity * quote.price * .9995 * .9999).toFixed(2)} (costs included). Final price may change.`;
    } catch (error) { document.querySelector("#live-order-status").textContent = error.message; }
  }
  async function placeOrder(side, orderSymbol = selectedSymbol(), orderQuantity = Number(document.querySelector("#live-quantity").value)) {
    if (ordering || !stop.disabled) return;
    const symbol = orderSymbol, quantity = orderQuantity;
    const message = document.querySelector("#live-order-status");
    ordering = true;
    document.querySelector("#live-symbol").disabled = start.disabled = true;
    updateTicket();
    try {
      renderPositions();
      if (!navigator.locks) throw new Error("This browser needs Web Locks support to place orders safely.");
      if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("Enter a positive whole number of shares.");
      message.textContent = `Checking a fresh ${symbol} quote…`;
      await navigator.locks.request(storageKey, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("Another tab is trading. Stop its automation and try again.");
        const data = await requestJson(`/api/live-stock?symbol=${encodeURIComponent(symbol)}`);
        if (!freshQuote(data, symbol)) throw new Error("Market closed or quote stale. No order placed.");
        const account = readAccount();
        account.quantity = account.positions[symbol] || 0;
        const price = data.price * (side === "BUY" ? 1.0005 : .9995);
        const fee = quantity * price * .0001;
        const total = quantity * price + (side === "BUY" ? fee : -fee);
        if (!Number.isFinite(total) || (side === "BUY" && total > account.cash)) throw new Error("Insufficient buying power at the latest price. Reduce shares.");
        if (side === "SELL" && quantity > account.quantity) throw new Error("You cannot sell more shares than you hold.");
        account.cash += side === "BUY" ? -total : total;
        account.quantity += side === "BUY" ? quantity : -quantity;
        account.symbol = symbol;
        if (account.quantity) account.positions[symbol] = account.quantity;
        else delete account.positions[symbol];
        account.trades.push({ time: new Date().toISOString(), symbol, side, quantity, price, fee, source: "manual" });
        account.trades = account.trades.slice(-1000);
        localStorage.setItem(storageKey, JSON.stringify(account));
        ledger = account;
        quotes.set(symbol, data);
        if (symbol === selectedSymbol()) showQuote(data);
        render(data.price, account);
        message.textContent = `Filled · ${side} ${quantity} ${symbol} @ $${price.toFixed(2)} · Fee $${fee.toFixed(2)} · Paper order`;
      });
    } catch (error) { message.textContent = error.message; }
    finally { ordering = false; document.querySelector("#live-symbol").disabled = start.disabled = false; updateTicket(); try { renderPositions(); } catch (error) { message.textContent = error.message; } }
  }
  document.querySelector("#live-buy").addEventListener("click", () => void placeOrder("BUY"));
  document.querySelector("#live-sell").addEventListener("click", () => void placeOrder("SELL"));
  document.querySelector("#live-quantity").addEventListener("input", updateTicket);
  for (const [id, getQuantity] of [["#live-max-buy", a => Math.floor(a.cash / (quote.price * 1.0005 * 1.0001))], ["#live-sell-all", a => a.quantity]]) {
    document.querySelector(id).addEventListener("click", () => {
      try { document.querySelector("#live-quantity").value = getQuantity(readAccount()); updateTicket(); }
      catch (error) { document.querySelector("#live-order-status").textContent = error.message; }
    });
  }
  document.querySelector("#live-held-symbol").addEventListener("click", () => {
    if (ordering || !stop.disabled) return;
    document.querySelector("#live-symbol").value = readAccount().symbol;
    quote = null; updateTicket(); void previewQuote();
  });
  window.addEventListener("storage", () => { updateTicket(); try { render(undefined, readAccount()); } catch (error) { status.textContent = error.message; } });
  function drawCandles(bars, chart = document.querySelector("#live-chart")) {
    chart.replaceChildren();
    const candles = bars.filter(b => [b.open, b.high, b.low, b.close, b.timestamp].every(Number.isFinite) && b.low <= Math.min(b.open, b.close) && b.high >= Math.max(b.open, b.close)).slice(-90);
    const svg = (tag, attrs, text) => {
      const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
      if (text !== undefined) element.textContent = text;
      return element;
    };
    if (!candles.length) { chart.append(svg("text", {x:30, y:140, fill:"#aab6bf"}, "Waiting for OHLC candles…")); return; }
    const min = Math.min(...candles.map(b => b.low)), max = Math.max(...candles.map(b => b.high));
    const padding = Math.max((max - min) * .08, .01);
    const low = min - padding, high = max + padding;
    const y = price => 250 - (price - low) / (high - low) * 230;
    const step = 780 / candles.length;
    const x = i => 20 + (i + .5) * step;
    for (let i = 0; i <= 4; i++) {
      const price = low + (high - low) * i / 4;
      chart.append(svg("line", {x1:20, x2:800, y1:y(price), y2:y(price), stroke:"#36434b", "stroke-width":.6}));
      chart.append(svg("text", {x:812, y:y(price) + 4, fill:"#aab6bf", "font-size":12}, `$${price.toFixed(2)}`));
    }
    candles.forEach((bar, i) => {
      const color = bar.close >= bar.open ? "#51d5b0" : "#f09c9c";
      const group = svg("g", {});
      group.append(svg("title", {}, `${new Date(bar.timestamp * 1000).toLocaleString()} · O $${bar.open.toFixed(2)} · H $${bar.high.toFixed(2)} · L $${bar.low.toFixed(2)} · C $${bar.close.toFixed(2)}`));
      group.append(svg("line", {x1:x(i), x2:x(i), y1:y(bar.high), y2:y(bar.low), stroke:color, "stroke-width":1}));
      group.append(svg("rect", {x:x(i) - step * .32, y:Math.min(y(bar.open), y(bar.close)), width:step * .64, height:Math.max(1, Math.abs(y(bar.open) - y(bar.close))), fill:color}));
      chart.append(group);
    });
    for (const i of new Set([0, Math.floor((candles.length - 1) / 2), candles.length - 1])) {
      chart.append(svg("text", {x:x(i), y:280, fill:"#aab6bf", "font-size":12, "text-anchor":i === 0 ? "start" : i === candles.length - 1 ? "end" : "middle"}, new Date(candles[i].timestamp * 1000).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})));
    }
  }
  function showQuote(data) {
    if (data.symbol) quotes.set(data.symbol, data);
    quote = data;
    updateTicket();
    lastQuoteAt = data.timestamp * 1000;
    document.querySelector("#live-price").textContent = `$${data.price.toFixed(2)}`;
    document.querySelector("#live-quote-time").textContent = new Date(lastQuoteAt).toLocaleString();
    document.querySelector("#live-feed-status").textContent = `${data.symbol ?? "Stock"} · ${data.tradable ? "Feed fresh / regular session" : "Market closed or feed stale — fills paused"} · ${data.source} · fetched ${new Date().toLocaleTimeString()}`;
    drawCandles(data.bars);
  }
  async function previewQuote() {
    if (!liveWorkspaceOpen || !stop.disabled || previewBusy) return;
    const token = ++previewVersion;
    const symbol = document.querySelector("#live-symbol").value.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) {
      document.querySelector("#live-feed-status").textContent = "Enter a valid stock ticker.";
      return;
    }
    previewBusy = true;
    document.querySelector("#live-feed-status").textContent = "Fetching latest quote…";
    try {
      const data = await requestJson(`/api/live-stock?symbol=${encodeURIComponent(symbol)}`);
      if (token !== previewVersion || !liveWorkspaceOpen || !stop.disabled) return;
      showQuote(data);
      render(data.price, readAccount());
      void refreshPositions();
    } catch (error) {
      if (token === previewVersion) document.querySelector("#live-feed-status").textContent = `Feed unavailable: ${error.message}. Retrying on next refresh.`;
    } finally { previewBusy = false; }
  }
  function halt() {
    generation += 1;
    clearTimeout(timer);
    releaseLock?.();
    releaseLock = null;
    start.disabled = false;
    stop.disabled = true;
    document.querySelector("#live-workspace-tab").setAttribute("data-running", "false");
    document.querySelector("#live-symbol").disabled = false;
    document.querySelector("#live-strategy").disabled = false;
    document.querySelector("#live-refresh").disabled = false;
    status.textContent = "Automation stopped. You can buy or sell manually; holdings are retained.";
    updateTicket();
    try { renderPositions(); } catch (error) { status.textContent = error.message; }
  }
  stop.addEventListener("click", halt);
  window.addEventListener("pagehide", halt);
  function render(price, account = ledger) {
    renderPositions(account);
    output.textContent = account.trades.length ? account.trades.slice(-12).reverse().map(t => `${new Date(t.time).toLocaleString()}  ${t.side}  ${t.quantity} ${t.symbol ?? account.symbol} @ $${t.price.toFixed(2)} · ${t.source === "manual" ? "Manual" : "Algorithm"}`).join("\n") : "No fills yet. Your completed paper orders will appear here.";
    updateTicket();
  }
  function renderPositions(account = readAccount()) {
    renderStockCharts(account);
    const container = document.querySelector("#live-positions");
    container.replaceChildren();
    let value = 0, complete = true, stale = false;
    const entries = Object.entries(account.positions || {});
    if (!entries.length) container.textContent = "No open positions. Buy shares to add a stock here.";
    for (const [symbol, quantity] of entries) {
      const data = quotes.get(symbol);
      const marked = Number.isFinite(data?.price) && data.price > 0;
      if (marked) value += quantity * data.price; else complete = false;
      if (!freshQuote(data, symbol)) stale = true;
      const row = document.createElement("div"); row.className = "live-position-row";
      const label = document.createElement("span");
      label.textContent = `${symbol} · ${quantity} shares · ${marked ? `$${(quantity * data.price).toFixed(2)} value${freshQuote(data, symbol) ? "" : " (last quote)"}` : "Quote pending"}`;
      const button = document.createElement("button"); button.type = "button"; button.className = "button live-sell";
      button.textContent = `Sell all ${symbol}`; button.disabled = ordering || !stop.disabled;
      button.addEventListener("click", () => void placeOrder("SELL", symbol, quantity));
      row.append(label, button); container.append(row);
    }
    const suffix = stale ? " (last quotes)" : "";
    document.querySelector("#live-equity").textContent = complete ? `$${(account.cash + value).toFixed(2)}${suffix}` : "Awaiting quotes";
    document.querySelector("#live-pnl").textContent = complete ? `$${(account.cash + value - 100000).toFixed(2)}${suffix}` : "Awaiting quotes";
  }
  function renderStockCharts(account) {
    const grid = document.querySelector("#live-stock-charts");
    grid.replaceChildren();
    const symbols = new Set(Object.keys(account.positions || {}));
    if (!stop.disabled) symbols.add(selectedSymbol());
    if (!symbols.size) grid.textContent = "Your stock charts appear here when you buy shares or start automation.";
    for (const symbol of symbols) {
      const data = quotes.get(symbol);
      const card = document.createElement("article"); card.className = "stock-mini-card";
      const title = document.createElement("h4"); title.textContent = symbol;
      const holding = document.createElement("p");
      holding.textContent = `${account.positions?.[symbol] || 0} shares${!stop.disabled && symbol === selectedSymbol() ? " · Automation active" : ""} · ${Number.isFinite(data?.price) ? `$${data.price.toFixed(2)}` : "Quote pending"}`;
      const chart = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      chart.setAttribute("viewBox", "0 0 900 300"); chart.setAttribute("role", "img");
      chart.setAttribute("aria-label", `${symbol} one-minute candlestick chart`);
      drawCandles((data?.bars || []).slice(-40), chart);
      const stamp = document.createElement("p"); stamp.className = "algorithm-help";
      stamp.textContent = data ? `1-minute candles · ${new Date(data.timestamp * 1000).toLocaleString()}${freshQuote(data, symbol) ? "" : " · Last available quote / market closed or stale"}` : "Waiting for market data; retries automatically.";
      const view = document.createElement("button"); view.type = "button"; view.className = "button button-quiet";
      view.textContent = `View ${symbol}`; view.disabled = ordering || !stop.disabled;
      view.addEventListener("click", () => {
        if (ordering || !stop.disabled) return;
        document.querySelector("#live-symbol").value = symbol;
        previewVersion += 1; quote = null; updateTicket();
        if (data) showQuote(data);
        void previewQuote();
      });
      card.append(title, holding, chart, stamp, view); grid.append(card);
    }
  }
  async function refreshPositions() {
    if (positionsBusy || !liveWorkspaceOpen) return;
    positionsBusy = true;
    try {
      const symbols = Object.keys(readAccount().positions);
      await Promise.allSettled(symbols.map(async symbol => {
        if (freshQuote(quotes.get(symbol), symbol) && Date.now() - quotes.get(symbol).timestamp * 1000 < 15000) return;
        const data = await requestJson(`/api/live-stock?symbol=${encodeURIComponent(symbol)}`);
        if (data.symbol === symbol) quotes.set(symbol, data);
      }));
      renderPositions();
    } catch (error) { status.textContent = error.message; }
    finally { positionsBusy = false; }
  }
  async function run(symbol, program, token) {
    if (token !== generation) return;
    try {
      const data = await requestJson(`/api/live-stock?symbol=${encodeURIComponent(symbol)}`);
      if (token !== generation) return;
      showQuote(data);
      const bars = data.bars;
      const latest = bars.at(-1).timestamp;
      const closes = bars.map(b => b.close);
      let quantSignal = null;
      if (program.kind === "quant" && closes.length >= program.lookback) {
        const sample = closes.slice(-program.lookback);
        const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length;
        const deviation = Math.sqrt(sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sample.length);
        const z = deviation > 0 ? (sample.at(-1) - mean) / deviation : 0;
        quantSignal = { buy: deviation > 0 && z <= -program.entryZ, sell: z >= program.exitZ, z };
      }
      const series = Object.fromEntries(Object.entries(program.indicators ?? {}).map(([name, spec]) =>
        [name, pineIndicatorSeries(spec.kind, spec.length, closes)]));
      const crossed = condition => {
        const left = series[condition.left], right = series[condition.right];
        const values = [left.at(-2), right.at(-2), left.at(-1), right.at(-1)];
        if (!values.every(Number.isFinite)) return false;
        return condition.cross === "crossover"
          ? values[0] <= values[1] && values[2] > values[3]
          : values[0] >= values[1] && values[2] < values[3];
      };
      // Prime on start; only newly completed candles can trigger paper fills.
      if (ledger.lastBar === null) ledger.lastBar = latest;
      if (data.tradable && latest > ledger.lastBar) {
        const nativeSignals = program.language ? await executeNativeAlgorithm(program, bars) : null;
        if (token !== generation) return;
        let side = null, quantity = 0;
        const warm = program.kind === "quant" ? program.lookback : program.language ? 2 : Math.max(...Object.values(program.indicators).map(i => i.length)) + 2;
        if (bars.length >= warm) {
          const exit = program.kind === "quant" ? quantSignal?.sell || data.price <= ledger.quantStop : nativeSignals ? nativeSignals.at(-1) === "sell" : crossed(program.exit);
          const entry = program.kind === "quant" ? quantSignal?.buy : nativeSignals ? nativeSignals.at(-1) === "buy" : crossed(program.entry);
          if (ledger.quantity && exit) { side = "SELL"; quantity = ledger.quantity; }
          else if (!ledger.quantity && entry) { side = "BUY"; quantity = Math.floor(ledger.cash * 0.1 / (data.price * 1.0005 * 1.0001)); }
        }
        if (side && quantity > 0) {
          const price = data.price * (side === "BUY" ? 1.0005 : 0.9995);
          const cost = quantity * price;
          ledger.cash += side === "BUY" ? -cost * 1.0001 : cost * 0.9999;
          ledger.quantity += side === "BUY" ? quantity : -quantity;
          if (program.kind === "quant") ledger.quantStop = side === "BUY" ? price * .98 : null;
          if (ledger.quantity) ledger.positions[symbol] = ledger.quantity;
          else delete ledger.positions[symbol];
          ledger.trades.push({ time: new Date().toISOString(), symbol, side, quantity, price });
          ledger.trades = ledger.trades.slice(-1000);
        }
      }
      ledger.lastBar = Math.max(ledger.lastBar, latest);
      localStorage.setItem(storageKey, JSON.stringify(ledger));
      render(data.price);
      status.textContent = `${data.tradable ? "Running" : "Paused: market closed or feed stale"} · ${symbol} $${data.price.toFixed(2)} · Quote ${new Date(data.timestamp * 1000).toLocaleString()} · ${data.source}. Strategy pinned until stopped.`;
      if (program.kind === "quant") status.textContent += ` Quant ${program.lookback}-minute window · ${quantSignal ? `z-score ${quantSignal.z.toFixed(2)}; buy ≤ −${program.entryZ}, sell ≥ ${program.exitZ}` : "warming up"}.`;
    } catch (error) {
      if (token !== generation) return;
      halt();
      status.textContent = `Stopped: ${error.message}. Check the feed/storage and restart.`;
      return;
    }
    if (token === generation) timer = setTimeout(() => void run(symbol, program, token), 30000);
  }
  async function startTrading() {
    if (busy) return;
    busy = true;
    try {
      const useUpload = document.querySelector("#live-strategy").value === "uploaded";
      const useQuant = document.querySelector("#live-strategy").value === "quant";
      const settings = useQuant ? readStrategyControls() : null;
      const program = useQuant ? {kind:"quant", direction:"long", lookback:settings.lookbackDays, entryZ:settings.entryZ, exitZ:settings.exitZ} : useUpload ? activeAlgorithmProgram() : crossoverProgram(20, 50);
      if (useQuant && (!Number.isInteger(program.lookback) || program.lookback < 2 || !Number.isFinite(program.entryZ) || program.entryZ <= 0 || !Number.isFinite(program.exitZ))) throw new Error("Review the stock quant lookback and thresholds before starting.");
      const symbol = document.querySelector("#live-symbol").value.trim().toUpperCase();
      if (activeMarket !== "stock" || !program || program.direction !== "long") throw new Error("Activate a long-only algorithm in Stock Trading first.");
      const selected = useUpload ? importedStrategies.find(item => item.id === selectedImportedStrategyId) : null;
      if (selected?.name.startsWith("Daily ")) throw new Error("This library strategy requires daily bars. Use the minute demo or upload an algorithm designed for minute data.");
      if (program.language && !document.querySelector("#trust-algorithm").checked) throw new Error("Check 'I trust this source' before running local Python/C++ code.");
      if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) throw new Error("Enter a valid stock ticker.");
      ledger = readAccount();
      if (useQuant && ledger.quantity) throw new Error("Quant starts with no shares of its selected ticker. Sell that position first or select another ticker; other stock holdings can remain open.");
      ledger.quantStop = null;
      if (!Number.isFinite(ledger.cash) || ledger.cash < 0 || !Number.isInteger(ledger.quantity) || ledger.quantity < 0 || !Array.isArray(ledger.trades)) throw new Error("Saved live paper account is invalid.");
      ledger.symbol = symbol;
      ledger.lastBar = null;
      localStorage.setItem(storageKey, JSON.stringify(ledger));
      start.disabled = true;
      stop.disabled = false;
      document.querySelector("#live-workspace-tab").setAttribute("data-running", "true");
      previewVersion += 1;
      document.querySelector("#live-symbol").disabled = true;
      document.querySelector("#live-strategy").disabled = true;
      document.querySelector("#live-refresh").disabled = true;
      const token = ++generation;
      status.textContent = "Connecting to recent stock candles…";
      await run(symbol, structuredClone(program), token);
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; }
  }
  start.addEventListener("click", () => {
    if (ordering || busy || !stop.disabled) return;
    if (!navigator.locks) { status.textContent = "Use a browser supporting Web Locks to prevent simultaneous paper sessions."; return; }
    void navigator.locks.request(storageKey, { ifAvailable: true }, async lock => {
      if (!lock) { status.textContent = "Paper trading is already running in another tab."; return; }
      const stopped = new Promise(resolve => { releaseLock = resolve; });
      await startTrading();
      if (stop.disabled) { releaseLock?.(); releaseLock = null; }
      else await stopped;
    });
  });
  document.querySelector("#live-workspace-tab").addEventListener("click", async () => {
    if (controlsBusy || playbackRunning || marketSwitching) return;
    await selectMarket("stock");
    if (activeMarket !== "stock") return;
    liveWorkspaceOpen = true;
    document.body.classList.add("live-view");
    document.querySelector("#live-stock-panel").hidden = false;
    document.querySelector("#market-intro-copy").textContent = "Follow stock quotes, buy and sell paper shares, and track your account. Enable algorithm automation whenever you choose.";
    if (stop.disabled) status.textContent = "Choose your shares and Buy or Sell. Algorithm automation is optional.";
    updateTicket();
    renderPositions();
    void refreshPositions();
    for (const tab of document.querySelectorAll(".market-tab")) {
      const selected = tab.id === "live-workspace-tab";
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-pressed", String(selected));
    }
    void previewQuote();
  });
  for (const tab of document.querySelectorAll(".market-tab[data-market]")) {
    tab.addEventListener("click", () => {
      if (controlsBusy || playbackRunning || marketSwitching) return;
      liveWorkspaceOpen = false;
      previewVersion += 1;
      document.body.classList.remove("live-view");
      document.querySelector("#live-stock-panel").hidden = true;
      document.querySelector("#live-workspace-tab").classList.remove("is-active");
      document.querySelector("#live-workspace-tab").setAttribute("aria-pressed", "false");
      tab.classList.add("is-active");
      tab.setAttribute("aria-pressed", "true");
    }, {capture: true});
  }
  document.querySelector("#live-refresh").addEventListener("click", () => void previewQuote());
  document.querySelector("#live-symbol").addEventListener("input", () => { previewVersion += 1; quote = null; updateTicket(); });
  document.querySelector("#live-symbol").addEventListener("change", () => void previewQuote());
  setInterval(() => void previewQuote(), 15000);
  setInterval(() => { void refreshPositions(); }, 15000);
  setInterval(() => {
    updateTicket();
    if (lastQuoteAt !== null) document.querySelector("#live-quote-time").textContent = `${new Date(lastQuoteAt).toLocaleTimeString()} · ${Math.max(0, Math.floor((Date.now() - lastQuoteAt) / 1000))}s old`;
  }, 1000);
})();
