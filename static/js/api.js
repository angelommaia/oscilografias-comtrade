const API = "";

// ---------------------------------------------------------------------------
// Versão desktop (janela Tauri): o endereço inicial traz ?desktop=1&token=…
// O token vai em toda chamada de API (cabeçalho X-Oscilo-Token) e é retirado
// da barra de endereço logo na abertura.
// ---------------------------------------------------------------------------
const _params = new URLSearchParams(window.location.search);
function _session(key, fromUrl) {
  try {
    if (fromUrl) sessionStorage.setItem(key, fromUrl);
    return sessionStorage.getItem(key) || fromUrl || "";
  } catch {
    return fromUrl || "";
  }
}
const DESKTOP_TOKEN = _session("oscilo.token", _params.get("token"));
export const IS_DESKTOP = _session("oscilo.desktop", _params.get("desktop")) === "1" && !!DESKTOP_TOKEN;
export const STARTUP_FILE = _params.get("open") || "";
if (_params.has("token")) {
  history.replaceState(null, "", window.location.pathname);
}

/**
 * Texto legível do erro devolvido pela API. O FastAPI usa `detail` como texto
 * (HTTPException) ou como lista de erros de validação (422) – sem isto a lista
 * aparecia como "[object Object]".
 */
export function apiErrorMessage(detail, fallback = "Erro desconhecido.") {
  if (!detail) return fallback;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => {
        const loc = (d.loc || []).filter((p) => p !== "body").join(" › ");
        if ((d.loc || []).includes("images")) return "Figura grande demais para o relatório.";
        return loc ? `${loc}: ${d.msg}` : d.msg;
      })
      .filter((m, i, all) => m && all.indexOf(m) === i)
      .join("\n") || fallback;
  }
  return detail.message || detail.msg || JSON.stringify(detail);
}

export async function fetchJson(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (DESKTOP_TOKEN) headers.set("X-Oscilo-Token", DESKTOP_TOKEN);
  const res = await fetch(`${API}${url}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const error = new Error(apiErrorMessage(err.detail, res.statusText));
    error.status = res.status;
    error.detail = err.detail;
    throw error;
  }
  return res.json();
}

export async function loadSample(sampleId) {
  return fetchJson("/api/load/sample", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sample_id: sampleId }),
  });
}

export async function loadFromUpload(cfgFile, datFile) {
  const form = new FormData();
  form.append("cfg", cfgFile);
  if (datFile) form.append("dat", datFile);
  return fetchJson("/api/load/upload", { method: "POST", body: form });
}

export async function loadFromPath(path) {
  return fetchJson("/api/load/path", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

/** Diálogo nativo de arquivo (Tauri). Retorna a lista de caminhos ([] se cancelado).
 * Aceita .cfg (o .dat é lido da mesma pasta), .cff e .zip; vários de uma vez. */
export async function pickComtradeFiles({ title = "Abrir oscilografia COMTRADE" } = {}) {
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error("Diálogo nativo indisponível.");
  const res = await invoke("plugin:dialog|open", {
    options: {
      title,
      multiple: true,
      directory: false,
      filters: [
        { name: "COMTRADE (.cfg, .cff, .zip)", extensions: ["cfg", "CFG", "cff", "CFF", "zip", "ZIP"] },
        { name: "Todos os arquivos", extensions: ["*"] },
      ],
    },
  });
  if (!res) return [];
  const list = Array.isArray(res) ? res : [res];
  return list.map((r) => (typeof r === "string" ? r : r?.path)).filter(Boolean);
}

export async function listSamples() {
  return fetchJson("/api/samples");
}

export async function fetchWaveform(recordId, channelIndices, viewRange, maxPoints) {
  const params = new URLSearchParams({
    channels: channelIndices.join(","),
    start_sample: String(viewRange.start),
    max_points: String(maxPoints),
  });
  if (viewRange.end != null) params.set("end_sample", String(viewRange.end));
  return fetchJson(`/api/records/${recordId}/waveform?${params}`);
}

export async function fetchValueAtTime(recordId, channelIndices, timeS, { times = null, mode = "inst", signal } = {}) {
  const params = new URLSearchParams({ channels: channelIndices.join(","), mode });
  if (times && times.length) params.set("times", times.map(String).join(","));
  else params.set("time_s", String(timeS));
  return fetchJson(`/api/records/${recordId}/value-at-time?${params}`, signal ? { signal } : undefined);
}

export function formatChannelValue(value, unit, kind) {
  if (value == null || Number.isNaN(value)) return "—";
  if (kind === "digital") return value >= 0.5 ? "1" : "0";
  const abs = Math.abs(value);
  let text;
  if (abs >= 1000) text = value.toFixed(2);
  else if (abs >= 10) text = value.toFixed(3);
  else if (abs >= 1) text = value.toFixed(4);
  else text = value.toFixed(5);
  return unit ? `${text} ${unit}` : text;
}

export function formatTime(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const abs = Math.abs(seconds);
  const sign = seconds < 0 ? "-" : "";
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  if (h > 0) {
    return `${sign}${h}h ${String(m).padStart(2, "0")}m ${s.toFixed(3).padStart(6, "0")}s`;
  }
  if (m > 0) {
    return `${sign}${m}m ${s.toFixed(3).padStart(6, "0")}s`;
  }
  return `${sign}${s.toFixed(3)} s`;
}

export function decimateIndices(length, maxPoints) {
  if (length <= maxPoints) {
    return Array.from({ length }, (_, i) => i);
  }
  const step = length / maxPoints;
  const indices = [];
  for (let i = 0; i < maxPoints; i += 1) {
    indices.push(Math.min(length - 1, Math.floor(i * step)));
  }
  return indices;
}

/** POST JSON que devolve o corpo bruto (Blob) – usado para baixar arquivos. */
export async function postForBlob(url, body) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (DESKTOP_TOKEN) headers.set("X-Oscilo-Token", DESKTOP_TOKEN);
  const res = await fetch(`${API}${url}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(apiErrorMessage(err.detail, res.statusText));
  }
  return res.blob();
}

/** Diálogo nativo "Salvar como" (Tauri). Retorna o caminho ou null. */
export async function pickSavePath(defaultPath, filterName, extensions) {
  const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error("Diálogo nativo indisponível.");
  const res = await invoke("plugin:dialog|save", {
    options: { title: "Salvar relatório", defaultPath, filters: [{ name: filterName, extensions }] },
  });
  if (!res) return null;
  return typeof res === "string" ? res : res.path || null;
}
