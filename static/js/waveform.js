export function drawAnalogWaveform(canvas, times, values, options = {}) {
  const { color = "#3a6ea5", yMin, yMax, viewStart, viewEnd, unit = "" } = options;
  const ctx = setupCanvas(canvas);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!times.length || w <= 0 || h <= 0) return;

  const minT = viewStart ?? times[0];
  const maxT = viewEnd ?? times[times.length - 1];
  const spanT = maxT - minT || 1;

  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    if (v < dataMin) dataMin = v;
    if (v > dataMax) dataMax = v;
  }
  if (!Number.isFinite(dataMin)) {
    dataMin = 0;
    dataMax = 1;
  }
  const vMin = yMin ?? dataMin;
  const vMax = yMax ?? dataMax;
  const pad = Math.max((vMax - vMin) * 0.06, Math.abs(vMax) * 0.02, 0.01);
  const lo = Math.min(vMin, dataMin) - pad;
  const hi = Math.max(vMax, dataMax) + pad;
  const spanV = hi - lo || 1;

  ctx.clearRect(0, 0, w, h);
  drawGrid(ctx, w, h);

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  let started = false;
  let lastX = null;

  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    const x = ((t - minT) / spanT) * w;

    if (t < minT) continue;
    if (t > maxT) {
      if (started && lastX != null) {
        const y = h - ((values[i - 1] - lo) / spanV) * h;
        ctx.lineTo(w, y);
      }
      break;
    }

    if (values[i] == null || !Number.isFinite(values[i])) {
      started = false; // lacuna (ex.: janela fasorial incompleta)
      continue;
    }
    const y = h - ((values[i] - lo) / spanV) * h;
    if (!started) {
      if (i > 0 && times[i - 1] < minT && values[i - 1] != null) {
        const t0 = times[i - 1];
        const v0 = values[i - 1];
        const t1 = times[i];
        const v1 = values[i];
        const ratio = (minT - t0) / (t1 - t0 || 1);
        const vEdge = v0 + (v1 - v0) * ratio;
        ctx.moveTo(0, h - ((vEdge - lo) / spanV) * h);
      } else {
        ctx.moveTo(x, y);
      }
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
    lastX = x;
  }
  ctx.stroke();

  drawAxisLabels(ctx, w, h, lo, hi, unit);
}

export function drawDigitalWaveform(canvas, times, values, options = {}) {
  const { color = "#5a8a5a", viewStart, viewEnd } = options;
  const ctx = setupCanvas(canvas);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!times.length || w <= 0 || h <= 0) return;

  const minT = viewStart ?? times[0];
  const maxT = viewEnd ?? times[times.length - 1];
  const spanT = maxT - minT || 1;
  const yCenter = h / 2;
  const barHalf = Math.min(h * 0.38, 22);

  ctx.clearRect(0, 0, w, h);
  drawGrid(ctx, w, h, true);

  // Linha contínua em zero (estado baixo)
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(0, yCenter);
  ctx.lineTo(w, yCenter);
  ctx.stroke();

  // Barras densas quando em 1
  ctx.fillStyle = color;

  let i = 0;
  while (i < times.length) {
    while (i < times.length && values[i] < 0.5) i += 1;
    if (i >= times.length) break;

    const startIdx = i;
    while (i < times.length && values[i] >= 0.5) i += 1;
    const endIdx = Math.min(i, times.length - 1);

    let tStart = times[startIdx];
    let tEnd = i < times.length ? times[i] : times[endIdx];

    if (tEnd < minT || tStart > maxT) continue;

    tStart = Math.max(tStart, minT);
    tEnd = Math.min(tEnd, maxT);
    if (tEnd <= tStart) continue;

    const x1 = ((tStart - minT) / spanT) * w;
    const x2 = ((tEnd - minT) / spanT) * w;
    const width = Math.max(x2 - x1, 2);

    ctx.fillRect(x1, yCenter - barHalf, width, barHalf * 2);
  }
}

export function drawOverlayAnalog(canvas, seriesList, options = {}) {
  const { viewStart, viewEnd } = options;
  const ctx = setupCanvas(canvas);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!seriesList.length) return;

  const minT = viewStart ?? Math.min(...seriesList.flatMap((s) => s.times));
  const maxT = viewEnd ?? Math.max(...seriesList.flatMap((s) => s.times));
  const spanT = maxT - minT || 1;

  ctx.clearRect(0, 0, w, h);
  drawGrid(ctx, w, h);

  const palette = ["#3a6ea5", "#8a5a3a", "#5a8a5a", "#7a3a7a", "#3a7a7a", "#a05a3a"];

  seriesList.forEach((series, idx) => {
    const values = series.values;
    const lo = series.yMin ?? Math.min(...values);
    const hi = series.yMax ?? Math.max(...values);
    const pad = (hi - lo) * 0.1 || 1;
    const yLo = lo - pad;
    const yHi = hi + pad;
    const spanV = yHi - yLo || 1;
    const color = series.color || palette[idx % palette.length];

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    let started = false;

    for (let i = 0; i < series.times.length; i += 1) {
      const t = series.times[i];
      if (t < minT || t > maxT) continue;
      const x = ((t - minT) / spanT) * w;
      const y = h - ((values[i] - yLo) / spanV) * h;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  });
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function drawGrid(ctx, w, h, light = false) {
  ctx.strokeStyle = light ? "#ececec" : "#e4e4e4";
  ctx.lineWidth = 1;
  const rows = 4;
  for (let i = 1; i < rows; i += 1) {
    const y = (h / rows) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (light) {
    ctx.strokeStyle = "#ddd";
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }
}

function drawAxisLabels(ctx, w, h, lo, hi, unit) {
  ctx.fillStyle = "#888";
  ctx.font = "10px Segoe UI, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(`${formatValue(hi)}${unit ? " " + unit : ""}`, 4, 10);
  ctx.fillText(`${formatValue(lo)}${unit ? " " + unit : ""}`, 4, h - 10);
}

function formatValue(v) {
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(1);
  if (abs >= 10) return v.toFixed(2);
  if (abs >= 1) return v.toFixed(3);
  return v.toFixed(4);
}

export function interpolateValue(times, values, time) {
  if (!times.length) return null;
  if (time <= times[0]) return values[0];
  if (time >= times[times.length - 1]) return values[values.length - 1];

  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }

  const t0 = times[lo];
  const t1 = times[hi];
  const v0 = values[lo];
  const v1 = values[hi];
  if (t1 === t0) return v0;
  const ratio = (time - t0) / (t1 - t0);
  return v0 + (v1 - v0) * ratio;
}
