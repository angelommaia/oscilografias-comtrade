/** Aba "Cursores": valores em C1 e C2, diferenças e estatísticas entre eles. */
import { escapeHtml, fmtNum } from "../../core/bus.js";
import { formatTime } from "../../api.js";

const MODE_KEY = "oscilo.analysis.cursors.mode";
const MODES = [
  { id: "rms", label: "RMS" },
  { id: "phasor", label: "Fasor" },
  { id: "value", label: "Instantâneo" },
];

export default {
  id: "cursors",
  title: "Cursores",
  analysisId: "cursors",
  refetchOn: ["cursors", "channels", "record"],
  range: "none",

  paramVisibility() {
    return { t1: false, t2: false };
  },

  precheck(body, ctx) {
    const c = ctx.fixedCursors;
    if (c.c1 == null && c.c2 == null) {
      return "Fixe os cursores: passe o mouse sobre a oscilografia e tecle 1 (C1) e 2 (C2), ou use os botões C1/C2 da barra. Depois arraste as linhas para ajustar.";
    }
    if (!body.channels.length) return "Selecione canais na barra lateral.";
    return null;
  },

  create(root, ctx) {
    let mode = "rms";
    try {
      mode = localStorage.getItem(MODE_KEY) || "rms";
    } catch {
      /* ignora */
    }
    root.innerHTML = `
      <div class="cur-head"></div>
      <div class="imp-controls">
        <div class="imp-loops">${MODES.map((m) => `<label class="imp-chip"><input type="radio" name="curmode" value="${m.id}" ${m.id === mode ? "checked" : ""}/> ${m.label}</label>`).join("")}</div>
      </div>
      <div class="hm-wrap cur-wrap"></div>
      <p class="an-empty hidden"></p>
    `;
    const head = root.querySelector(".cur-head");
    const wrap = root.querySelector(".cur-wrap");
    const emptyEl = root.querySelector(".an-empty");
    let panelRef = null;
    let last = null;

    root.querySelector(".imp-controls").addEventListener("change", (e) => {
      mode = e.target.value;
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch {
        /* ignora */
      }
      if (last) draw();
    });
    root.addEventListener("click", (e) => {
      const t = e.target.closest("[data-goto]");
      if (t) ctx.setCursor(Number(t.dataset.goto));
    });

    function cell(at, unit, kind) {
      if (!at) return "—";
      if (kind === "digital") return String(at.value);
      if (mode === "value") return fmtNum(at.value, { unit, si: true });
      if (mode === "rms") return fmtNum(at.rms, { unit, si: true });
      if (at.mag == null) return "—";
      return `${fmtNum(at.mag, { unit, si: true })}<br><span class="muted">∠ ${fmtNum(at.ang_rel, { decimals: 1 })}°</span>`;
    }

    function deltaCell(r) {
      if (r.kind === "digital" || !r.delta) return "—";
      if (mode === "phasor") {
        return `${fmtNum(r.delta.mag, { unit: r.unit, si: true })}${r.delta.ang != null ? `<br><span class="muted">${fmtNum(r.delta.ang, { decimals: 1 })}°</span>` : ""}`;
      }
      return fmtNum(mode === "value" ? r.delta.value : r.delta.rms, { unit: r.unit, si: true });
    }

    function intervalCell(r) {
      const iv = r.interval;
      if (!iv) return "—";
      if (r.kind === "digital") {
        return iv.changes ? `${iv.changes} mudança(s)` : "sem mudança";
      }
      return `<span title="Máx ${fmtNum(iv.max, { unit: r.unit, si: true })} · Mín ${fmtNum(iv.min, { unit: r.unit, si: true })} · Média ${fmtNum(iv.mean, { unit: r.unit, si: true })}">pico ${fmtNum(iv.peak, { unit: r.unit, si: true })}<br><span class="muted">RMS ${fmtNum(iv.rms, { unit: r.unit, si: true })}</span></span>`;
    }

    function draw() {
      const res = last;
      const t = (v, cls, label) => (v == null ? `<span class="cur-tag ${cls}">${label} —</span>` : `<button type="button" class="cur-tag ${cls}" data-goto="${v}" title="Ir para ${label}">${label} ${formatTime(v)}</button>`);
      head.innerHTML = `
        ${t(res.t1, "c1", "C1")} ${t(res.t2, "c2", "C2")}
        ${res.dt != null ? `<span class="cur-dt">Δt = <b>${fmtNum(res.dt * 1e3, { decimals: 2 })} ms</b> · ${fmtNum(res.dt_cycles, { decimals: 2 })} ciclos · ${fmtNum(res.freq_hz, { decimals: 2 })} Hz</span>` : ""}`;
      const rows = res.channels.map((r) => `
        <tr>
          <td title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>
          <td class="num">${cell(r.at[0], r.unit, r.kind)}</td>
          <td class="num">${cell(r.at[1], r.unit, r.kind)}</td>
          <td class="num">${deltaCell(r)}</td>
          <td class="num">${intervalCell(r)}</td>
        </tr>`).join("");
      wrap.innerHTML = `
        <table class="phasor-table cur-table">
          <thead><tr><th>Canal</th><th class="num">C1</th><th class="num">C2</th><th class="num">Δ (C2−C1)</th><th class="num">Entre C1 e C2</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="muted hm-note">${mode === "value" ? "Valor da amostra mais próxima do cursor." : `Janela de ${fmtNum(res.window_cycles, { decimals: 1 })} ciclo(s) terminando no cursor.`}
        ${mode === "phasor" ? " Ângulos relativos ao primeiro canal analógico da lista." : ""}
        Clique em C1/C2 para levar o cursor até eles.</p>`;
    }

    return {
      bindPanel(panel) {
        panelRef = panel;
      },
      extraRequest() {
        const c = ctx.fixedCursors;
        return {
          channels: ctx.selectedChannels().slice(0, 64),
          params: { ...(panelRef?.params || {}), t1: c.c1, t2: c.c2 },
        };
      },
      render(res) {
        emptyEl.classList.add("hidden");
        last = res;
        draw();
      },
      clear(message) {
        last = null;
        head.innerHTML = "";
        wrap.innerHTML = "";
        emptyEl.textContent = message;
        emptyEl.classList.remove("hidden");
      },
    };
  },
};
