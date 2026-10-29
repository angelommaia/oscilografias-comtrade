/** Aba "Impedância": plano R-X com trajetória dos laços, ponto no cursor e zonas mho. */
import { escapeHtml, fmtNum } from "../../core/bus.js";
import { formatTime } from "../../api.js";
import { XYPlot } from "../../plots/xyplot.js";
import { LOOP_STYLE, MUTED_INK } from "../colors.js";

const LOOPS = ["AG", "BG", "CG", "AB", "BC", "CA"];
const UI_KEY = "oscilo.analysis.impedance.ui";

function loadUi() {
  const def = {
    loops: { AG: true, BG: true, CG: true, AB: true, BC: true, CA: true },
    untilCursor: false,
    zones: [
      { on: false, reach: 0, label: "Z1" },
      { on: false, reach: 0, label: "Z2" },
      { on: false, reach: 0, label: "Z3" },
    ],
    mta: 80,
  };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(UI_KEY) || "{}") };
  } catch {
    return def;
  }
}

export default {
  id: "impedance",
  title: "Impedância",
  analysisId: "impedance",
  refetchOn: ["selection", "view", "groups", "record"],
  range: "selection-or-view",

  precheck(body) {
    if (!body.voltage_group || !body.current_group) {
      return "Selecione grupos trifásicos de tensão E corrente na barra lateral (seção Fasores).";
    }
    return null;
  },

  paramVisibility(params) {
    const mode = params.k0_mode;
    return {
      r1: mode === "z0z1", x1: mode === "z0z1", r0: mode === "z0z1", x0: mode === "z0z1",
      k0_mag: mode === "k0", k0_ang: mode === "k0",
    };
  },

  create(root, ctx) {
    const ui = loadUi();
    const saveUi = () => {
      try {
        localStorage.setItem(UI_KEY, JSON.stringify(ui));
      } catch {
        /* ignora */
      }
    };

    root.innerHTML = `
      <div class="imp-controls">
        <div class="imp-loops">
          ${LOOPS.map((l) => `<label class="imp-chip"><input type="checkbox" data-loop="${l}" ${ui.loops[l] ? "checked" : ""}/>
            <span class="imp-swatch" style="border-color:${LOOP_STYLE[l].color};border-style:${LOOP_STYLE[l].dash.length ? "dashed" : "solid"}"></span>${l}</label>`).join("")}
        </div>
        <div class="imp-actions">
          <label class="imp-chip" title="Mostra a trajetória apenas até o instante do cursor"><input type="checkbox" class="imp-until" ${ui.untilCursor ? "checked" : ""}/> Até o cursor</label>
          <button type="button" class="btn btn-sm imp-fit" title="Ajustar a todos os pontos (ou duplo clique no gráfico)">Ajustar</button>
          <button type="button" class="btn btn-sm imp-fit-zones" title="Enquadrar zonas e linha">Zonas</button>
        </div>
      </div>
      <details class="imp-zones">
        <summary>Zonas mho e ângulo característico</summary>
        <div class="imp-zones-grid">
          <label>Ângulo (MTA) <input type="number" step="any" class="an-input imp-mta" value="${ui.mta}"/> °</label>
          ${ui.zones.map((z, i) => `<label><input type="checkbox" data-zone-on="${i}" ${z.on ? "checked" : ""}/> ${z.label}
            <input type="number" step="any" min="0" class="an-input" data-zone-reach="${i}" value="${z.reach}"/> Ω</label>`).join("")}
        </div>
      </details>
      <div class="imp-plot-wrap">
        <canvas class="imp-canvas"></canvas>
        <div class="plot-tooltip hidden"></div>
      </div>
      <div class="imp-readout"></div>
      <p class="an-empty hidden"></p>
    `;

    const canvas = root.querySelector(".imp-canvas");
    const tooltip = root.querySelector(".plot-tooltip");
    const readout = root.querySelector(".imp-readout");
    const emptyEl = root.querySelector(".an-empty");
    const plotWrap = root.querySelector(".imp-plot-wrap");
    let result = null;
    let cursorT = ctx.cursorTime;
    let hover = null;

    const plot = new XYPlot(canvas, {
      equalAspect: true,
      xLabel: "R (Ω)",
      yLabel: "X (Ω)",
      onDraw: (g, T) => drawScene(g, T),
      onHover: (world, screen) => onHover(world, screen),
      onClick: () => {
        if (hover) ctx.setCursor(hover.t);
      },
    });

    // ------------------------------------------------------------ controles
    root.querySelector(".imp-loops").addEventListener("change", (e) => {
      const l = e.target.dataset.loop;
      if (!l) return;
      ui.loops[l] = e.target.checked;
      saveUi();
      plot.draw();
      updateReadout();
    });
    root.querySelector(".imp-until").addEventListener("change", (e) => {
      ui.untilCursor = e.target.checked;
      saveUi();
      plot.draw();
    });
    root.querySelector(".imp-fit").addEventListener("click", () => {
      fitAll();
      plot.draw();
    });
    root.querySelector(".imp-fit-zones").addEventListener("click", () => {
      const b = zoneBounds();
      if (b) {
        plot.setDataBounds(b);
        plot.fit();
        plot.draw();
      }
    });
    root.querySelector(".imp-zones").addEventListener("change", (e) => {
      const t = e.target;
      if (t.classList.contains("imp-mta")) ui.mta = Number(t.value) || 0;
      if (t.dataset.zoneOn != null) ui.zones[Number(t.dataset.zoneOn)].on = t.checked;
      if (t.dataset.zoneReach != null) ui.zones[Number(t.dataset.zoneReach)].reach = Math.max(0, Number(t.value) || 0);
      saveUi();
      plot.draw();
    });

    // ------------------------------------------------------------ geometria
    function visibleLoops() {
      return LOOPS.filter((l) => ui.loops[l] && result?.loops[l]);
    }

    /**
     * Enquadramento robusto: usa os quantis 2%–98% de R e X para que pontos
     * espúrios (corrente ~0 após a abertura do disjuntor) não esmaguem a falta.
     */
    function fitAll() {
      if (!result) return;
      const rs = [0];
      const xs = [0];
      for (const l of visibleLoops()) {
        const d = result.loops[l];
        for (let i = 0; i < d.r.length; i += 1) {
          rs.push(d.r[i]);
          xs.push(d.x[i]);
        }
      }
      const q = (arr, p) => {
        const s = [...arr].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
      };
      let xmin = Math.min(0, q(rs, 0.02));
      let xmax = Math.max(0, q(rs, 0.98));
      let ymin = Math.min(0, q(xs, 0.02));
      let ymax = Math.max(0, q(xs, 0.98));
      const zb = zoneBounds();
      if (zb) {
        xmin = Math.min(xmin, zb.xmin); xmax = Math.max(xmax, zb.xmax);
        ymin = Math.min(ymin, zb.ymin); ymax = Math.max(ymax, zb.ymax);
      }
      plot.setDataBounds({ xmin, xmax, ymin, ymax });
      plot.fit();
    }

    function zoneBounds() {
      const pts = [[0, 0]];
      const mta = (ui.mta * Math.PI) / 180;
      for (const z of ui.zones) {
        if (!z.on || !(z.reach > 0)) continue;
        const cx = (z.reach / 2) * Math.cos(mta);
        const cy = (z.reach / 2) * Math.sin(mta);
        const r = z.reach / 2;
        pts.push([cx - r, cy - r], [cx + r, cy + r]);
      }
      if (result?.z1) pts.push([result.z1.r, result.z1.x]);
      if (pts.length < 2) return null;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return { xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys) };
    }

    function nearestByTime(d, t) {
      const ts = d.times;
      if (!ts.length || t == null) return -1;
      let lo = 0, hi = ts.length - 1;
      if (t <= ts[0]) return 0;
      if (t >= ts[hi]) return hi;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ts[mid] <= t) lo = mid; else hi = mid;
      }
      return t - ts[lo] < ts[hi] - t ? lo : hi;
    }

    // ------------------------------------------------------------ desenho
    function drawScene(g, T) {
      if (!result) return;
      const mta = (ui.mta * Math.PI) / 180;

      // zonas mho (círculo pela origem com diâmetro = alcance no ângulo MTA)
      for (const z of ui.zones) {
        if (!z.on || !(z.reach > 0)) continue;
        const cx = (z.reach / 2) * Math.cos(mta);
        const cy = (z.reach / 2) * Math.sin(mta);
        g.strokeStyle = MUTED_INK;
        g.lineWidth = 1.2;
        g.setLineDash([]);
        g.beginPath();
        g.arc(T.x(cx), T.y(cy), (z.reach / 2) * T.scale, 0, Math.PI * 2);
        g.stroke();
        g.fillStyle = MUTED_INK;
        g.font = "10px Segoe UI, sans-serif";
        g.fillText(z.label, T.x(z.reach * Math.cos(mta)) + 4, T.y(z.reach * Math.sin(mta)) - 4);
      }

      // linha (Z1) e ângulo característico
      if (result.z1) {
        g.strokeStyle = "#222";
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(T.x(0), T.y(0));
        g.lineTo(T.x(result.z1.r), T.y(result.z1.x));
        g.stroke();
        g.fillStyle = "#222";
        g.font = "600 10px Segoe UI, sans-serif";
        g.fillText("Z1 linha", T.x(result.z1.r) + 4, T.y(result.z1.x) - 4);
      }

      for (const l of visibleLoops()) {
        const d = result.loops[l];
        const st = LOOP_STYLE[l];
        const limit = ui.untilCursor && cursorT != null ? cursorT : Infinity;
        g.strokeStyle = st.color;
        g.lineWidth = 1.5;
        g.setLineDash(st.dash);
        g.beginPath();
        let started = false;
        let prevT = null;
        const gap = medianStep(d) * 3 + 1e-9;
        let lastI = -1;
        for (let i = 0; i < d.r.length; i += 1) {
          if (d.times[i] > limit) break;
          const x = T.x(d.r[i]);
          const y = T.y(d.x[i]);
          // quebra a linha em lacunas (corrente abaixo do mínimo)
          if (!started || (prevT != null && d.times[i] - prevT > gap)) {
            g.moveTo(x, y);
            started = true;
          } else {
            g.lineTo(x, y);
          }
          prevT = d.times[i];
          lastI = i;
        }
        g.stroke();
        g.setLineDash([]);
        // início (círculo vazado) e fim (quadrado)
        if (d.r.length) {
          g.lineWidth = 1.5;
          g.beginPath();
          g.arc(T.x(d.r[0]), T.y(d.x[0]), 4, 0, Math.PI * 2);
          g.stroke();
          if (lastI > 0) {
            g.fillStyle = st.color;
            g.fillRect(T.x(d.r[lastI]) - 3, T.y(d.x[lastI]) - 3, 6, 6);
          }
        }
      }

      // pontos no cursor (rótulo direto)
      if (cursorT != null) {
        g.font = "600 11px Segoe UI, sans-serif";
        for (const l of visibleLoops()) {
          const d = result.loops[l];
          const i = nearestByTime(d, cursorT);
          if (i < 0 || Math.abs(d.times[i] - cursorT) > 2 * medianStep(d) + 1e-9) continue;
          const x = T.x(d.r[i]);
          const y = T.y(d.x[i]);
          g.fillStyle = "#fff";
          g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
          g.fillStyle = LOOP_STYLE[l].color;
          g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill();
          g.fillStyle = "#2a2a2a";
          g.fillText(l, x + 7, y - 6);
        }
      }

      if (hover) {
        g.strokeStyle = "#2a2a2a";
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(T.x(hover.r), T.y(hover.x), 6, 0, Math.PI * 2);
        g.stroke();
      }
    }

    const stepCache = new WeakMap();
    function medianStep(d) {
      if (stepCache.has(d)) return stepCache.get(d);
      const n = d.times.length;
      const s = n > 1 ? (d.times[n - 1] - d.times[0]) / (n - 1) : 0;
      stepCache.set(d, s);
      return s;
    }

    function onHover(world, screen) {
      if (!world || !result) {
        hover = null;
        tooltip.classList.add("hidden");
        plot.draw();
        return;
      }
      const T = plot.transform();
      let best = null;
      let bestD = 12 * 12;
      const limit = ui.untilCursor && cursorT != null ? cursorT : Infinity;
      for (const l of visibleLoops()) {
        const d = result.loops[l];
        for (let i = 0; i < d.r.length; i += 1) {
          if (d.times[i] > limit) break;
          const dx = T.x(d.r[i]) - screen.x;
          const dy = T.y(d.x[i]) - screen.y;
          const dist = dx * dx + dy * dy;
          if (dist < bestD) {
            bestD = dist;
            best = { loop: l, t: d.times[i], r: d.r[i], x: d.x[i] };
          }
        }
      }
      hover = best;
      if (best) {
        const mag = Math.hypot(best.r, best.x);
        const ang = (Math.atan2(best.x, best.r) * 180) / Math.PI;
        tooltip.innerHTML = `<b>${best.loop}</b> · ${formatTime(best.t)}<br/>
          R = ${fmtNum(best.r)} · X = ${fmtNum(best.x)} ${escapeHtml(result.unit)}<br/>
          |Z| = ${fmtNum(mag)} ∠ ${fmtNum(ang, { decimals: 1 })}°<br/><span class="muted">clique para mover o cursor</span>`;
        tooltip.style.left = `${Math.min(screen.x + 14, canvas.clientWidth - 180)}px`;
        tooltip.style.top = `${Math.max(screen.y - 10, 0)}px`;
        tooltip.classList.remove("hidden");
        canvas.style.cursor = "pointer";
      } else {
        tooltip.classList.add("hidden");
        canvas.style.cursor = "";
      }
      plot.draw();
    }

    function updateReadout() {
      if (!result) {
        readout.innerHTML = "";
        return;
      }
      const rows = [];
      for (const l of visibleLoops()) {
        const d = result.loops[l];
        let r = null, x = null;
        if (cursorT != null) {
          const i = nearestByTime(d, cursorT);
          if (i >= 0 && Math.abs(d.times[i] - cursorT) <= 2 * medianStep(d) + 1e-9) {
            r = d.r[i]; x = d.x[i];
          }
        }
        const mag = r == null ? null : Math.hypot(r, x);
        const ang = r == null ? null : (Math.atan2(x, r) * 180) / Math.PI;
        rows.push(`<tr><td><span class="imp-swatch" style="border-color:${LOOP_STYLE[l].color};border-style:${LOOP_STYLE[l].dash.length ? "dashed" : "solid"}"></span>${l}</td>
          <td class="num">${fmtNum(r)}</td><td class="num">${fmtNum(x)}</td><td class="num">${fmtNum(mag)}</td>
          <td class="num">${ang == null ? "—" : `${fmtNum(ang, { decimals: 1 })}°`}</td></tr>`);
      }
      const k0 = result.k0;
      readout.innerHTML = `
        <table class="phasor-table">
          <thead><tr><th>Laço${cursorT != null ? ` @ ${formatTime(cursorT)}` : ""}</th><th class="num">R</th><th class="num">X</th><th class="num">|Z| (${escapeHtml(result.unit)})</th><th class="num">∠Z</th></tr></thead>
          <tbody>${rows.join("")}</tbody>
        </table>
        <div class="pd-extras">
          <span>k0 = ${fmtNum(k0.mag, { decimals: 3 })} ∠ ${fmtNum(k0.ang, { decimals: 1 })}°</span>
          <span>I mín. = ${fmtNum(result.min_current_a, { unit: "A" })}</span>
          ${result.side === "secondary" ? `<span>RTC/RTP = ${fmtNum(result.ratio, { decimals: 4 })}</span>` : ""}
        </div>`;
    }

    return {
      render(res) {
        const first = !result;
        result = res;
        emptyEl.classList.add("hidden");
        plotWrap.classList.remove("hidden");
        plot.opts.xLabel = `R (${res.unit})`;
        plot.opts.yLabel = `X (${res.unit})`;
        if (first || !plot.userZoomed) fitAll();
        plot.draw();
        updateReadout();
      },
      clear(message) {
        result = null;
        plotWrap.classList.add("hidden");
        readout.innerHTML = "";
        emptyEl.textContent = message;
        emptyEl.classList.remove("hidden");
      },
      onCursor(t) {
        cursorT = t;
        if (result) {
          plot.draw();
          updateReadout();
        }
      },
      resize() {
        plot.draw();
      },
    };
  },
};
