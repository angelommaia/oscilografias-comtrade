import { T as TH } from "./core/theme.js";

export function drawAnalogWaveform(canvas, times, values, options = {}) {
  // yFixed: [lo, hi] da escala vertical exata (zoom por retângulo); o que sair dela é cortado
  const { color = TH.waveAnalog, yMin, yMax, yFixed = null, viewStart, viewEnd, unit = "" } = options;
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
  let lo;
  let hi;
  if (yFixed && yFixed[1] > yFixed[0]) {
    [lo, hi] = yFixed;
  } else {
    const vMin = yMin ?? dataMin;
    const vMax = yMax ?? dataMax;
    const pad = Math.max((vMax - vMin) * 0.06, Math.abs(vMax) * 0.02, 0.01);
    lo = Math.min(vMin, dataMin) - pad;
    hi = Math.max(vMax, dataMax) + pad;
  }
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
  return { lo, hi };
}

export function drawDigitalWaveform(canvas, times, values, options = {}) {
  const { color = TH.waveDigital, viewStart, viewEnd } = options;
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

/** Faixa com vários canais analógicos sobrepostos, em até 2 eixos (esquerda e
 * direita). Cada série: {times, values, color, axis: 0|1, factor} (factor
 * converte para a unidade-base do eixo, ex.: kV → V). Cada eixo: {unit, yMin,
 * yMax (faixa sugerida já na unidade-base), yFixed: [lo, hi] | null}.
 * Devolve a escala usada em cada eixo: [{lo, hi}]. */
export function drawMultiAnalog(canvas, seriesList, options = {}) {
  const { viewStart, viewEnd, axes = [] } = options;
  const ctx = setupCanvas(canvas);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!seriesList.length || w <= 0 || h <= 0) return [];
  const minT = viewStart ?? Math.min(...seriesList.map((s) => s.times[0] ?? 0));
  const maxT = viewEnd ?? Math.max(...seriesList.map((s) => s.times[s.times.length - 1] ?? 1));
  const spanT = maxT - minT || 1;

  const scales = axes.map((ax, a) => {
    if (ax.yFixed && ax.yFixed[1] > ax.yFixed[0]) return { lo: ax.yFixed[0], hi: ax.yFixed[1] };
    let dMin = Infinity;
    let dMax = -Infinity;
    for (const sr of seriesList) {
      if (sr.axis !== a) continue;
      const f = sr.factor || 1;
      for (const v of sr.values) {
        if (v == null || !Number.isFinite(v)) continue;
        if (v * f < dMin) dMin = v * f;
        if (v * f > dMax) dMax = v * f;
      }
    }
    if (!Number.isFinite(dMin)) { dMin = 0; dMax = 1; }
    const vMin = ax.yMin ?? dMin;
    const vMax = ax.yMax ?? dMax;
    const pad = Math.max((vMax - vMin) * 0.06, Math.abs(vMax) * 0.02, 0.01);
    return { lo: Math.min(vMin, dMin) - pad, hi: Math.max(vMax, dMax) + pad };
  });

  ctx.clearRect(0, 0, w, h);
  drawGrid(ctx, w, h);
  seriesList.forEach((sr, idx) => {
    const sc = scales[sr.axis] || scales[0];
    strokeSeries(ctx, sr.times, sr.values, {
      minT, maxT, spanT, w, h, lo: sc.lo, spanV: sc.hi - sc.lo || 1, factor: sr.factor || 1,
      color: sr.color || TH.palette[idx % TH.palette.length],
    });
  });
  scales.forEach((sc, a) => drawAxisLabels(ctx, w, h, sc.lo, sc.hi, axes[a]?.unit || "", a === 1 ? "right" : "left"));
  return scales;
}

function strokeSeries(ctx, times, values, o) {
  const { minT, maxT, spanT, w, h, lo, spanV, factor, color } = o;
  const yOf = (v) => h - ((v * factor - lo) / spanV) * h;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    if (t < minT) continue;
    if (t > maxT) {
      if (started && values[i - 1] != null) ctx.lineTo(w, yOf(values[i - 1]));
      break;
    }
    const v = values[i];
    if (v == null || !Number.isFinite(v)) { started = false; continue; }
    const x = ((t - minT) / spanT) * w;
    if (!started) {
      if (i > 0 && times[i - 1] < minT && values[i - 1] != null) {
        const r = (minT - times[i - 1]) / (t - times[i - 1] || 1);
        ctx.moveTo(0, yOf(values[i - 1] + (v - values[i - 1]) * r));
        ctx.lineTo(x, yOf(v));
      } else {
        ctx.moveTo(x, yOf(v));
      }
      started = true;
    } else {
      ctx.lineTo(x, yOf(v));
    }
  }
  ctx.stroke();
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
  ctx.strokeStyle = light ? TH.gridLight : TH.grid;
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
    ctx.strokeStyle = TH.gridStrong;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }
}

function drawAxisLabels(ctx, w, h, lo, hi, unit, side = "left") {
  ctx.fillStyle = TH.axis;
  ctx.font = "10px Segoe UI, sans-serif";
  ctx.textAlign = side === "right" ? "right" : "left";
  ctx.textBaseline = "middle";
  const x = side === "right" ? w - 4 : 4;
  ctx.fillText(`${formatValue(hi)}${unit ? " " + unit : ""}`, x, 10);
  ctx.fillText(`${formatValue(lo)}${unit ? " " + unit : ""}`, x, h - 10);
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
