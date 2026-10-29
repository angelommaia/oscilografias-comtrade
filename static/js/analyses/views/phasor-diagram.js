/** Aba "Fasores": diagrama fasorial polar no instante do cursor. */
import { escapeHtml, fmtNum } from "../../core/bus.js";
import { MUTED_INK, NEUTRAL_INK, PHASE_COLORS } from "../colors.js";

const HIDDEN_KEY = "oscilo.analysis.phasor.hidden";

export default {
  id: "phasor",
  title: "Fasores",
  analysisId: "phasor_diagram",
  refetchOn: ["cursor", "groups", "record"],
  range: "none",

  precheck(body, ctx) {
    if (ctx.cursorTime == null) return "Posicione o cursor no gráfico (clique na régua ou nas faixas).";
    if (!body.voltage_group && !body.current_group) return "Defina ou selecione um grupo trifásico de tensão ou corrente na barra lateral (seção Fasores).";
    return null;
  },

  create(root) {
    root.innerHTML = `
      <div class="pd-canvas-wrap"><canvas class="pd-canvas"></canvas></div>
      <div class="pd-scale"></div>
      <div class="pd-table-wrap"></div>
      <p class="an-empty hidden"></p>
    `;
    const canvas = root.querySelector(".pd-canvas");
    const scaleEl = root.querySelector(".pd-scale");
    const tableWrap = root.querySelector(".pd-table-wrap");
    const emptyEl = root.querySelector(".an-empty");
    let hidden;
    try {
      hidden = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]"));
    } catch {
      hidden = new Set();
    }
    let last = null;

    const items = () => (last ? [...last.phasors, ...last.sequence.map((s) => ({ ...s, kind: "seq" }))] : []);

    function draw() {
      if (!last) return;
      const visible = items().filter((p) => !hidden.has(p.key) && p.mag != null);
      const scale = drawPolar(canvas, visible);
      scaleEl.innerHTML = scale;
    }

    tableWrap.addEventListener("change", (e) => {
      const key = e.target.dataset.key;
      if (!key) return;
      if (e.target.checked) hidden.delete(key);
      else hidden.add(key);
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
      } catch {
        /* ignora */
      }
      draw();
    });

    return {
      render(result) {
        last = result;
        emptyEl.classList.add("hidden");
        root.querySelector(".pd-canvas-wrap").classList.remove("hidden");
        tableWrap.innerHTML = renderTable(items(), hidden, result.extras);
        draw();
      },
      clear(message) {
        last = null;
        tableWrap.innerHTML = "";
        scaleEl.innerHTML = "";
        root.querySelector(".pd-canvas-wrap").classList.add("hidden");
        emptyEl.textContent = message;
        emptyEl.classList.remove("hidden");
      },
      resize: draw,
    };
  },
};

function styleFor(p) {
  const color = p.kind === "seq" || p.kind === "channel" ? NEUTRAL_INK : PHASE_COLORS[p.phase] || NEUTRAL_INK;
  let dash = p.quantity === "I" ? [6, 4] : [];
  if (p.kind === "line") dash = [2, 3];
  const width = p.kind === "seq" ? 1.6 : 2;
  return { color, dash, width };
}

function drawPolar(canvas, phasors) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (W <= 0 || H <= 0) return "";
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - 26;

  // grade polar
  g.strokeStyle = "#e6e6e6";
  g.lineWidth = 1;
  for (const f of [0.25, 0.5, 0.75, 1]) {
    g.beginPath();
    g.arc(cx, cy, R * f, 0, Math.PI * 2);
    g.stroke();
  }
  g.font = "10px Segoe UI, sans-serif";
  g.fillStyle = MUTED_INK;
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (let a = 0; a < 360; a += 30) {
    const rad = (a * Math.PI) / 180;
    g.strokeStyle = a % 90 === 0 ? "#c9c9c9" : "#efefef";
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + R * Math.cos(rad), cy - R * Math.sin(rad));
    g.stroke();
    const lbl = a > 180 ? a - 360 : a;
    g.fillText(`${lbl}°`, cx + (R + 14) * Math.cos(rad), cy - (R + 14) * Math.sin(rad));
  }

  const maxOf = (q) => Math.max(0, ...phasors.filter((p) => p.quantity === q).map((p) => p.mag));
  const maxV = maxOf("V");
  const maxI = maxOf("I");
  const maxX = maxOf("X");
  const scaleFor = (p) => (p.quantity === "V" ? maxV : p.quantity === "I" ? maxI : maxX) || 1;

  // fasores menores por cima
  // sequência primeiro (fica por baixo), depois maiores → menores
  const ordered = [...phasors].sort((a, b) => {
    const sa = a.kind === "seq" ? 0 : 1;
    const sb = b.kind === "seq" ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return b.mag / scaleFor(b) - a.mag / scaleFor(a);
  });
  const labels = [];
  for (const p of ordered) {
    const r = (p.mag / scaleFor(p)) * R;
    const rad = (p.ang * Math.PI) / 180;
    const x = cx + r * Math.cos(rad);
    const y = cy - r * Math.sin(rad);
    const st = styleFor(p);
    g.strokeStyle = st.color;
    g.fillStyle = st.color;
    g.lineWidth = st.width;
    g.setLineDash(st.dash);
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(x, y);
    g.stroke();
    g.setLineDash([]);
    if (r > 6) {
      const head = 8;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - head * Math.cos(rad - 0.4), y + head * Math.sin(rad - 0.4));
      g.lineTo(x - head * Math.cos(rad + 0.4), y + head * Math.sin(rad + 0.4));
      g.closePath();
      g.fill();
    }
    if (r >= 12) {
      // rótulos de sequência deslocados na perpendicular para não colidir com a fase
      const off = p.kind === "seq" ? 12 : 0;
      labels.push({
        text: p.label,
        x: cx + (r + 10) * Math.cos(rad) + off * Math.sin(rad),
        y: cy - (r + 10) * Math.sin(rad) + off * Math.cos(rad),
      });
    }
  }

  // rótulos diretos com fundo para legibilidade
  g.font = "600 11px Segoe UI, sans-serif";
  for (const l of labels) {
    const w = g.measureText(l.text).width + 6;
    g.fillStyle = "rgba(255,255,255,0.85)";
    g.fillRect(l.x - w / 2, l.y - 7, w, 14);
    g.fillStyle = "#2a2a2a";
    g.fillText(l.text, l.x, l.y);
  }

  const parts = [];
  if (maxV) parts.push(`<span><b>V</b> (contínuo): anel externo = ${fmtNum(maxV, { unit: "V", si: true })}</span>`);
  if (maxI) parts.push(`<span><b>I</b> (tracejado): anel externo = ${fmtNum(maxI, { unit: "A", si: true })}</span>`);
  return parts.join("");
}

function renderTable(items, hidden, extras) {
  const sections = [
    { title: "Tensões", filter: (p) => p.kind !== "seq" && p.quantity === "V" },
    { title: "Correntes", filter: (p) => p.kind !== "seq" && p.quantity === "I" },
    { title: "Canais", filter: (p) => p.kind === "channel" && p.quantity === "X" },
    { title: "Componentes simétricas", filter: (p) => p.kind === "seq" },
  ];
  const rows = [];
  for (const sec of sections) {
    const list = items.filter(sec.filter);
    if (!list.length) continue;
    rows.push(`<tr class="pd-sec"><th colspan="3">${sec.title}</th></tr>`);
    for (const p of list) {
      const st = styleFor(p);
      const swatch = `<span class="pd-swatch" style="border-color:${st.color};border-style:${p.quantity === "I" ? "dashed" : p.kind === "line" ? "dotted" : "solid"}"></span>`;
      rows.push(`<tr>
        <td><label class="pd-row-label"><input type="checkbox" data-key="${p.key}" ${hidden.has(p.key) ? "" : "checked"}/>${swatch}${escapeHtml(p.label)}</label></td>
        <td class="num">${fmtNum(p.mag, { unit: p.unit, si: true })}</td>
        <td class="num">${p.ang == null ? "—" : `${fmtNum(p.ang, { decimals: 1 })}°`}</td>
      </tr>`);
    }
  }
  const ex = [];
  if (extras) {
    if (extras.p_w != null) ex.push(`P = ${fmtNum(extras.p_w, { unit: "W", si: true })}`);
    if (extras.q_var != null) ex.push(`Q = ${fmtNum(extras.q_var, { unit: "var", si: true })}`);
    if (extras.fp != null) ex.push(`FP = ${fmtNum(extras.fp, { decimals: 3 })}`);
    if (extras.v2_v1_pct != null) ex.push(`V2/V1 = ${fmtNum(extras.v2_v1_pct, { decimals: 2 })}%`);
    if (extras.v0_v1_pct != null) ex.push(`V0/V1 = ${fmtNum(extras.v0_v1_pct, { decimals: 2 })}%`);
    if (extras.i2_i1_pct != null) ex.push(`I2/I1 = ${fmtNum(extras.i2_i1_pct, { decimals: 2 })}%`);
  }
  return `
    <table class="phasor-table pd-table">
      <thead><tr><th>Fasor</th><th class="num">Módulo (RMS)</th><th class="num">Ângulo</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
    ${ex.length ? `<div class="pd-extras">${ex.map((e) => `<span>${e}</span>`).join("")}</div>` : ""}
  `;
}
