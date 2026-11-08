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
import { removeGroup, runAnalysis } from "./analyses/api.js";
import { openGroupDialog } from "./analyses/groups-dialog.js";
import { ProtectionView } from "./protection/view.js";
import { openReportDialog } from "./report.js";
import { initAbout } from "./about.js";
import { mergeInfoHtml, openMergeDialog } from "./merge.js";
import { T as TH, getTheme, initTheme, setTheme } from "./core/theme.js";
import { addGroup } from "./analyses/api.js";
import {
  drawAnalogWaveform,
  drawDigitalWaveform,
  drawOverlayAnalog,
  interpolateValue,
} from "./waveform.js";

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignora */
  }
}

const state = {
  record: null,
  selectedChannels: new Set(),
  layout: "stacked",
  density: readPref("oscilo.density", "compact"),
  onOpen: readPref("oscilo.onopen", "all"),
  viewStart: 0,
  viewEnd: 1,
  cursorTime: null,
  selection: null,
  markers: [],
  fixedCursors: { c1: null, c2: null },
  sourceName: "",
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
  sampleList: document.getElementById("sample-list"),
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
  statusCursors: document.getElementById("status-cursors"),
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
  rotationHint: document.getElementById("rotation-hint"),
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
  /** Cursores fixos C1/C2 (s) – null quando não posicionados. */
  get fixedCursors() {
    return { ...state.fixedCursors };
  },
  get sourceName() {
    return state.sourceName;
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
  /** Estimador e janela (ciclos) do painel de fasores – vão para o relatório. */
  get estimator() {
    return state.estimator;
  },
  get windowCycles() {
    return state.windowCycles;
  },
  selectedAnalogChannels() {
    const analog = new Set((state.record?.analog_channels || []).map((c) => c.index));
    return Array.from(state.selectedChannels).filter((i) => analog.has(i)).sort((a, b) => a - b);
  },
  /** Todos os canais exibidos (analógicos e digitais), em ordem. */
  selectedChannels() {
    return Array.from(state.selectedChannels).sort((a, b) => a - b);
  },
  /** Mostra um canal na oscilografia (ex.: clique num evento digital). */
  addChannel(index) {
    if (state.selectedChannels.has(index)) return;
    state.selectedChannels.add(index);
    syncChannelCheckboxes();
    refreshView();
    bus.emit("channels");
  },
  /** Imagem PNG (data URL) das faixas visíveis, com régua, marcadores e C1/C2. */
  captureView(options) {
    return captureView(options);
  },
  openReport() {
    openReportDialog(analysisCtx);
  },
  /** Executa fn com o tema claro (figuras do relatório sempre claras). */
  withLightTheme(fn) {
    const prev = getTheme();
    if (prev === "light") return fn();
    setTheme("light", { persist: false });
    try {
      return fn();
    } finally {
      setTheme(prev, { persist: false });
    }
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
const emitFixedCursors = () => bus.emit("cursors", analysisCtx.fixedCursors);
const emitFixedCursorsLater = debounce(emitFixedCursors, 150);
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

function bindTheme() {
  const btn = document.getElementById("theme-toggle");
  const sync = () => {
    const dark = getTheme() === "dark";
    btn.textContent = dark ? "☀" : "☾";
    btn.title = dark ? "Tema claro" : "Tema escuro";
  };
  window.addEventListener("oscilo-theme", () => {
    sync();
    redrawAllCanvases();
    ruler.draw();
    dock.active?.instance?.resize?.();
    if (document.body.classList.contains("mode-prot")) protectionView.setVisible(true);
  });
  btn.addEventListener("click", () => setTheme(getTheme() === "dark" ? "light" : "dark"));
  initTheme();
  sync();
}

function init() {
  bindTheme();
  appendFixedCursorLines(els.rulerCanvas.parentElement);
  bindSideTabs();
  bindPhasorPanel();
  bindMenus();
  bindSidebarToggle();
  bindToolbar();
  bindDesktop();
  bindDock();
  loadSampleList();
  window.addEventListener("resize", debounce(() => {
    refreshView();
    dock.resize();
  }, 150));
  dock.init().then(renderAnalysesMenu);
  protectionView.init();
  bindModeTabs();
}

// ---------------------------------------------------------------------------
// Barra lateral em abas (Analógicos | Digitais | Fasores)
// ---------------------------------------------------------------------------
function setSideTab(name) {
  const tab = document.querySelector(`.side-tab[data-pane="${name}"]`);
  if (!tab || tab.disabled) name = "analog";
  document.querySelectorAll(".side-tab").forEach((b) => b.classList.toggle("active", b.dataset.pane === name));
  document.querySelectorAll(".side-pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
  try {
    localStorage.setItem("oscilo.sideTab", name);
  } catch {
    /* ignora */
  }
}

function bindSideTabs() {
  document.querySelectorAll(".side-tab").forEach((b) => b.addEventListener("click", () => setSideTab(b.dataset.pane)));
  let saved = "analog";
  try {
    saved = localStorage.getItem("oscilo.sideTab") || "analog";
  } catch {
    /* ignora */
  }
  setSideTab(saved);
}

/** Habilita a aba Fasores só quando o registro tem configuração fasorial. */
function updateSideTabs() {
  const tab = document.getElementById("tab-phasor");
  const available = !els.phasorSection.classList.contains("hidden");
  tab.disabled = !available;
  let wanted = "analog";
  try {
    wanted = localStorage.getItem("oscilo.sideTab") || "analog";
  } catch {
    /* ignora */
  }
  const active = document.querySelector(".side-tab.active")?.dataset.pane;
  if (active === "phasor" && !available) setSideTab("analog");
  else if (wanted === "phasor" && available && active !== "phasor") setSideTab("phasor");
}

function bindPhasorPanel() {
  const header = els.phasorPanel.querySelector(".phasor-panel-header");
  let collapsed = false;
  try {
    collapsed = localStorage.getItem("oscilo.phasorPanel.collapsed") === "1";
  } catch {
    /* ignora */
  }
  els.phasorPanel.classList.toggle("collapsed", collapsed);
  header.addEventListener("click", () => {
    collapsed = !collapsed;
    els.phasorPanel.classList.toggle("collapsed", collapsed);
    try {
      localStorage.setItem("oscilo.phasorPanel.collapsed", collapsed ? "1" : "0");
    } catch {
      /* ignora */
    }
    dock.resize();
  });
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

// ---------------------------------------------------------------------------
// Painel de análises sob demanda (fechado por padrão; abre pelo menu Análises)
// ---------------------------------------------------------------------------
function setDockOpen(open) {
  dock.setOpen(open);
  els.dock.classList.toggle("hidden", !open);
  writePref("oscilo.dock.open", open ? "1" : "0");
  refreshView();
  dock.resize();
}

function openAnalysis(viewId) {
  dock.activateById(viewId);
  setDockOpen(true);
}

function renderAnalysesMenu() {
  const list = document.getElementById("analyses-list");
  list.innerHTML = dock.panels
    .map((p) => `<button type="button" class="menu-item" data-view="${escapeHtml(p.view.id)}" title="${escapeHtml(p.schema.description || "")}">${escapeHtml(p.view.title)}</button>`)
    .join("") + '<div class="menu-sep"></div><button type="button" class="menu-item" data-view="__close">Fechar painel</button>';
  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (!b) return;
    if (b.dataset.view === "__close") setDockOpen(false);
    else openAnalysis(b.dataset.view);
  });
}

function bindDock() {
  try {
    const w = Number(localStorage.getItem("oscilo.dock.width"));
    if (w > 0) els.dock.style.width = `${w}px`;
  } catch {
    /* ignora */
  }
  const open = readPref("oscilo.dock.open", "0") === "1";
  dock.setOpen(open);
  els.dock.classList.toggle("hidden", !open);
  document.getElementById("dock-close").addEventListener("click", () => setDockOpen(false));
  document.getElementById("dock-expand").addEventListener("click", () => {
    els.dock.classList.toggle("expanded");
    refreshView();
    dock.resize();
  });

  const resizer = els.dock.querySelector(".dock-resizer");
  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    els.dock.classList.remove("expanded");
    const startX = e.clientX;
    const startW = els.dock.getBoundingClientRect().width;
    const onMove = (ev) => {
      const w = Math.min(Math.max(startW + (startX - ev.clientX), 280), window.innerWidth * 0.7);
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

// ---------------------------------------------------------------------------
// Menus suspensos da barra (Arquivo, Exibir, Análises)
// ---------------------------------------------------------------------------
function closeMenus(except = null) {
  document.querySelectorAll(".menu.open").forEach((m) => {
    if (m !== except) m.classList.remove("open");
  });
}

function bindMenus() {
  document.querySelectorAll(".menu").forEach((menu) => {
    menu.querySelector(".menu-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = !menu.classList.contains("open");
      closeMenus(menu);
      menu.classList.toggle("open", willOpen);
    });
    menu.querySelector(".menu-pop").addEventListener("click", (e) => {
      // botões fecham o menu; opções (rádio) deixam aberto para comparar
      if (e.target.closest("button.menu-item, label.file-btn")) closeMenus();
    });
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".menu")) closeMenus();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenus();
  });

  const setRadio = (name, value) => {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  };
  setRadio("density", state.density);
  setRadio("onopen", state.onOpen);
  document.querySelectorAll('input[name="density"]').forEach((input) => input.addEventListener("change", () => {
    state.density = input.value;
    writePref("oscilo.density", state.density);
    refreshView();
  }));
  document.querySelectorAll('input[name="onopen"]').forEach((input) => input.addEventListener("change", () => {
    state.onOpen = input.value;
    writePref("oscilo.onopen", state.onOpen);
  }));
}

function bindSidebarToggle() {
  const apply = (hidden) => {
    document.body.classList.toggle("sidebar-hidden", hidden);
    writePref("oscilo.sidebar.hidden", hidden ? "1" : "0");
    refreshView();
    dock.resize();
  };
  document.body.classList.toggle("sidebar-hidden", readPref("oscilo.sidebar.hidden", "0") === "1");
  document.getElementById("toggle-sidebar").addEventListener("click", () => {
    apply(!document.body.classList.contains("sidebar-hidden"));
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
  els.sampleList.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sample]");
    if (b) onSampleSelected(b.dataset.sample);
  });

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
  document.getElementById("show-all").addEventListener("click", () => selectChannels("all"));
  document.getElementById("clear-selection").addEventListener("click", clearChannelSelection);
  document.querySelectorAll(".list-actions [data-check]").forEach((b) => b.addEventListener("click", () => checkListed(b.dataset.check, b.dataset.on === "1")));

  els.analogSearch.addEventListener("input", () => {
    state.analogFilter = els.analogSearch.value.trim().toLowerCase();
    filterChannelList("analog");
  });
  els.digitalSearch.addEventListener("input", () => {
    state.digitalFilter = els.digitalSearch.value.trim().toLowerCase();
    filterChannelList("digital");
  });

  els.navScroll.addEventListener("input", onNavScroll);

  document.getElementById("set-c1").addEventListener("click", () => setFixedCursor("c1"));
  document.getElementById("set-c2").addEventListener("click", () => setFixedCursor("c2"));
  document.getElementById("clear-cursors").addEventListener("click", () => {
    state.fixedCursors = { c1: null, c2: null };
    updateFixedCursorLines();
    updateStatus();
    emitFixedCursors();
  });
  document.getElementById("open-report").addEventListener("click", () => openReportDialog(analysisCtx));
  initAbout();
  document.getElementById("open-merge").addEventListener("click", openMerge);
  els.recordInfo.addEventListener("click", (e) => {
    if (e.target.closest(".mg-adjust")) openMerge();
  });
  els.rotationHint.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-swap]");
    if (btn) swapGroupPhases(btn.dataset.swap);
  });

  window.addEventListener("keydown", (e) => {
    const typing = e.target.closest?.("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]");
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "1" || e.key === "2")
        && !document.body.classList.contains("mode-prot")) {
      setFixedCursor(e.key === "1" ? "c1" : "c2");
      e.preventDefault();
      return;
    }
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
  try {
    const { samples } = await listSamples();
    els.sampleList.innerHTML = samples.length
      ? samples.map((sample) => `<button type="button" class="menu-item" data-sample="${escapeHtml(sample.id)}">${escapeHtml(sample.folder || sample.name)}</button>`).join("")
      : '<span class="menu-note">Nenhum exemplo encontrado</span>';
  } catch (err) {
    console.warn("Não foi possível listar exemplos:", err);
    els.sampleList.innerHTML = '<span class="menu-note">Erro ao carregar exemplos</span>';
  }
}

async function onSampleSelected(sampleId) {
  if (!sampleId) return;
  setLoading("Carregando exemplo…");
  try {
    const record = await loadSample(sampleId);
    setRecord(record, `${sampleId}.cfg`);
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
    setRecord(record, cfg.name);
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
  const list = readRecent();
  document.getElementById("recent-list").innerHTML = list
    .map((p) => `<button type="button" class="menu-item" data-recent="${escapeHtml(p)}" title="${escapeHtml(p)}">${escapeHtml(p.split(/[\\/]/).slice(-2).join(" / "))}</button>`)
    .join("");
  document.getElementById("recent-block").classList.toggle("hidden", !list.length);
}

async function openLocalPath(path) {
  if (!path) return;
  setLoading(`Lendo ${escapeHtml(path.split(/[\\/]/).pop())}…`);
  try {
    const record = await loadFromPath(path);
    setRecord(record, path);
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
  document.querySelector("#menu-file .file-btn").classList.add("hidden");
  btn.addEventListener("click", async () => {
    try {
      const path = await pickComtradeFile();
      if (path) openLocalPath(path);
    } catch (err) {
      console.warn("Diálogo nativo:", err);
      els.fileInput.click(); // alternativa: upload
    }
  });
  document.getElementById("recent-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-recent]");
    if (b) openLocalPath(b.dataset.recent);
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

function setRecord(record, sourceName = "", { keep = false } = {}) {
  const prev = state.record;
  const sameLayout = keep && prev
    && prev.analog_channels.length === record.analog_channels.length
    && prev.digital_channels.length === record.digital_channels.length;
  const keptChannels = sameLayout ? new Set(state.selectedChannels) : null;
  state.record = record;
  state.sourceName = record.source_path || sourceName || record.source_name || "";
  state.selectedChannels.clear();
  state.waveformCache = null;
  if (!sameLayout) {
    state.markers = [];
    state.markerCounter = 1;
    state.fixedCursors = { c1: null, c2: null };
    state.viewStart = 0;
    state.viewEnd = record.duration_s || 1;
    state.selection = null;
  } else {
    state.viewEnd = Math.min(state.viewEnd, record.duration_s || 1);
  }
  state.cursorTime = null;
  state.analogFilter = "";
  state.digitalFilter = "";
  els.analogSearch.value = "";
  els.digitalSearch.value = "";

  renderRecordInfo();
  renderChannelLists();
  bus.emit("record", record);
  emitFixedCursors();
  loadPhasorConfig();
  if (keptChannels && keptChannels.size) {
    keptChannels.forEach((i) => state.selectedChannels.add(i));
    syncChannelCheckboxes();
    refreshView();
    bus.emit("channels");
  } else {
    selectChannels(state.onOpen);
  }
}

function openMerge() {
  openMergeDialog({
    current: state.record,
    onMerged: (meta) => setRecord(meta, meta.source_name, { keep: !!state.record?.merge }),
  });
}

/** Cria um grupo manual com B e C trocadas (corrige sequência ACB). */
async function swapGroupPhases(groupId) {
  const groups = [...(state.phasorConfig?.voltage_groups || []), ...(state.phasorConfig?.current_groups || [])];
  const g = groups.find((x) => x.id === groupId);
  if (!g || !state.record) return;
  try {
    const res = await addGroup(state.record.id, {
      quantity: g.quantity,
      label: `${g.label} (B↔C)`.slice(0, 60),
      a: g.a,
      b: g.c,
      c: g.b,
    });
    if (g.quantity === "V") state.voltageGroupId = res.group.id;
    else state.currentGroupId = res.group.id;
    applyPhasorConfig(res.config);
  } catch (err) {
    alert(err.message);
  }
}

function updateRotationHint() {
  const groups = [...(state.phasorConfig?.voltage_groups || []), ...(state.phasorConfig?.current_groups || [])];
  const parts = [];
  for (const id of [state.voltageGroupId, state.currentGroupId]) {
    const g = groups.find((x) => x.id === id);
    if (!g) continue;
    if (g.rotation === "ACB") {
      parts.push(`<b>${escapeHtml(g.label)}</b>: sequência negativa dominante (ACB) – fases provavelmente trocadas.
        <button type="button" class="link-btn" data-swap="${escapeHtml(g.id)}">Corrigir (trocar B↔C)</button>`);
    } else if (g.inferred) {
      parts.push(`<span title="${escapeHtml(g.label)}: fases tomadas pela ${escapeHtml(g.inferred)}">${g.quantity === "V" ? "Tensão" : "Corrente"}: fases pela ordem dos canais · ${g.rotation ? `rotação ${g.rotation}` : "rotação não verificada"}</span>`);
    }
  }
  els.rotationHint.innerHTML = parts.join("<br>");
  els.rotationHint.classList.toggle("hidden", !parts.length);
}

function onGroupsChanged() {
  updateRotationHint();
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
  updateSideTabs();

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

  const tag = (g) => (g.source === "manual" ? " (manual)" : "")
    + (g.rotation === "ACB" ? " ⚠ ACB" : "")
    + (g.inferred ? " · ordem" : "");
  const opts = (groups) =>
    `<option value="">—</option>` +
    groups
      .map((g) => `<option value="${escapeHtml(g.id)}" title="${g.rotation ? `Rotação ${g.rotation}` : "Rotação não verificada"}">${escapeHtml(g.label)}${tag(g)}</option>`)
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
  updateSideTabs();
  renderPhasorTable(els.phasorTableWrap, []);
  onGroupsChanged();
}

function renderRecordInfo() {
  const r = state.record;
  if (!r) {
    els.recordInfo.innerHTML = "";
    return;
  }
  if (r.merge) {
    els.recordInfo.innerHTML = `
      <strong>Registro combinado</strong> · ${r.merge.records.length} terminais<br/>
      Taxa comum: ${r.sample_rate_hz.toFixed(0)} Hz · ${formatTime(r.duration_s)}<br/>
      ${mergeInfoHtml(r)}`;
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
  document.getElementById("count-analog").textContent = `(${state.record.analog_channels.length})`;
  document.getElementById("count-digital").textContent = `(${state.record.digital_channels.length})`;
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

/** "all": todos os canais; "changing": analógicos + digitais que mudam; "analog": seleção padrão. */
async function selectChannels(mode) {
  if (!state.record) return;
  if (mode === "analog") {
    selectDefaultAnalog();
    return;
  }
  state.selectedChannels.clear();
  state.record.analog_channels.forEach((c) => state.selectedChannels.add(c.index));
  if (mode === "all") {
    state.record.digital_channels.forEach((c) => state.selectedChannels.add(c.index));
  } else {
    (await changingDigitals()).forEach((i) => state.selectedChannels.add(i));
  }
  syncChannelCheckboxes();
  refreshView();
  bus.emit("channels");
}

/** Índices dos digitais que mudam de estado (consulta a sequência de eventos). */
async function changingDigitals() {
  const rec = state.record;
  if (!rec) return [];
  if (rec._changing) return rec._changing;
  try {
    const res = await runAnalysis(rec.id, "events", { params: { scope: "all" } });
    rec._changing = res.channels.filter((c) => c.changes > 0).map((c) => c.index);
  } catch {
    rec._changing = [];
  }
  return rec._changing;
}

/** Marca/desmarca os canais que aparecem na lista (respeita a busca). */
async function checkListed(kind, on) {
  if (!state.record) return;
  if (kind === "changing") {
    state.record.digital_channels.forEach((c) => state.selectedChannels.delete(c.index));
    (await changingDigitals()).forEach((i) => state.selectedChannels.add(i));
  } else {
    const list = kind === "analog" ? els.analogList : els.digitalList;
    list.querySelectorAll(".channel-item").forEach((item) => {
      if (item.style.display === "none") return;
      const idx = Number(item.dataset.index);
      if (on) state.selectedChannels.add(idx);
      else state.selectedChannels.delete(idx);
    });
  }
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
  return Math.min(Math.max(width * 2, 1200), samplesInView, 8000);
}

function applyViewChrome() {
  ruler.setView(state.viewStart, state.viewEnd);
  ruler.setCursor(state.cursorTime);
  ruler.setSelection(state.selection);
  ruler.setMarkers(state.markers);
  updateCursorLines();
  updateMarkerLines();
  updateFixedCursorLines();
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

/** Altura das faixas: compactas cabem em notebooks; com poucos analógicos, eles
 * dividem a altura disponível. */
function trackHeight(ch) {
  const compact = state.density === "compact";
  if (ch.kind === "digital") return compact ? 22 : 40;
  const chans = state.waveformCache?.channels || [];
  const nAnalog = chans.filter((c) => c.kind !== "digital").length || 1;
  const nDigital = chans.length - nAnalog;
  const avail = els.tracksContainer.clientHeight - nDigital * (compact ? 23 : 41) - 4;
  const fill = Math.floor(avail / nAnalog) - 1;
  const [lo, hi] = compact ? [64, 160] : [110, 220];
  return Math.max(lo, Math.min(hi, fill));
}

function renderStackedTrack(ch) {
  const row = document.createElement("div");
  row.className = "track-row";
  if (ch.kind === "derived") row.classList.add("derived");
  row.dataset.channelIndex = String(ch.index);

  const gutter = document.createElement("div");
  gutter.className = "track-gutter-panel";
  const metaLabel = ch.kind === "derived" ? "calculado" : ch.kind === "digital" ? "" : escapeHtml(ch.unit || "");
  if (ch.kind === "digital") {
    gutter.classList.add("digital");
    gutter.innerHTML = `<div class="name" title="${escapeHtml(ch.name)}">${escapeHtml(ch.name)}</div>${instantValueHtml(ch.index)}`;
  } else {
    gutter.innerHTML = `
      <div class="name" title="${escapeHtml(ch.name)}">${escapeHtml(ch.name)}</div>
      <div class="meta"><span>${metaLabel}</span>${instantValueHtml(ch.index)}</div>`;
  }

  const wrap = document.createElement("div");
  wrap.className = "track-canvas-wrap";
  wrap.style.height = `${trackHeight(ch)}px`;

  const canvas = document.createElement("canvas");
  canvas.dataset.channelIndex = String(ch.index);
  wrap.appendChild(canvas);

  const cursor = document.createElement("div");
  cursor.className = "cursor-line";
  wrap.appendChild(cursor);

  for (const marker of state.markers) {
    wrap.appendChild(createMarkerLine(marker));
  }
  appendFixedCursorLines(wrap);

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
    gutter.classList.add("digital");
    gutter.innerHTML = `<div class="name" title="${escapeHtml(title)}">${escapeHtml(title)}</div>${instantValueHtml(channelMeta.index)}`;
  } else {
    gutter.innerHTML = `<div class="name">${escapeHtml(title)}</div>`;
  }

  const wrap = document.createElement("div");
  wrap.className = "track-canvas-wrap";
  wrap.style.height = small ? `${state.density === "compact" ? 22 : 40}px` : `${Math.max(200, els.tracksContainer.clientHeight * 0.55)}px`;

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
  appendFixedCursorLines(wrap);

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
        yMin: yRange(ch)[0],
        yMax: yRange(ch)[1],
        color: TH.palette[i % TH.palette.length],
      })),
      { viewStart: state.viewStart, viewEnd: state.viewEnd }
    );
  });

  updateCursorLines();
  updateMarkerLines();
  updateFixedCursorLines();
}

/** Faixa vertical: a do .cfg, a menos que seja muito maior que o sinal (ex.:
 * conversor de 16 bits com fundo de escala de dezenas de kA) – aí usa o sinal. */
function yRange(ch) {
  if (ch.kind !== "analog") return [undefined, undefined];
  const lo = ch.cfg_min ?? ch.min;
  const hi = ch.cfg_max ?? ch.max;
  const dataSpan = Math.max(Math.abs(ch.data_max ?? ch.max ?? 0), Math.abs(ch.data_min ?? ch.min ?? 0));
  const cfgSpan = Math.max(Math.abs(lo ?? 0), Math.abs(hi ?? 0));
  if (dataSpan > 0 && cfgSpan > 8 * dataSpan) {
    const m = dataSpan * 1.05;
    return [-m, m];
  }
  return [lo, hi];
}

function drawChannelCanvas(canvas, ch) {
  const [yMin, yMax] = yRange(ch);
  const opts = {
    viewStart: state.viewStart,
    viewEnd: state.viewEnd,
    unit: ch.unit,
    yMin,
    yMax,
    color: ch.kind === "derived" ? TH.derived : undefined,
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

/** Digitais chegam só com as transições: valor = último ponto com t ≤ cursor. */
function stepValue(times, values, time) {
  if (!times.length) return null;
  let lo = 0;
  let hi = times.length - 1;
  if (time < times[0]) return values[0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  return values[lo];
}

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
    const value = ch.kind === "digital"
      ? stepValue(ch.times, ch.values, state.cursorTime)
      : interpolateValue(ch.times, ch.values, state.cursorTime);
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
  const { c1, c2 } = state.fixedCursors;
  const parts = [];
  if (c1 != null) parts.push(`C1 ${formatTime(c1)}`);
  if (c2 != null) parts.push(`C2 ${formatTime(c2)}`);
  if (c1 != null && c2 != null) parts.push(`Δt ${((c2 - c1) * 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 3 })} ms`);
  els.statusCursors.textContent = parts.length ? parts.join(" · ") : "C1/C2: teclas 1 e 2";
}

// ---------------------------------------------------------------------------
// Cursores fixos C1/C2 (arrastáveis)
// ---------------------------------------------------------------------------
function setFixedCursor(key, time = undefined) {
  if (!state.record) return;
  let t = time !== undefined ? time : state.cursorTime;
  if (t == null) t = (state.viewStart + state.viewEnd) / 2;
  state.fixedCursors[key] = snapToSample(t);
  updateFixedCursorLines();
  updateStatus();
  emitFixedCursors();
}

/** Cursores fixos caem sempre sobre uma amostra (Δt exato). */
function snapToSample(t) {
  const r = state.record;
  if (!r) return t;
  const fs = r.sample_rate_hz || 0;
  const k = fs > 0 ? Math.round(t * fs) / fs : t;
  return Math.min(Math.max(k, 0), r.duration_s);
}

function createFixedCursor(key) {
  const el = document.createElement("div");
  el.className = `fixed-cursor ${key}`;
  el.dataset.key = key;
  el.dataset.label = key.toUpperCase();
  el.title = `${key.toUpperCase()} – arraste para mover`;
  el.addEventListener("mousedown", (e) => startFixedCursorDrag(e, el));
  return el;
}

function appendFixedCursorLines(wrap) {
  wrap.appendChild(createFixedCursor("c1"));
  wrap.appendChild(createFixedCursor("c2"));
}

function startFixedCursorDrag(e, el) {
  e.preventDefault();
  e.stopPropagation();
  const wrap = el.parentElement;
  const key = el.dataset.key;
  document.body.classList.add("dragging-cursor");
  const onMove = (ev) => {
    const rect = wrap.getBoundingClientRect();
    const t = xToTime(Math.min(Math.max(ev.clientX - rect.left, 0), rect.width), rect.width);
    state.fixedCursors[key] = snapToSample(t);
    updateFixedCursorLines();
    updateStatus();
    emitFixedCursorsLater();
  };
  const onUp = () => {
    document.body.classList.remove("dragging-cursor");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    emitFixedCursors();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function updateFixedCursorLines() {
  document.querySelectorAll(".fixed-cursor").forEach((el) => {
    const t = state.fixedCursors[el.dataset.key];
    const wrap = el.parentElement;
    const visible = t != null && state.record && t >= state.viewStart && t <= state.viewEnd;
    el.style.display = visible ? "block" : "none";
    if (visible) el.style.left = `${timeToX(t, wrap.clientWidth)}px`;
  });
}

// ---------------------------------------------------------------------------
// Captura da oscilografia (figura do relatório)
// ---------------------------------------------------------------------------
const CURSOR_COLORS = { c1: "#b5179e", c2: "#0b7a75" };

function captureView({ scale = 2 } = {}) {
  const rows = Array.from(els.tracksContainer.querySelectorAll(".track-row")).filter((r) => r.offsetParent !== null);
  if (!rows.length || !state.record) return null;
  const wraps = rows.map((r) => r.querySelector(".track-canvas-wrap"));
  const plotW = wraps[0].clientWidth;
  const gutterW = 190;
  const rulerH = els.rulerCanvas.clientHeight;
  const heights = wraps.map((w) => w.clientHeight);
  const footH = 22;
  const totalH = rulerH + heights.reduce((a, b) => a + b + 1, 0) + footH;
  const W = gutterW + plotW;
  const cv = document.createElement("canvas");
  cv.width = Math.round(W * scale);
  cv.height = Math.round(totalH * scale);
  const g = cv.getContext("2d");
  g.scale(scale, scale);
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, W, totalH);
  g.fillStyle = "#e4e4e4";
  g.fillRect(0, 0, gutterW, rulerH);
  g.drawImage(els.rulerCanvas, gutterW, 0, plotW, rulerH);

  const fit = (text, maxW) => {
    if (g.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
    return `${t}…`;
  };
  let y = rulerH;
  rows.forEach((row, i) => {
    const h = heights[i];
    const canvas = wraps[i].querySelector("canvas");
    g.fillStyle = "#f4f4f4";
    g.fillRect(0, y, gutterW, h);
    g.fillStyle = "#2a2a2a";
    g.font = "600 12px Segoe UI, Arial, sans-serif";
    g.fillText(fit(row.querySelector(".name")?.textContent.trim() || "", gutterW - 12), 8, y + 18);
    g.fillStyle = "#666";
    g.font = "11px Segoe UI, Arial, sans-serif";
    g.fillText(fit(row.querySelector(".meta")?.textContent.trim() || "", gutterW - 12), 8, y + 33);
    g.fillStyle = "#fafafa";
    g.fillRect(gutterW, y, plotW, h);
    if (canvas) g.drawImage(canvas, gutterW, y, plotW, h);
    g.strokeStyle = "#d0d0d0";
    g.beginPath();
    g.moveTo(0, y + h + 0.5);
    g.lineTo(W, y + h + 0.5);
    g.stroke();
    y += h + 1;
  });
  const vline = (t, color, label, dash) => {
    if (t == null || t < state.viewStart || t > state.viewEnd) return;
    const x = gutterW + timeToX(t, plotW);
    g.strokeStyle = color;
    g.lineWidth = 1.2;
    g.setLineDash(dash);
    g.beginPath();
    g.moveTo(x + 0.5, rulerH);
    g.lineTo(x + 0.5, y);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = color;
    g.font = "bold 11px Segoe UI, Arial, sans-serif";
    g.fillText(label, x + 3, rulerH + 12);
  };
  state.markers.forEach((m) => vline(m.time, "#c06040", m.label, []));
  vline(state.fixedCursors.c1, CURSOR_COLORS.c1, "C1", [5, 3]);
  vline(state.fixedCursors.c2, CURSOR_COLORS.c2, "C2", [5, 3]);
  g.fillStyle = "#555";
  g.font = "11px Segoe UI, Arial, sans-serif";
  const r = state.record;
  g.fillText(`${r.station || ""} ${r.device ? `· ${r.device}` : ""} · janela ${formatTime(state.viewStart)} → ${formatTime(state.viewEnd)}`.trim(), 8, y + 15);
  return cv.toDataURL("image/png");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


init();
