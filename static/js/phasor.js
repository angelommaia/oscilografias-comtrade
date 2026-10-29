import { fetchJson } from "./api.js";

export async function fetchPhasorConfig(recordId) {
  return fetchJson(`/api/records/${recordId}/phasor-config`);
}

export async function fetchDerivedWaveform(
  recordId,
  voltageGroup,
  currentGroup,
  metrics,
  viewRange,
  windowCycles,
  maxPoints,
  estimator = "ls"
) {
  const params = new URLSearchParams({
    estimator,
    voltage_group: voltageGroup,
    current_group: currentGroup,
    metrics: metrics.join(","),
    start_sample: String(viewRange.start),
    window_cycles: String(windowCycles),
    max_points: String(maxPoints),
  });
  if (viewRange.end != null) params.set("end_sample", String(viewRange.end));
  return fetchJson(`/api/records/${recordId}/derived/waveform?${params}`);
}

export async function fetchDerivedAtTime(
  recordId,
  voltageGroup,
  currentGroup,
  timeS,
  windowCycles,
  estimator = "ls"
) {
  const params = new URLSearchParams({
    estimator,
    voltage_group: voltageGroup,
    current_group: currentGroup,
    time_s: String(timeS),
    window_cycles: String(windowCycles),
  });
  return fetchJson(`/api/records/${recordId}/derived/at-time?${params}`);
}

export function formatDerivedValue(value, unit) {
  if (value == null || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  let decimals;
  if (abs >= 1e6) decimals = 0;
  else if (abs >= 1000) decimals = 1;
  else if (abs >= 10) decimals = 2;
  else if (abs >= 1) decimals = 3;
  else decimals = 4;
  const text = value.toFixed(decimals).replace(".", ",");
  return unit ? `${text} ${unit}` : text;
}

const METRIC_GROUPS = [
  { id: "RMS", keys: ["rms_va", "rms_vb", "rms_vc", "rms_ia", "rms_ib", "rms_ic"] },
  { id: "Fase", keys: ["ang_va", "ang_vb", "ang_vc", "ang_ia", "ang_ib", "ang_ic", "ang_vi_a", "ang_vi_b", "ang_vi_c"] },
  { id: "Potência", keys: ["p_total", "q_total", "s_total"] },
  { id: "Sequência", keys: ["v0", "v2", "i0", "i2"] },
  { id: "Linha", keys: ["vab", "vbc", "vca"] },
];

export function renderDerivedMetricCheckboxes(container, catalog, selected, onChange, groups = METRIC_GROUPS) {
  container.innerHTML = "";
  for (const group of groups || METRIC_GROUPS) {
    const title = document.createElement("div");
    title.className = "derived-group-title";
    title.textContent = group.id;
    container.appendChild(title);

    for (const key of group.keys) {
      const info = catalog[key];
      if (!info) continue;
      const row = document.createElement("label");
      row.className = "channel-item derived-item";
      row.innerHTML = `
        <input type="checkbox" data-metric="${key}" ${selected.has(key) ? "checked" : ""} />
        <span>${info.name} <span class="unit">(${info.unit})</span></span>
      `;
      row.querySelector("input").addEventListener("change", (e) => {
        onChange(key, e.target.checked);
      });
      container.appendChild(row);
    }
  }
}

export function renderPhasorTable(container, metrics) {
  if (!metrics?.length) {
    container.innerHTML = '<p class="phasor-empty">Posicione o cursor para ver as grandezas.</p>';
    return;
  }

  const rows = metrics
    .map(
      (m) => `
      <tr>
        <td>${m.name}</td>
        <td class="num">${formatDerivedValue(m.value, m.unit)}</td>
      </tr>`
    )
    .join("");

  container.innerHTML = `
    <table class="phasor-table">
      <thead><tr><th>Grandeza</th><th>Valor</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

export { METRIC_GROUPS };
