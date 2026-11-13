/** Abrir registros de qualquer fonte: .cfg/.dat, .cff, .zip, pastas
 * e vários arquivos de uma vez – pelo menu, pelo diálogo nativo ou arrastando
 * para a janela.
 *
 * Um registro encontrado → é aberto direto. Vários → lista para escolher:
 * abrir um, ou marcar 2–6 e juntar (ou adicionar, no diálogo Juntar). */

import { IS_DESKTOP, fetchJson, formatTime } from "./api.js";
import { escapeHtml, fmtNum } from "./core/bus.js";

export const ACCEPT = ".cfg,.CFG,.dat,.DAT,.cff,.CFF,.zip,.ZIP";
const EXT_RE = /\.(cfg|dat|cff|zip)$/i;

/** Caminho relativo de arquivos vindos de pastas soltas (web). File não tem
 * esse dado quando vem de webkitGetAsEntry, então guardamos à parte. */
const REL_PATH = new WeakMap();

/** "pasta/sub/A.cfg" para arquivos de pastas; só o nome nos demais.
 * Normaliza separadores e remove "/" inicial, "." e ".." (o backend sanea de
 * novo – isto é só para não mandar lixo). */
export function relativeName(file) {
  const raw = REL_PATH.get(file) || file.webkitRelativePath || file.name;
  const parts = String(raw)
    .split(/[\\/]+/)
    .filter((p) => p && p !== "." && p !== "..");
  return parts.length ? parts.join("/") : file.name;
}

export async function loadFiles(files) {
  const form = new FormData();
  // O 3º argumento vira o filename do multipart: o backend usa as subpastas
  // para agrupar .cfg/.dat de mesmo nome em pastas diferentes e para exibir.
  files.forEach((f) => form.append("files", f, relativeName(f)));
  return fetchJson("/api/load/files", { method: "POST", body: form });
}

export async function loadPaths(paths) {
  return fetchJson("/api/load/path", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
}

async function loadStaged(staging, keys) {
  return fetchJson("/api/load/staged", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ staging, keys }),
  });
}

function dropStaged(staging) {
  fetchJson(`/api/load/staged/${encodeURIComponent(staging)}`, { method: "DELETE" }).catch(() => {});
}

export function fmtBytes(n) {
  if (!n) return "";
  return n >= 1048576 ? `${fmtNum(n / 1048576, { decimals: 1 })} MB` : `${fmtNum(n / 1024, { decimals: 0 })} kB`;
}

/** Resumo para o texto de "carregando". */
export function describeSources({ files, paths }) {
  if (files?.length) {
    const total = files.reduce((s, f) => s + (f.size || 0), 0);
    const name = files.length === 1 ? files[0].name : `${files.length} arquivos`;
    return `${name}${total ? ` (${fmtBytes(total)})` : ""}`;
  }
  if (paths?.length) return paths.length === 1 ? paths[0].split(/[\\/]/).pop() : `${paths.length} itens`;
  return "";
}

/** Abre as fontes e devolve {records, action, sourcePath, notes} ou null (cancelado).
 * purpose: "open" (janela principal) ou "add" (diálogo Juntar).
 * busy(msg|null): mostra/oculta o aviso de carregamento. */
export async function openSources({ files = null, paths = null, purpose = "open", busy = () => {} }) {
  const label = describeSources({ files, paths });
  busy(`Lendo ${escapeHtml(label)}…`);
  let res;
  try {
    res = files ? await loadFiles(files) : await loadPaths(paths);
  } finally {
    busy(null);
  }
  if (!res.choose) {
    return {
      records: [res],
      action: purpose === "add" ? "add" : "open",
      sourcePath: res.source_path || null,
      notes: res.notes || [],
    };
  }
  const pick = await chooseRecords(res.choose, purpose);
  if (!pick) {
    dropStaged(res.choose.staging);
    return null;
  }
  busy(`Lendo ${pick.keys.length > 1 ? `${pick.keys.length} registros` : "registro"}…`);
  try {
    const out = await loadStaged(res.choose.staging, pick.keys);
    return {
      records: out.records,
      action: pick.action,
      sourcePath: paths?.length === 1 ? paths[0] : null,
      notes: res.choose.notes || [],
    };
  } finally {
    busy(null);
    dropStaged(res.choose.staging);
  }
}

/** Texto curto de seleção (puro, testável com node --test). */
export function selectionState(n, add) {
  const max = 6;
  const min = add ? 1 : 2;
  return {
    disabled: n < min || n > max,
    text: n ? `${n} marcado(s)${n > max ? ` – máximo ${max}` : ""}` : "",
  };
}

/** Lista de registros encontrados. Resolve {keys, action} ou null. */
function chooseRecords(choose, purpose) {
  let dlg = document.getElementById("open-choose-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "open-choose-dialog";
    dlg.className = "group-dialog choose-dialog";
    document.body.appendChild(dlg);
  }
  const add = purpose === "add";
  const rows = choose.records.map((r) => {
    const who = [r.station, r.device].filter(Boolean).join(" · ");
    const when = (r.start || "").replace(",", " ").slice(0, 23);
    const rate = r.sample_rate_hz ? `${fmtNum(r.sample_rate_hz, { decimals: 0 })} Hz` : "";
    const dur = r.sample_rate_hz && r.samples ? formatTime(r.samples / r.sample_rate_hz) : "";
    // r.folder: subpasta relativa (backend); ajuda quando há nomes repetidos.
    const where = r.folder ? `<span class="muted ch-folder">${escapeHtml(r.folder)}/</span>` : "";
    return `<tr data-key="${escapeHtml(r.key)}">
      <td><input type="checkbox" class="ch-use" aria-label="Selecionar ${escapeHtml(r.name)}"/></td>
      <td class="ch-name" title="${escapeHtml(r.folder ? `${r.folder}/${r.name}` : r.name)}">${where}${escapeHtml(r.name)}${r.kind === "cff" ? ' <span class="ch-tag">.cff</span>' : ""}<br><span class="muted">${escapeHtml(who)}</span></td>
      <td class="num">${escapeHtml(when)}</td>
      <td class="num">${escapeHtml([rate, dur].filter(Boolean).join(" · "))}</td>
      <td class="num">${escapeHtml(fmtBytes(r.size))}</td>
      ${add ? "" : '<td><button type="button" class="btn btn-sm ch-open">Abrir</button></td>'}
    </tr>`;
  }).join("");
  dlg.innerHTML = `
    <form method="dialog" autocomplete="off">
      <h3>${choose.records.length} registros em ${escapeHtml(choose.title || "")}</h3>
      <p class="muted">${add
        ? "Marque os registros a adicionar à junção (até 6)."
        : "Clique em <b>Abrir</b> para ver um registro, ou marque de 2 a 6 (ex.: os dois terminais da linha) e use <b>Juntar selecionados</b>."}</p>
      <div class="ch-wrap"><table class="phasor-table ch-table">
        <thead><tr><th></th><th>Arquivo</th><th class="num">Início</th><th class="num">Taxa · duração</th><th class="num">Tamanho</th>${add ? "" : "<th></th>"}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${(choose.notes || []).length ? `<p class="muted ch-notes">${choose.notes.map(escapeHtml).join("<br>")}</p>` : ""}
      <p class="dlg-error"></p>
      <div class="dlg-actions">
        <span class="muted ch-count"></span>
        <button value="cancel" class="btn" formnovalidate>Fechar</button>
        <button value="ok" class="btn btn-primary ch-ok" disabled>${add ? "Adicionar selecionados" : "Juntar selecionados"}</button>
      </div>
    </form>`;
  const ok = dlg.querySelector(".ch-ok");
  const count = dlg.querySelector(".ch-count");
  const checked = () => Array.from(dlg.querySelectorAll("tr[data-key]")).filter((tr) => tr.querySelector(".ch-use").checked);
  const sync = () => {
    const s = selectionState(checked().length, add);
    ok.disabled = s.disabled;
    count.textContent = s.text;
  };
  // innerHTML recria form/tabela; o <dialog> é reaproveitado, então os
  // ouvintes ficam no form (descartado a cada abertura), não no dialog.
  const form = dlg.querySelector("form");
  form.addEventListener("change", sync);
  sync();

  return new Promise((resolve) => {
    let result = null;
    form.addEventListener("click", (e) => {
      const btn = e.target.closest(".ch-open");
      if (btn) {
        result = { keys: [btn.closest("tr").dataset.key], action: "open" };
        dlg.close("ok");
      }
    });
    form.addEventListener("dblclick", (e) => {
      const tr = e.target.closest("tr[data-key]");
      if (tr && !add && !e.target.closest("input,button")) {
        result = { keys: [tr.dataset.key], action: "open" };
        dlg.close("ok");
      }
    });
    form.addEventListener("submit", (e) => {
      if (e.submitter?.value !== "ok") return;
      const keys = checked().map((tr) => tr.dataset.key);
      result = { keys, action: add ? "add" : "merge" };
    });
    dlg.addEventListener("close", () => resolve(result), { once: true });
    dlg.showModal();
  });
}

// ---------------------------------------------------------------------------
// Arrastar e soltar arquivos na janela
// ---------------------------------------------------------------------------
function overlay(show) {
  let el = document.getElementById("drop-overlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "drop-overlay";
    el.className = "drop-overlay hidden";
    el.innerHTML = `<div class="drop-box"><b>Solte para abrir</b><span>.cfg + .dat, .cff, .zip ou pasta</span></div>`;
    document.body.appendChild(el);
  }
  el.classList.toggle("hidden", !show);
}

/** Liga o arraste de arquivos. onDrop({files}|{paths}).
 * Web: eventos HTML5 (upload). Desktop: evento do Tauri com os CAMINHOS
 * (o WebView2 não entrega os arquivos ao HTML5 quando o arraste nativo está
 * ligado, e por caminho nada precisa ser enviado).
 * Requer na capability do Tauri: core:event:allow-listen e allow-unlisten. */
export function initFileDrop(onDrop) {
  const listen = window.__TAURI__?.event?.listen;
  if (IS_DESKTOP && listen) {
    listen("tauri://drag-enter", () => overlay(true)).catch(() => {});
    listen("tauri://drag-leave", () => overlay(false)).catch(() => {});
    listen("tauri://drag-drop", (ev) => {
      overlay(false);
      const paths = ev?.payload?.paths || [];
      if (paths.length) onDrop({ paths });
    }).catch((err) => console.warn("Arrastar (desktop):", err));
    // No desktop o HTML5 não recebe arquivos externos; seguir adiante só
    // atrapalharia (ex.: overlay preso). Os arrastes internos usam ponteiro.
    return;
  }
  let depth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    overlay(true);
  });
  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay(false);
  });
  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay(false);
    // dt.items só vale durante o evento: filesFromDrop lê as entradas antes
    // do primeiro await.
    const files = await filesFromDrop(e.dataTransfer);
    if (files.length) onDrop({ files });
    else alert("Nenhum arquivo .cfg, .dat, .cff ou .zip entre os itens soltos.");
  });
}

const MAX_DROP_FILES = 400;
const MAX_DROP_DEPTH = 4;

/** Arquivos soltos, incluindo o conteúdo de pastas (até 4 níveis), com o
 * caminho relativo guardado em REL_PATH ("Pasta/sub/A.cfg"). */
async function filesFromDrop(dt) {
  const entries = Array.from(dt.items || []).map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return Array.from(dt.files || []).filter((f) => EXT_RE.test(f.name));
  const out = [];
  const walk = async (entry, depth) => {
    if (out.length >= MAX_DROP_FILES) return;
    if (entry.isFile) {
      if (!EXT_RE.test(entry.name)) return;
      const file = await new Promise((res, rej) => entry.file(res, rej));
      // fullPath = "/Pasta/sub/A.cfg"; arquivos soltos direto = "/A.cfg".
      REL_PATH.set(file, entry.fullPath || entry.name);
      out.push(file);
    } else if (entry.isDirectory && depth < MAX_DROP_DEPTH) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, depth + 1);
      } while (batch.length && out.length < MAX_DROP_FILES);
    }
  };
  for (const entry of entries) await walk(entry, 0);
  return out;
}
