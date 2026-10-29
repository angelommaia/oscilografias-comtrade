/**
 * Barramento de eventos simples para desacoplar o visualizador principal dos
 * painéis de análise.
 *
 * Eventos emitidos por app.js:
 *   "record"    – novo registro carregado        (record)
 *   "cursor"    – cursor de tempo mudou          (timeS | null)
 *   "selection" – seleção de intervalo mudou     ({start, end} | null)
 *   "view"      – janela visível mudou           ({start, end})
 *   "groups"    – grupos trifásicos / escolha mudou (phasorConfig)
 */
export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this._handlers.get(event)?.delete(fn);
  }

  emit(event, payload) {
    for (const fn of this._handlers.get(event) || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] handler de "${event}" falhou:`, err);
      }
    }
  }
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Formata número em pt-BR com casas adaptativas e prefixo SI opcional. */
export function fmtNum(value, { unit = "", si = false, decimals } = {}) {
  if (value == null || !Number.isFinite(value)) return "—";
  let v = value;
  let prefix = "";
  if (si) {
    const abs = Math.abs(v);
    if (abs >= 1e9) { v /= 1e9; prefix = "G"; }
    else if (abs >= 1e6) { v /= 1e6; prefix = "M"; }
    else if (abs >= 1e3) { v /= 1e3; prefix = "k"; }
  }
  const abs = Math.abs(v);
  const d = decimals ?? (abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 10 ? 2 : 3);
  const text = v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const u = `${prefix}${unit}`;
  return u ? `${text} ${u}` : text;
}
