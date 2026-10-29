/**
 * Plano XY em canvas com grade, zoom (roda do mouse), pan (arrastar) e
 * ajuste automático (duplo clique). Reutilizável por qualquer análise que
 * desenhe em coordenadas cartesianas (R-X, P-Q, trajetórias, etc.).
 *
 *   const plot = new XYPlot(canvas, {
 *     equalAspect: true, xLabel: "R (Ω)", yLabel: "X (Ω)",
 *     onDraw: (g, T) => { ... T.x(r), T.y(x) ... },
 *     onHover: (world, screen) => {...}, onClick: (world, screen) => {...},
 *   });
 *   plot.setDataBounds({xmin, xmax, ymin, ymax}); plot.fit(); plot.draw();
 */
export class XYPlot {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.opts = { equalAspect: false, xLabel: "", yLabel: "", padding: 0.08, logX: false, logY: false, ...options };
    this.view = { xmin: -1, xmax: 1, ymin: -1, ymax: 1 };
    this.dataBounds = null;
    this.margin = { left: 52, right: 12, top: 10, bottom: 34 };
    this._drag = null;
    this._userZoomed = false;

    canvas.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    canvas.addEventListener("mousedown", (e) => this._onDown(e));
    canvas.addEventListener("mousemove", (e) => this._onMove(e));
    canvas.addEventListener("mouseleave", () => this.opts.onHover?.(null, null));
    window.addEventListener("mouseup", (e) => this._onUp(e));
    canvas.addEventListener("dblclick", () => {
      this._userZoomed = false;
      this.fit();
      this.draw();
    });
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(canvas);
  }

  get userZoomed() {
    return this._userZoomed;
  }

  setDataBounds(bounds) {
    this.dataBounds = bounds;
  }

  fit() {
    const b = this.dataBounds;
    if (!b || !Number.isFinite(b.xmin)) return;
    let { xmin, xmax, ymin, ymax } = b;
    if (this.opts.logX) { xmin = Math.log10(Math.max(xmin, 1e-12)); xmax = Math.log10(Math.max(xmax, 1e-12)); }
    if (this.opts.logY) { ymin = Math.log10(Math.max(ymin, 1e-12)); ymax = Math.log10(Math.max(ymax, 1e-12)); }
    const pad = this.opts.padding;
    let dx = xmax - xmin || Math.abs(xmax) || 1;
    let dy = ymax - ymin || Math.abs(ymax) || 1;
    xmin -= dx * pad; xmax += dx * pad;
    ymin -= dy * pad; ymax += dy * pad;
    this.view = { xmin, xmax, ymin, ymax };
    this._applyAspect();
  }

  setView(view) {
    this.view = { ...view };
    this._applyAspect();
  }

  _plotRect() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const m = this.margin;
    return { x: m.left, y: m.top, w: Math.max(10, w - m.left - m.right), h: Math.max(10, h - m.top - m.bottom), W: w, H: h };
  }

  _applyAspect() {
    if (!this.opts.equalAspect) return;
    const r = this._plotRect();
    const v = this.view;
    const cx = (v.xmin + v.xmax) / 2;
    const cy = (v.ymin + v.ymax) / 2;
    let sx = (v.xmax - v.xmin) / r.w;
    let sy = (v.ymax - v.ymin) / r.h;
    const s = Math.max(sx, sy);
    this.view = {
      xmin: cx - (s * r.w) / 2, xmax: cx + (s * r.w) / 2,
      ymin: cy - (s * r.h) / 2, ymax: cy + (s * r.h) / 2,
    };
  }

  transform() {
    const r = this._plotRect();
    const v = this.view;
    const kx = r.w / (v.xmax - v.xmin || 1);
    const ky = r.h / (v.ymax - v.ymin || 1);
    const fx = this.opts.logX ? (w) => Math.log10(w) : (w) => w;
    const fy = this.opts.logY ? (w) => Math.log10(w) : (w) => w;
    const gx = this.opts.logX ? (u) => 10 ** u : (u) => u;
    const gy = this.opts.logY ? (u) => 10 ** u : (u) => u;
    return {
      rect: r,
      view: v,
      x: (wx) => r.x + (fx(wx) - v.xmin) * kx,
      y: (wy) => r.y + r.h - (fy(wy) - v.ymin) * ky,
      invX: (sx) => gx(v.xmin + (sx - r.x) / kx),
      invY: (sy) => gy(v.ymin + (r.y + r.h - sy) / ky),
      scale: kx,
    };
  }

  draw() {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (W <= 0 || H <= 0) return;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    this._applyAspect();
    const T = this.transform();
    const r = T.rect;

    g.fillStyle = "#fff";
    g.fillRect(r.x, r.y, r.w, r.h);

    // grade
    const xt = this.opts.logX ? logTicks(T.view.xmin, T.view.xmax) : niceTicks(T.view.xmin, T.view.xmax, Math.max(3, Math.floor(r.w / 70)));
    const yt = this.opts.logY ? logTicks(T.view.ymin, T.view.ymax) : niceTicks(T.view.ymin, T.view.ymax, Math.max(3, Math.floor(r.h / 50)));
    g.lineWidth = 1;
    g.font = "10px Segoe UI, sans-serif";
    g.fillStyle = "#666";
    g.textAlign = "center";
    g.textBaseline = "top";
    const xdec = this.opts.logX ? null : stepDecimals(xt);
    const ydec = this.opts.logY ? null : stepDecimals(yt);
    for (const t of xt) {
      const sx = Math.round(T.x(t)) + 0.5;
      g.strokeStyle = t === 0 && !this.opts.logX ? "#9a9a9a" : "#ececec";
      g.beginPath(); g.moveTo(sx, r.y); g.lineTo(sx, r.y + r.h); g.stroke();
      if (!this.opts.logX || isLabelTick(t)) g.fillText(fmtTick(t, xdec), sx, r.y + r.h + 4);
    }
    g.textAlign = "right";
    g.textBaseline = "middle";
    for (const t of yt) {
      const sy = Math.round(T.y(t)) + 0.5;
      g.strokeStyle = t === 0 && !this.opts.logY ? "#9a9a9a" : "#ececec";
      g.beginPath(); g.moveTo(r.x, sy); g.lineTo(r.x + r.w, sy); g.stroke();
      if (!this.opts.logY || isLabelTick(t)) g.fillText(fmtTick(t, ydec), r.x - 4, sy);
    }
    g.strokeStyle = "#c8c8c8";
    g.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);

    g.fillStyle = "#444";
    g.font = "11px Segoe UI, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "bottom";
    g.fillText(this.opts.xLabel, r.x + r.w / 2, T.rect.H - 2);
    g.save();
    g.translate(11, r.y + r.h / 2);
    g.rotate(-Math.PI / 2);
    g.textBaseline = "middle";
    g.fillText(this.opts.yLabel, 0, 0);
    g.restore();

    g.save();
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
    this.opts.onDraw?.(g, T);
    g.restore();
  }

  _local(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _onWheel(e) {
    e.preventDefault();
    const p = this._local(e);
    const T = this.transform();
    const v = this.view;
    // coordenadas no espaço da vista (log10 quando o eixo é logarítmico)
    const wx = v.xmin + ((p.x - T.rect.x) / T.rect.w) * (v.xmax - v.xmin);
    const wy = v.ymin + ((T.rect.y + T.rect.h - p.y) / T.rect.h) * (v.ymax - v.ymin);
    const f = Math.exp(Math.sign(e.deltaY) * 0.18);
    this.view = {
      xmin: wx - (wx - v.xmin) * f, xmax: wx + (v.xmax - wx) * f,
      ymin: wy - (wy - v.ymin) * f, ymax: wy + (v.ymax - wy) * f,
    };
    this._userZoomed = true;
    this.draw();
  }

  _onDown(e) {
    const p = this._local(e);
    this._drag = { start: p, view: { ...this.view }, moved: false };
  }

  _onMove(e) {
    const p = this._local(e);
    if (this._drag) {
      const dxs = p.x - this._drag.start.x;
      const dys = p.y - this._drag.start.y;
      if (Math.abs(dxs) + Math.abs(dys) > 3) this._drag.moved = true;
      if (this._drag.moved) {
        const T = this.transform();
        const k = T.scale;
        const v0 = this._drag.view;
        const kx = (v0.xmax - v0.xmin) / T.rect.w;
        const ky = (v0.ymax - v0.ymin) / T.rect.h;
        this.view = {
          xmin: v0.xmin - dxs * kx, xmax: v0.xmax - dxs * kx,
          ymin: v0.ymin + dys * ky, ymax: v0.ymax + dys * ky,
        };
        void k;
        this._userZoomed = true;
        this.canvas.style.cursor = "grabbing";
        this.draw();
        return;
      }
    }
    const T = this.transform();
    this.opts.onHover?.({ x: T.invX(p.x), y: T.invY(p.y) }, p);
  }

  _onUp(e) {
    if (!this._drag) return;
    const wasMoved = this._drag.moved;
    this._drag = null;
    this.canvas.style.cursor = "";
    if (!wasMoved && e.target === this.canvas) {
      const p = this._local(e);
      const T = this.transform();
      this.opts.onClick?.({ x: T.invX(p.x), y: T.invY(p.y) }, p);
    }
  }

  destroy() {
    this._ro.disconnect();
  }
}

/** Marcas de escala log (1, 2, 5 × 10^n) para limites em log10. */
function logTicks(lmin, lmax) {
  const out = [];
  const many = lmax - lmin > 4;
  for (let e = Math.floor(lmin); e <= Math.ceil(lmax); e += 1) {
    for (const m of many ? [1] : [1, 2, 5]) {
      const v = m * 10 ** e;
      const lv = Math.log10(v);
      if (lv >= lmin - 1e-9 && lv <= lmax + 1e-9) out.push(v);
    }
  }
  return out;
}

function isLabelTick(v) {
  const m = v / 10 ** Math.floor(Math.log10(v) + 1e-9);
  return Math.abs(m - 1) < 1e-6 || Math.abs(m - 2) < 1e-6 || Math.abs(m - 5) < 1e-6;
}

export function niceTicks(min, max, count) {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) {
    ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  }
  return ticks;
}

function stepDecimals(ticks) {
  if (ticks.length < 2) return null;
  const step = Math.abs(ticks[1] - ticks[0]);
  return Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
}

function fmtTick(v, decimals = null) {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (decimals != null && a < 1e4) {
    return v.toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  if (a >= 1e6) return `${(v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}M`;
  if (a >= 1e4) return `${(v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}k`;
  return v.toLocaleString("pt-BR", { maximumFractionDigits: a >= 10 ? 0 : a >= 1 ? 1 : a >= 0.01 ? 3 : 4 });
}
