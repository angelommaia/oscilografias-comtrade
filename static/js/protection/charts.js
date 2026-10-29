/**
 * Gráficos do modo Proteção:
 *  - plano de impedância R-X (21, 78), plano Idiff × Irest (87T), curvas
 *    tempo-corrente log-log (50/51/67) – todos no XYPlot (zoom/pan/ajuste);
 *  - gráfico auxiliar no tempo (harmônicas, dZ/dt, correntes).
 */
import { escapeHtml, fmtNum } from "../core/bus.js";
import { formatTime } from "../api.js";
import { XYPlot } from "../plots/xyplot.js";
import { LOOP_STYLE, NEUTRAL_INK, PHASE_COLORS } from "../analyses/colors.js";

// Zonas/estágios são ordinais (1 = mais importante): uma rampa de um só matiz,
// do escuro ao claro, sempre com rótulo direto.
const ORDINAL = ["#1f3b73", "#355e9e", "#5a84c2", "#86a8d6", "#a9bfdf"];

function trajStyle(style, key) {
  if (style === "loops") return LOOP_STYLE[key] || { color: NEUTRAL_INK, dash: [] };
  if (style === "phases") return { color: PHASE_COLORS[key] || NEUTRAL_INK, dash: [] };
  return { color: "#222", dash: [] };
}

function nearestByTime(d, t) {
  const ts = d.times;
  if (!ts.length || t == null) return -1;
  let lo = 0;
  let hi = ts.length - 1;
  if (t <= ts[0]) return 0;
  if (t >= ts[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  return t - ts[lo] < ts[hi] - t ? lo : hi;
}

function quantile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

export class MainChart {
  constructor(canvas, tooltip, { onPick } = {}) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.onPick = onPick;
    this.result = null;
    this.cursor = null;
    this.hidden = new Set();
    this.untilCursor = false;
    this.hover = null;
    this._kind = null;
    this.plot = this._makePlot(false);
  }

  _makePlot(log) {
    if (this.plot) {
      // troca o <canvas> para descartar os ouvintes do gráfico anterior
      this.plot.destroy();
      const fresh = this.canvas.cloneNode(false);
      this.canvas.replaceWith(fresh);
      this.canvas = fresh;
    }
    return new XYPlot(this.canvas, {
      equalAspect: false,
      logX: log,
      logY: log,
      onDraw: (g, T) => this._draw(g, T),
      onHover: (w, s) => this._onHover(w, s),
      onClick: () => {
        if (this.hover?.t != null) this.onPick?.(this.hover.t);
      },
    });
  }

  render(result, { refit = false } = {}) {
    const log = !!result.plane?.log;
    const kind = log ? "tcc" : result.plane?.equal ? "rx" : "xy";
    if (kind !== this._kind) {
      this.plot = this._makePlot(log);
      this._kind = kind;
      refit = true;
    }
    this.result = result;
    const pl = result.plane;
    this.plot.opts.equalAspect = !!pl.equal;
    this.plot.opts.xLabel = log ? "Corrente (A prim.)" : `${pl.x} (${pl.unit})`;
    this.plot.opts.yLabel = log ? "Tempo (s)" : `${pl.y} (${pl.unit})`;
    if (refit || !this.plot.userZoomed) this.fit();
    this.plot.draw();
  }

  /** mode: "auto" (zonas/característica quando houver) | "all" (tudo). */
  fit(mode = this.fitMode || "auto") {
    this.fitMode = mode;
    const r = this.result;
    if (!r) return;
    let b;
    if (r.plane.log) {
      const xs = [];
      for (const c of r.curves || []) xs.push(c.pickup_a);
      for (const p of r.points || []) xs.push(p.i_a);
      const lo = Math.min(...xs, Infinity);
      const hi = Math.max(...xs, -Infinity);
      b = Number.isFinite(lo) ? { xmin: lo * 0.6, xmax: Math.max(hi * 3, lo * 40), ymin: 0.01, ymax: 100 } : { xmin: 10, xmax: 1e5, ymin: 0.01, ymax: 100 };
    } else {
      const xs = [0];
      const ys = [0];
      for (const gm of r.geometry || []) {
        if (gm.kind === "load") continue; // regiões de carga vão ao "infinito"
        for (const [x, y] of gm.polygon) {
          if (Math.abs(x) < 1e6 && Math.abs(y) < 1e6) { xs.push(x); ys.push(y); }
        }
      }
      const tx = [];
      const ty = [];
      for (const [k, d] of Object.entries(r.trajectories || {})) {
        if (this.hidden.has(k)) continue;
        tx.push(...d.r);
        ty.push(...d.x);
      }
      const hasGeom = xs.length > 1;
      if (tx.length && (mode === "all" || !hasGeom)) {
        xs.push(quantile(tx, 0.03), quantile(tx, 0.97));
        ys.push(quantile(ty, 0.03), quantile(ty, 0.97));
      } else if (tx.length) {
        // foco na característica: inclui só os pontos até 1,5× a sua extensão
        const ext = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
        const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
        for (let i = 0; i < tx.length; i += 1) {
          if (Math.abs(tx[i] - cx) < ext * 1.5 && Math.abs(ty[i] - cy) < ext * 1.5) { xs.push(tx[i]); ys.push(ty[i]); }
        }
      }
      b = { xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys) };
      if (r.plane.origin) { b.xmin = 0; b.ymin = 0; }
    }
    this.plot.setDataBounds(b);
    this.plot.fit();
  }

  setCursor(t) {
    this.cursor = t;
    this.plot.draw();
  }

  setHidden(set) {
    this.hidden = set;
    this.plot.draw();
  }

  // ------------------------------------------------------------------ desenho
  _draw(g, T) {
    const r = this.result;
    if (!r) return;
    g.textAlign = "left";
    if (r.plane.log) {
      this._drawTcc(g, T);
      return;
    }
    // origem destacada
    const geoms = r.geometry || [];
    const zones = geoms.filter((gm) => gm.kind === "zone");
    const nz = new Map();
    zones.forEach((z) => nz.set(z.zone, true));

    for (const gm of geoms) {
      const pts = gm.polygon;
      if (!pts?.length) continue;
      g.save();
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(T.x(x), T.y(y)) : g.moveTo(T.x(x), T.y(y))));
      if (gm.kind !== "line") g.closePath();
      let label = gm.label;
      if (gm.kind === "zone") {
        const col = ORDINAL[(gm.zone - 1) % ORDINAL.length];
        g.fillStyle = hexA(col, 0.05);
        g.fill();
        g.strokeStyle = col;
        g.lineWidth = gm.zone === 1 ? 2 : 1.5;
        g.setLineDash(gm.loop_type === "phase" ? [5, 3] : []);
        g.stroke();
        label = `${gm.label}${gm.delay ? ` · ${fmtNum(gm.delay, { decimals: 2 })} s` : ""}`;
      } else if (gm.kind === "load") {
        g.fillStyle = "rgba(217,149,43,0.14)";
        g.fill();
        g.strokeStyle = "#c0841f";
        g.setLineDash([4, 3]);
        g.stroke();
      } else if (gm.kind === "blinder_outer" || gm.kind === "blinder_inner") {
        g.strokeStyle = "#555";
        g.lineWidth = gm.kind === "blinder_inner" ? 1.8 : 1.2;
        g.setLineDash(gm.kind === "blinder_outer" ? [6, 4] : []);
        g.stroke();
      } else if (gm.kind === "operate") {
        g.fillStyle = "rgba(184,71,28,0.07)";
        g.fill();
        g.strokeStyle = "#8a3415";
        g.lineWidth = 2;
        g.stroke();
        label = "Operação";
      } else if (gm.kind === "line") {
        g.strokeStyle = "#8a3415";
        g.lineWidth = 1.5;
        g.setLineDash([6, 3]);
        g.stroke();
      }
      g.restore();
      // rótulo direto no vértice mais alto e à direita
      if (label && gm.kind !== "load") {
        let best = pts[0];
        for (const p of pts) if (p[1] + 0.2 * p[0] > best[1] + 0.2 * best[0] && Math.abs(p[0]) < 1e6 && Math.abs(p[1]) < 1e6) best = p;
        g.font = "600 10px Segoe UI, sans-serif";
        g.fillStyle = "#2a2a2a";
        g.fillText(label, T.x(best[0]) + 4, T.y(best[1]) - 4);
      } else if (gm.kind === "load") {
        const p = pts[0];
        g.font = "10px Segoe UI, sans-serif";
        g.fillStyle = "#8a5a00";
        g.fillText(label, T.x(p[0]) + 4, T.y(p[1]) + 12);
      }
    }

    // linha (Z1)
    if (r.line) {
      g.strokeStyle = "#222";
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(T.x(0), T.y(0)); g.lineTo(T.x(r.line.r), T.y(r.line.x)); g.stroke();
      g.font = "600 10px Segoe UI, sans-serif";
      g.fillStyle = "#222";
      g.fillText("Z1 linha", T.x(r.line.r) + 4, T.y(r.line.x) + 12);
    }

    // trajetórias
    const limit = this.untilCursor && this.cursor != null ? this.cursor : Infinity;
    for (const [k, d] of Object.entries(r.trajectories || {})) {
      if (this.hidden.has(k) || !d.r.length) continue;
      const st = trajStyle(r.trajectory_style, k);
      const step = d.times.length > 1 ? (d.times[d.times.length - 1] - d.times[0]) / (d.times.length - 1) : 0;
      g.strokeStyle = st.color;
      g.lineWidth = 1.5;
      g.setLineDash(st.dash);
      g.beginPath();
      let prev = null;
      let last = -1;
      for (let i = 0; i < d.r.length; i += 1) {
        if (d.times[i] > limit) break;
        const x = T.x(d.r[i]);
        const y = T.y(d.x[i]);
        if (prev == null || d.times[i] - prev > step * 3 + 1e-9) g.moveTo(x, y);
        else g.lineTo(x, y);
        prev = d.times[i];
        last = i;
      }
      g.stroke();
      g.setLineDash([]);
      g.beginPath(); g.arc(T.x(d.r[0]), T.y(d.x[0]), 3.5, 0, Math.PI * 2); g.stroke();
      if (last > 0) {
        g.fillStyle = st.color;
        g.fillRect(T.x(d.r[last]) - 3, T.y(d.x[last]) - 3, 6, 6);
      }
    }

    // pontos no cursor (rótulo direto)
    if (this.cursor != null) {
      g.font = "600 11px Segoe UI, sans-serif";
      for (const [k, d] of Object.entries(r.trajectories || {})) {
        if (this.hidden.has(k)) continue;
        const i = nearestByTime(d, this.cursor);
        const step = d.times.length > 1 ? (d.times[d.times.length - 1] - d.times[0]) / (d.times.length - 1) : 0;
        if (i < 0 || Math.abs(d.times[i] - this.cursor) > 2 * step + 1e-9) continue;
        const st = trajStyle(r.trajectory_style, k);
        const x = T.x(d.r[i]);
        const y = T.y(d.x[i]);
        g.fillStyle = "#fff";
        g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
        g.fillStyle = st.color;
        g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = "#2a2a2a";
        g.fillText(k, x + 7, y - 6);
      }
    }
    if (this.hover) {
      g.strokeStyle = "#2a2a2a";
      g.lineWidth = 1.5;
      g.beginPath(); g.arc(T.x(this.hover.x), T.y(this.hover.y), 6, 0, Math.PI * 2); g.stroke();
    }
  }

  _drawTcc(g, T) {
    const r = this.result;
    (r.curves || []).forEach((c, idx) => {
      const col = ORDINAL[idx % ORDINAL.length];
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.setLineDash(c.quantity === "phase" ? [] : c.quantity === "residual" ? [6, 3] : [2, 3]);
      g.beginPath();
      c.points.forEach(([x, y], i) => {
        const sx = T.x(Math.max(x, 1e-9));
        const sy = T.y(Math.min(Math.max(y, 1e-4), 1e4));
        if (i) g.lineTo(sx, sy);
        else g.moveTo(sx, sy);
      });
      g.stroke();
      g.setLineDash([]);
      const lab = c.points[Math.min(c.points.length - 1, Math.floor(c.points.length * 0.15))];
      if (lab) {
        g.font = "600 10px Segoe UI, sans-serif";
        g.fillStyle = "#2a2a2a";
        g.fillText(c.label, T.x(lab[0]) + 4, T.y(Math.min(Math.max(lab[1], 1e-4), 1e4)) - 5);
      }
    });
    // correntes no cursor: retas verticais
    const cur = r.cursor?.currents;
    if (cur && this.cursor != null) {
      g.font = "10px Segoe UI, sans-serif";
      for (const [k, v] of Object.entries(cur)) {
        if (!v) continue;
        const col = { Ia: PHASE_COLORS.A, Ib: PHASE_COLORS.B, Ic: PHASE_COLORS.C }[k] || NEUTRAL_INK;
        g.strokeStyle = col;
        g.setLineDash([2, 3]);
        g.beginPath(); g.moveTo(T.x(v), T.rect.y); g.lineTo(T.x(v), T.rect.y + T.rect.h); g.stroke();
        g.setLineDash([]);
        g.fillStyle = "#2a2a2a";
        g.fillText(k, T.x(v) + 3, T.rect.y + 12);
      }
    }
    // pontos de operação: tempo pela curva (vazado) e simulado (cheio)
    for (const p of r.points || []) {
      g.strokeStyle = "#222";
      g.lineWidth = 1.5;
      g.beginPath(); g.arc(T.x(p.i_a), T.y(Math.max(p.t_curve, 1e-4)), 5, 0, Math.PI * 2); g.stroke();
      if (p.t_sim != null) {
        g.fillStyle = "#b8471c";
        g.beginPath(); g.arc(T.x(p.i_a), T.y(Math.max(p.t_sim, 1e-4)), 4, 0, Math.PI * 2); g.fill();
      }
    }
  }

  _onHover(world, screen) {
    const r = this.result;
    if (!world || !r || r.plane.log) {
      this.hover = null;
      this.tooltip.classList.add("hidden");
      return;
    }
    const T = this.plot.transform();
    let best = null;
    let bestD = 144;
    for (const [k, d] of Object.entries(r.trajectories || {})) {
      if (this.hidden.has(k)) continue;
      for (let i = 0; i < d.r.length; i += 1) {
        const dx = T.x(d.r[i]) - screen.x;
        const dy = T.y(d.x[i]) - screen.y;
        const dist = dx * dx + dy * dy;
        if (dist < bestD) {
          bestD = dist;
          best = { key: k, t: d.times[i], x: d.r[i], y: d.x[i] };
        }
      }
    }
    this.hover = best;
    if (best) {
      const u = escapeHtml(r.plane.unit);
      const extra = r.plane.equal
        ? `|Z| = ${fmtNum(Math.hypot(best.x, best.y))} ∠ ${fmtNum((Math.atan2(best.y, best.x) * 180) / Math.PI, { decimals: 1 })}°`
        : `Idiff/Irest = ${best.x ? fmtNum((best.y / best.x) * 100, { decimals: 1 }) : "—"}%`;
      this.tooltip.innerHTML = `<b>${escapeHtml(best.key)}</b> · ${formatTime(best.t)}<br/>
        ${escapeHtml(r.plane.x)} = ${fmtNum(best.x)} · ${escapeHtml(r.plane.y)} = ${fmtNum(best.y)} ${u}<br/>${extra}<br/>
        <span class="muted">clique para mover o cursor</span>`;
      this.tooltip.style.left = `${Math.min(screen.x + 14, this.canvas.clientWidth - 200)}px`;
      this.tooltip.style.top = `${Math.max(screen.y - 10, 0)}px`;
      this.tooltip.classList.remove("hidden");
      this.canvas.style.cursor = "pointer";
    } else {
      this.tooltip.classList.add("hidden");
      this.canvas.style.cursor = "";
    }
    this.plot.draw();
  }
}

/** Gráfico auxiliar: séries no tempo com limiares opcionais. */
export class SeriesChart {
  constructor(canvas, { onPick } = {}) {
    this.series = [];
    this.thresholds = [];
    this.cursor = null;
    this.range = null;
    this.plot = new XYPlot(canvas, {
      xLabel: "Tempo (s)",
      padding: 0.04,
      onDraw: (g, T) => this._draw(g, T),
      onClick: (w) => onPick?.(w.x),
    });
  }

  render(series, thresholds, yLabel, range) {
    this.series = series || [];
    this.thresholds = thresholds || [];
    this.range = range;
    this.plot.opts.yLabel = yLabel || "";
    let ymin = 0;
    let ymax = 1;
    for (const s of this.series) for (const v of s.values) if (v != null && Number.isFinite(v)) { ymin = Math.min(ymin, v); ymax = Math.max(ymax, v); }
    for (const th of this.thresholds) ymax = Math.max(ymax, th.y * 1.2);
    ymax = Math.min(ymax, Math.max(...this.thresholds.map((t) => t.y * 4), quantileFinite(this.series, 0.995) * 1.15, 1));
    this.plot.setDataBounds({ xmin: range.t0, xmax: range.t1, ymin, ymax });
    this.plot.fit();
    this.plot.draw();
  }

  setCursor(t) {
    this.cursor = t;
    this.plot.draw();
  }

  _draw(g, T) {
    this.series.forEach((s, idx) => {
      const col = s.phase ? PHASE_COLORS[s.phase] : NEUTRAL_INK;
      g.strokeStyle = col;
      g.lineWidth = 1.5;
      g.setLineDash(s.id.startsWith("h5") ? [5, 3] : []);
      g.beginPath();
      let started = false;
      s.times.forEach((t, i) => {
        const v = s.values[i];
        if (v == null || !Number.isFinite(v)) { started = false; return; }
        const x = T.x(t);
        const y = T.y(v);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      });
      g.stroke();
      void idx;
    });
    g.setLineDash([]);
    for (const th of this.thresholds) {
      g.strokeStyle = "#8a3415";
      g.setLineDash([6, 3]);
      g.beginPath(); g.moveTo(T.rect.x, T.y(th.y)); g.lineTo(T.rect.x + T.rect.w, T.y(th.y)); g.stroke();
      g.setLineDash([]);
      g.fillStyle = "#8a3415";
      g.font = "10px Segoe UI, sans-serif";
      g.fillText(th.label, T.rect.x + 4, T.y(th.y) - 3);
    }
    if (this.cursor != null) {
      g.strokeStyle = "#4a7ab8";
      g.beginPath(); g.moveTo(T.x(this.cursor), T.rect.y); g.lineTo(T.x(this.cursor), T.rect.y + T.rect.h); g.stroke();
    }
    // legenda direta
    g.font = "10px Segoe UI, sans-serif";
    let lx = T.rect.x + T.rect.w - 6;
    g.textAlign = "right";
    [...this.series].reverse().forEach((s) => {
      const col = s.phase ? PHASE_COLORS[s.phase] : NEUTRAL_INK;
      const w = g.measureText(s.label).width;
      g.fillStyle = "#2a2a2a";
      g.fillText(s.label, lx, T.rect.y + 12);
      g.fillStyle = col;
      g.fillRect(lx - w - 14, T.rect.y + 8, 10, 3);
      lx -= w + 24;
    });
    g.textAlign = "left";
  }
}

function quantileFinite(series, p) {
  const vals = [];
  for (const s of series) for (const v of s.values) if (v != null && Number.isFinite(v)) vals.push(v);
  return vals.length ? quantile(vals, p) : 1;
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
