/**
 * Modo "Proteção": ajustes de funções de proteção aplicados ao registro.
 *
 * As funções vêm do backend (/api/analyses, category = "protection"); o
 * formulário de ajustes é gerado do esquema. Cada execução devolve o formato
 * padrão (plane, geometry/curves, trajectories, lanes, summary, series), que
 * esta tela desenha sem conhecer a função – exceto pelos detalhes em FUNC_UI.
 */
import { debounce, escapeHtml, fmtNum } from "../core/bus.js";
import { fetchWaveform, formatTime } from "../api.js";
import { fetchAnalysesCatalog, runAnalysis } from "../analyses/api.js";
import { defaultValues, renderParamForm } from "../core/param-form.js";
import { MainChart, SeriesChart } from "./charts.js";
import { Timeline, digitalIntervals } from "./timeline.js";

const ORDER = ["prot_distance", "prot_power_swing", "prot_differential", "prot_overcurrent"];

/** Detalhes de apresentação por função (o resto é genérico). */
const FUNC_UI = {
  prot_distance: {
    trajKeys: ["AG", "BG", "CG", "AB", "BC", "CA"],
    sectionSummary: (sec, v) => {
      const m = /^Zona (\d)$/.exec(sec);
      if (!m) return "";
      const i = m[1];
      if (!v[`z${i}_on`]) return "desligada";
      const dir = { fwd: "frente", rev: "reversa", nondir: "não dir." }[v[`z${i}_dir`]];
      return `${v[`z${i}_shape`] === "mho" ? "mho" : "quad"} · ${dir} · ${v[`z${i}_reach`]}${v.reach_unit === "pct" ? "%" : " Ω"} · ${v[`z${i}_delay`]} s`;
    },
    openSection: (sec, idx) => idx < 2 || sec === "Zona 1",
  },
  prot_power_swing: { trajKeys: ["Z1"], aux: { label: "|dZ1/dt| (Ω/s)" }, openSection: () => true },
  prot_differential: {
    trajKeys: ["A", "B", "C"],
    aux: {
      label: "Harmônicas da diferencial (% fund.)",
      thresholds: (v) => [
        ...(v.h2_on ? [{ y: Number(v.h2), label: `2ª: ${v.h2}%` }] : []),
        ...(v.h5_on ? [{ y: Number(v.h5), label: `5ª: ${v.h5}%` }] : []),
      ],
    },
    openSection: (sec) => sec !== "Harmônicas",
  },
  prot_overcurrent: {
    trajKeys: [],
    refetchOnCursor: true,
    aux: { label: "Correntes (A prim.)" },
    sectionSummary: (sec, v) => {
      const m = /^Estágio (\d)$/.exec(sec);
      if (!m) return "";
      const s = m[1];
      if (!v[`s${s}_on`]) return "desligado";
      return `${{ phase: "fase", residual: "3I0", neg: "I2" }[v[`s${s}_qty`]]} · ${v[`s${s}_kind`] === "dt" ? "tempo def." : v[`s${s}_kind`]} · ${v[`s${s}_pick`]}`;
    },
    openSection: (sec, idx) => idx < 2 || sec === "Estágio 1",
  },
};

const STORE = "oscilo.protection.";
const load = (k, d) => {
  try {
    const v = localStorage.getItem(STORE + k);
    return v ? JSON.parse(v) : d;
  } catch {
    return d;
  }
};
const save = (k, v) => {
  try {
    localStorage.setItem(STORE + k, JSON.stringify(v));
  } catch {
    /* ignora */
  }
};

export class ProtectionView {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.funcs = [];
    this.active = null;
    this.values = {};
    this.inputs = {};
    this.result = null;
    this.generation = 0;
    this.visible = false;
    this.dirty = true;
    this.range = load("range", "sel");
    this.digital = [];
    this.hidden = new Set();
    this.scheduleRun = debounce(() => this.run(), 250);
    this.scheduleCursorRun = debounce(() => this.run(), 300);
  }

  async init() {
    this.root.innerHTML = TEMPLATE;
    this.$ = (sel) => this.root.querySelector(sel);
    this.mainChart = new MainChart(this.$(".pv-main-canvas"), this.$(".pv-chart-box .plot-tooltip"), {
      onPick: (t) => this.ctx.setCursor(t),
    });
    this.auxChart = new SeriesChart(this.$(".pv-aux-canvas"), { onPick: (t) => this.ctx.setCursor(t) });
    this.timeline = new Timeline(this.$(".pv-tl-canvas"), { onClick: (t) => this.ctx.setCursor(t) });

    let catalog = [];
    try {
      catalog = (await fetchAnalysesCatalog()).analyses.filter((a) => a.category === "protection");
    } catch (err) {
      this.$(".pv-status").textContent = `Erro ao carregar funções: ${err.message}`;
      return;
    }
    this.funcs = ORDER.map((id) => catalog.find((f) => f.id === id)).filter(Boolean)
      .concat(catalog.filter((f) => !ORDER.includes(f.id)));
    this.$(".pv-funcs").innerHTML = this.funcs
      .map((f) => `<button type="button" class="pv-func" data-id="${f.id}" title="${escapeHtml(f.description)}">
        <span class="pv-code">${escapeHtml(f.code)}</span><span>${escapeHtml(f.name)}</span></button>`)
      .join("");
    this.$(".pv-funcs").addEventListener("click", (e) => {
      const b = e.target.closest(".pv-func");
      if (b) this.select(b.dataset.id);
    });

    this.$(".pv-range").value = this.range;
    this.$(".pv-range").addEventListener("change", (e) => {
      this.range = e.target.value;
      save("range", this.range);
      this.invalidate();
    });
    this.$(".pv-export").addEventListener("click", () => this.exportProfile());
    this.$(".pv-import").addEventListener("click", () => this.$(".pv-import-file").click());
    this.$(".pv-import-file").addEventListener("change", (e) => this.importProfile(e.target.files?.[0]));
    this.$(".pv-reset").addEventListener("click", () => this.resetProfile());
    this.root.querySelectorAll(".pv-fit").forEach((b) => b.addEventListener("click", () => {
      this.mainChart.fit(b.dataset.fit);
      this.mainChart.plot.draw();
    }));
    this.$(".pv-until").addEventListener("change", (e) => {
      this.mainChart.untilCursor = e.target.checked;
      this.mainChart.plot.draw();
    });
    this.$(".pv-traj-toggles").addEventListener("change", (e) => {
      const k = e.target.dataset.traj;
      if (!k) return;
      if (e.target.checked) this.hidden.delete(k);
      else this.hidden.add(k);
      this.mainChart.setHidden(new Set(this.hidden));
      this.renderReadout();
    });
    this.$(".pv-add-group").addEventListener("click", () => this.ctx.openGroupDialog?.());
    this._bindDigitalPicker();

    const bus = this.ctx.bus;
    bus.on("record", () => {
      this.digital = [];
      this.result = null;
      this.invalidate();
    });
    bus.on("groups", () => {
      this.renderInputs();
      this.invalidate();
    });
    bus.on("selection", () => this.range === "sel" && this.invalidate());
    bus.on("view", () => this.range === "view" && this.invalidate());
    bus.on("cursor", (t) => this.onCursor(t));

    this.select(load("active", this.funcs[0]?.id) || this.funcs[0]?.id);
  }

  // ------------------------------------------------------------------ estado
  setVisible(v) {
    this.visible = v;
    if (v && this.dirty) this.scheduleRun();
    if (v) requestAnimationFrame(() => {
      this.mainChart.plot.draw();
      this.auxChart.plot.draw();
      this.timeline.draw();
    });
  }

  invalidate() {
    this.dirty = true;
    if (this.visible) this.scheduleRun();
  }

  select(id) {
    const f = this.funcs.find((x) => x.id === id) || this.funcs[0];
    if (!f) return;
    this.active = f;
    save("active", f.id);
    this.root.querySelectorAll(".pv-func").forEach((b) => b.classList.toggle("active", b.dataset.id === f.id));
    if (!this.values[f.id]) this.values[f.id] = defaultValues(f.params, load(`params.${f.id}`, {}));
    const ui = FUNC_UI[f.id] || {};
    this.form = renderParamForm(this.$(".pv-form"), f.params, this.values[f.id], {
      openSections: ui.openSection,
      onChange: () => {
        save(`params.${f.id}`, this.values[f.id]);
        this.updateSummaries();
        this.invalidate();
      },
    });
    this.updateSummaries();
    this.hidden = new Set();
    this.result = null;
    this.renderInputs();
    this.renderTrajToggles();
    this.invalidate();
  }

  updateSummaries() {
    const ui = FUNC_UI[this.active.id] || {};
    if (!ui.sectionSummary) return;
    const v = this.values[this.active.id];
    for (const p of this.active.params) {
      if (p.section) this.form.setSectionSummary(p.section, ui.sectionSummary(p.section, v));
    }
  }

  renderInputs() {
    const f = this.active;
    if (!f) return;
    const cfg = this.ctx.phasorConfig;
    const vg = cfg?.voltage_groups || [];
    const ig = cfg?.current_groups || [];
    const cur = this.inputs[f.id] || (this.inputs[f.id] = {});
    let iCount = 0;
    const html = f.inputs.map((spec) => {
      const list = spec.quantity === "V" ? vg : ig;
      const valid = list.some((g) => g.id === cur[spec.key]);
      if (!valid) {
        if (spec.required) {
          const pick = spec.quantity === "I" ? list[Math.min(iCount, list.length - 1)] : list[0];
          cur[spec.key] = pick?.id || "";
        } else if (!(spec.key in cur) || !valid) {
          cur[spec.key] = spec.key === "v" && list[0] ? list[0].id : "";
        }
      }
      if (spec.quantity === "I") iCount += 1;
      const opts = `<option value="">${spec.required ? "— selecione —" : "— nenhuma —"}</option>` +
        list.map((g) => `<option value="${escapeHtml(g.id)}" ${g.id === cur[spec.key] ? "selected" : ""}>${escapeHtml(g.label)}</option>`).join("");
      return `<label class="pf-field"><span>${escapeHtml(spec.label)}</span><select class="select" data-input="${spec.key}">${opts}</select></label>`;
    });
    const box = this.$(".pv-inputs");
    box.innerHTML = html.join("") || '<p class="muted">Sem entradas.</p>';
    box.onchange = (e) => {
      const k = e.target.dataset.input;
      if (!k) return;
      cur[k] = e.target.value;
      this.invalidate();
    };
    this.$(".pv-no-groups").classList.toggle("hidden", !!(vg.length || ig.length) || !this.ctx.record);
  }

  renderTrajToggles() {
    const keys = FUNC_UI[this.active.id]?.trajKeys || [];
    this.$(".pv-traj-toggles").innerHTML = keys
      .map((k) => `<label class="imp-chip"><input type="checkbox" data-traj="${k}" ${this.hidden.has(k) ? "" : "checked"}/>${k}</label>`)
      .join("");
    this.$(".pv-until-wrap").classList.toggle("hidden", !keys.length);
  }

  _interval() {
    const ctx = this.ctx;
    if (this.range === "view") return { t_start: ctx.viewRange.start, t_end: ctx.viewRange.end, label: "janela visível" };
    if (this.range === "sel" && ctx.selection && ctx.selection.end - ctx.selection.start > 1e-6) {
      return { t_start: ctx.selection.start, t_end: ctx.selection.end, label: "seleção" };
    }
    return { label: this.range === "sel" ? "registro inteiro (sem seleção)" : "registro inteiro" };
  }

  // ------------------------------------------------------------------ execução
  async run() {
    const f = this.active;
    const ctx = this.ctx;
    if (!f || !this.visible) return;
    this.dirty = false;
    if (!ctx.record) {
      this.showMessage("Abra um registro COMTRADE para simular as funções de proteção.");
      return;
    }
    const inputs = { ...(this.inputs[f.id] || {}) };
    const missing = f.inputs.filter((s) => s.required && !inputs[s.key]);
    if (missing.length) {
      this.showMessage(`Selecione: ${missing.map((m) => m.label).join(", ")}. Se não houver grupos, use "+ Grupo trifásico".`);
      return;
    }
    const iv = this._interval();
    const body = { inputs, params: this.values[f.id], time_s: ctx.cursorTime, max_points: 4000 };
    if (iv.t_start != null) Object.assign(body, { t_start: iv.t_start, t_end: iv.t_end });
    const gen = ++this.generation;
    this.$(".pv-status").textContent = "Calculando…";
    try {
      const res = await runAnalysis(ctx.record.id, f.id, body);
      if (gen !== this.generation) return;
      const first = !this.result || this.result.analysis !== res.analysis;
      this.result = res;
      this.$(".pv-empty").classList.add("hidden");
      this.$(".pv-content").classList.remove("hidden");
      const res_txt = res.resolution_s > 1 / (ctx.record.sample_rate_hz || 1) * 1.5 ? ` · resolução ${fmtNum(res.resolution_s * 1000, { decimals: 1 })} ms` : "";
      this.$(".pv-status").textContent = `${f.code} ${f.name} · ${formatTime(res.t_start)} → ${formatTime(res.t_end)} (${iv.label})${res_txt}`;
      this.$(".pv-warn").innerHTML = (res.warnings || []).map((w) => `<div>⚠ ${escapeHtml(w)}</div>`).join("");
      this.mainChart.cursor = ctx.cursorTime;
      this.mainChart.render(res, { refit: first });
      this.renderAux();
      this.renderSummary();
      this.renderReadout();
      await this.renderTimeline();
    } catch (err) {
      if (gen !== this.generation) return;
      this.showMessage(err.message);
    }
  }

  showMessage(msg) {
    this.$(".pv-status").textContent = "—";
    this.$(".pv-warn").innerHTML = "";
    this.$(".pv-content").classList.add("hidden");
    const el = this.$(".pv-empty");
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  onCursor(t) {
    if (!this.visible || !this.result) return;
    this.mainChart.setCursor(t);
    this.auxChart.setCursor(t);
    this.timeline.setCursor(t);
    this.renderReadout();
    if (FUNC_UI[this.active.id]?.refetchOnCursor) this.scheduleCursorRun();
  }

  renderAux() {
    const res = this.result;
    const ui = FUNC_UI[this.active.id]?.aux;
    const wrap = this.$(".pv-aux");
    if (!ui || !res.series?.length) {
      wrap.classList.add("hidden");
      return;
    }
    wrap.classList.remove("hidden");
    this.$(".pv-aux-title").textContent = ui.label;
    let thresholds = ui.thresholds ? ui.thresholds(this.values[this.active.id]) : [];
    if (this.active.id === "prot_overcurrent") {
      thresholds = (res.curves || []).map((c) => ({ y: c.pickup_a, label: `${c.label}: ${fmtNum(c.pickup_a, { decimals: 0 })} A` }));
    }
    this.auxChart.cursor = this.ctx.cursorTime;
    this.auxChart.render(res.series, thresholds, "", { t0: res.t_start, t1: res.t_end });
  }

  renderSummary() {
    const res = this.result;
    const rows = (res.summary || []).map((s) => {
      const dt = s.pickup_t != null && s.trip_t != null ? s.trip_t - s.pickup_t : null;
      const tripCls = s.trip_t != null ? "pv-trip" : "";
      return `<tr>
        <td>${escapeHtml(s.element)}</td>
        <td class="num">${s.pickup_t != null ? `<a href="#" data-t="${s.pickup_t}">${formatTime(s.pickup_t)}</a>` : "—"}</td>
        <td class="num ${tripCls}">${s.trip_t != null ? `<a href="#" data-t="${s.trip_t}">${formatTime(s.trip_t)}</a>` : "—"}</td>
        <td class="num">${dt != null ? `${fmtNum(dt * 1000, { decimals: 1 })} ms` : "—"}</td>
        <td>${escapeHtml(s.detail || "")}</td></tr>`;
    });
    const info = Object.entries(res.info || {})
      .map(([k, v]) => `<span>${escapeHtml(k)}: ${typeof v === "number" ? fmtNum(v) : escapeHtml(v)}</span>`).join("");
    const crossings = (res.crossings || [])
      .map((c) => `<li><a href="#" data-t="${c.t}">${formatTime(c.t)}</a> – ${escapeHtml(c.kind)}${c.dt != null ? ` (ΔT = ${fmtNum(c.dt * 1000, { decimals: 1 })} ms)` : ""}</li>`).join("");
    const box = this.$(".pv-summary");
    box.innerHTML = `
      <table class="phasor-table pv-table">
        <thead><tr><th>Elemento</th><th class="num">Partida</th><th class="num">Trip</th><th class="num">Δt</th><th>Detalhe</th></tr></thead>
        <tbody>${rows.join("") || '<tr><td colspan="5" class="muted">Nenhum elemento habilitado.</td></tr>'}</tbody>
      </table>
      ${crossings ? `<ul class="pv-cross">${crossings}</ul>` : ""}
      <div class="pd-extras">${info}</div>`;
    box.onclick = (e) => {
      const a = e.target.closest("[data-t]");
      if (!a) return;
      e.preventDefault();
      this.ctx.setCursor(Number(a.dataset.t));
    };
  }

  renderReadout() {
    const res = this.result;
    const box = this.$(".pv-readout");
    const t = this.ctx.cursorTime;
    if (!res || t == null) {
      box.innerHTML = '<p class="muted">Posicione o cursor (clique no gráfico, na linha do tempo ou nas formas de onda).</p>';
      return;
    }
    if (res.plane.log) {
      const c = res.cursor;
      const cur = c?.currents || {};
      const dir = c?.directional;
      box.innerHTML = `<div class="pv-ro-title">Cursor ${formatTime(c?.time_s ?? t)}</div>
        <div class="pd-extras">${Object.entries(cur).map(([k, v]) => `<span>${k} = ${fmtNum(v, { unit: "A" })}</span>`).join("")}</div>
        ${dir ? `<div class="pd-extras"><span>∠(Ia, Vbc) = ${fmtNum(dir.phase_angle, { decimals: 1 })}° (MTA ${dir.mta}°)</span>
        <span>∠(Ires, Vpol) = ${fmtNum(dir.ground_angle, { decimals: 1 })}° (RCA ${dir.rca}°)</span></div>` : ""}`;
      return;
    }
    const keys = Object.keys(res.trajectories || {}).filter((k) => !this.hidden.has(k));
    const rows = keys.map((k) => {
      const d = res.trajectories[k];
      const i = nearest(d.times, t);
      const step = d.times.length > 1 ? (d.times[d.times.length - 1] - d.times[0]) / (d.times.length - 1) : 0;
      const ok = i >= 0 && Math.abs(d.times[i] - t) <= 2 * step + 1e-9;
      const x = ok ? d.r[i] : null;
      const y = ok ? d.x[i] : null;
      const third = res.plane.equal
        ? (x == null ? "—" : `${fmtNum(Math.hypot(x, y))} ∠ ${fmtNum((Math.atan2(y, x) * 180) / Math.PI, { decimals: 1 })}°`)
        : (x ? `${fmtNum((y / x) * 100, { decimals: 1 })}%` : "—");
      return `<tr><td>${escapeHtml(k)}</td><td class="num">${fmtNum(x)}</td><td class="num">${fmtNum(y)}</td><td class="num">${third}</td></tr>`;
    });
    const u = escapeHtml(res.plane.unit);
    box.innerHTML = `<div class="pv-ro-title">Cursor ${formatTime(t)}</div>
      <table class="phasor-table"><thead><tr><th></th><th class="num">${escapeHtml(res.plane.x)} (${u})</th><th class="num">${escapeHtml(res.plane.y)} (${u})</th>
      <th class="num">${res.plane.equal ? "|Z| ∠Z" : "Idiff/Irest"}</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  }

  async renderTimeline() {
    const res = this.result;
    const digital = [];
    if (this.digital.length && this.ctx.record) {
      try {
        const fs = this.ctx.record.sample_rate_hz;
        const data = await fetchWaveform(this.ctx.record.id, this.digital,
          { start: Math.max(0, Math.floor(res.t_start * fs)), end: Math.ceil(res.t_end * fs) + 1 }, 8000);
        for (const ch of data.channels) {
          digital.push({ label: ch.name, kind: "digital", intervals: digitalIntervals(ch.times, ch.values) });
        }
      } catch (err) {
        console.warn("Digitais:", err);
      }
    }
    this.timeline.cursor = this.ctx.cursorTime;
    this.timeline.setData({ t0: res.t_start, t1: res.t_end, lanes: res.lanes || [], digital });
  }

  _bindDigitalPicker() {
    const btn = this.$(".pv-dig-btn");
    const pop = this.$(".pv-dig-pop");
    const list = this.$(".pv-dig-list");
    const search = this.$(".pv-dig-search");
    const fill = () => {
      const rec = this.ctx.record;
      const q = search.value.trim().toLowerCase();
      list.innerHTML = (rec?.digital_channels || [])
        .filter((c) => !q || c.name.toLowerCase().includes(q))
        .slice(0, 300)
        .map((c) => `<label class="channel-item"><input type="checkbox" value="${c.index}" ${this.digital.includes(c.index) ? "checked" : ""}/> ${escapeHtml(c.name)}</label>`)
        .join("") || '<p class="muted">Sem canais digitais.</p>';
    };
    btn.addEventListener("click", () => {
      pop.classList.toggle("hidden");
      if (!pop.classList.contains("hidden")) fill();
    });
    search.addEventListener("input", fill);
    list.addEventListener("change", (e) => {
      const idx = Number(e.target.value);
      if (e.target.checked) this.digital = [...new Set([...this.digital, idx])].slice(0, 12);
      else this.digital = this.digital.filter((i) => i !== idx);
      btn.textContent = `Canais digitais (${this.digital.length})`;
      if (this.result) this.renderTimeline();
    });
    document.addEventListener("click", (e) => {
      if (!pop.contains(e.target) && e.target !== btn) pop.classList.add("hidden");
    });
  }

  // ------------------------------------------------------------------ perfis
  exportProfile() {
    const f = this.active;
    const blob = new Blob([JSON.stringify({ oscilo_profile: 1, function: f.id, code: f.code, params: this.values[f.id] }, null, 2)],
      { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ajustes_${f.code.replace(/\W+/g, "_")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async importProfile(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const f = this.funcs.find((x) => x.id === data.function);
      if (!f || typeof data.params !== "object") throw new Error("Arquivo não é um perfil de ajustes do Oscilo.");
      this.values[f.id] = defaultValues(f.params, data.params);
      save(`params.${f.id}`, this.values[f.id]);
      this.select(f.id);
    } catch (err) {
      alert(`Não foi possível importar: ${err.message}`);
    } finally {
      this.$(".pv-import-file").value = "";
    }
  }

  resetProfile() {
    const f = this.active;
    if (!confirm(`Restaurar os ajustes padrão de ${f.code} ${f.name}?`)) return;
    this.values[f.id] = defaultValues(f.params, {});
    save(`params.${f.id}`, this.values[f.id]);
    this.select(f.id);
  }
}

function nearest(ts, t) {
  if (!ts.length) return -1;
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

const TEMPLATE = `
  <aside class="pv-side">
    <nav class="pv-funcs"></nav>
    <div class="pv-block">
      <div class="pv-block-title">Entradas</div>
      <div class="pv-inputs"></div>
      <p class="phasor-hint pv-no-groups hidden">Nenhum grupo trifásico definido. Crie um com o botão abaixo.</p>
      <button type="button" class="btn btn-sm pv-add-group">+ Grupo trifásico</button>
      <label class="pf-field"><span>Intervalo simulado</span>
        <select class="select pv-range">
          <option value="sel">Seleção (ou registro inteiro)</option>
          <option value="view">Janela visível</option>
          <option value="all">Registro inteiro</option>
        </select></label>
    </div>
    <div class="pv-block pv-profile">
      <div class="pv-block-title">Ajustes</div>
      <div class="pv-profile-actions">
        <button type="button" class="btn btn-sm pv-export" title="Baixar os ajustes desta função (JSON)">Exportar</button>
        <button type="button" class="btn btn-sm pv-import" title="Carregar ajustes de um arquivo JSON">Importar</button>
        <button type="button" class="link-btn pv-reset">Padrão</button>
        <input type="file" class="pv-import-file" accept=".json,application/json" hidden />
      </div>
    </div>
    <div class="pv-form"></div>
  </aside>
  <section class="pv-main">
    <div class="pv-header">
      <span class="pv-status">—</span>
      <div class="pv-warn"></div>
    </div>
    <p class="an-empty pv-empty hidden"></p>
    <div class="pv-content hidden">
      <div class="pv-top">
        <div class="pv-chart">
          <div class="pv-chart-tools">
            <div class="pv-traj-toggles imp-loops"></div>
            <div class="imp-actions">
              <label class="imp-chip pv-until-wrap" title="Mostra a trajetória apenas até o instante do cursor"><input type="checkbox" class="pv-until"/> Até o cursor</label>
              <button type="button" class="btn btn-sm pv-fit" data-fit="auto" title="Enquadrar a característica (zonas, blinders, região de operação)">Característica</button>
              <button type="button" class="btn btn-sm pv-fit" data-fit="all" title="Enquadrar toda a trajetória">Tudo</button>
            </div>
          </div>
          <div class="pv-chart-box"><canvas class="pv-main-canvas"></canvas><div class="plot-tooltip hidden"></div></div>
        </div>
        <div class="pv-results">
          <div class="pv-readout"></div>
          <div class="pv-summary"></div>
        </div>
      </div>
      <div class="pv-aux hidden">
        <div class="pv-aux-title"></div>
        <canvas class="pv-aux-canvas"></canvas>
      </div>
      <div class="pv-tl">
        <div class="pv-tl-head">
          <span>Linha do tempo da simulação</span>
          <div class="pv-dig">
            <button type="button" class="btn btn-sm pv-dig-btn" title="Mostrar canais digitais do registro (ex.: trip real do relé) para comparação">Canais digitais (0)</button>
            <div class="pv-dig-pop hidden">
              <input type="search" class="channel-search pv-dig-search" placeholder="Buscar canal digital…" />
              <div class="pv-dig-list"></div>
            </div>
          </div>
        </div>
        <canvas class="pv-tl-canvas"></canvas>
      </div>
    </div>
  </section>
`;
