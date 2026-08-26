// =========================================================
// STATE
// =========================================================
let state = {
  granularity: "M15",
  rangeDays: 5,
  chartDark: false,
  logMode: false,
  pctMode: false,
  dragMode: "zoom",
  zoomEpoch: 0,
  candles: [],
  gbpRate: 1.27,
  refreshTimer: null,
};

const GRANULARITY_MINUTES = {
  M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D: 1440, W: 10080, M: 43200,
};

const UP_COLOR = "#00b386";
const DOWN_COLOR = "#eb5757";

// =========================================================
// DATA FETCHING
// =========================================================
async function fetchCandles(granularity, count) {
  const res = await fetch(`/api/oanda?granularity=${granularity}&count=${count}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to fetch OANDA data");

  return data.candles.map(c => ({
    time: new Date(c.time),
    open: parseFloat(c.mid.o),
    high: parseFloat(c.mid.h),
    low: parseFloat(c.mid.l),
    close: parseFloat(c.mid.c),
    volume: c.volume || 0,
  }));
}

async function fetchGbpRate() {
  // Frankfurter is a free, keyless, CORS-friendly exchange rate API
  const res = await fetch("https://api.frankfurter.app/latest?from=GBP&to=USD");
  const data = await res.json();
  return data.rates.USD; // USD per 1 GBP
}

function usdToGbp(usdAmount, rate) {
  return usdAmount / rate;
}

// =========================================================
// TECHNICAL LOGIC
// =========================================================
function computeATR(candles, period = 14) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  const atrs = new Array(candles.length).fill(null);
  for (let i = period - 1; i < trs.length; i++) {
    const window = trs.slice(i - period + 1, i + 1);
    atrs[i] = window.reduce((a, b) => a + b, 0) / period;
  }
  return atrs;
}

function detectFVGs(candles, lookback, minGap) {
  const fvgs = [];
  const n = candles.length;
  const start = Math.max(2, n - lookback);
  for (let i = start; i < n; i++) {
    const c1 = candles[i - 2], c3 = candles[i];
    if (c3.low > c1.high && (c3.low - c1.high) >= minGap) {
      fvgs.push({ type: "bullish", top: c3.low, bottom: c1.high, formedPos: i });
    }
    if (c3.high < c1.low && (c1.low - c3.high) >= minGap) {
      fvgs.push({ type: "bearish", top: c1.low, bottom: c3.high, formedPos: i });
    }
  }
  return fvgs;
}

function filterUnmitigated(candles, fvgs) {
  return fvgs.filter(fvg => {
    const subsequent = candles.slice(fvg.formedPos + 1);
    if (fvg.type === "bullish") {
      return !subsequent.some(c => c.low <= fvg.bottom);
    } else {
      return !subsequent.some(c => c.high >= fvg.top);
    }
  });
}

function generateSignal(candles, activeFvgs) {
  const price = candles[candles.length - 1].close;
  let signal = "HOLD", chosen = null;
  const inside = activeFvgs.filter(f => price >= f.bottom && price <= f.top);
  const candidates = inside.length ? inside : activeFvgs;
  if (candidates.length) {
    chosen = candidates.reduce((best, f) => {
      const mid = (f.top + f.bottom) / 2;
      const bestMid = (best.top + best.bottom) / 2;
      return Math.abs(price - mid) < Math.abs(price - bestMid) ? f : best;
    });
    if (inside.length) signal = chosen.type === "bullish" ? "BUY" : "SELL";
  }
  return { signal, chosen };
}

function calculateTradePlan(signal, price, fvg, atr, rateGbpUsd, settings) {
  if (signal === "HOLD" || !fvg || atr == null) return null;
  const buffer = atr * settings.atrBuffer;
  let sl, stopDistance, tp;
  if (signal === "BUY") {
    sl = fvg.bottom - buffer;
    stopDistance = price - sl;
    tp = price + stopDistance * settings.rewardRisk;
  } else {
    sl = fvg.top + buffer;
    stopDistance = sl - price;
    tp = price - stopDistance * settings.rewardRisk;
  }
  if (stopDistance <= 0) return null;

  const riskAmountGbp = settings.accountBalance * (settings.riskPercent / 100);
  const riskAmountUsd = riskAmountGbp * rateGbpUsd;
  const recommendedLot = Math.max(riskAmountUsd / (stopDistance * 100), 0.01);

  return {
    entryUsd: price, slUsd: sl, tpUsd: tp, stopDistanceUsd: stopDistance,
    recommendedLot: Math.round(recommendedLot * 100) / 100,
    riskAmountGbp: Math.round(riskAmountGbp * 100) / 100,
    rewardAmountGbp: Math.round(riskAmountGbp * settings.rewardRisk * 100) / 100,
  };
}

// =========================================================
// UI HELPERS
// =========================================================
function getSettings() {
  return {
    accountBalance: parseFloat(document.getElementById("accountBalance").value),
    riskPercent: parseFloat(document.getElementById("riskPercent").value),
    rewardRisk: parseFloat(document.getElementById("rewardRisk").value),
    atrBuffer: parseFloat(document.getElementById("atrBuffer").value),
    fvgLookback: parseInt(document.getElementById("fvgLookback").value),
    minGap: parseFloat(document.getElementById("minGap").value),
    refreshSeconds: parseInt(document.getElementById("refreshSeconds").value),
  };
}

function fmt(n, decimals = 2) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// =========================================================
// CHART RENDERING
// =========================================================
function renderChart(candles, activeFvgs, signal, latestPrice, sessionOpen) {
  const dark = state.chartDark;
  const bg = dark ? "#0e1117" : "#ffffff";
  const grid = dark ? "#262b36" : "#e6e6e6";
  const axisLine = dark ? "#3a3f4b" : "#d9d9d9";
  const fontColor = dark ? "#d1d4dc" : "#131722";

  const pct = state.pctMode;
  const logMode = state.logMode && !pct;
  const toDisp = v => (pct ? (v / sessionOpen - 1) * 100 : v);

  const x = candles.map(c => c.time);
  const openV = candles.map(c => toDisp(c.open));
  const highV = candles.map(c => toDisp(c.high));
  const lowV = candles.map(c => toDisp(c.low));
  const closeV = candles.map(c => toDisp(c.close));
  const volColors = candles.map(c => (c.close >= c.open ? UP_COLOR : DOWN_COLOR));

  const candleTrace = {
    x, open: openV, high: highV, low: lowV, close: closeV,
    type: "candlestick", name: "Gold",
    increasing: { line: { color: UP_COLOR }, fillcolor: UP_COLOR },
    decreasing: { line: { color: DOWN_COLOR }, fillcolor: DOWN_COLOR },
    xaxis: "x", yaxis: "y",
  };

  const volTrace = {
    x, y: candles.map(c => c.volume),
    type: "bar", marker: { color: volColors, opacity: 0.5 },
    xaxis: "x", yaxis: "y2", showlegend: false,
  };

  const shapes = activeFvgs.map(fvg => ({
    type: "rect", xref: "x", yref: "y",
    x0: candles[fvg.formedPos].time, x1: candles[candles.length - 1].time,
    y0: toDisp(fvg.bottom), y1: toDisp(fvg.top),
    fillcolor: fvg.type === "bullish" ? "rgba(0,179,134,0.15)" : "rgba(235,87,87,0.12)",
    line: { color: fvg.type === "bullish" ? UP_COLOR : DOWN_COLOR, width: 1 },
  }));

  const dispPrice = toDisp(latestPrice);
  const change = latestPrice - sessionOpen;
  shapes.push({
    type: "line", xref: "paper", yref: "y", x0: 0, x1: 1, y0: dispPrice, y1: dispPrice,
    line: { color: "#9aa0a6", width: 1, dash: "dot" },
  });

  const priceLabel = pct ? `${fmt(dispPrice, 2)}%` : fmt(dispPrice, 3);

  const layout = {
    height: 520,
    margin: { l: 10, r: 65, t: 20, b: 10 },
    plot_bgcolor: bg, paper_bgcolor: bg,
    font: { color: fontColor, size: 12 },
    hovermode: "x unified", showlegend: false,
    dragmode: state.dragMode,
    uirevision: `epoch-${state.zoomEpoch}`,
    bargap: 0.2,
    shapes,
    annotations: [{
      x: 1, xref: "paper", y: dispPrice, yref: "y", xanchor: "left",
      text: priceLabel, showarrow: false,
      bgcolor: change >= 0 ? UP_COLOR : DOWN_COLOR, font: { color: "white", size: 12 },
      bordercolor: "rgba(0,0,0,0)",
    }],
    grid: { rows: 2, columns: 1, pattern: "independent" },
    xaxis: {
      domain: [0, 1], anchor: "y", showgrid: true, gridcolor: grid, showline: true,
      linecolor: axisLine, fixedrange: false,
      rangeslider: { visible: true, thickness: 0.06 },
      matches: "x2",
    },
    yaxis: {
      domain: [0.24, 1], side: "right", showgrid: true, gridcolor: grid,
      showline: true, linecolor: axisLine, fixedrange: false,
      type: logMode ? "log" : "linear",
      ticksuffix: pct ? "%" : "",
    },
    xaxis2: { domain: [0, 1], anchor: "y2", showgrid: true, gridcolor: grid, showline: true, linecolor: axisLine },
    yaxis2: { domain: [0, 0.2], side: "right", showticklabels: false, fixedrange: true },
  };

  const config = {
    scrollZoom: true, displaylogo: false,
    modeBarButtonsToAdd: ["drawline", "drawopenpath", "drawclosedpath", "drawcircle", "drawrect", "eraseshape"],
  };

  Plotly.react("priceChart", [candleTrace, volTrace], layout, config);
}

// =========================================================
// MAIN UPDATE CYCLE
// =========================================================
async function updateDashboard() {
  const timestamp = document.getElementById("timestamp");
  try {
    const minutesPerCandle = GRANULARITY_MINUTES[state.granularity];
    const count = Math.min(5000, Math.max(50, Math.ceil((state.rangeDays * 1440) / minutesPerCandle)));

    const [candles, gbpRate] = await Promise.all([
      fetchCandles(state.granularity, count),
      fetchGbpRate(),
    ]);
    state.candles = candles;
    state.gbpRate = gbpRate;

    const settings = getSettings();
    const fvgs = detectFVGs(candles, settings.fvgLookback, settings.minGap);
    const activeFvgs = filterUnmitigated(candles, fvgs);
    const { signal, chosen } = generateSignal(candles, activeFvgs);

    const latestPrice = candles[candles.length - 1].close;
    const sessionOpen = candles[0].open;
    const atrArr = computeATR(candles);
    const latestAtr = atrArr[atrArr.length - 1];

    const plan = calculateTradePlan(signal, latestPrice, chosen, latestAtr, gbpRate, settings);

    renderChart(candles, activeFvgs, signal, latestPrice, sessionOpen);

    // ---- Signal panel ----
    const badge = document.getElementById("signalBadge");
    badge.textContent = signal;
    badge.className = "signal-badge " + (signal === "BUY" ? "signal-buy" : signal === "SELL" ? "signal-sell" : "signal-hold");
    document.getElementById("priceUsd").textContent = `$${fmt(latestPrice)}`;
    document.getElementById("fvgCount").textContent = activeFvgs.length;
    document.getElementById("gbpRate").textContent = fmt(gbpRate, 4);

    const signalInfo = document.getElementById("signalInfo");
    if (signal === "HOLD" && chosen) {
      const mid = (chosen.top + chosen.bottom) / 2;
      signalInfo.style.display = "block";
      signalInfo.textContent = `Nearest unfilled ${chosen.type} gap ≈ $${fmt(Math.abs(latestPrice - mid))} away.`;
    } else if (signal === "HOLD") {
      signalInfo.style.display = "block";
      signalInfo.textContent = "No unfilled Fair Value Gaps nearby — no trade right now.";
    } else {
      signalInfo.style.display = "none";
    }

    // ---- Trade plan panel ----
    const planEl = document.getElementById("tradePlanContent");
    if (plan) {
      planEl.innerHTML = `
        <div class="metric-row">
          <div class="metric"><div class="label">Entry</div><div class="value">$${fmt(plan.entryUsd)}</div></div>
          <div class="metric"><div class="label">Stop Loss</div><div class="value">$${fmt(plan.slUsd)}</div></div>
          <div class="metric"><div class="label">Take Profit</div><div class="value">$${fmt(plan.tpUsd)}</div></div>
        </div>
        <div class="metric-row">
          <div class="metric"><div class="label">✅ Recommended Lot</div><div class="value">${plan.recommendedLot}</div></div>
          <div class="metric"><div class="label">Risking (£)</div><div class="value">£${fmt(plan.riskAmountGbp)}</div></div>
          <div class="metric"><div class="label">Target Reward (£)</div><div class="value">£${fmt(plan.rewardAmountGbp)}</div></div>
        </div>`;
    } else {
      planEl.innerHTML = `<div class="info-box">No active trade plan right now — signal is HOLD.</div>`;
    }

    // ---- What-if simulator (live price link) ----
    document.getElementById("whatIfLivePrice").textContent =
      `Linked to the live Gold price: $${fmt(latestPrice)} (£${fmt(usdToGbp(latestPrice, gbpRate))})`;
    if (!document.getElementById("wfStop").dataset.userEdited) {
      document.getElementById("wfStop").value = latestAtr ? fmt(latestAtr, 2) : 5;
    }
    updateWhatIf();

    timestamp.textContent = `📡 Updated ${new Date().toLocaleTimeString()} • ${state.granularity}`;
  } catch (err) {
    timestamp.textContent = `⚠️ Error: ${err.message}`;
    console.error(err);
  }
}

function updateWhatIf() {
  const deposit = parseFloat(document.getElementById("wfDeposit").value);
  const riskPct = parseFloat(document.getElementById("wfRisk").value);
  const rr = parseFloat(document.getElementById("wfRR").value);
  const stopUsd = parseFloat(document.getElementById("wfStop").value);
  const rate = state.gbpRate;

  const riskAmountUsd = deposit * (riskPct / 100) * rate;
  const recommendedLot = Math.round(Math.max(riskAmountUsd / (stopUsd * 100), 0.01) * 100) / 100;

  const lotInput = document.getElementById("wfLot");
  document.getElementById("wfLotLabel").textContent = lotInput.value;
  const lot = parseFloat(lotInput.value);

  const lossUsd = stopUsd * 100 * lot;
  const profitUsd = stopUsd * rr * 100 * lot;

  document.getElementById("wfRecommended").textContent = recommendedLot;
  document.getElementById("wfLoss").textContent = `£${fmt(usdToGbp(lossUsd, rate))}`;
  document.getElementById("wfProfit").textContent = `£${fmt(usdToGbp(profitUsd, rate))}`;

  const warning = document.getElementById("wfWarning");
  if (lot > recommendedLot * 1.5) {
    warning.style.display = "block";
    warning.textContent = `This lot size risks more than your ${riskPct}% setting suggests (recommended: ${recommendedLot}).`;
  } else {
    warning.style.display = "none";
  }
}

// =========================================================
// EVENT WIRING
// =========================================================
function restartAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  const seconds = parseInt(document.getElementById("refreshSeconds").value) || 60;
  state.refreshTimer = setInterval(updateDashboard, seconds * 1000);
}

document.getElementById("timeframeSelect").addEventListener("change", e => {
  state.granularity = e.target.value;
  updateDashboard();
});

document.getElementById("refreshBtn").addEventListener("click", updateDashboard);

document.getElementById("chartThemeBtn").addEventListener("click", () => {
  state.chartDark = !state.chartDark;
  updateDashboard();
});

document.querySelectorAll(".rangeBtn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".rangeBtn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.rangeDays = parseInt(btn.dataset.range);
    updateDashboard();
  });
});

document.getElementById("logBtn").addEventListener("click", () => {
  state.logMode = !state.logMode;
  document.getElementById("logBtn").classList.toggle("active", state.logMode);
  updateDashboard();
});

document.getElementById("pctBtn").addEventListener("click", () => {
  state.pctMode = !state.pctMode;
  document.getElementById("pctBtn").classList.toggle("active", state.pctMode);
  updateDashboard();
});

document.getElementById("resetZoomBtn").addEventListener("click", () => {
  state.zoomEpoch += 1;
  updateDashboard();
});

document.querySelectorAll(".toolbar-left button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".toolbar-left button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.dragMode = btn.dataset.mode;
    Plotly.relayout("priceChart", { dragmode: state.dragMode });
  });
});

document.getElementById("wfStop").addEventListener("input", e => {
  e.target.dataset.userEdited = "true";
  updateWhatIf();
});
["wfDeposit", "wfRisk", "wfRR", "wfLot"].forEach(id => {
  document.getElementById(id).addEventListener("input", updateWhatIf);
});

document.getElementById("refreshSeconds").addEventListener("change", restartAutoRefresh);
["accountBalance", "riskPercent", "rewardRisk", "atrBuffer", "fvgLookback", "minGap"].forEach(id => {
  document.getElementById(id).addEventListener("change", updateDashboard);
});

// ---- Live clock ----
setInterval(() => {
  document.getElementById("clock").textContent = new Date().toUTCString().split(" ")[4] + " (UTC)";
}, 1000);

// ---- Init ----
updateDashboard();
restartAutoRefresh();
