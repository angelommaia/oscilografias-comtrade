import {
  IS_DESKTOP,
  STARTUP_FILE,
  loadFromPath,
  pickComtradeFile,
  fetchWaveform,
  fetchValueAtTime,
  formatTime,
  listSamples,
  loadFromUpload,
  loadSample,
} from "./api.js";
import {
  clearInstantValue,
  instantValueHtml,
  setInstantValue,
} from "./instant-value.js";
import {
  fetchDerivedAtTime,
  fetchDerivedWaveform,
  fetchPhasorConfig,
  renderDerivedMetricCheckboxes,
  renderPhasorTable,
} from "./phasor.js";
import { TimelineRuler } from "./ruler.js";
import { EventBus } from "./core/bus.js";
import { AnalysisDock } from "./analyses/index.js";
import { removeGroup } from "./analyses/api.js";
import { openGroupDialog } from "./analyses/groups-dialog.js";
import { ProtectionView } from "./protection/view.js";
import {
  drawAnalogWaveform,
  drawDigitalWaveform,
  drawOverlayAnalog,
  interpolateValue,
} from "./waveform.js";

const state = {
  record: null,
  selectedChannels: new Set(),
  layout: "stacked",
  viewStart: 0,
  viewEnd: 1,
  cursorTime: null,
  selection: null,
  markers: [],
  waveformCache: null,
  markerCounter: 1,
  refreshGeneration: 0,
  analogFilter: "",
  digitalFilter: "",
  phasorConfig: null,
  voltageGroupId: null,
  currentGroupId: null,
  windowCycles: 1,
  estimator: "ls",
  selectedDerivedMetrics: new Set(),
};

const els = {
  fileInput: document.getElementById("file-input"),
  sampleSelect: document.getElementById("sample-select"),
  analogList: document.getElementById("analog-channels"),
  digitalList: document.getElementById("digital-channels"),
  analogSearch: document.getElementById("analog-search"),
  digitalSearch: document.getElementById("digital-search"),
  recordInfo: document.getElementById("record-info"),
  tracksContainer: document.getElementById("tracks-container"),
  emptyState: document.getElementById("empty-state"),
  rulerCanvas: document.getElementById("ruler-canvas"),
  selectionOverlay: document.getElementById("selection-overlay"),
  statusPosition: document.getElementById("status-position"),
  statusSelection: document.getElementById("status-selection"),
  statusZoom: document.getElementById("status-zoom"),
  statusMarkers: document.getElementById("status-markers"),
  navScrollBar: document.getElementById("nav-scroll-bar"),
  navScroll: document.getElementById("nav-scroll"),
  phasorSection: document.getElementById("phasor-section"),
  voltageGroup: document.getElementById("voltage-group"),
  currentGroup: document.getElementById("current-group"),
  windowCyclesSelect: document.getElementById("window-cycles"),
  derivedMetricsList: document.getElementById("derived-metrics-list"),
  phasorPanel: document.getElementById("phasor-panel"),
  phasorTableWrap: document.getElementById("phasor-table-wrap"),
  estimatorSelect: document.getElementById("estimator"),
  addGroupBtn: document.getElementById("add-group"),
  removeGroupBtn: document.getElementById("remove-group"),
  noGroupsHint: document.getElementById("no-groups-hint"),
  toggleDock: document.getElementById("toggle-dock"),
  dock: document.getElementById("analysis-dock"),
  groupDialog: document.getElementById("group-dialog"),
};

// ---------------------------------------------------------------------------
// Barramento de eventos + contexto compartilhado com os painéis de análise
// ---------------------------------------------------------------------------
const bus = new EventBus();
let lastEmittedView = null;

const analysisCtx = {
  bus,
  get record() {
    return state.record;
  },
  get cursorTime() {
    return state.cursorTime;
  },
  get selection() {
    return state.selection ? normalizeSelection(state.selection) : null;
  },
  get viewRange() {
    return { start: state.viewStart, end: state.viewEnd };
  },
  get voltageGroupId() {
    return state.voltageGroupId;
  },
  get currentGroupId() {
    return state.currentGroupId;
  },
  get phasorConfig() {
    return state.phasorConfig;
  },
  selectedAnalogChannels() {
    const analog = new Set((state.record?.analog_channels || []).map((c) => c.index));
    return Array.from(state.selectedChannels).filter((i) => analog.has(i)).sort((a, b) => a - b);
  },
  /** Move o cursor (ex.: clique num ponto da trajetória de impedância). */
  setCursor(time) {
    setCursorTime(time, { reveal: true });
  },
  openGroupDialog() {
    els.addGroupBtn.click();
  },
};

const emitCursor = () => bus.emit("cursor", state.cursorTime);
const emitSelection = () => bus.emit("selection", analysisCtx.selection);
const dock = new AnalysisDock(els.dock, analysisCtx);
const protectionView = new ProtectionView(document.getElementById("protection-view"), analysisCtx);

let navScrollSync = false;

const ruler = new TimelineRuler(els.rulerCanvas, (event) => {
  if (event.type === "cursor") {
    state.cursorTime = event.time;
    updateCursorLines();
    updateInstantValues();
    updatePhasorPanel();
    updateStatus();
    emitCursor();
  } else if (event.type === "selection") {
    state.selection = event.selection;
    updateSelectionOverlay();
    updateStatus();
    emitSelection();
  } else if (event.type === "add-marker") {
    addMarker(event.time);
  }
});

function init() {
  bindToolbar();
  bindDesktop();
  bindDock();
  loadSampleList();
  window.addEventListener("resize", debounce(() => {
    refreshView();
    dock.resize();
  }, 150));
  dock.init();
  protectionView.init();
  bindModeTabs();
}

function bindModeTabs() {
  const main = document.querySelector(".main");
  const protEl = document.getElementById("protection-view");
  const setMode = (mode) => {
    document.querySelectorAll(".mode-tab").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    document.body.classList.toggle("mode-prot", mode === "prot");
    main.classList.toggle("hidden", mode === "prot");
    protEl.classList.toggle("hidden", mode !== "prot");
    if (mode === "prot") {
      els.phasorPanel.classList.add("hidden");
    } else {
      els.phasorPanel.classList.toggle("hidden", !(state.voltageGroupId && state.currentGroupId));
      refreshView();
    }
    protectionView.setVisible(mode === "prot");
    try {
      localStorage.setItem("oscilo.mode", mode);
    } catch {
      /* ignora */
    }
  };
  document.querySelectorAll(".mode-tab").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  let saved = "osc";
  try {
    saved = localStorage.getItem("oscilo.mode") || "osc";
  } catch {
    /* ignora */
  }
  if (saved === "prot") setMode("prot");
}

function bindDock() {
  let open = true;
  try {
    open = localStorage.getItem("oscilo.dock.open") !== "0";
    const w = Number(localStorage.getItem("oscilo.dock.width"));
    if (w > 0) els.dock.style.width = `${w}px`;
  } catch {
    /* ignora */
  }
  const apply = () => {
    dock.setOpen(open);
    els.toggleDock.classList.toggle("active", open);
    refreshView();
  };
  els.toggleDock.addEventListener("click", () => {
    open = !open;
    try {
      localStorage.setItem("oscilo.dock.open", open ? "1" : "0");
    } catch {
      /* ignora */
    }
    apply();
  });
  dock.setOpen(open);
  els.toggleDock.classList.toggle("active", open);

  const resizer = els.dock.querySelector(".dock-resizer");
  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = els.dock.getBoundingClientRect().width;
    const onMove = (ev) => {
      const w = Math.min(Math.max(startW + (startX - ev.clientX), 300), window.innerWidth * 0.6);
      els.dock.style.width = `${w}px`;
      dock.resize();
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem("oscilo.dock.width", String(Math.round(els.dock.getBoundingClientRect().width)));
      } catch {
        /* ignora */
      }
      refreshView();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

function setCursorTime(time, { reveal = false } = {}) {
  if (!state.record || time == null) return;
  state.cursorTime = time;
  if (reveal && (time < state.viewStart || time > state.viewEnd)) {
    setViewAround(time, state.viewEnd - state.viewStart);
  }
  ruler.setCursor(time);
  updateCursorLines();
  updateInstantValues();
  updatePhasorPanel();
  updateStatus();
  emitCursor();
}

function bindToolbar() {
  els.fileInput.addEventListener("change", onFileSelected);
  els.sampleSelect.addEventListener("change", onSampleSelected);

  document.getElementById("zoom-in").addEventListener("click", () => zoomBy(0.5));
  document.getElementById("zoom-out").addEventListener("click", () => zoomBy(2));
  document.getElementById("zoom-fit").addEventListener("click", zoomFit);
  document.getElementById("zoom-selection").addEventListener("click", zoomToSelection);

  document.querySelectorAll('input[name="layout"]').forEach((input) => {
    input.addEventListener("change", () => {
      state.layout = input.value;
      refreshView();
    });
  });

  document.getElementById("add-marker").addEventListener("click", () => {
    if (state.cursorTime != null) addMarker(state.cursorTime);
  });
  document.getElementById("clear-markers").addEventListener("click", clearMarkers);
  document.getElementById("select-all-analog").addEventListener("click", selectDefaultAnalog);
  document.getElementById("clear-selection").addEventListener("click", clearChannelSelection);

  els.analogSearch.addEventListener("input", () => {
    state.analogFilter = els.analogSearch.value.trim().toLowerCase();
    filterChannelList("analog");
  });
  els.digitalSearch.addEventListener("input", () => {
    state.digitalFilter = els.digitalSearch.value.trim().toLowerCase();
    filterChannelList("digital");
  });

  els.navScroll.addEventListener("input", onNavScroll);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.selection && !els.groupDialog.open) {
      state.selection = null;
      ruler.setSelection(null);
      updateSelectionOverlay();
      updateStatus();
      emitSelection();
    }
  });

  els.voltageGroup.addEventListener("change", () => {
    state.voltageGroupId = els.voltageGroup.value || null;
    onGroupsChanged();
  });
  els.currentGroup.addEventListener("change", () => {
    state.currentGroupId = els.currentGroup.value || null;
    onGroupsChanged();
  });
  els.estimatorSelect.addEventListener("change", () => {
    state.estimator = els.estimatorSelect.value;
    refreshView();
    updatePhasorPanel();
  });
  els.addGroupBtn.addEventListener("click", () => {
    if (!state.record) return;
    openGroupDialog(els.groupDialog, state.record, ({ group, config }) => {
      if (group.quantity === "V") state.voltageGroupId = group.id;
      else state.currentGroupId = group.id;
      applyPhasorConfig(config);
    });
  });
  els.removeGroupBtn.addEventListener("click", async () => {
    if (!state.record) return;
    const manual = [state.voltageGroupId, state.currentGroupId].filter((id) => id?.startsWith("M:"));
    let config = null;
    for (const id of manual) {
      try {
        config = (await removeGroup(state.record.id, id)).config;
      } catch (err) {
        alert(err.message);
      }
    }
    if (config) {
      if (manual.includes(state.voltageGroupId)) state.voltageGroupId = null;
      if (manual.includes(state.currentGroupId)) state.currentGroupId = null;
      applyPhasorConfig(config);
    }
  });
  els.windowCyclesSelect.addEventListener("change", () => {
    state.windowCycles = Number(els.windowCyclesSelect.value);
    refreshView();
    updatePhasorPanel();
  });
}

async function loadSampleList() {
  els.sampleSelect.querySelectorAll("option:not(:first-child)").forEach((o) => o.remove());
  try {
    const { samples } = await listSamples();
    if (!samples.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Nenhum exemplo encontrado";
      opt.disabled = true;
      els.sampleSelect.appendChild(opt);
      return;
    }
    for (const sample of samples) {
      const opt = document.createElement("option");
      opt.value = sample.id;
      const label = sample.folder ? `${sample.folder} / ${sample.name}` : sample.name;
      opt.textContent = label;
      els.sampleSelect.appendChild(opt);
    }
  } catch (err) {
    console.warn("Não foi possível listar exemplos:", err);
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Erro ao carregar exemplos";
    opt.disabled = true;
    els.sampleSelect.appendChild(opt);
  }
}

async function onSampleSelected() {
  const sampleId = els.sampleSelect.value;
  if (!sampleId) return;
  setLoading("Carregando exemplo…");
  try {
    const record = await loadSample(sampleId);
    setRecord(record);
  } catch (err) {
    alert(`Erro ao carregar: ${err.message}`);
  } finally {
    setLoading(null);
  }
}

async function onFileSelected(e) {
  const files = Array.from(e.target.files || []);
  const cfg = files.find((f) => f.name.toLowerCase().endsWith(".cfg"));
  const dat = files.find((f) => f.name.toLowerCase().endsWith(".dat"));
  if (!cfg) {
    alert("Selecione pelo menos o arquivo .cfg (e o .dat correspondente).");
    return;
  }
  const sizeMb = ((cfg.size + (dat?.size || 0)) / 1048576).toFixed(0);
  setLoading(`Enviando e lendo ${escapeHtml(cfg.name)} (${sizeMb} MB)…`);
  try {
    const record = await loadFromUpload(cfg, dat);
    setRecord(record);
  } catch (err) {
    alert(`Erro ao carregar: ${err.message}`);
  } finally {
    setLoading(null);
    els.fileInput.value = "";
  }
}

// ---------------------------------------------------------------------------
// Versão desktop: abrir direto do disco + recentes
// ---------------------------------------------------------------------------
const RECENT_KEY = "oscilo.recent";
const RECENT_MAX = 12;

function readRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}

function pushRecent(path) {
  const list = [path, ...readRecent().filter((p) => p !== path)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignora */
  }
  renderRecent();
}

function renderRecent() {
  const sel = document.getElementById("recent-select");
  const list = readRecent();
  sel.innerHTML = '<option value="">Recentes…</option>' + list
    .map((p) => `<option value="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(p.split(/[\\/]/).slice(-2).join(" / "))}</option>`)
    .join("");
  sel.classList.toggle("hidden", !list.length);
}

async function openLocalPath(path) {
  if (!path) return;
  setLoading(`Lendo ${escapeHtml(path.split(/[\\/]/).pop())}…`);
  try {
    const record = await loadFromPath(path);
    setRecord(record);
    pushRecent(record.source_path || path);
    document.title = `${path.split(/[\\/]/).pop()} – Oscilo`;
  } catch (err) {
    alert(`Erro ao abrir ${path}:\n${err.message}`);
  } finally {
    setLoading(null);
  }
}

function bindDesktop() {
  if (!IS_DESKTOP) return;
  document.body.classList.add("is-desktop");
  const btn = document.getElementById("open-native");
  btn.classList.remove("hidden");
  // o upload pelo navegador continua disponível como alternativa
  document.querySelector(".file-btn").classList.add("hidden");
  btn.addEventListener("click", async () => {
    try {
      const path = await pickComtradeFile();
      if (path) openLocalPath(path);
    } catch (err) {
      console.warn("Diálogo nativo:", err);
      els.fileInput.click(); // alternativa: upload
    }
  });
  const recent = document.getElementById("recent-select");
  recent.addEventListener("change", () => {
    const p = recent.value;
    recent.value = "";
    if (p) openLocalPath(p);
  });
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
      e.preventDefault();
      btn.click();
    }
  });
  renderRecent();
  if (STARTUP_FILE) openLocalPath(STARTUP_FILE);
}

function setLoading(message) {
  document.body.classList.toggle("is-loading", !!message);
  let el = document.getElementById("loading-banner");
  if (!message) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "loading-banner";
    el.className = "loading-banner";
    document.body.appendChild(el);
  }
  el.innerHTML = `<span class="spinner"></span>${message}`;
}

function setRecord(record) {
  state.record = record;
  state.selectedChannels.clear();
  state.waveformCache = null;
  state.markers = [];
  state.markerCounter = 1;
  state.viewStart = 0;
  state.viewEnd = record.duration_s || 1;
  state.cursorTime = null;
  state.selection = null;
  state.analogFilter = "";
  state.digitalFilter = "";
  els.analogSearch.value = "";
  els.digitalSearch.value = "";

  renderRecordInfo();
  renderChannelLists();
  bus.emit("record", record);
  loadPhasorConfig();
  selectDefaultAnalog();
}

function onGroupsChanged() {
  const both = !!(state.voltageGroupId && state.currentGroupId);
  els.phasorPanel.classList.toggle("hidden", !both || document.body.classList.contains("mode-prot"));
  els.removeGroupBtn.classList.toggle(
    "hidden",
    ![state.voltageGroupId, state.currentGroupId].some((id) => id?.startsWith("M:"))
  );
  refreshView();
  updatePhasorPanel();
  bus.emit("groups", state.phasorConfig);
}

async function loadPhasorConfig() {
  state.phasorConfig = null;
  state.selectedDerivedMetrics.clear();
  state.voltageGroupId = null;
  state.currentGroupId = null;
  els.phasorSection.classList.add("hidden");
  els.phasorPanel.classList.add("hidden");

  if (!state.record) return;

  try {
    const config = await fetchPhasorConfig(state.record.id);
    els.estimatorSelect.innerHTML = (config.estimators || [])
      .map((e) => `<option value="${escapeHtml(e.id)}" title="${escapeHtml(e.description)}">${escapeHtml(e.name)}</option>`)
      .join("");
    els.estimatorSelect.value = state.estimator;
    els.windowCyclesSelect.value = String(state.windowCycles);
    applyPhasorConfig(config);
  } catch (err) {
    console.warn("Fasores:", err);
  }
}

/** Atualiza seletores de grupo e métricas a partir da configuração do backend. */
function applyPhasorConfig(config) {
  state.phasorConfig = config;
  const vIds = config.voltage_groups.map((g) => g.id);
  const iIds = config.current_groups.map((g) => g.id);
  if (!vIds.includes(state.voltageGroupId)) state.voltageGroupId = config.default_voltage_group;
  if (!iIds.includes(state.currentGroupId)) state.currentGroupId = config.default_current_group;

  const opts = (groups) =>
    `<option value="">—</option>` +
    groups
      .map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.label)}${g.source === "manual" ? " (manual)" : ""}</option>`)
      .join("");
  els.voltageGroup.innerHTML = opts(config.voltage_groups);
  els.currentGroup.innerHTML = opts(config.current_groups);
  els.voltageGroup.value = state.voltageGroupId || "";
  els.currentGroup.value = state.currentGroupId || "";
  els.noGroupsHint.classList.toggle("hidden", vIds.length > 0 && iIds.length > 0);

  renderDerivedMetricCheckboxes(
    els.derivedMetricsList,
    config.metrics,
    state.selectedDerivedMetrics,
    (key, checked) => {
      if (checked) state.selectedDerivedMetrics.add(key);
      else state.selectedDerivedMetrics.delete(key);
      refreshView();
    },
    config.metric_groups
  );

  els.phasorSection.classList.remove("hidden");
  renderPhasorTable(els.phasorTableWrap, []);
  onGroupsChanged();
}

function renderRecordInfo() {
  const r = state.record;
  if (!r) {
    els.recordInfo.innerHTML = "";
    return;
  }
  els.recordInfo.innerHTML = `
    <strong>${escapeHtml(r.station || "—")}</strong><br/>
    ${escapeHtml(r.device || "")}<br/>
    Taxa: ${r.sample_rate_hz.toFixed(0)} Hz · ${r.total_samples} amostras · ${formatTime(r.duration_s)}<br/>
    Início: ${escapeHtml(r.start_time)}<br/>
    Trigger: ${escapeHtml(r.trigger_time)}
  `;
}

function renderChannelLists() {
  els.analogList.innerHTML = "";
  els.digitalList.innerHTML = "";
  if (!state.record) return;

  for (const ch of state.record.analog_channels) {
    els.analogList.appendChild(createChannelItem(ch));
  }
  for (const ch of state.record.digital_channels) {
    els.digitalList.appendChild(createChannelItem(ch));
  }
}

function createChannelItem(ch) {
  const div = document.createElement("div");
  div.className = "channel-item";
  div.dataset.index = String(ch.index);
  div.dataset.kind = ch.kind;
  div.dataset.search = ch.name.toLowerCase();
  const id = `ch-${ch.index}`;
  div.innerHTML = `
    <input type="checkbox" id="${id}" data-index="${ch.index}" />
    <label for="${id}">
      ${escapeHtml(ch.name)}
      ${ch.unit ? `<span class="unit"> (${escapeHtml(ch.unit)})</span>` : ""}
    </label>
  `;
  div.querySelector("input").addEventListener("change", (e) => {
    if (e.target.checked) state.selectedChannels.add(ch.index);
    else state.selectedChannels.delete(ch.index);
    refreshView();
    bus.emit("channels");
  });
  return div;
}

function filterChannelList(kind) {
  const filter = kind === "analog" ? state.analogFilter : state.digitalFilter;
  const list = kind === "analog" ? els.analogList : els.digitalList;
  list.querySelectorAll(".channel-item").forEach((item) => {
    const text = item.dataset.search || "";
    item.style.display = !filter || text.includes(filter) ? "" : "none";
  });
}

function selectDefaultAnalog() {
  if (!state.record) return;
  state.selectedChannels.clear();

  const patterns = [
    /:V A\b/i,
    /:V B\b/i,
    /:V C\b/i,
    /:Ix\b/i,
    /:I A\b/i,
    /:I B\b/i,
    /:I C\b/i,
    /:IN\b/i,
  ];

  const matched = [];
  for (const ch of state.record.analog_channels) {
    if (patterns.some((p) => p.test(ch.name))) matched.push(ch.index);
  }

  const toSelect = matched.length
    ? matched.slice(0, 8)
    : state.record.analog_channels.slice(0, 4).map((c) => c.index);
  toSelect.forEach((idx) => state.selectedChannels.add(idx));
  syncChannelCheckboxes();
  refreshView();
  bus.emit("channels");
}

function clearChannelSelection() {
  state.selectedChannels.clear();
  syncChannelCheckboxes();
  refreshView();
  bus.emit("channels");
}

function syncChannelCheckboxes() {
  document.querySelectorAll(".channel-item input").forEach((input) => {
    input.checked = state.selectedChannels.has(Number(input.dataset.index));
  });
}

function computeMaxPoints() {
  const width = Math.max(els.tracksContainer.clientWidth - 200, 400);
  const startSample = timeToSample(state.viewStart);
  const endSample = timeToSample(state.viewEnd) + 1;
  const samplesInView = Math.max(1, endSample - startSample);
  return Math.min(Math.max(width * 2, 2000), samplesInView, 20000);
}

function applyViewChrome() {
  ruler.setView(state.viewStart, state.viewEnd);
  ruler.setCursor(state.cursorTime);
  ruler.setSelection(state.selection);
  ruler.setMarkers(state.markers);
  updateCursorLines();
  updateMarkerLines();
  updateSelectionOverlay();
  updateInstantValues();
  updatePhasorPanel();
  updateStatus();
  updateNavScroll();
  if (state.record && (!lastEmittedView || lastEmittedView.start !== state.viewStart || lastEmittedView.end !== state.viewEnd)) {
    lastEmittedView = { start: state.viewStart, end: state.viewEnd };
    bus.emit("view", lastEmittedView);
  }
}

async function refreshView(options = {}) {
  const { skipDerived = false, derivedOnly = false } = options;
  const generation = ++state.refreshGeneration;
  const hasChannels = state.selectedChannels.size > 0;
  const hasDerived =
    state.selectedDerivedMetrics.size > 0 && state.phasorConfig && state.voltageGroupId && state.currentGroupId;

  if (!derivedOnly && (!state.record || (!hasChannels && !hasDerived))) {
    els.emptyState.style.display = "flex";
    els.tracksContainer.querySelectorAll(".track-row, .overlay-stack").forEach((el) => el.remove());
    state.waveformCache = null;
    ruler.setView(0, 1);
    ruler.draw();
    updateStatus();
    updateNavScroll();
    return;
  }

  els.emptyState.style.display = "none";

  const startSample = timeToSample(state.viewStart);
  const endSample = timeToSample(state.viewEnd) + 1;
  const maxPoints = computeMaxPoints();
  let channels = [];

  try {
    if (!derivedOnly) {
      if (hasChannels) {
        const indices = Array.from(state.selectedChannels).sort((a, b) => a - b);
        const data = await fetchWaveform(
          state.record.id,
          indices,
          { start: startSample, end: endSample },
          maxPoints
        );
        if (generation !== state.refreshGeneration) return;
        channels = data.channels;
        state.waveformCache = { ...data, channels: [...channels] };
      } else {
        state.waveformCache = { channels: [] };
        channels = [];
      }
    } else {
      channels = (state.waveformCache?.channels || []).filter((ch) => ch.kind !== "derived");
    }

    if (hasDerived && !skipDerived) {
      try {
        const derived = await fetchDerivedWaveform(
          state.record.id,
          state.voltageGroupId,
          state.currentGroupId,
          Array.from(state.selectedDerivedMetrics),
          { start: startSample, end: endSample },
          state.windowCycles,
          maxPoints,
          state.estimator
        );
        if (generation !== state.refreshGeneration) return;
        channels = [...channels.filter((ch) => ch.kind !== "derived"), ...derived.channels];
        state.waveformCache.channels = channels;
      } catch (derivedErr) {
        console.warn("Grandezas derivadas:", derivedErr);
        if (!hasChannels && !derivedOnly) throw derivedErr;
      }
    }

    if (generation !== state.refreshGeneration) return;

    renderTracks();
    redrawAllCanvases();
    applyViewChrome();
  } catch (err) {
    console.error(err);
    if (generation === state.refreshGeneration) {
      applyViewChrome();
    }
  }
}

function renderTracks() {
  els.tracksContainer.querySelectorAll(".track-row, .overlay-stack").forEach((el) => el.remove());
  const channels = state.waveformCache?.channels || [];
  if (!channels.length) return;

  if (state.layout === "overlay") {
    renderOverlayTracks(channels);
  } else {
    channels.forEach((ch) => renderStackedTrack(ch));
  }
}

function renderStackedTrack(ch) {
  const row = document.createElement("div");
  row.className = "track-row";
  if (ch.kind === "derived") row.classList.add("derived");
  row.dataset.channelIndex = String(ch.index);

  const gutter = document.createElement("div");
  gutter.className = "track-gutter-panel";
  const metaLabel = ch.kind === "derived" ? "calculado" : ch.kind === "digital" ? "digital" : escapeHtml(ch.unit || "analógico");
  gutter.innerHTML = `
    <div class="name">${escapeHtml(ch.name)}</div>
    <div class="meta">${metaLabel}</div>
    ${instantValueHtml(ch.index)}
  `;

  const wrap = document.createElement("div");
  wrap.className = "track-canvas-wrap";
  wrap.style.height = ch.kind === "digital" ? "72px" : "110px";

  const canvas = document.createElement("canvas");
  canvas.dataset.channelIndex = String(ch.index);
  wrap.appendChild(canvas);

  const cursor = document.createElement("div");
  cursor.className = "cursor-line";
  wrap.appendChild(cursor);

  for (const marker of state.markers) {
    wrap.appendChild(createMarkerLine(marker));
  }

  bindTrackInteraction(wrap);
  row.appendChild(gutter);
  row.appendChild(wrap);
  els.tracksContainer.appendChild(row);
}

function renderOverlayTracks(channels) {
  const stack = document.createElement("div");
  stack.className = "overlay-stack";

  const analog = channels.filter((c) => c.kind === "analog");
  const digital = channels.filter((c) => c.kind === "digital");

  if (analog.length) {
    stack.appendChild(createOverlayRow("Analógicos (sobrepostos)", analog, false));
  }
  digital.forEach((ch) => {
    stack.appendChild(createOverlayRow(ch.name, [ch], true, ch));
  });

  els.tracksContainer.appendChild(stack);
}

function createOverlayRow(title, channels, small, channelMeta = null) {
  const row = document.createElement("div");
  row.className = "track-row";

  const gutter = document.createElement("div");
  gutter.className = "track-gutter-panel";
  if (channelMeta) {
    gutter.innerHTML = `
      <div class="name">${escapeHtml(title)}</div>
      <div class="meta">digital</div>
      ${instantValueHtml(channelMeta.index)}
    `;
  } else {
    gutter.innerHTML = `<div class="name">${escapeHtml(title)}</div>`;
  }

  const wrap = document.createElement("div");
  wrap.className = "track-canvas-wrap";
  wrap.style.height = small ? "72px" : "240px";

  const canvas = document.createElement("canvas");
  if (channelMeta) canvas.dataset.channelIndex = String(channelMeta.index);
  else canvas.dataset.overlayAnalog = "1";
  wrap.appendChild(canvas);

  const cursor = document.createElement("div");
  cursor.className = "cursor-line";
  wrap.appendChild(cursor);

  for (const marker of state.markers) {
    wrap.appendChild(createMarkerLine(marker));
  }

  bindTrackInteraction(wrap);
  row.appendChild(gutter);
  row.appendChild(wrap);
  return row;
}

function bindTrackInteraction(wrap) {
  wrap.addEventListener("mousemove", (e) => onTrackMouseMove(e, wrap));
  wrap.addEventListener("mousedown", (e) => onTrackMouseDown(e, wrap));
}

function redrawAllCanvases() {
  const channels = state.waveformCache?.channels || [];
  const byIndex = new Map(channels.map((ch) => [String(ch.index), ch]));

  document.querySelectorAll("canvas[data-channel-index]").forEach((canvas) => {
    const ch = byIndex.get(String(canvas.dataset.channelIndex));
    if (!ch) return;
    drawChannelCanvas(canvas, ch);
  });

  const analog = channels.filter((c) => c.kind === "analog");
  document.querySelectorAll("canvas[data-overlay-analog]").forEach((canvas) => {
    drawOverlayAnalog(
      canvas,
      analog.map((ch, i) => ({
        times: ch.times,
        values: ch.values,
        yMin: ch.cfg_min ?? ch.min,
        yMax: ch.cfg_max ?? ch.max,
        color: palette[i % palette.length],
      })),
      { viewStart: state.viewStart, viewEnd: state.viewEnd }
    );
  });

  updateCursorLines();
  updateMarkerLines();
}

function drawChannelCanvas(canvas, ch) {
  const opts = {
    viewStart: state.viewStart,
    viewEnd: state.viewEnd,
    unit: ch.unit,
    yMin: ch.kind === "analog" ? ch.cfg_min ?? ch.min : undefined,
    yMax: ch.kind === "analog" ? ch.cfg_max ?? ch.max : undefined,
    color: ch.kind === "derived" ? "#6a4a8a" : undefined,
  };

  if (ch.kind === "digital") {
    drawDigitalWaveform(canvas, ch.times, ch.values, opts);
  } else {
    drawAnalogWaveform(canvas, ch.times, ch.values, opts);
  }
}

function onTrackMouseMove(e, wrap) {
  const rect = wrap.getBoundingClientRect();
  const time = xToTime(e.clientX - rect.left, rect.width);
  state.cursorTime = time;
  ruler.setCursor(time);
  updateCursorLines();
  updateInstantValues();
  updatePhasorPanel();
  updateStatus();
  emitCursor();
}

function onTrackMouseDown(e, wrap) {
  const rect = wrap.getBoundingClientRect();
  const startX = e.clientX - rect.left;
  const anchor = xToTime(startX, rect.width);
  let moved = false;

  const onMove = (ev) => {
    const x = ev.clientX - rect.left;
    if (Math.abs(x - startX) > 4) moved = true;
    if (moved) {
      const t = xToTime(x, rect.width);
      state.selection = { start: anchor, end: t };
      ruler.setSelection(normalizeSelection(state.selection));
      updateSelectionOverlay();
      updateStatus();
      emitSelection();
    } else {
      state.cursorTime = xToTime(x, rect.width);
      ruler.setCursor(state.cursorTime);
      updateCursorLines();
      updateInstantValues();
      updateStatus();
      emitCursor();
    }
  };

  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function updateCursorLines() {
  document.querySelectorAll(".track-canvas-wrap").forEach((wrap) => {
    const line = wrap.querySelector(".cursor-line");
    if (!line) return;
    if (state.cursorTime == null) {
      line.style.display = "none";
      return;
    }
    line.style.display = "block";
    line.style.left = `${timeToX(state.cursorTime, wrap.clientWidth)}px`;
  });
}

function updateMarkerLines() {
  document.querySelectorAll(".marker-line").forEach((line) => {
    const wrap = line.parentElement;
    line.style.left = `${timeToX(Number(line.dataset.time), wrap.clientWidth)}px`;
  });
}

function updateSelectionOverlay() {
  const wrap = els.rulerCanvas.parentElement;
  const w = wrap.clientWidth;
  if (!state.selection || !w) {
    els.selectionOverlay.classList.add("hidden");
    return;
  }
  const sel = normalizeSelection(state.selection);
  const x1 = timeToX(sel.start, w);
  const x2 = timeToX(sel.end, w);
  els.selectionOverlay.classList.remove("hidden");
  els.selectionOverlay.style.left = `${Math.min(x1, x2)}px`;
  els.selectionOverlay.style.width = `${Math.abs(x2 - x1)}px`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const panRefreshView = debounce(() => {
  const hasChannels = state.selectedChannels.size > 0;
  refreshView({ skipDerived: hasChannels });
}, 30);
const panRefreshDerived = debounce(() => refreshView({ derivedOnly: true }), 250);

const fetchExactInstantValues = debounce(async () => {
  if (state.cursorTime == null || !state.record || !state.waveformCache) return;
  const indices = state.waveformCache.channels
    .map((ch) => ch.index)
    .filter((idx) => typeof idx === "number" || /^\d+$/.test(String(idx)));
  try {
    const result = await fetchValueAtTime(state.record.id, indices, state.cursorTime);
    const byIndex = new Map(result.channels.map((ch) => [ch.index, ch]));
    document.querySelectorAll(".instant-value").forEach((el) => {
      const ch = byIndex.get(Number(el.dataset.instant));
      if (ch) {
        setInstantValue(el, ch.value, ch.unit, ch.kind, result.time_s);
      }
    });
  } catch (err) {
    console.warn("Valor instantâneo:", err);
  }
}, 80);

function updateInstantValues() {
  if (state.cursorTime == null || !state.waveformCache) {
    document.querySelectorAll(".instant-value").forEach(clearInstantValue);
    return;
  }

  const byIndex = new Map(state.waveformCache.channels.map((ch) => [String(ch.index), ch]));
  document.querySelectorAll(".instant-value").forEach((el) => {
    const ch = byIndex.get(String(el.dataset.instant));
    if (!ch) {
      clearInstantValue(el);
      return;
    }
    const value = interpolateValue(ch.times, ch.values, state.cursorTime);
    const kind = ch.kind === "derived" ? "analog" : ch.kind;
    setInstantValue(el, value, ch.unit, kind, state.cursorTime);
  });

  fetchExactInstantValues();
}

const updatePhasorPanel = debounce(async () => {
  if (!state.phasorConfig || !state.record || state.cursorTime == null || !state.voltageGroupId || !state.currentGroupId) {
    renderPhasorTable(els.phasorTableWrap, []);
    return;
  }
  try {
    const result = await fetchDerivedAtTime(
      state.record.id,
      state.voltageGroupId,
      state.currentGroupId,
      state.cursorTime,
      state.windowCycles,
      state.estimator
    );
    renderPhasorTable(els.phasorTableWrap, result.metrics);
  } catch (err) {
    console.warn("Painel fasorial:", err);
  }
}, 100);

function getViewSpan() {
  return Math.max(state.viewEnd - state.viewStart, 1e-9);
}

function updateNavScroll() {
  if (!state.record) {
    els.navScrollBar.classList.add("hidden");
    return;
  }

  const duration = state.record.duration_s;
  const span = getViewSpan();
  const canPan = span < duration * 0.999;

  if (!canPan) {
    els.navScrollBar.classList.add("hidden");
    return;
  }

  els.navScrollBar.classList.remove("hidden");
  const maxStart = duration - span;
  const ratio = maxStart > 0 ? state.viewStart / maxStart : 0;

  navScrollSync = true;
  els.navScroll.value = String(Math.round(Math.min(1, Math.max(0, ratio)) * 1000));
  navScrollSync = false;
}

function onNavScroll() {
  if (navScrollSync || !state.record) return;

  const duration = state.record.duration_s;
  const span = getViewSpan();
  const maxStart = Math.max(duration - span, 0);
  const ratio = Number(els.navScroll.value) / 1000;

  state.viewStart = ratio * maxStart;
  state.viewEnd = state.viewStart + span;
  applyViewChrome();
  panRefreshView();
  if (state.selectedChannels.size > 0 && state.selectedDerivedMetrics.size > 0) {
    panRefreshDerived();
  }
}

function addMarker(time) {
  state.markers.push({ time, label: `M${state.markerCounter++}` });
  ruler.setMarkers(state.markers);
  refreshView();
}

function clearMarkers() {
  state.markers = [];
  ruler.setMarkers([]);
  refreshView();
}

function zoomBy(factor) {
  const center = state.cursorTime ?? (state.viewStart + state.viewEnd) / 2;
  const span = (state.viewEnd - state.viewStart) * factor;
  setViewAround(center, span);
}

function zoomFit() {
  if (!state.record) return;
  state.viewStart = 0;
  state.viewEnd = state.record.duration_s;
  applyViewChrome();
  refreshView();
}

function zoomToSelection() {
  if (!state.selection) {
    alert("Selecione um intervalo arrastando o mouse na régua ou nas faixas.");
    return;
  }
  const sel = normalizeSelection(state.selection);
  const span = sel.end - sel.start;
  if (span < 1e-6) {
    alert("A seleção é muito pequena. Arraste sobre um intervalo maior.");
    return;
  }
  const pad = span * 0.02;
  state.viewStart = Math.max(0, sel.start - pad);
  state.viewEnd = Math.min(state.record.duration_s, sel.end + pad);
  applyViewChrome();
  refreshView();
}

function setViewAround(center, span) {
  const duration = state.record?.duration_s || 1;
  span = Math.max(duration / 500, Math.min(duration, span));
  let start = center - span / 2;
  let end = center + span / 2;
  if (start < 0) {
    end -= start;
    start = 0;
  }
  if (end > duration) {
    start -= end - duration;
    end = duration;
  }
  state.viewStart = Math.max(0, start);
  state.viewEnd = Math.min(duration, end);
  applyViewChrome();
  refreshView();
}

function timeToSample(time) {
  return Math.max(0, Math.floor(time * state.record.sample_rate_hz));
}

function timeToX(time, width) {
  const span = state.viewEnd - state.viewStart || 1;
  return ((time - state.viewStart) / span) * width;
}

function xToTime(x, width) {
  const span = state.viewEnd - state.viewStart || 1;
  return state.viewStart + (x / width) * span;
}

function normalizeSelection(sel) {
  return { start: Math.min(sel.start, sel.end), end: Math.max(sel.start, sel.end) };
}

function createMarkerLine(marker) {
  const line = document.createElement("div");
  line.className = "marker-line";
  line.dataset.label = marker.label;
  line.dataset.time = String(marker.time);
  return line;
}

function updateStatus() {
  els.statusPosition.textContent = `Posição: ${state.cursorTime != null ? formatTime(state.cursorTime) : "—"}`;
  if (state.selection) {
    const sel = normalizeSelection(state.selection);
    els.statusSelection.textContent = `Seleção: ${formatTime(sel.start)} → ${formatTime(sel.end)} (${formatTime(sel.end - sel.start)})`;
  } else {
    els.statusSelection.textContent = "Seleção: —";
  }
  const duration = state.record?.duration_s || 1;
  const pct = ((duration / (state.viewEnd - state.viewStart)) * 100).toFixed(0);
  els.statusZoom.textContent = `Zoom: ${pct}%`;
  els.statusMarkers.textContent = `Marcadores: ${state.markers.length}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const palette = ["#3a6ea5", "#8a5a3a", "#5a8a5a", "#7a3a7a", "#3a7a7a", "#a05a3a"];

init();
