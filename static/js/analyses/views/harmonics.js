/** Aba "Harmônicos": DC, fundamental, % por ordem e DHT da janela analisada. */
import { escapeHtml, fmtNum } from "../../core/bus.js";

const SOURCE_KEY = "oscilo.analysis.harmonics.source";

export default {
  id: "harmonics",
  title: "Harmônicos",
  analysisId: "harmonics",
  refetchOn: ["selection", "cursor", "groups", "channels", "record"],
  range: "selection",

  precheck(body, ctx) {
    if (!body.channels.length && !body.voltage_group && !body.current_group) {
      return "Selecione canais analógicos ou grupos trifásicos.";
    }
    if (ctx.cursorTime == null && !(ctx.selection && ctx.selection.end > ctx.selection.start)) {
      return "Selecione um intervalo (arraste na régua) ou posicione o cursor.";
    }
    return null;
  },

  create(root, ctx) {
    let source = "groups";
    try {
      source = localStorage.getItem(SOURCE_KEY) || "groups";
    } catch {
      /* ignora */
    }
    root.innerHTML = `
      <div class="imp-controls">
        <label class="imp-chip"><input type="radio" name="hsrc" value="groups" ${source === "groups" ? "checked" : ""}/> Grupos V/I</label>
        <label class="imp-chip"><input type="radio" name="hsrc" value="channels" ${source === "channels" ? "checked" : ""}/> Canais exibidos</label>
      </div>
      <div class="hm-wrap"></div>
      <p class="an-empty hidden"></p>
    `;
    const wrap = root.querySelector(".hm-wrap");
    const emptyEl = root.querySelector(".an-empty");
    root.querySelector(".imp-controls").addEventListener("change", (e) => {
      source = e.target.value;
      try {
        localStorage.setItem(SOURCE_KEY, source);
      } catch {
        /* ignora */
      }
      panelRef.onEvent("params");
    });
    let panelRef = null;

    return {
      bindPanel(panel) {
        panelRef = panel;
      },
      extraRequest() {
        if (source === "channels") {
          return { channels: ctx.selectedAnalogChannels().slice(0, 12), voltage_group: null, current_group: null };
        }
        return { channels: [] };
      },
      render(res) {
        emptyEl.classList.add("hidden");
        const chs = res.channels;
        const head = chs.map((c) => `<th class="num" title="${escapeHtml(c.name)}">${escapeHtml(shortName(c.name))}</th>`).join("");
        const fund = chs.map((c) => `<td class="num">${fmtNum(c.harmonics[0]?.rms, { unit: c.unit, si: true })}</td>`).join("");
        const dc = chs.map((c) => `<td class="num">${fmtNum(c.dc, { unit: c.unit, si: true })}</td>`).join("");
        const thd = chs.map((c) => `<td class="num"><b>${fmtNum(c.thd_pct, { decimals: 2 })}%</b></td>`).join("");
        const maxH = Math.max(...chs.map((c) => c.harmonics.length));
        const rows = [];
        for (let h = 2; h <= maxH; h += 1) {
          const cells = chs.map((c) => {
            const item = c.harmonics[h - 1];
            const pct = item?.pct;
            const w = pct == null ? 0 : Math.min(100, pct * 2);
            return `<td class="num hm-cell"><span class="hm-bar" style="width:${w}%"></span><span class="hm-val">${fmtNum(pct, { decimals: 2 })}</span></td>`;
          });
          rows.push(`<tr><td>${h}ª <span class="muted">${fmtNum(h * res.f0, { decimals: 0 })} Hz</span></td>${cells.join("")}</tr>`);
        }
        wrap.innerHTML = `
          <table class="phasor-table hm-table">
            <thead><tr><th>Ordem</th>${head}</tr></thead>
            <tbody>
              <tr><td>DC</td>${dc}</tr>
              <tr><td>Fundamental (RMS)</td>${fund}</tr>
              <tr><td>DHT</td>${thd}</tr>
              <tr class="pd-sec"><th colspan="${chs.length + 1}">% da fundamental (barra: 50% = largura total)</th></tr>
              ${rows.join("")}
            </tbody>
          </table>
          <p class="muted hm-note">${res.samples} amostras. Ajuste por mínimos quadrados – não exige nº inteiro de ciclos.</p>`;
      },
      clear(message) {
        wrap.innerHTML = "";
        emptyEl.textContent = message;
        emptyEl.classList.remove("hidden");
      },
    };
  },
};

function shortName(name) {
  return name.length > 14 ? `${name.slice(0, 13)}…` : name;
}
