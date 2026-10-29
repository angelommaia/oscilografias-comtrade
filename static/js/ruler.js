import { formatTime } from "./api.js";

export class TimelineRuler {
  constructor(canvas, onInteraction) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onInteraction = onInteraction;
    this.viewStart = 0;
    this.viewEnd = 1;
    this.cursorTime = null;
    this.selection = null;
    this.markers = [];
    this._dragging = null;
    this._dragMoved = false;

    canvas.addEventListener("mousedown", (e) => this._onMouseDown(e));
    window.addEventListener("mousemove", (e) => this._onMouseMove(e));
    window.addEventListener("mouseup", (e) => this._onMouseUp(e));
    canvas.addEventListener("dblclick", (e) => this._onDblClick(e));
  }

  setView(viewStart, viewEnd) {
    this.viewStart = viewStart;
    this.viewEnd = viewEnd;
    this.draw();
  }

  setCursor(time) {
    this.cursorTime = time;
    this.draw();
  }

  setSelection(selection) {
    this.selection = selection;
    this.draw();
  }

  setMarkers(markers) {
    this.markers = markers;
    this.draw();
  }

  timeToX(time, width) {
    const span = this.viewEnd - this.viewStart || 1;
    return ((time - this.viewStart) / span) * width;
  }

  xToTime(x, width) {
    const span = this.viewEnd - this.viewStart || 1;
    return this.viewStart + (x / width) * span;
  }

  draw() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w <= 0 || h <= 0) return;

    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--bg-ruler").trim() || "#d8d8d8";
    ctx.fillRect(0, 0, w, h);

    const span = this.viewEnd - this.viewStart;
    const tickStep = pickTickStep(span, w, span >= 60 ? 105 : 75);
    const firstTick = Math.ceil(this.viewStart / tickStep) * tickStep;

    ctx.strokeStyle = "#999";
    ctx.fillStyle = "#444";
    ctx.font = "11px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let t = firstTick; t <= this.viewEnd + tickStep * 0.001; t += tickStep) {
      const x = this.timeToX(t, w);
      if (x < -20 || x > w + 20) continue;
      ctx.beginPath();
      ctx.moveTo(x, h - 14);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillText(formatTime(t), x, 2);
    }

    ctx.strokeStyle = "#bbb";
    ctx.beginPath();
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(w, h - 0.5);
    ctx.stroke();

    if (this.selection) {
      const x1 = this.timeToX(this.selection.start, w);
      const x2 = this.timeToX(this.selection.end, w);
      ctx.fillStyle = "rgba(74, 122, 184, 0.25)";
      ctx.fillRect(Math.min(x1, x2), 0, Math.abs(x2 - x1), h);
    }

    for (const marker of this.markers) {
      const x = this.timeToX(marker.time, w);
      ctx.strokeStyle = "#c06040";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = "#c06040";
      ctx.textAlign = "left";
      ctx.fillText(marker.label || "M", x + 3, 2);
    }

    if (this.cursorTime != null) {
      const x = this.timeToX(this.cursorTime, w);
      ctx.strokeStyle = "#4a7ab8";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  _localX(e) {
    const rect = this.canvas.getBoundingClientRect();
    return e.clientX - rect.left;
  }

  _onMouseDown(e) {
    const w = this.canvas.getBoundingClientRect().width;
    const time = this.xToTime(this._localX(e), w);
    this._dragging = { mode: "pending", anchor: time, startX: this._localX(e) };
    this._dragMoved = false;
  }

  _onMouseMove(e) {
    if (!this._dragging) return;
    const w = this.canvas.getBoundingClientRect().width;
    const time = this.xToTime(this._localX(e), w);
    const dx = Math.abs(this._localX(e) - this._dragging.startX);

    if (this._dragging.mode === "pending" && dx > 4) {
      this._dragging.mode = "selection";
    }

    if (this._dragging.mode === "selection") {
      this._dragMoved = true;
      this.selection = { start: this._dragging.anchor, end: time };
      this.onInteraction?.({ type: "selection", selection: normalizeSelection(this.selection) });
    } else if (this._dragging.mode === "pending") {
      this.cursorTime = time;
      this.onInteraction?.({ type: "cursor", time });
    }
    this.draw();
  }

  _onMouseUp(e) {
    if (!this._dragging) return;

    if (this._dragging.mode === "pending" && !this._dragMoved) {
      const w = this.canvas.getBoundingClientRect().width;
      const time = this.xToTime(this._localX(e), w);
      this.cursorTime = time;
      this.onInteraction?.({ type: "cursor", time });
      this.draw();
    }

    this._dragging = null;
  }

  _onDblClick(e) {
    const w = this.canvas.getBoundingClientRect().width;
    const time = this.xToTime(this._localX(e), w);
    this.onInteraction?.({ type: "add-marker", time });
  }
}

function normalizeSelection(sel) {
  return {
    start: Math.min(sel.start, sel.end),
    end: Math.max(sel.start, sel.end),
  };
}

function pickTickStep(span, width = 800, labelPx = 75) {
  const candidates = [
    0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
    1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
  ];
  const maxTicks = Math.max(2, Math.floor(width / labelPx));
  for (const step of candidates) {
    if (span / step <= maxTicks) return step;
  }
  return candidates[candidates.length - 1];
}
