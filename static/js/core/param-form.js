/**
 * Formulário gerado a partir do esquema de parâmetros do backend.
 *
 *  - seções colapsáveis (<details>), com resumo opcional no título;
 *  - `visible_if`: {"outro": valor | [valores]} – todas as condições (E);
 *  - devolve os valores tipados via onChange(key, value, allValues).
 */
import { escapeHtml } from "./bus.js";

export function renderParamForm(container, params, values, { onChange, openSections } = {}) {
  const sections = new Map();
  for (const p of params) {
    const sec = p.section || "Geral";
    if (!sections.has(sec)) sections.set(sec, []);
    sections.get(sec).push(p);
  }

  const html = [];
  let idx = 0;
  for (const [sec, items] of sections) {
    const open = openSections ? openSections(sec, idx) : idx < 3;
    html.push(`<details class="pf-section" data-section="${escapeHtml(sec)}" ${open ? "open" : ""}>
      <summary>${escapeHtml(sec)}<span class="pf-summary"></span></summary><div class="pf-grid">`);
    for (const p of items) html.push(renderField(p, values[p.key]));
    html.push("</div></details>");
    idx += 1;
  }
  container.innerHTML = html.join("");

  const byKey = new Map(params.map((p) => [p.key, p]));
  const applyVisibility = () => {
    container.querySelectorAll("[data-field]").forEach((el) => {
      const p = byKey.get(el.dataset.field);
      el.classList.toggle("hidden", !isVisible(p, values));
    });
  };

  const handler = (e) => {
    const key = e.target.dataset.param;
    const p = key && byKey.get(key);
    if (!p) return;
    let v;
    if (p.type === "bool") v = e.target.checked;
    else if (p.type === "number") v = e.target.value === "" ? p.default : Number(e.target.value);
    else v = e.target.value;
    values[key] = v;
    applyVisibility();
    onChange?.(key, v, values);
  };
  // propriedades (não addEventListener): re-renderizar o mesmo container
  // substitui os ouvintes em vez de acumulá-los
  container.onchange = handler;
  // números: recalcula também enquanto digita (com debounce no chamador)
  container.oninput = (e) => {
    if (e.target.type === "number") handler(e);
  };
  applyVisibility();

  return {
    setValues(newValues) {
      Object.assign(values, newValues);
      for (const p of params) {
        const input = container.querySelector(`[data-param="${CSS.escape(p.key)}"]`);
        if (!input) continue;
        if (p.type === "bool") input.checked = !!values[p.key];
        else input.value = values[p.key] ?? "";
      }
      applyVisibility();
    },
    setSectionSummary(section, text) {
      const el = container.querySelector(`[data-section="${CSS.escape(section)}"] .pf-summary`);
      if (el) el.textContent = text ? ` · ${text}` : "";
    },
  };
}

export function defaultValues(params, stored = {}) {
  const out = {};
  for (const p of params) out[p.key] = stored[p.key] ?? p.default;
  return out;
}

function isVisible(p, values) {
  if (!p?.visible_if) return true;
  return Object.entries(p.visible_if).every(([k, want]) => {
    const cur = values[k];
    const list = Array.isArray(want) ? want : [want];
    return list.some((w) => String(w) === String(cur));
  });
}

function renderField(p, value) {
  const label = `${escapeHtml(p.label)}${p.unit ? ` <span class="unit">(${escapeHtml(p.unit)})</span>` : ""}`;
  const help = p.help ? ` title="${escapeHtml(p.help)}"` : "";
  const key = escapeHtml(p.key);
  if (p.type === "bool") {
    return `<label class="pf-field pf-bool" data-field="${key}"${help}>
      <input type="checkbox" data-param="${key}" ${value ? "checked" : ""}/> <span>${label}</span></label>`;
  }
  if (p.type === "select") {
    const opts = (p.options || [])
      .map((o) => `<option value="${escapeHtml(o.value)}" ${String(o.value) === String(value) ? "selected" : ""}>${escapeHtml(o.label)}</option>`)
      .join("");
    return `<label class="pf-field" data-field="${key}"${help}><span>${label}</span>
      <select class="select" data-param="${key}">${opts}</select></label>`;
  }
  const attrs = [p.min != null ? `min="${p.min}"` : "", p.max != null ? `max="${p.max}"` : "", `step="${p.step ?? "any"}"`].join(" ");
  return `<label class="pf-field" data-field="${key}"${help}><span>${label}</span>
    <input class="an-input" type="${p.type === "number" ? "number" : "text"}" data-param="${key}" value="${escapeHtml(value ?? "")}" ${attrs}/></label>`;
}
