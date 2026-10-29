/**
 * Painel lateral de análises (dock) com abas.
 *
 * Cada aba é uma "view" registrada com `registerView()`. A view declara qual
 * análise do backend consome; o dock cuida de: formulário de parâmetros (gerado
 * a partir do esquema enviado pelo backend e salvo no navegador), quando
 * recalcular (cursor, seleção, janela, grupos), concorrência de requisições e
 * exibição de erros. A view só desenha o resultado.
 *
 * Contrato de uma view:
 *   {
 *     id, title, analysisId,
 *     refetchOn: ["cursor","selection","view","groups","channels","record"],
 *     range: "selection-or-view" | "selection" | "none",
 *     create(bodyEl, ctx) -> {
 *        render(result), clear(message), onCursor?(t), extraRequest?() , resize?()
 *     }
 *   }
 */
import { debounce, escapeHtml } from "../core/bus.js";
import { formatTime } from "../api.js";
import { fetchAnalysesCatalog, runAnalysis } from "./api.js";

const VIEWS = [];

export function registerView(view) {
  VIEWS.push(view);
}

const STORAGE_PREFIX = "oscilo.analysis.";

function loadStored(key, fallback) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveStored(key, value) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    /* armazenamento indisponível: ignora */
  }
}

export class AnalysisDock {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.panels = [];
    this.active = null;
    this.tabsEl = root.querySelector(".dock-tabs");
    this.bodyEl = root.querySelector(".dock-body");
  }

  async init() {
    let catalog = [];
    try {
      catalog = (await fetchAnalysesCatalog()).analyses;
    } catch (err) {
      this.bodyEl.innerHTML = `<p class="an-empty">Não foi possível carregar o catálogo de análises: ${escapeHtml(err.message)}</p>`;
      return;
    }
    const byId = new Map(catalog.map((a) => [a.id, a]));

    for (const view of VIEWS) {
      const schema = byId.get(view.analysisId);
      if (!schema) continue;
      const panel = new AnalysisPanel(view, schema, this.ctx);
      this.panels.push(panel);

      const tab = document.createElement("button");
      tab.className = "dock-tab";
      tab.textContent = view.title;
      tab.title = schema.description;
      tab.addEventListener("click", () => this.activate(panel));
      panel.tab = tab;
      this.tabsEl.appendChild(tab);
      this.bodyEl.appendChild(panel.el);
    }

    const bus = this.ctx.bus;
    for (const evt of ["record", "cursor", "selection", "view", "groups", "channels"]) {
      bus.on(evt, (payload) => this.panels.forEach((p) => p.onEvent(evt, payload)));
    }

    const stored = loadStored("activeTab", null);
    this.activate(this.panels.find((p) => p.view.id === stored) || this.panels[0]);
  }

  activate(panel) {
    if (!panel) return;
    this.active = panel;
    for (const p of this.panels) {
      const on = p === panel;
      p.tab.classList.toggle("active", on);
      p.setVisible(on);
    }
    saveStored("activeTab", panel.view.id);
  }

  setOpen(open) {
    this.root.classList.toggle("hidden", !open);
    if (open) this.active?.setVisible(true);
  }

  resize() {
    this.active?.instance.resize?.();
  }
}

class AnalysisPanel {
  constructor(view, schema, ctx) {
    this.view = view;
    this.schema = schema;
    this.ctx = ctx;
    this.visible = false;
    this.dirty = true;
    this.generation = 0;
    this.params = this._initialParams();

    this.el = document.createElement("div");
    this.el.className = "an-panel hidden";
    this.el.innerHTML = `
      <div class="an-header">
        <span class="an-status">—</span>
        <button type="button" class="link-btn an-toggle-params">Parâmetros</button>
      </div>
      <form class="an-params hidden" autocomplete="off"></form>
      <div class="an-body"></div>
    `;
    this.statusEl = this.el.querySelector(".an-status");
    this.formEl = this.el.querySelector(".an-params");
    this.el.querySelector(".an-toggle-params").addEventListener("click", () => {
      this.formEl.classList.toggle("hidden");
      this.instance.resize?.();
    });
    this._buildForm();
    this.instance = view.create(this.el.querySelector(".an-body"), ctx, this);
    this.instance.bindPanel?.(this);
    this.scheduleRun = debounce(() => this.run(), 120);
  }

  _initialParams() {
    const stored = loadStored(`params.${this.schema.id}`, {});
    const params = {};
    for (const p of this.schema.params) {
      params[p.key] = stored[p.key] ?? p.default;
    }
    return params;
  }

  _buildForm() {
    const sections = new Map();
    for (const p of this.schema.params) {
      const sec = p.section || "";
      if (!sections.has(sec)) sections.set(sec, []);
      sections.get(sec).push(p);
    }
    const html = [];
    for (const [sec, items] of sections) {
      html.push(`<fieldset class="an-fieldset">${sec ? `<legend>${escapeHtml(sec)}</legend>` : ""}`);
      for (const p of items) html.push(renderField(p, this.params[p.key]));
      html.push("</fieldset>");
    }
    this.formEl.innerHTML = html.join("");
    this.formEl.addEventListener("change", (e) => {
      const key = e.target.dataset.param;
      if (!key) return;
      const p = this.schema.params.find((x) => x.key === key);
      this.params[key] = p.type === "bool" ? e.target.checked : e.target.value;
      saveStored(`params.${this.schema.id}`, this.params);
      this._applyVisibility();
      this.onEvent("params");
    });
    this.formEl.addEventListener("submit", (e) => e.preventDefault());
    this._applyVisibility();
  }

  /** Esconde campos irrelevantes (ex.: k0 manual quando modo = Z0/Z1). */
  _applyVisibility() {
    const rules = this.view.paramVisibility?.(this.params) || {};
    this.formEl.querySelectorAll("[data-field]").forEach((el) => {
      el.classList.toggle("hidden", rules[el.dataset.field] === false);
    });
  }

  setParam(key, value) {
    this.params[key] = value;
    const input = this.formEl.querySelector(`[data-param="${key}"]`);
    if (input) {
      if (input.type === "checkbox") input.checked = !!value;
      else input.value = value;
    }
    saveStored(`params.${this.schema.id}`, this.params);
    this.onEvent("params");
  }

  setVisible(visible) {
    this.visible = visible;
    this.el.classList.toggle("hidden", !visible);
    if (visible) {
      requestAnimationFrame(() => this.instance.resize?.());
      if (this.dirty) this.scheduleRun();
    }
  }

  onEvent(evt, payload) {
    if (evt === "cursor") this.instance.onCursor?.(payload);
    const triggers = this.view.refetchOn || ["record", "groups", "params"];
    if (evt === "record" || triggers.includes(evt) || evt === "params") {
      this.dirty = true;
      if (this.visible) this.scheduleRun();
    }
  }

  _range() {
    const mode = this.view.range || "none";
    const sel = this.ctx.selection;
    if (mode === "none") return {};
    if (sel && sel.end - sel.start > 1e-6) return { t_start: sel.start, t_end: sel.end, source: "seleção" };
    if (mode === "selection-or-view") {
      const v = this.ctx.viewRange;
      return { t_start: v.start, t_end: v.end, source: "janela visível" };
    }
    return {};
  }

  async run() {
    const ctx = this.ctx;
    if (!ctx.record) {
      this.instance.clear("Abra um registro COMTRADE.");
      this.statusEl.textContent = "—";
      return;
    }
    const gen = ++this.generation;
    this.dirty = false;
    const range = this._range();
    const body = {
      time_s: ctx.cursorTime,
      voltage_group: ctx.voltageGroupId,
      current_group: ctx.currentGroupId,
      channels: [],
      params: this.params,
      max_points: 4000,
      ...(this.instance.extraRequest?.() || {}),
    };
    if (range.t_start != null) {
      body.t_start = range.t_start;
      body.t_end = range.t_end;
    }

    const precheck = this.view.precheck?.(body, ctx);
    if (precheck) {
      this.instance.clear(precheck);
      this.statusEl.textContent = "—";
      return;
    }

    this.statusEl.textContent = "Calculando…";
    try {
      const result = await runAnalysis(ctx.record.id, this.schema.id, body);
      if (gen !== this.generation) return;
      this.statusEl.textContent = describeResult(result, range);
      this.instance.render(result, body);
    } catch (err) {
      if (gen !== this.generation) return;
      this.statusEl.textContent = "Erro";
      this.instance.clear(err.message);
    }
  }
}

function describeResult(result, range) {
  if (result.window) {
    return `t = ${formatTime(result.time_s)} · janela ${formatTime(result.window.t_start)} → ${formatTime(result.window.t_end)}`;
  }
  if (result.t_start != null) {
    const src = range.source ? ` (${range.source})` : "";
    return `${formatTime(result.t_start)} → ${formatTime(result.t_end)}${src}`;
  }
  return "";
}

function renderField(p, value) {
  const id = `anp-${Math.random().toString(36).slice(2, 9)}`;
  const label = `${escapeHtml(p.label)}${p.unit ? ` <span class="unit">(${escapeHtml(p.unit)})</span>` : ""}`;
  const help = p.help ? ` title="${escapeHtml(p.help)}"` : "";
  if (p.type === "bool") {
    return `<label class="an-field an-field-bool" data-field="${p.key}"${help}>
      <input type="checkbox" id="${id}" data-param="${p.key}" ${value ? "checked" : ""}/> ${label}</label>`;
  }
  if (p.type === "select") {
    const opts = (p.options || [])
      .map((o) => `<option value="${escapeHtml(o.value)}" ${String(o.value) === String(value) ? "selected" : ""}>${escapeHtml(o.label)}</option>`)
      .join("");
    return `<label class="an-field" data-field="${p.key}"${help}><span>${label}</span>
      <select class="select" id="${id}" data-param="${p.key}">${opts}</select></label>`;
  }
  const attrs = [
    p.min != null ? `min="${p.min}"` : "",
    p.max != null ? `max="${p.max}"` : "",
    `step="${p.step ?? "any"}"`,
  ].join(" ");
  const type = p.type === "number" ? "number" : "text";
  return `<label class="an-field" data-field="${p.key}"${help}><span>${label}</span>
    <input class="an-input" type="${type}" id="${id}" data-param="${p.key}" value="${escapeHtml(value ?? "")}" ${attrs}/></label>`;
}
