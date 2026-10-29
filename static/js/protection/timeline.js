/**
 * Linha do tempo de estados (partida, trip, bloqueio) + canais digitais do
 * registro para comparação. Clique move o cursor.
 */
import { formatTime } from "../api.js";
import { niceTicks } from "../plots/xyplot.js";

export const LANE_COLORS = {
  pickup: "#d9952b",
  trip: "#b8471c",
  block: "#6b7a99",
  info: "#a9b6cc",
  digital: "#2f6f4f",
};
const LABEL_W = 170;
const ROW_H = 18;
const AXIS_H = 22;

export class Timeline {
  constructor(canvas, { onClick } = {}) {
    this.canvas = canvas;
    this.onClick = onClick;
    this.data = null;
    this.cursor = null;
    canvas.addEventListener("click", (e) => {
      if (!this.data) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < LABEL_W) return;
      this.onClick?.(this._xToT(x, rect.width));
    });
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(canvas);
  }

  setData(data) {
    this.data = data;
    const rows = (data?.lanes.length || 0) + (data?.digital.length || 0) + (data?.digital.length ? 1 : 0);
    this.canvas.style.height = `${AXIS_H + Math.max(rows, 1) * ROW_H + 6}px`;
    this.draw();
  }

  setCursor(t) {
    this.cursor = t;
    this.draw();
  }

  _tToX(t, w) {
    const { t0, t1 } = this.data;
    return LABEL_W + ((t - t0) / (t1 - t0 || 1)) * (w - LABEL_W - 8);
  }

  _xToT(x, w) {
    const { t0, t1 } = this.data;
    return t0 + ((x - LABEL_W) / (w - LABEL_W - 8)) * (t1 - t0);
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (W <= 0 || H <= 0) return;
    c.width = Math.floor(W * dpr);
    c.height = Math.floor(H * dpr);
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!this.data) return;

    const { t0, t1 } = this.data;
    g.font = "10px Segoe UI, sans-serif";
    g.textBaseline = "middle";

    // eixo de tempo
    const ticks = niceTicks(t0, t1, Math.max(3, Math.floor((W - LABEL_W) / 90)));
    g.fillStyle = "#666";
    g.textAlign = "center";
    for (const t of ticks) {
      const x = this._tToX(t, W);
      g.strokeStyle = "#ececec";
      g.beginPath(); g.moveTo(x, AXIS_H - 4); g.lineTo(x, H); g.stroke();
      g.fillText(formatTime(t), x, 9);
    }

    let y = AXIS_H;
    const drawLane = (lane, sep = false) => {
      if (sep) {
        g.strokeStyle = "#cfcfcf";
        g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke();
        g.fillStyle = "#666";
        g.textAlign = "left";
        g.fillText("Canais digitais do registro", 6, y + ROW_H / 2);
        y += ROW_H;
      }
      g.fillStyle = "#2a2a2a";
      g.textAlign = "left";
      g.fillText(clip(lane.label, 28), 6, y + ROW_H / 2);
      g.fillStyle = "#f3f3f3";
      g.fillRect(LABEL_W, y + 3, W - LABEL_W - 8, ROW_H - 6);
      const color = LANE_COLORS[lane.kind] || LANE_COLORS.info;
      for (const [a, b] of lane.intervals) {
        const x1 = this._tToX(a, W);
        const x2 = Math.max(this._tToX(b, W), x1 + 2);
        g.fillStyle = color;
        g.fillRect(x1, y + 3, x2 - x1, ROW_H - 6);
        if (lane.kind === "block") {
          // hachura: identidade não depende só da cor
          g.save();
          g.beginPath(); g.rect(x1, y + 3, x2 - x1, ROW_H - 6); g.clip();
          g.strokeStyle = "rgba(255,255,255,0.7)";
          for (let hx = x1 - ROW_H; hx < x2; hx += 5) {
            g.beginPath(); g.moveTo(hx, y + ROW_H); g.lineTo(hx + ROW_H, y); g.stroke();
          }
          g.restore();
        }
      }
      y += ROW_H;
    };
    this.data.lanes.forEach((l) => drawLane(l));
    this.data.digital.forEach((l, i) => drawLane(l, i === 0));

    if (this.cursor != null && this.cursor >= t0 && this.cursor <= t1) {
      const x = this._tToX(this.cursor, W);
      g.strokeStyle = "#4a7ab8";
      g.beginPath(); g.moveTo(x + 0.5, AXIS_H - 4); g.lineTo(x + 0.5, H); g.stroke();
    }
  }
}

function clip(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Converte série digital (times/values) em intervalos ativos. */
export function digitalIntervals(times, values) {
  const out = [];
  let start = null;
  for (let i = 0; i < times.length; i += 1) {
    const on = values[i] >= 0.5;
    if (on && start == null) start = times[i];
    if (!on && start != null) {
      out.push([start, times[i]]);
      start = null;
    }
  }
  if (start != null) out.push([start, times[times.length - 1]]);
  return out;
}
