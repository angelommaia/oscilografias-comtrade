/**
 * Tema claro/escuro. O CSS troca pelas variáveis de :root[data-theme]; os
 * gráficos em canvas leem as cores de `T` (atualizado aqui) e são redesenhados
 * no evento "oscilo-theme".
 */
import { INK, LOOP_STYLE, PHASE_COLORS } from "../analyses/colors.js";

const PALETTES = {
  light: {
    surface: "#ffffff", text: "#2a2a2a", textMuted: "#666666", ink: "#222222",
    grid: "#e4e4e4", gridLight: "#ececec", gridStrong: "#c9c9c9", axis: "#888888", border: "#c8c8c8",
    labelBg: "rgba(255,255,255,0.85)", ruler: "#d8d8d8", rulerTick: "#999999", rulerTickMinor: "#bbbbbb",
    selection: "rgba(74, 122, 184, 0.25)", cursor: "#4a7ab8", marker: "#c06040",
    waveAnalog: "#3a6ea5", waveDigital: "#5a8a5a", derived: "#6a4a8a",
    palette: ["#3a6ea5", "#8a5a3a", "#5a8a5a", "#7a3a7a", "#3a7a7a", "#a05a3a"],
    ordinal: ["#1f3b73", "#355e9e", "#5a84c2", "#86a8d6", "#a9bfdf"],
    warn: "#8a5a00", trip: "#8a3415", laneBg: "#f3f3f3", laneSep: "rgba(255,255,255,0.7)",
    phases: { A: "#b8471c", B: "#2a9d8f", C: "#4a3fbf" }, neutral: "#4a4a4a", muted: "#8a8a8a",
  },
  dark: {
    surface: "#262b33", text: "#dfe3e8", textMuted: "#9aa3ad", ink: "#e6e9ed",
    grid: "#2f353d", gridLight: "#2b3038", gridStrong: "#4a525d", axis: "#8b95a1", border: "#4a525d",
    labelBg: "rgba(30,34,40,0.85)", ruler: "#2c313a", rulerTick: "#7a8490", rulerTickMinor: "#565e69",
    selection: "rgba(110, 162, 224, 0.28)", cursor: "#6ea2e0", marker: "#e0835f",
    waveAnalog: "#6fa8e6", waveDigital: "#6fbf8a", derived: "#b39ddb",
    palette: ["#6fa8e6", "#e0a070", "#7fc98f", "#c890d8", "#6cc8c8", "#e08a6a"],
    ordinal: ["#9cc0f0", "#7aa6e0", "#5a88c8", "#456ea8", "#3a5a88"],
    warn: "#e0b25c", trip: "#ff8a65", laneBg: "#2b3038", laneSep: "rgba(0,0,0,0.35)",
    phases: { A: "#ef7d4f", B: "#3cc6b6", C: "#9a92ff" }, neutral: "#c3c9d0", muted: "#8b95a1",
  },
};

export const T = { ...PALETTES.light };
let current = "light";

export function getTheme() {
  return current;
}

export function setTheme(name, { persist = true } = {}) {
  current = name === "dark" ? "dark" : "light";
  const pal = PALETTES[current];
  Object.assign(T, pal);
  Object.assign(PHASE_COLORS, pal.phases);
  INK.neutral = pal.neutral;
  INK.muted = pal.muted;
  for (const [loop, ph] of Object.entries({ AG: "A", BG: "B", CG: "C", AB: "A", BC: "B", CA: "C" })) {
    LOOP_STYLE[loop].color = pal.phases[ph];
  }
  document.documentElement.dataset.theme = current;
  if (persist) {
    try {
      localStorage.setItem("oscilo.theme", current);
    } catch {
      /* ignora */
    }
  }
  window.dispatchEvent(new CustomEvent("oscilo-theme", { detail: current }));
}

export function initTheme() {
  let pref = null;
  try {
    pref = localStorage.getItem("oscilo.theme");
  } catch {
    /* ignora */
  }
  if (!pref) pref = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  setTheme(pref, { persist: false });
}
