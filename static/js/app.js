import {
  IS_DESKTOP,
  STARTUP_FILE,
  pickComtradeFiles,
  fetchWaveform,
  fetchValueAtTime,
  formatTime,
  listSamples,
  loadSample,
} from "./api.js";
import { initFileDrop, openSources } from "./open-files.js";
import {
  axesOf,
  axisKey,
  canOverlay,
  createLayout,
  detachChannel,
  dropTarget,
  insertChannels,
  moveTrack,
  overlayChannels,
  overlayTrack,
  insertChannelsEach,
  splitTrack,
  syncLayout,
} from "./tracks-layout.js";
import {
  DEFAULT_VALUE_MODE,
  VALUE_MODES,
  baseUnit,
  cursorLineCount,
  cursorValuesHtml,
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
import { addToMergeDialog, isMergeDialogOpen, mergeInfoHtml, openMergeDialog } from "./merge.js";
import { T as TH, getTheme, initTheme, setTheme } from "./core/theme.js";
import { addGroup } from "./analyses/api.js";
import {
  drawAnalogWaveform,
  drawDigitalWaveform,
  drawMultiAnalog,
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
  // faixas por registro (tracks-layout.js): id do registro → layout
  layouts: new Map(),
  density: readPref("oscilo.density", "compact"),
  onOpen: readPref("oscilo.onopen", "all"),
  valueMode: VALUE_MODES.some((m) => m.id === readPref("oscilo.valuemode", ""))
    ? readPref("oscilo.valuemode", DEFAULT_VALUE_MODE)
    : DEFAULT_VALUE_MODE,
  cursorValues: { key: "", byIndex: new Map() },
  viewStart: 0,
  viewEnd: 1,
  cursorTime: null,
  // tempo sob o mouse nas faixas (só para as teclas 1/2; não desenha nem consulta nada)
  pointerTime: null,
  selection: null,
  // zooms por retângulo anteriores (clique direito sem arrastar volta um)
  zoomHistory: [],
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
const emitFixedCursors = () => {
  bus.emit("cursors", analysisCtx.fixedCursors);
  updateCursorValues();
};
const emitFixedCursorsLater = debounce(emitFixedCursors, 150);
const dock = new AnalysisDock(els.dock, analysisCtx);
const protectionView = new ProtectionView(document.getElementById("protection-view"), analysisCtx);

let navScrollSync = false;

const ruler = new TimelineRuler(els.rulerCanvas, (event) => {
  if (event.type === "cursor") {
    state.cursorTime = event.time;
    updateCursorLines();
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
  bindSideLists();
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
  // o programa sempre abre com o painel de análises visível, na aba Resumo
  // (o × continua fechando; fechado, não calcula)
  dock.activateById("summary");
  dock.setOpen(true);
  els.dock.classList.remove("hidden");
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
  setRadio("valuemode", state.valueMode);
  document.querySelectorAll('input[name="valuemode"]').forEach((input) => input.addEventListener("change", () => {
    state.valueMode = input.value;
    writePref("oscilo.valuemode", state.valueMode);
    updateCursorValues();
  }));
  document.querySelectorAll('input[name="density"]').forEach((input) => input.addEventListener("change", () => {
    state.density = input.value;
    writePref("oscilo.density", state.density);
    // trocar o modo global reaplica a todas as faixas analógicas
    state.layouts.forEach((L) => L.tracks.forEach((t) => { t.height = null; }));
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
  updatePhasorPanel();
  updateStatus();
  emitCursor();
}

function bindToolbar() {
  els.fileInput.addEventListener("change", onFileSelected);
  bindTrackWheel();
  initFileDrop(openFrom);
  els.sampleList.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sample]");
    if (b) onSampleSelected(b.dataset.sample);
  });

  document.getElementById("zoom-in").addEventListener("click", () => zoomBy(0.5));
  document.getElementById("zoom-out").addEventListener("click", () => zoomBy(2));
  document.getElementById("zoom-fit").addEventListener("click", zoomFit);
  document.getElementById("zoom-selection").addEventListener("click", zoomToSelection);

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
  document.getElementById("open-merge").addEventListener("click", () => openMerge());
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
      // na posição do mouse quando ele está sobre as faixas; senão, no cursor
      setFixedCursor(e.key === "1" ? "c1" : "c2", state.pointerTime ?? undefined);
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
  els.fileInput.value = "";
  if (files.length) openFrom({ files });
}

/** Ponto único de abertura: menu, diálogo nativo, recentes, linha de comando
 * e arrastar e soltar. Um registro abre direto; vários mostram a lista (abrir
 * um ou juntar os marcados). Com o diálogo Juntar aberto, os arquivos soltos
 * são adicionados a ele. */
async function openFrom(src) {
  if (isMergeDialogOpen()) {
    addToMergeDialog(src);
    return;
  }
  let res;
  try {
    res = await openSources({ ...src, purpose: "open", busy: setLoading });
  } catch (err) {
    const where = src.paths?.length === 1 ? ` ${src.paths[0]}` : "";
    alert(`Erro ao abrir${where}:\n${err.message}`);
    return;
  }
  if (!res || !res.records.length) return;
  const [first] = res.records;
  setRecord(first, res.sourcePath || first.source_name);
  if (IS_DESKTOP && res.sourcePath) pushRecent(res.sourcePath);
  if (IS_DESKTOP) document.title = `${(res.sourcePath || first.source_name || "").split(/[\\/]/).pop()} – Oscilo`;
  if (res.action === "merge" && res.records.length > 1) openMerge({ preselect: res.records.map((r) => r.id) });
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

function openLocalPath(path) {
  if (path) openFrom({ paths: [path] });
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
      const paths = await pickComtradeFiles();
      if (paths.length) openFrom({ paths });
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
  // junção refeita (mesmos canais): mantém ordem, sobreposições e alturas
  if (sameLayout && state.layouts.has(prev.id) && !state.layouts.has(record.id)) {
    state.layouts.set(record.id, structuredClone(state.layouts.get(prev.id)));
  }
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
    state.zoomHistory = [];
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

function openMerge({ preselect = null } = {}) {
  openMergeDialog({
    current: state.record,
    preselect,
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

// ---------------------------------------------------------------------------
// Barra lateral: lista de canais (seções por terminal no registro combinado,
// seleção múltipla, abrir/fechar selecionados, arrastar para o gráfico)
// ---------------------------------------------------------------------------
const sideSel = { analog: new Set(), digital: new Set() };
const sideAnchor = { analog: null, digital: null };
const groupOpen = new Map(); // "kind|rótulo" → aberto? (vale para a sessão)

function renderChannelLists() {
  els.analogList.innerHTML = "";
  els.digitalList.innerHTML = "";
  sideSel.analog.clear();
  sideSel.digital.clear();
  sideAnchor.analog = sideAnchor.digital = null;
  if (!state.record) return;
  fillChannelList(els.analogList, "analog", state.record.analog_channels);
  fillChannelList(els.digitalList, "digital", state.record.digital_channels);
  document.getElementById("count-analog").textContent = `(${state.record.analog_channels.length})`;
  document.getElementById("count-digital").textContent = `(${state.record.digital_channels.length})`;
  updateSideSelectionUi();
}

/** No registro combinado os canais chegam como "RÓTULO: nome": uma seção
 * retrátil por terminal. Num registro comum, lista simples. */
function fillChannelList(list, kind, channels) {
  const labels = (state.record.merge?.records || []).map((r) => r.label).filter(Boolean);
  if (labels.length < 2) {
    channels.forEach((ch) => list.appendChild(createChannelItem(ch)));
    return;
  }
  const groups = new Map(labels.map((l) => [l, []]));
  const other = [];
  for (const ch of channels) {
    const l = labels.find((x) => ch.name.startsWith(`${x}: `));
    if (l) groups.get(l).push(ch);
    else other.push(ch);
  }
  if (other.length) groups.set("Outros", other);
  for (const [label, chans] of groups) {
    if (!chans.length) continue;
    const key = `${kind}|${label}`;
    const det = document.createElement("details");
    det.className = "ch-group";
    det.open = groupOpen.get(key) ?? true;
    det.innerHTML = `<summary><span class="chg-label">${escapeHtml(label)}</span> <span class="chg-count">(${chans.length})</span></summary>`;
    det.addEventListener("toggle", () => groupOpen.set(key, det.open));
    chans.forEach((ch) => det.appendChild(createChannelItem(ch, `${label}: `)));
    list.appendChild(det);
  }
}

function createChannelItem(ch, prefix = "") {
  const div = document.createElement("div");
  div.className = "channel-item";
  div.dataset.index = String(ch.index);
  div.dataset.kind = ch.kind;
  div.dataset.search = ch.name.toLowerCase();
  const shown = prefix && ch.name.startsWith(prefix) ? ch.name.slice(prefix.length) : ch.name;
  // o nome não é <label for>: clicar nele seleciona; o checkbox abre/fecha
  div.innerHTML = `
    <input type="checkbox" data-index="${ch.index}" aria-label="Abrir ${escapeHtml(ch.name)}" />
    <label title="${escapeHtml(ch.name)}">
      ${escapeHtml(shown)}
      ${ch.unit ? `<span class="unit"> (${escapeHtml(ch.unit)})</span>` : ""}
    </label>
  `;
  div.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("input")) return;
    e.preventDefault(); // sem seleção de texto
    div.closest(".channel-list")?.focus({ preventScroll: true }); // Enter/Delete valem logo após o clique
    // arrastar um item selecionado leva todos os selecionados (na ordem da lista)
    const kind = ch.kind;
    const ids = sideSel[kind].has(ch.index) && sideSel[kind].size > 1
      ? visibleItems(kind).filter((it) => sideSel[kind].has(Number(it.dataset.index))).map((it) => it.dataset.index)
      : [String(ch.index)];
    const label = ids.length > 1 ? `${ids.length} canais` : ch.name;
    startLayoutDrag(e, ids.length > 1 ? { type: "channels", ids } : { type: "channel", id: String(ch.index) }, label);
  });
  div.addEventListener("click", (e) => {
    if (e.target.closest("input")) return;
    selectSideItem(ch.kind, ch.index, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
  });
  div.addEventListener("dblclick", (e) => {
    if (e.target.closest("input")) return;
    setChannelsOpen([ch.index], !state.selectedChannels.has(ch.index));
  });
  div.title = "Clique seleciona (Ctrl/Shift para vários) · duplo clique ou checkbox abre/fecha · arraste para o gráfico";
  div.querySelector("input").addEventListener("change", (e) => {
    setChannelsOpen([ch.index], e.target.checked);
  });
  return div;
}

function visibleItems(kind) {
  const list = kind === "analog" ? els.analogList : els.digitalList;
  // filtrados pela busca ou dentro de seção recolhida não contam
  return Array.from(list.querySelectorAll(".channel-item")).filter((it) => it.style.display !== "none" && !it.closest("details:not([open])"));
}

function selectSideItem(kind, index, { toggle = false, range = false } = {}) {
  const sel = sideSel[kind];
  if (range && sideAnchor[kind] != null) {
    const items = visibleItems(kind).map((it) => Number(it.dataset.index));
    const a = items.indexOf(sideAnchor[kind]);
    const b = items.indexOf(index);
    if (a >= 0 && b >= 0) {
      if (!toggle) sel.clear();
      items.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((i) => sel.add(i));
    }
  } else if (toggle) {
    if (sel.has(index)) sel.delete(index);
    else sel.add(index);
    sideAnchor[kind] = index;
  } else {
    sel.clear();
    sel.add(index);
    sideAnchor[kind] = index;
  }
  updateSideSelectionUi();
}

function updateSideSelectionUi() {
  for (const kind of ["analog", "digital"]) {
    const list = kind === "analog" ? els.analogList : els.digitalList;
    list.querySelectorAll(".channel-item").forEach((it) => {
      it.classList.toggle("selected", sideSel[kind].has(Number(it.dataset.index)));
    });
    const btn = list.parentElement.querySelector(".sel-toggle");
    if (btn) {
      const ids = [...sideSel[kind]];
      btn.disabled = !ids.length;
      const anyClosed = ids.some((i) => !state.selectedChannels.has(i));
      btn.textContent = !ids.length ? "Abrir/fechar selecionados" : `${anyClosed ? "Abrir" : "Fechar"} ${ids.length} selecionado${ids.length > 1 ? "s" : ""}`;
    }
  }
}

/** Abre ou fecha canais (checkboxes, duplo clique, Enter/Delete, botão). */
function setChannelsOpen(indices, open) {
  let changed = false;
  indices.forEach((i) => {
    if (open && !state.selectedChannels.has(i)) { state.selectedChannels.add(i); changed = true; }
    if (!open && state.selectedChannels.has(i)) { state.selectedChannels.delete(i); changed = true; }
  });
  syncChannelCheckboxes();
  updateSideSelectionUi();
  if (!changed) return;
  refreshView();
  bus.emit("channels");
}

/** Selecionados: se algum estiver fechado, abre todos; senão, fecha todos. */
function toggleSelectedOpen(kind) {
  const ids = [...sideSel[kind]];
  if (!ids.length) return;
  setChannelsOpen(ids, ids.some((i) => !state.selectedChannels.has(i)));
}

function bindSideLists() {
  for (const [kind, list] of [["analog", els.analogList], ["digital", els.digitalList]]) {
    list.tabIndex = 0;
    list.setAttribute("aria-multiselectable", "true");
    list.addEventListener("keydown", (e) => {
      if (e.target.closest("input")) return;
      if (e.key === "Enter") {
        setChannelsOpen([...sideSel[kind]], true);
        e.preventDefault();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        setChannelsOpen([...sideSel[kind]], false);
        e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        visibleItems(kind).forEach((it) => sideSel[kind].add(Number(it.dataset.index)));
        updateSideSelectionUi();
        e.preventDefault();
      } else if (e.key === "Escape") {
        sideSel[kind].clear();
        updateSideSelectionUi();
      }
    });
    // retângulo de seleção a partir de área vazia da lista
    list.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest(".channel-item, summary")) return;
      startSideRect(e, kind, list);
    });
    const actions = list.parentElement.querySelector(".list-actions");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link-btn sel-toggle";
    btn.title = "Abre os selecionados (ou fecha, se todos já estiverem abertos) · Enter abre, Delete fecha";
    btn.addEventListener("click", () => toggleSelectedOpen(kind));
    actions?.appendChild(btn);
  }
  updateSideSelectionUi();
}

function startSideRect(e, kind, list) {
  e.preventDefault();
  list.focus({ preventScroll: true });
  const additive = e.ctrlKey || e.metaKey;
  const base = additive ? new Set(sideSel[kind]) : new Set();
  const x0 = e.clientX;
  const y0 = e.clientY;
  const box = document.createElement("div");
  box.className = "zoom-rect side-rect";
  document.body.appendChild(box);
  const onMove = (ev) => {
    const lr = list.getBoundingClientRect();
    const x1 = Math.min(Math.max(ev.clientX, lr.left), lr.right);
    const y1 = Math.min(Math.max(ev.clientY, lr.top), lr.bottom);
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    Object.assign(box.style, { left: `${Math.min(x0, x1)}px`, top: `${top}px`, width: `${Math.abs(x1 - x0)}px`, height: `${bottom - top}px` });
    const sel = new Set(base);
    visibleItems(kind).forEach((it) => {
      const r = it.getBoundingClientRect();
      if (r.bottom >= top && r.top <= bottom && bottom - top > 3) sel.add(Number(it.dataset.index));
    });
    sideSel[kind] = sel;
    updateSideSelectionUi();
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    box.remove();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
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
  updateSideSelectionUi();
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
    els.tracksContainer.querySelectorAll(".track-row").forEach((el) => el.remove());
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

// ---------------------------------------------------------------------------
// Faixas (modelo em tracks-layout.js): uma lista ordenada por registro; cada
// faixa tem 1 canal ou vários analógicos sobrepostos (até 2 unidades).
// ---------------------------------------------------------------------------
function currentLayout() {
  if (!state.record) return createLayout();
  let L = state.layouts.get(state.record.id);
  if (!L) {
    L = createLayout();
    state.layouts.set(state.record.id, L);
  }
  return L;
}

/** {kind, unit, name} de um canal pelo id ("12" ou "derived:…"): primeiro os
 * dados exibidos, depois as listas do registro (canal ainda não aberto). */
function channelMeta(id) {
  const key = String(id);
  const ch = state.waveformCache?.channels?.find((c) => String(c.index) === key);
  if (ch) return { kind: ch.kind, unit: ch.unit, name: ch.name };
  const rec = state.record;
  const found = rec && [...rec.analog_channels, ...rec.digital_channels].find((c) => String(c.index) === key);
  return found ? { kind: found.kind, unit: found.unit, name: found.name } : { kind: "derived", unit: "", name: key };
}

function trackKind(track) {
  return channelMeta(track.channels[0]).kind;
}

/** Monta as faixas. Se a estrutura não mudou (mesmas faixas, canais, alturas
 * e modo), mantém o DOM e só os canvases são redesenhados – zoom e pan não
 * reconstroem nada nem mexem na rolagem vertical. */
let lastTrackSig = "";
function renderTracks({ force = false } = {}) {
  const channels = state.waveformCache?.channels || [];
  const L = currentLayout();
  if (channels.length) syncLayout(L, channels.map((c) => String(c.index)));
  const sig = [
    state.record?.id, state.density, els.tracksContainer.clientHeight, getTheme(),
    state.markers.map((m) => m.label).join(","),
    cursorLineCount(state.fixedCursors.c1 != null, state.fixedCursors.c2 != null),
    ...L.tracks.map((t) => `${t.id}:${t.channels.join(",")}:${t.height || ""}`),
  ].join("|");
  const rows = els.tracksContainer.querySelectorAll(".track-row");
  if (!force && channels.length && sig === lastTrackSig && rows.length === L.tracks.length) return;
  const scroll = els.tracksContainer.scrollTop;
  rows.forEach((el) => el.remove());
  lastTrackSig = "";
  if (!channels.length) return;
  const byId = new Map(channels.map((c) => [String(c.index), c]));
  L.tracks.forEach((t) => renderTrack(t, byId));
  lastTrackSig = sig;
  els.tracksContainer.scrollTop = scroll; // reordenar/abrir não volta ao topo
  syncScrollbarGutter();
  lastCvLines = cursorLineCount(state.fixedCursors.c1 != null, state.fixedCursors.c2 != null);
  updateCursorValues();
}

/** Desconta na régua e na barra de navegação a largura da barra de rolagem
 * vertical das faixas (Windows: ~17 px), para os eixos de tempo coincidirem. */
function syncScrollbarGutter() {
  const tc = els.tracksContainer;
  const sb = Math.max(0, tc.offsetWidth - tc.clientWidth);
  const cur = document.documentElement.style.getPropertyValue("--track-sbw");
  if (cur !== `${sb}px`) {
    document.documentElement.style.setProperty("--track-sbw", `${sb}px`);
    ruler.draw();
  }
}

/** Reconstrói as faixas com os dados já carregados (reordenar, sobrepor,
 * retirar): só redesenho, nenhuma consulta. */
function relayout() {
  renderTracks({ force: true });
  redrawAllCanvases();
}

const TRACK_COLORS = () => TH.palette;

/** Altura das faixas: compactas cabem em notebooks; com poucas faixas
 * analógicas, elas dividem a altura disponível. Digitais: sempre compactas. */
function trackHeight(track) {
  const kind = trackKind(track);
  if (kind === "digital") return DIGITAL_TRACK_H;
  const n = track.channels.length;
  const lines = cursorLineCount(state.fixedCursors.c1 != null, state.fixedCursors.c2 != null);
  const compact = state.density === "compact";
  // nome (até 2 linhas) + unidade + linhas de valor (C1 · C2 · Δ); sobreposta: nome + valores por canal
  let lo = compact ? (lines > 1 ? 92 : 66) : (lines > 1 ? 120 : 110);
  if (n > 1) lo = Math.max(lo, 26 + n * (14 + lines * 13));
  if (track.height) return Math.max(track.height, 40);
  const L = currentLayout();
  const nDigital = L.tracks.filter((t) => trackKind(t) === "digital").length;
  const nAnalog = (L.tracks.length - nDigital) || 1;
  const avail = els.tracksContainer.clientHeight - nDigital * (DIGITAL_TRACK_H + 1) - 4;
  const fill = Math.floor(avail / nAnalog) - 1;
  const hi = compact ? 160 : 220;
  return Math.max(lo, Math.min(Math.max(hi, lo), fill));
}
const DIGITAL_TRACK_H = 22;

function renderTrack(track, byId) {
  const chans = track.channels.map((id) => byId.get(id)).filter(Boolean);
  if (!chans.length) return;
  const first = chans[0];
  const multi = chans.length > 1;
  const colors = TRACK_COLORS();
  const row = document.createElement("div");
  row.className = "track-row";
  if (first.kind === "derived") row.classList.add("derived");
  if (first.kind === "digital") row.classList.add("digital-row");
  if (multi) row.classList.add("multi");
  row.dataset.trackId = track.id;
  row.dataset.title = chans.map((c) => c.name).join(" + ");

  const gutter = document.createElement("div");
  gutter.className = "track-gutter-panel";
  const drag = `<span class="tg-drag" title="Arraste para mudar a ordem ou soltar sobre outra faixa para sobrepor">⋮⋮</span>`;
  const menu = `<button type="button" class="tg-menu" title="Opções da faixa" aria-label="Opções da faixa">⋯</button>`;
  if (first.kind === "digital") {
    gutter.classList.add("digital");
    gutter.innerHTML = `${drag}<div class="name tg-grip" title="${escapeHtml(first.name)}">${escapeHtml(first.name)}</div>${cvHtml(first.index)}${menu}`;
  } else if (!multi) {
    const metaLabel = first.kind === "derived" ? "calculado" : escapeHtml(first.unit || "");
    gutter.innerHTML = `
      <div class="tg-head">${drag}<div class="name tg-grip" title="${escapeHtml(first.name)}">${escapeHtml(first.name)}</div>${menu}</div>
      <div class="meta"><span>${metaLabel}</span></div>
      ${cvHtml(first.index)}`;
  } else {
    gutter.classList.add("multi");
    gutter.innerHTML = `
      <div class="tg-head">${drag}<div class="name tg-grip" title="${escapeHtml(row.dataset.title)}">${chans.length} canais sobrepostos</div>${menu}</div>
      ${chans.map((c, i) => `<div class="tg-ch"><span class="sw" style="background:${colors[i % colors.length]}"></span><span class="tg-ch-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span><span class="unit">${escapeHtml(c.unit || "")}</span></div>${cvHtml(c.index)}`).join("")}`;
  }

  const wrap = document.createElement("div");
  wrap.className = "track-canvas-wrap";
  wrap.style.height = `${trackHeight(track)}px`;
  const canvas = document.createElement("canvas");
  canvas.dataset.trackId = track.id;
  wrap.appendChild(canvas);
  const cursor = document.createElement("div");
  cursor.className = "cursor-line";
  wrap.appendChild(cursor);
  for (const marker of state.markers) wrap.appendChild(createMarkerLine(marker));
  appendFixedCursorLines(wrap);
  if (multi) {
    const legend = document.createElement("div");
    legend.className = "track-legend";
    legend.innerHTML = chans.map((c, i) => `<span class="lg-item"><span class="sw" style="background:${colors[i % colors.length]}"></span>${escapeHtml(c.name)}<button type="button" class="lg-x" data-detach="${escapeHtml(String(c.index))}" title="Retirar ${escapeHtml(c.name)} desta faixa (volta a ter faixa própria)">×</button></span>`).join("");
    legend.addEventListener("mousedown", (e) => e.stopPropagation());
    legend.addEventListener("click", (e) => {
      const b = e.target.closest("[data-detach]");
      if (!b) return;
      detachChannel(currentLayout(), track.id, b.dataset.detach);
      relayout();
    });
    wrap.appendChild(legend);
  }
  if (first.kind !== "digital") {
    const handle = document.createElement("div");
    handle.className = "track-resize";
    handle.title = "Arraste para mudar a altura desta faixa · duplo clique volta à altura padrão";
    handle.addEventListener("mousedown", (e) => startTrackResize(e, track, wrap));
    handle.addEventListener("dblclick", (e) => {
      e.stopPropagation(); // não é o duplo clique da faixa (escala vertical)
      if (track.height == null) return;
      track.height = null; // volta à altura padrão do modo compacto/alto
      relayout();
    });
    wrap.appendChild(handle);
  }

  bindTrackInteraction(wrap);
  wrap.addEventListener("dblclick", (e) => {
    if (e.target.closest(".track-legend, .track-resize, .fixed-cursor")) return;
    if (!Object.keys(track.yZoom).length) return;
    track.yZoom = {}; // volta a escala vertical desta faixa ao automático
    drawTrackCanvas(canvas);
  });
  bindTrackGutter(gutter, track);
  row.appendChild(gutter);
  row.appendChild(wrap);
  els.tracksContainer.appendChild(row);
}

function bindTrackInteraction(wrap) {
  wrap.addEventListener("mousemove", (e) => onTrackMouseMove(e, wrap));
  wrap.addEventListener("mouseleave", () => { state.pointerTime = null; });
  wrap.addEventListener("mousedown", (e) => onTrackMouseDown(e, wrap));
  // o botão direito desenha o retângulo de zoom: sem menu de contexto nas faixas
  wrap.addEventListener("contextmenu", (e) => e.preventDefault());
}

/** Roda do mouse sobre as faixas e a régua: Shift + roda desloca no tempo;
 * Ctrl + roda dá zoom no tempo centrado no mouse (sem deixar o navegador ou o
 * WebView2 ampliar a página); sem modificador, rola a lista de faixas. */
function bindTrackWheel() {
  els.tracksContainer.parentElement.addEventListener("wheel", (e) => {
    if ((!e.shiftKey && !e.ctrlKey) || !state.record) return;
    // com Shift o Chromium/WebView2 entrega o giro em deltaX
    const delta = e.deltaY || e.deltaX;
    if (!delta) return;
    e.preventDefault();
    const notches = Math.max(-5, Math.min(5, delta / 100));
    if (e.ctrlKey) zoomAtPointer(e.clientX, notches);
    else panBy(notches * 0.1); // 10 % da janela por "clique" da roda
  }, { passive: false });
  window.addEventListener("resize", () => syncScrollbarGutter());
}

function panBy(fraction) {
  const duration = state.record.duration_s;
  const span = state.viewEnd - state.viewStart;
  if (span >= duration) return;
  const start = Math.min(Math.max(state.viewStart + fraction * span, 0), duration - span);
  if (start === state.viewStart) return;
  state.viewStart = start;
  state.viewEnd = start + span;
  applyViewChrome();
  redrawAllCanvases();
  panRefreshView();
  if (state.selectedChannels.size > 0 && state.selectedDerivedMetrics.size > 0) panRefreshDerived();
}

/** Ctrl + roda: zoom no tempo mantendo fixo o instante sob o mouse. */
function zoomAtPointer(clientX, notches) {
  if (!state.record) return;
  const r = els.rulerCanvas.getBoundingClientRect();
  const frac = Math.min(Math.max((clientX - r.left) / (r.width || 1), 0), 1);
  const duration = state.record.duration_s;
  const span0 = state.viewEnd - state.viewStart;
  const span = Math.max(duration / 500, Math.min(duration, span0 * Math.pow(1.25, notches)));
  if (span === span0) return;
  const t = state.viewStart + frac * span0;
  let start = t - frac * span;
  start = Math.min(Math.max(start, 0), duration - span);
  state.viewStart = start;
  state.viewEnd = start + span;
  applyViewChrome();
  redrawAllCanvases();
  panRefreshView();
  if (state.selectedChannels.size > 0 && state.selectedDerivedMetrics.size > 0) panRefreshDerived();
}

function redrawAllCanvases() {
  document.querySelectorAll("canvas[data-track-id]").forEach((canvas) => drawTrackCanvas(canvas));
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

/** Desenha a faixa e guarda em canvas._axes a escala de cada eixo (na
 * unidade-base), usada para converter o retângulo de zoom em amplitude. */
function drawTrackCanvas(canvas) {
  const track = currentLayout().tracks.find((t) => t.id === canvas.dataset.trackId);
  if (!track) return;
  const byId = new Map((state.waveformCache?.channels || []).map((c) => [String(c.index), c]));
  const chans = track.channels.map((id) => byId.get(id)).filter(Boolean);
  if (!chans.length) return;
  const view = { viewStart: state.viewStart, viewEnd: state.viewEnd };
  const first = chans[0];
  canvas._axes = null;
  if (first.kind === "digital") {
    drawDigitalWaveform(canvas, first.times, first.values, view);
  } else if (chans.length === 1) {
    const [yMin, yMax] = yRange(first);
    const key = axisKey(first);
    const { factor } = baseUnit(first.unit);
    const z = track.yZoom[key];
    const sc = drawAnalogWaveform(canvas, first.times, first.values, {
      ...view, unit: first.unit, yMin, yMax,
      yFixed: z ? [z[0] / factor, z[1] / factor] : null,
      color: first.kind === "derived" ? TH.derived : undefined,
    });
    if (sc) canvas._axes = [{ key, lo: sc.lo * factor, hi: sc.hi * factor }];
  } else {
    const axes = axesOf(track, (id) => byId.get(id));
    const colors = TRACK_COLORS();
    const axisDefs = axes.map((ax) => {
      let yMin;
      let yMax;
      ax.channels.forEach((id) => {
        const ch = byId.get(id);
        const f = baseUnit(ch.unit).factor;
        const [a, b] = yRange(ch);
        if (a != null) yMin = Math.min(yMin ?? Infinity, a * f);
        if (b != null) yMax = Math.max(yMax ?? -Infinity, b * f);
      });
      return { unit: ax.key, yMin, yMax, yFixed: track.yZoom[ax.key] || null };
    });
    const series = chans.map((ch, i) => ({
      times: ch.times, values: ch.values, color: colors[i % colors.length],
      axis: axes.findIndex((ax) => ax.channels.includes(String(ch.index))),
      factor: baseUnit(ch.unit).factor,
    }));
    const scales = drawMultiAnalog(canvas, series, { ...view, axes: axisDefs });
    canvas._axes = scales.map((sc, a) => ({ key: axes[a].key, lo: sc.lo, hi: sc.hi }));
  }
  canvas.parentElement?.classList.toggle("y-zoomed", Object.keys(track.yZoom).length > 0);
}

// ---------------------------------------------------------------------------
// Altura, reordenar/sobrepor (arrastar o nome) e menu da faixa
// ---------------------------------------------------------------------------
function startTrackResize(e, track, wrap) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const y0 = e.clientY;
  const h0 = wrap.clientHeight;
  document.body.classList.add("resizing-track");
  let moved = false;
  const onMove = (ev) => {
    if (Math.abs(ev.clientY - y0) > 2) moved = true;
    if (moved) wrap.style.height = `${Math.max(40, Math.min(900, h0 + ev.clientY - y0))}px`;
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.classList.remove("resizing-track");
    if (!moved) return; // clique simples (ou 1º do duplo clique): não fixa altura
    track.height = wrap.clientHeight; // só esta faixa sai do modo alto/compacto
    drawTrackCanvas(wrap.querySelector("canvas"));
    updateCursorLines();
    updateMarkerLines();
    updateFixedCursorLines();
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function bindTrackGutter(gutter, track) {
  gutter.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !e.target.closest(".tg-drag, .tg-grip")) return;
    e.preventDefault();
    const title = currentLayout().tracks.find((t) => t.id === track.id)?.channels.map((id) => channelMeta(id).name).join(" + ");
    startLayoutDrag(e, { type: "track", trackId: track.id }, title || "");
  });
  gutter.querySelector(".tg-menu")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openTrackMenu(e.currentTarget, track);
  });
}

/** Arraste de uma faixa (pelo nome) ou de um canal da barra lateral até o
 * gráfico. Bordas entre faixas = inserir ali; meio de uma faixa analógica =
 * sobrepor. Começa só depois de 5 px (um clique simples continua clique). */
function startLayoutDrag(e, source, label) {
  const x0 = e.clientX;
  const y0 = e.clientY;
  let active = false;
  let ghost = null;
  let line = null;
  let target = null;
  let hl = null;
  let lastEv = null;
  let raf = 0;
  // perto da borda de cima/baixo da área das faixas, rola sozinho (para levar
  // a faixa a uma posição fora da tela)
  const autoScroll = () => {
    raf = 0;
    if (!active || !lastEv) return;
    const a = els.tracksContainer.getBoundingClientRect();
    const edge = 36;
    let dy = 0;
    if (lastEv.clientY < a.top + edge) dy = -Math.ceil((a.top + edge - lastEv.clientY) / 3);
    else if (lastEv.clientY > a.bottom - edge) dy = Math.ceil((lastEv.clientY - (a.bottom - edge)) / 3);
    if (dy && lastEv.clientX >= a.left && lastEv.clientX <= a.right) {
      const before = els.tracksContainer.scrollTop;
      els.tracksContainer.scrollTop += dy;
      if (els.tracksContainer.scrollTop !== before) show(lastEv);
      raf = requestAnimationFrame(autoScroll);
    }
  };
  const cleanup = () => {
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey, true);
    ghost?.remove();
    line?.remove();
    hl?.classList.remove("drop-overlay-ok", "drop-overlay-bad");
    document.body.classList.remove("dragging-track");
  };
  const show = (ev) => {
    ghost.style.left = `${ev.clientX + 12}px`;
    ghost.style.top = `${ev.clientY + 8}px`;
    target = layoutDropTarget(ev.clientX, ev.clientY, source);
    hl?.classList.remove("drop-overlay-ok", "drop-overlay-bad");
    hl = null;
    line.style.display = "none";
    ghost.querySelector(".dg-hint").textContent = "";
    if (!target) return;
    if (target.action === "overlay") {
      hl = target.row.querySelector(".track-canvas-wrap");
      hl.classList.add(target.ok ? "drop-overlay-ok" : "drop-overlay-bad");
      ghost.querySelector(".dg-hint").textContent = target.ok ? "sobrepor nesta faixa" : target.reason;
    } else {
      line.style.display = "block";
      line.style.top = `${target.y - 1}px`;
      line.style.left = `${target.left}px`;
      line.style.width = `${target.width}px`;
      ghost.querySelector(".dg-hint").textContent = source.type === "track" ? "mover para cá"
        : source.type === "channels" ? "uma faixa para cada, aqui" : "abrir aqui";
    }
  };
  const onMove = (ev) => {
    if (!active) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      active = true;
      document.body.classList.add("dragging-track");
      ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.innerHTML = `<b>${escapeHtml(label)}</b><span class="dg-hint"></span>`;
      line = document.createElement("div");
      line.className = "drop-line";
      document.body.append(ghost, line);
    }
    lastEv = ev;
    show(ev);
    if (!raf) raf = requestAnimationFrame(autoScroll);
  };
  const onUp = () => {
    cleanup();
    if (!active) return;
    suppressNextClick();
    if (target) applyLayoutDrop(source, target);
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      cleanup();
      if (active) suppressNextClick();
    }
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("keydown", onKey, true);
}

/** Depois de um arraste, o clique que o navegador dispara ao soltar não deve
 * marcar checkbox nem abrir nada. */
function suppressNextClick() {
  const stop = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 300);
}

function sourceIds(source) {
  if (source.type === "track") return [...(currentLayout().tracks.find((t) => t.id === source.trackId)?.channels || [])];
  if (source.type === "channels") return source.ids.map(String);
  return [String(source.id)];
}

function layoutDropTarget(cx, cy, source) {
  const area = els.tracksContainer.getBoundingClientRect();
  if (cx < area.left || cx > area.right || cy < area.top - 10 || cy > area.bottom + 10) return null;
  const L = currentLayout();
  const rows = Array.from(els.tracksContainer.querySelectorAll(".track-row"));
  const lineAt = (pos) => {
    const r = rows[Math.min(pos, rows.length - 1)]?.getBoundingClientRect();
    const y = !r ? area.top + 2 : pos >= rows.length ? r.bottom : r.top;
    return { y: Math.min(Math.max(y, area.top + 1), area.bottom - 1), left: area.left, width: area.width };
  };
  if (!rows.length) return { action: "insert", pos: 0, ...lineAt(0) };
  const ids = sourceIds(source);
  const srcKind = channelMeta(ids[0]).kind;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i].getBoundingClientRect();
    if (cy < r.top || cy > r.bottom) continue;
    const track = L.tracks.find((t) => t.id === rows[i].dataset.trackId);
    const pos = L.tracks.indexOf(track);
    const rel = (cy - r.top) / (r.height || 1);
    const same = source.type === "track" && track.id === source.trackId;
    const kindsMatch = srcKind === "analog" && trackKind(track) === "analog";
    const t = dropTarget(pos, rel, kindsMatch && !same);
    if (t.action === "overlay") {
      const check = canOverlay(L, track.id, ids, channelMeta);
      return { ...t, track, row: rows[i], ok: check.ok, reason: check.reason };
    }
    return { ...t, ...lineAt(t.pos) };
  }
  return cy < rows[0].getBoundingClientRect().top ? { action: "insert", pos: 0, ...lineAt(0) }
    : { action: "insert", pos: rows.length, ...lineAt(rows.length) };
}

function applyLayoutDrop(source, target) {
  const L = currentLayout();
  const ids = sourceIds(source);
  if (target.action === "overlay") {
    if (!target.ok) {
      showToast(target.reason);
      return;
    }
    if (source.type === "track") overlayTrack(L, source.trackId, target.track.id, channelMeta);
    else overlayChannels(L, target.track.id, ids, channelMeta);
  } else if (source.type === "track") {
    moveTrack(L, source.trackId, target.pos);
  } else {
    // vários canais da lista entre faixas: uma faixa para cada, na ordem da lista
    insertChannelsEach(L, ids, target.pos);
  }
  // canal da lista que ainda não estava aberto: abre (busca os dados)
  const fresh = ids.filter((id) => /^\d+$/.test(id) && !state.selectedChannels.has(Number(id)));
  if (fresh.length) {
    fresh.forEach((id) => state.selectedChannels.add(Number(id)));
    syncChannelCheckboxes();
    refreshView();
    bus.emit("channels");
  } else {
    relayout();
  }
}

function openTrackMenu(btn, track) {
  document.getElementById("track-menu")?.remove();
  const L = currentLayout();
  const i = L.tracks.indexOf(track);
  if (i < 0) return;
  const raw = track.channels.filter((id) => /^\d+$/.test(id));
  const items = [
    { id: "up", label: "Mover para cima", disabled: i === 0 },
    { id: "down", label: "Mover para baixo", disabled: i === L.tracks.length - 1 },
    ...(track.channels.length > 1 ? [{ id: "split", label: "Separar canais" }] : []),
    ...(raw.length === track.channels.length ? [{ id: "close", label: track.channels.length > 1 ? "Fechar estes canais" : "Fechar canal" }] : []),
  ];
  const pop = document.createElement("div");
  pop.id = "track-menu";
  pop.className = "track-menu";
  pop.setAttribute("role", "menu");
  pop.innerHTML = items.map((it) => `<button type="button" class="menu-item" role="menuitem" data-act="${it.id}" ${it.disabled ? "disabled" : ""}>${it.label}</button>`).join("");
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)}px`;
  pop.style.top = `${Math.min(r.bottom + 2, window.innerHeight - pop.offsetHeight - 8)}px`;
  pop.querySelector("button:not([disabled])")?.focus();
  const close = () => {
    pop.remove();
    window.removeEventListener("mousedown", outside, true);
    window.removeEventListener("keydown", onKey, true);
  };
  const outside = (e) => { if (!pop.contains(e.target)) close(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); btn.focus(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const bs = Array.from(pop.querySelectorAll("button:not([disabled])"));
      const k = bs.indexOf(document.activeElement);
      bs[(k + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length]?.focus();
      e.preventDefault();
    }
  };
  window.addEventListener("mousedown", outside, true);
  window.addEventListener("keydown", onKey, true);
  pop.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    close();
    if (act === "up") moveTrack(L, track.id, i - 1);
    else if (act === "down") moveTrack(L, track.id, i + 2);
    else if (act === "split") splitTrack(L, track.id);
    else if (act === "close") {
      raw.forEach((id) => state.selectedChannels.delete(Number(id)));
      syncChannelCheckboxes();
      refreshView();
      bus.emit("channels");
      return;
    }
    relayout();
    // devolve o foco ao menu da faixa movida (teclado)
    els.tracksContainer.querySelector(`.track-row[data-track-id="${track.id}"] .tg-menu`)?.focus();
  });
}

function showToast(message) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 3500);
}

/** Passar o mouse não move nada: só guarda o tempo para as teclas 1/2. */
function onTrackMouseMove(e, wrap) {
  const rect = wrap.getBoundingClientRect();
  state.pointerTime = xToTime(e.clientX - rect.left, rect.width);
}

/** Gestos nas faixas:
 * - esquerdo: clique posiciona o cursor; arrastando, ele acompanha o mouse
 *   (C1/C2: teclas 1/2, botões ou arrastar as linhas);
 * - direito: arrastar desenha um retângulo e dá zoom nele (tempo e, se o
 *   retângulo ficar dentro de uma faixa analógica, também a escala vertical
 *   dela); clique direito sem arrastar volta ao zoom anterior;
 * - botão da roda (meio): volta ao zoom anterior;
 * - Shift + roda: desloca no tempo (bindTrackWheel). */
function onTrackMouseDown(e, wrap) {
  if (e.button === 2) {
    startZoomRect(e, wrap);
    return;
  }
  if (e.button === 1) {
    e.preventDefault(); // impede a rolagem automática do Windows
    // dois cliques no botão da roda: volta ao registro inteiro; um: zoom anterior
    const now = performance.now();
    if (now - lastMiddleClick < 450) {
      lastMiddleClick = 0;
      zoomFit();
    } else {
      lastMiddleClick = now;
      zoomBack();
    }
    return;
  }
  if (e.button !== 0) return;
  e.preventDefault(); // evita selecionar texto ao arrastar
  const rect = wrap.getBoundingClientRect();
  const toTime = (clientX) => xToTime(Math.min(Math.max(clientX - rect.left, 0), rect.width), rect.width);
  moveCursorTo(toTime(e.clientX));
  const onMove = (ev) => moveCursorTo(toTime(ev.clientX));
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

let lastMiddleClick = 0;

function moveCursorTo(time) {
  state.cursorTime = time;
  ruler.setCursor(time);
  updateCursorLines();
  updatePhasorPanel();
  updateStatus();
  emitCursor();
}

// ---------------------------------------------------------------------------
// Zoom por retângulo (botão direito)
// ---------------------------------------------------------------------------
const ZOOM_MIN_PX = 6;

function startZoomRect(e, wrap) {
  e.preventDefault();
  const area = els.tracksContainer.getBoundingClientRect();
  const plot = wrap.getBoundingClientRect(); // limites horizontais da área de plotagem
  const clampX = (x) => Math.min(Math.max(x, plot.left), plot.right);
  const clampY = (y) => Math.min(Math.max(y, area.top), area.bottom);
  const x0 = clampX(e.clientX);
  const y0 = clampY(e.clientY);
  let x1 = x0;
  let y1 = y0;
  const box = document.createElement("div");
  box.className = "zoom-rect";
  document.body.appendChild(box);
  document.body.classList.add("zooming-rect");
  const draw = () => {
    box.style.left = `${Math.min(x0, x1)}px`;
    box.style.top = `${Math.min(y0, y1)}px`;
    box.style.width = `${Math.abs(x1 - x0)}px`;
    box.style.height = `${Math.abs(y1 - y0)}px`;
  };
  draw();
  const onMove = (ev) => {
    x1 = clampX(ev.clientX);
    y1 = clampY(ev.clientY);
    draw();
  };
  const onUp = (ev) => {
    if (ev.button !== 2) return;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    box.remove();
    document.body.classList.remove("zooming-rect");
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    if (dx < ZOOM_MIN_PX && dy < ZOOM_MIN_PX) {
      zoomBack();
      return;
    }
    applyZoomRect(wrap, plot, { x0, x1, y0, y1 }, dx >= ZOOM_MIN_PX);
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/** Converte o retângulo (coordenadas da janela) em novo intervalo de tempo e,
 * quando cabe numa faixa analógica, em escala vertical dela. */
function applyZoomRect(startWrap, plot, r, zoomTime) {
  const { viewStart, viewEnd } = state;
  const span = viewEnd - viewStart || 1;
  const next = { viewStart, viewEnd };
  if (zoomTime) {
    const tA = viewStart + ((Math.min(r.x0, r.x1) - plot.left) / plot.width) * span;
    const tB = viewStart + ((Math.max(r.x0, r.x1) - plot.left) / plot.width) * span;
    const minSpan = (state.record?.duration_s || 1) / 500;
    if (tB - tA >= minSpan * 0.999) {
      next.viewStart = Math.max(0, tA);
      next.viewEnd = Math.min(state.record.duration_s, tB);
    } else {
      const c = (tA + tB) / 2;
      next.viewStart = Math.max(0, c - minSpan / 2);
      next.viewEnd = Math.min(state.record.duration_s, next.viewStart + minSpan);
    }
  }
  // zoom vertical: o retângulo terminou na mesma faixa analógica em que começou;
  // vale para todos os eixos da faixa (canais sobrepostos), cada um na sua escala
  const canvas = startWrap.querySelector("canvas[data-track-id]");
  const track = canvas && currentLayout().tracks.find((t) => t.id === canvas.dataset.trackId);
  const wr = startWrap.getBoundingClientRect();
  const insideStart = r.y1 >= wr.top && r.y1 <= wr.bottom;
  let yNew = null;
  if (track && canvas._axes?.length && insideStart && Math.abs(r.y1 - r.y0) >= ZOOM_MIN_PX) {
    yNew = {};
    for (const ax of canvas._axes) {
      const toV = (y) => ax.lo + ((wr.bottom - y) / wr.height) * (ax.hi - ax.lo);
      const vA = toV(Math.max(r.y0, r.y1));
      const vB = toV(Math.min(r.y0, r.y1));
      if (vB > vA) yNew[ax.key] = [vA, vB];
    }
    if (!Object.keys(yNew).length) yNew = null;
  }
  if (!zoomTime && !yNew) return;
  state.zoomHistory.push({ viewStart, viewEnd, yZoom: snapshotYZoom() });
  if (state.zoomHistory.length > 30) state.zoomHistory.shift();
  if (yNew) track.yZoom = { ...track.yZoom, ...yNew };
  state.viewStart = next.viewStart;
  state.viewEnd = next.viewEnd;
  applyViewChrome();
  refreshView();
}

function zoomBack() {
  const prev = state.zoomHistory.pop();
  if (!prev) return;
  state.viewStart = prev.viewStart;
  state.viewEnd = Math.min(prev.viewEnd, state.record?.duration_s ?? prev.viewEnd);
  currentLayout().tracks.forEach((t) => {
    t.yZoom = { ...(prev.yZoom.get(t.id) || {}) };
  });
  applyViewChrome();
  refreshView();
}

/** Zoom vertical de todas as faixas (para o "voltar ao zoom anterior"). */
function snapshotYZoom() {
  return new Map(currentLayout().tracks.map((t) => [t.id, { ...t.yZoom }]));
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

/** Consulta durante pan/zoom contínuos: no máximo uma em andamento; ao
 * terminar, se a janela mudou de novo, já pede a próxima (a tela acompanha a
 * rolagem em vez de esperar o usuário parar). */
let panInflight = false;
let panPending = false;
async function panRefreshView() {
  if (panInflight) {
    panPending = true;
    return;
  }
  panInflight = true;
  try {
    await refreshView({ skipDerived: state.selectedChannels.size > 0 });
  } finally {
    panInflight = false;
    if (panPending) {
      panPending = false;
      requestAnimationFrame(() => panRefreshView());
    }
  }
}
const panRefreshDerived = debounce(() => refreshView({ derivedOnly: true }), 250);

// ---------------------------------------------------------------------------
// Valores nos cursores C1/C2 (RMS verdadeiro | RMS fundamental | instantâneo)
// Calculados no backend só nos instantes de C1/C2 e só quando eles (ou o modo,
// ou os canais) mudam – nada é recalculado ao passar o mouse.
// ---------------------------------------------------------------------------
const CV_TITLE = "Valor em C1/C2 – posicione C1 com clique na faixa ou tecla 1; C2 com Shift+clique ou tecla 2";

function cvHtml(index) {
  return `<div class="cv" data-cv="${index}" title="${CV_TITLE}"><span class="cv-empty">—</span></div>`;
}

let cvSeq = 0;
async function updateCursorValues() {
  const nodes = document.querySelectorAll("[data-cv]");
  const { c1, c2 } = state.fixedCursors;
  const hasC1 = c1 != null;
  const hasC2 = c2 != null;
  applyTrackHeights();
  const chans = state.waveformCache?.channels || [];
  if (!state.record || !chans.length || (!hasC1 && !hasC2)) {
    nodes.forEach((el) => { el.innerHTML = cursorValuesHtml({ hasC1: false, hasC2: false }); });
    return;
  }
  const raw = chans.filter((ch) => ch.kind !== "derived" && /^\d+$/.test(String(ch.index))).map((ch) => Number(ch.index));
  const times = [c1, c2].filter((t) => t != null);
  const key = `${state.record.id}|${state.valueMode}|${times.join(",")}|${raw.join(",")}`;
  const seq = ++cvSeq;
  if (raw.length && state.cursorValues.key !== key) {
    try {
      const res = await fetchValueAtTime(state.record.id, raw, null, { times, mode: state.valueMode });
      if (seq !== cvSeq) return;
      const byIndex = new Map();
      res.points.forEach((pt, i) => {
        const slot = hasC1 && i === 0 ? "c1" : "c2";
        pt.channels.forEach((ch) => {
          const entry = byIndex.get(String(ch.index)) || {};
          entry[slot] = ch.value;
          byIndex.set(String(ch.index), entry);
        });
      });
      state.cursorValues = { key, byIndex };
    } catch (err) {
      if (seq !== cvSeq) return;
      console.warn("Valor no cursor:", err);
      state.cursorValues = { key: "", byIndex: new Map() };
    }
  }
  if (seq !== cvSeq) return;
  const byChan = new Map(chans.map((ch) => [String(ch.index), ch]));
  document.querySelectorAll("[data-cv]").forEach((el) => {
    const ch = byChan.get(String(el.dataset.cv));
    if (!ch) {
      el.innerHTML = cursorValuesHtml({ hasC1: false, hasC2: false });
      return;
    }
    let v;
    if (ch.kind === "derived") {
      // grandezas calculadas (já são módulos/RMS): interpolação da série exibida
      v = { c1: hasC1 ? interpolateValue(ch.times, ch.values, c1) : null, c2: hasC2 ? interpolateValue(ch.times, ch.values, c2) : null };
    } else {
      v = state.cursorValues.byIndex.get(String(ch.index)) || {};
    }
    el.innerHTML = cursorValuesHtml({ kind: ch.kind, unit: ch.unit, mode: state.valueMode, hasC1, hasC2, c1: v.c1 ?? null, c2: v.c2 ?? null });
  });
}

/** Ajusta a altura das faixas quando muda o nº de linhas de valor (C1 ↔ C1·C2·Δ). */
let lastCvLines = 0;
function applyTrackHeights() {
  const lines = cursorLineCount(state.fixedCursors.c1 != null, state.fixedCursors.c2 != null);
  if (lines === lastCvLines) return;
  lastCvLines = lines;
  const L = currentLayout();
  let changed = false;
  els.tracksContainer.querySelectorAll(".track-row[data-track-id]").forEach((row) => {
    const track = L.tracks.find((t) => t.id === row.dataset.trackId);
    const wrap = row.querySelector(".track-canvas-wrap");
    if (!track || !wrap) return;
    const h = `${trackHeight(track)}px`;
    if (wrap.style.height !== h) { wrap.style.height = h; changed = true; }
  });
  if (changed) redrawAllCanvases();
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
  redrawAllCanvases(); // desloca já o que está carregado; a consulta completa vem em seguida
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
  currentLayout().tracks.forEach((t) => { t.yZoom = {}; });
  state.zoomHistory = [];
  state.viewStart = 0;
  state.viewEnd = state.record.duration_s;
  applyViewChrome();
  refreshView();
}

function zoomToSelection() {
  if (!state.selection) {
    alert("Selecione um intervalo arrastando o mouse na régua (ou use o botão direito nas faixas para dar zoom num retângulo).");
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
  els.statusCursors.textContent = parts.length ? parts.join(" · ") : "C1/C2: teclas 1 e 2 (na posição do mouse)";
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
  if (e.button !== 0) return; // botão direito: segue para a faixa (zoom por retângulo)
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
    const items = Array.from(row.querySelectorAll(".tg-ch"));
    if (items.length > 1) {
      // faixa sobreposta: nome de cada canal com a cor da curva
      g.font = "11px Segoe UI, Arial, sans-serif";
      items.forEach((it, k) => {
        const yy = y + 14 + k * 14;
        if (yy > y + h - 4) return;
        g.fillStyle = it.querySelector(".sw")?.style.background || "#2a2a2a";
        g.fillRect(8, yy - 8, 9, 9);
        g.fillStyle = "#2a2a2a";
        g.fillText(fit(`${it.querySelector(".tg-ch-name")?.textContent || ""} ${it.querySelector(".unit")?.textContent || ""}`.trim(), gutterW - 26), 22, yy);
      });
    } else {
      g.fillText(fit(row.dataset.title || row.querySelector(".name")?.textContent.trim() || "", gutterW - 12), 8, y + 18);
      g.fillStyle = "#666";
      g.font = "11px Segoe UI, Arial, sans-serif";
      g.fillText(fit(row.querySelector(".meta")?.textContent.trim() || "", gutterW - 12), 8, y + 33);
    }
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
