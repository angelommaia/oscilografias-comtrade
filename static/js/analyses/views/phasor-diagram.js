/** Aba "Fasores": diagrama fasorial polar no instante do cursor. */
import { escapeHtml, fmtNum } from "../../core/bus.js";
import { INK, PHASE_COLORS } from "../colors.js";
import { T as TH } from "../../core/theme.js";

const HIDDEN_KEY = "oscilo.analysis.phasor.hidden";
const T2_KEY = "oscilo.analysis.phasor.terminal2";

const prefix = (id) => (id && id.includes("|") ? id.split("|", 1)[0] : "");

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

  create(root, ctx) {
    root.innerHTML = `
      <div class="pd-t2">
        <label class="imp-chip" title="Sobrepõe os fasores de outro terminal (ex.: outra ponta da linha num registro combinado)">
          <input type="checkbox" class="pd-t2-on"/> 2º terminal</label>
        <select class="select pd-t2-v" title="Tensão do 2º terminal"></select>
        <select class="select pd-t2-i" title="Corrente do 2º terminal"></select>
      </div>
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
    let panelRef = null;

    // ---- 2º terminal (grupos V/I de outra ponta; registro combinado ou mesmo registro)
    const t2On = root.querySelector(".pd-t2-on");
    const t2V = root.querySelector(".pd-t2-v");
    const t2I = root.querySelector(".pd-t2-i");
    let t2State = { on: false, v: "", i: "" };
    try {
      t2State = { ...t2State, ...JSON.parse(localStorage.getItem(T2_KEY) || "{}") };
    } catch {
      /* ignora */
    }
    const saveT2 = () => {
      try {
        localStorage.setItem(T2_KEY, JSON.stringify(t2State));
      } catch {
        /* ignora */
      }
    };
    function fillT2() {
      const cfg = ctx.phasorConfig;
      const opts = (groups, sel) => `<option value="">—</option>` + (groups || [])
        .map((g) => `<option value="${escapeHtml(g.id)}" ${g.id === sel ? "selected" : ""}>${escapeHtml(g.label)}</option>`).join("");
      const vgs = cfg?.voltage_groups || [];
      const igs = cfg?.current_groups || [];
      // padrão: grupos de outro terminal (prefixo diferente do grupo principal)
      const p1 = prefix(ctx.voltageGroupId || ctx.currentGroupId);
      const other = (list) => list.find((g) => prefix(g.id) && prefix(g.id) !== p1)?.id || "";
      // reescolhe se o grupo guardado não existe mais ou é do mesmo terminal do principal
      const stale = (id, list) => !list.some((g) => g.id === id) || (p1 && prefix(id) === p1);
      if (stale(t2State.v, vgs)) t2State.v = other(vgs);
      if (stale(t2State.i, igs)) t2State.i = other(igs);
      t2V.innerHTML = opts(vgs, t2State.v);
      t2I.innerHTML = opts(igs, t2State.i);
      t2On.checked = t2State.on;
      t2V.disabled = t2I.disabled = !t2State.on;
    }
    root.querySelector(".pd-t2").addEventListener("change", () => {
      t2State = { on: t2On.checked, v: t2V.value, i: t2I.value };
      t2V.disabled = t2I.disabled = !t2State.on;
      saveT2();
      panelRef?.onEvent("params");
    });
    ctx.bus.on("groups", fillT2);
    ctx.bus.on("record", () => setTimeout(fillT2, 0));
    fillT2();

    const items = () => (last ? [...last.phasors, ...last.sequence.map((s) => ({ ...s, kind: "seq" }))] : []);

    function draw() {
      if (!last) return;
      const visible = items().filter((p) => !hidden.has(p.key) && p.mag != null);
      const scale = drawPolar(canvas, visible);
      const t = last.terminals;
      scaleEl.innerHTML = scale
        + (t ? `<span><b>′</b> = ${escapeHtml(t["2"])} (traço fino, ponta vazada) · sem ′ = ${escapeHtml(t["1"])}</span>` : "")
        + (last.notes || []).map((n) => `<span class="pd-note">${escapeHtml(n)}</span>`).join("");
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
      bindPanel(panel) {
        panelRef = panel;
      },
      extraRequest() {
        if (!t2State.on || (!t2State.v && !t2State.i)) return {};
        return { inputs: { v2: t2State.v, i2: t2State.i } };
      },
      render(result) {
        last = result;
        emptyEl.classList.add("hidden");
        root.querySelector(".pd-canvas-wrap").classList.remove("hidden");
        tableWrap.innerHTML = renderTable(items(), hidden, result.extras, result.terminals);
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
  const color = p.kind === "seq" || p.kind === "channel" ? INK.neutral : PHASE_COLORS[p.phase] || INK.neutral;
  let dash = p.quantity === "I" ? [6, 4] : [];
  if (p.kind === "line") dash = [2, 3];
  const second = p.terminal === 2;
  const width = p.kind === "seq" ? 1.4 : second ? 1.4 : 2;
  return { color, dash, width, hollow: second, alpha: second ? 0.8 : 1 };
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
  g.strokeStyle = TH.grid;
  g.lineWidth = 1;
  for (const f of [0.25, 0.5, 0.75, 1]) {
    g.beginPath();
    g.arc(cx, cy, R * f, 0, Math.PI * 2);
    g.stroke();
  }
  g.font = "10px Segoe UI, sans-serif";
  g.fillStyle = INK.muted;
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (let a = 0; a < 360; a += 30) {
    const rad = (a * Math.PI) / 180;
    g.strokeStyle = a % 90 === 0 ? TH.gridStrong : TH.gridLight;
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
    g.globalAlpha = st.alpha;
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
      if (st.hollow) {
        g.fillStyle = TH.surface;
        g.fill();
        g.stroke();
      } else {
        g.fill();
      }
    }
    g.globalAlpha = 1;
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
    g.fillStyle = TH.labelBg;
    g.fillRect(l.x - w / 2, l.y - 7, w, 14);
    g.fillStyle = TH.ink;
    g.fillText(l.text, l.x, l.y);
  }

  const parts = [];
  if (maxV) parts.push(`<span><b>V</b> (contínuo): anel externo = ${fmtNum(maxV, { unit: "V", si: true })}</span>`);
  if (maxI) parts.push(`<span><b>I</b> (tracejado): anel externo = ${fmtNum(maxI, { unit: "A", si: true })}</span>`);
  return parts.join("");
}

function renderTable(items, hidden, extras, terminals) {
  const two = !!terminals;
  const tn = (n) => (two ? ` – ${terminals[String(n)]}` : "");
  const sections = [];
  for (const term of two ? [1, 2] : [1]) {
    const own = (p) => (p.terminal || 1) === term;
    sections.push(
      { title: `Tensões${tn(term)}`, filter: (p) => own(p) && p.kind !== "seq" && p.kind !== "channel" && p.quantity === "V" },
      { title: `Correntes${tn(term)}`, filter: (p) => own(p) && p.kind !== "seq" && p.kind !== "channel" && p.quantity === "I" },
      { title: `Componentes simétricas${tn(term)}`, filter: (p) => own(p) && p.kind === "seq" },
    );
  }
  sections.push({ title: "Canais", filter: (p) => p.kind === "channel" });
  const rows = [];
  for (const sec of sections) {
    const list = items.filter(sec.filter);
    if (!list.length) continue;
    rows.push(`<tr class="pd-sec"><th colspan="3">${escapeHtml(sec.title)}</th></tr>`);
    for (const p of list) {
      const st = styleFor(p);
      const swatch = `<span class="pd-swatch" style="border-color:${st.color};border-style:${p.quantity === "I" ? "dashed" : p.kind === "line" ? "dotted" : "solid"};opacity:${st.alpha}"></span>`;
      rows.push(`<tr>
        <td><label class="pd-row-label"><input type="checkbox" data-key="${p.key}" ${hidden.has(p.key) ? "" : "checked"}/>${swatch}${escapeHtml(p.label)}</label></td>
        <td class="num">${fmtNum(p.mag, { unit: p.unit, si: true })}</td>
        <td class="num">${p.ang == null ? "—" : `${fmtNum(p.ang, { decimals: 1 })}°`}</td>
      </tr>`);
    }
  }
  if (two && extras?.diffs?.length) {
    rows.push(`<tr class="pd-sec"><th>Entre terminais</th><th class="num">Razão de módulo</th><th class="num">Δ ângulo</th></tr>`);
    for (const d of extras.diffs) {
      rows.push(`<tr><td>${escapeHtml(d.label)}</td><td class="num">${fmtNum(d.ratio, { decimals: 3 })}</td><td class="num">${fmtNum(d.dang, { decimals: 1 })}°</td></tr>`);
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
    const t2 = extras.terminal2;
    if (t2 && terminals) ex.push(`${escapeHtml(terminals["2"])}: P = ${fmtNum(t2.p_w, { unit: "W", si: true })} · Q = ${fmtNum(t2.q_var, { unit: "var", si: true })}`);
  }
  return `
    <table class="phasor-table pd-table">
      <thead><tr><th>Fasor</th><th class="num">Módulo (RMS)</th><th class="num">Ângulo</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
    ${ex.length ? `<div class="pd-extras">${ex.map((e) => `<span>${e}</span>`).join("")}</div>` : ""}
  `;
}
