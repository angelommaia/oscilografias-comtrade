/**
 * Registro das abas de análise. Para adicionar uma análise nova no frontend:
 *   1. crie a análise no backend (backend/analysis/builtin/…) com @register;
 *   2. crie uma view em ./views/ seguindo o contrato descrito em dock.js;
 *   3. importe e registre aqui.
 */
import { registerView } from "./dock.js";
import phasorDiagram from "./views/phasor-diagram.js";
import impedance from "./views/impedance.js";
import harmonics from "./views/harmonics.js";

registerView(phasorDiagram);
registerView(impedance);
registerView(harmonics);

export { AnalysisDock } from "./dock.js";
