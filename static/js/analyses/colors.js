// Cores por fase (validadas para daltonismo – ver README). A identidade nunca
// depende só da cor: V = traço contínuo, I = tracejado, e todo fasor/laço tem rótulo.
export const PHASE_COLORS = { A: "#b8471c", B: "#2a9d8f", C: "#4a3fbf" };
export const NEUTRAL_INK = "#4a4a4a";
export const MUTED_INK = "#8a8a8a";

export const LOOP_STYLE = {
  AG: { color: PHASE_COLORS.A, dash: [] },
  BG: { color: PHASE_COLORS.B, dash: [] },
  CG: { color: PHASE_COLORS.C, dash: [] },
  AB: { color: PHASE_COLORS.A, dash: [6, 3] },
  BC: { color: PHASE_COLORS.B, dash: [6, 3] },
  CA: { color: PHASE_COLORS.C, dash: [6, 3] },
};
