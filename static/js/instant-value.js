/** Valores dos canais nos cursores C1/C2 (e Δ), ao lado do nome da faixa.
 *
 * Os valores vêm do backend (RMS verdadeiro, RMS fundamental ou instantâneo),
 * calculados só nos instantes dos cursores e só quando eles mudam. Aqui fica
 * apenas a formatação (sem DOM global), para poder ser testada isoladamente. */

import { escapeHtml, fmtNum } from "./core/bus.js";

export const VALUE_MODES = [
  { id: "true_rms", label: "RMS verdadeiro", tag: "rms", help: "Raiz da média dos quadrados em 1 ciclo nominal terminando no cursor (inclui harmônicos e DC)." },
  { id: "fund", label: "RMS fundamental", tag: "fund.", help: "Módulo RMS do fasor da fundamental (mínimos quadrados, 1 ciclo, mesma janela dos fasores)." },
  { id: "inst", label: "Instantâneo", tag: "inst.", help: "Valor da amostra mais próxima do cursor." },
];
export const DEFAULT_VALUE_MODE = "true_rms";

export function valueModeTag(mode) {
  return (VALUE_MODES.find((m) => m.id === mode) || VALUE_MODES[0]).tag;
}

const PREFIX = { k: 1e3, M: 1e6, m: 1e-3 };
const BASE_UNITS = new Set(["V", "A", "W", "VA", "var", "VAr", "Hz"]);

/** "kV" → {factor: 1000, unit: "V"}; unidades desconhecidas ficam como estão. */
export function baseUnit(unit) {
  const u = String(unit || "").trim();
  if (BASE_UNITS.has(u)) return { factor: 1, unit: u, si: true };
  const p = u.charAt(0);
  if (PREFIX[p] && BASE_UNITS.has(u.slice(1))) return { factor: PREFIX[p], unit: u.slice(1), si: true };
  return { factor: 1, unit: u, si: false };
}

/** Valor analógico com unidade e prefixo SI coerentes (ex.: 412,0 A · 13,8 kV). */
export function formatAnalog(value, unit) {
  if (value == null || !Number.isFinite(value)) return "—";
  const b = baseUnit(unit);
  return fmtNum(value * b.factor, { unit: b.unit, si: b.si });
}

export function formatDigital(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 0.5 ? "1" : "0";
}

/** HTML do bloco de valores de uma faixa.
 * @param {{kind: string, unit: string, mode: string, c1?: number|null, c2?: number|null,
 *          hasC1: boolean, hasC2: boolean}} v */
export function cursorValuesHtml(v) {
  if (!v.hasC1 && !v.hasC2) return `<span class="cv-empty">—</span>`;
  if (v.kind === "digital") {
    const a = v.hasC1 ? formatDigital(v.c1) : null;
    const b = v.hasC2 ? formatDigital(v.c2) : null;
    const last = b ?? a;
    const text = a != null && b != null ? `${a} → ${b}` : last;
    return `<span class="cv-dig${last === "1" ? " on" : ""}">${escapeHtml(text)}</span>`;
  }
  const tag = v.kind === "derived" ? "" : valueModeTag(v.mode);
  const line = (key, label, value) =>
    `<div class="cv-line ${key}"><span class="cv-k">${label}</span><span class="cv-v">${escapeHtml(formatAnalog(value, v.unit))}</span>${tag ? `<span class="cv-q">${tag}</span>` : ""}</div>`;
  const rows = [];
  if (v.hasC1) rows.push(line("c1", "C1", v.c1));
  if (v.hasC2) rows.push(line("c2", "C2", v.c2));
  if (v.hasC1 && v.hasC2) {
    const d = v.c1 != null && v.c2 != null && Number.isFinite(v.c1) && Number.isFinite(v.c2) ? v.c2 - v.c1 : null;
    rows.push(line("delta", "Δ", d));
  }
  return rows.join("");
}

/** Nº de linhas de valor mostradas nas faixas analógicas (define a altura mínima). */
export function cursorLineCount(hasC1, hasC2) {
  return hasC1 && hasC2 ? 3 : 1;
}
