/**
 * Diálogo "Juntar registros": escolhe 2–6 oscilografias abertas nesta sessão,
 * o modo de alinhamento (GPS / horário absoluto – padrão –, início da
 * perturbação ou trigger) e
 * ajustes manuais; o backend cria um registro combinado que passa a ser o
 * registro atual (todas as análises funcionam sobre ele).
 */
import { IS_DESKTOP, fetchJson, formatTime, pickComtradeFiles } from "./api.js";
import { escapeHtml, fmtNum } from "./core/bus.js";
import { ACCEPT, openSources } from "./open-files.js";

const MODES = [
  { id: "absolute", label: "GPS / horário absoluto", help: "Usa a data/hora de início de cada .cfg (convertida para UTC quando o fuso é informado) – para registradores sincronizados por GPS." },
  { id: "onset", label: "Início da perturbação", help: "Para registros sem sincronismo: alinha o primeiro instante em que tensões/correntes variam em cada registro." },
  { id: "trigger", label: "Trigger", help: "Alinha os instantes de trigger gravados nos arquivos." },
];
const DEFAULT_MODE = "absolute";
const STATUS_TEXT = { ok: "", invalid: "sem data/hora válida", no_overlap: "sem sobreposição", too_far: "inícios distantes" };

const fmtMs = (v) => (v == null ? "—" : `${fmtNum(v, { decimals: 1 })} ms`);

/** Adiciona arquivos ao diálogo aberto (arrastar e soltar com o Juntar aberto). */
let activeAdd = null;

export function isMergeDialogOpen() {
  return !!document.getElementById("merge-dialog")?.open && !!activeAdd;
}

export function addToMergeDialog(src) {
  if (activeAdd) activeAdd(src);
}

/** preselect: ids a marcar (ex.: "Juntar selecionados" da lista de um .zip). */
export function openMergeDialog({ current, onMerged, preselect = null }) {
  let dlg = document.getElementById("merge-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "merge-dialog";
    dlg.className = "group-dialog merge-dialog";
    document.body.appendChild(dlg);
  }
  const spec = current?.merge || null;
  const prev = new Map((spec?.records || []).map((r) => [r.id, r]));
  dlg.innerHTML = `
    <form method="dialog" autocomplete="off">
      <h3>Juntar registros</h3>
      <p class="muted mg-help">Abra as oscilografias de cada terminal (elas ficam na memória) e escolha quais juntar.
        Também dá para arrastar arquivos, .zip ou pastas para cá.
        Os sinais são reamostrados numa base de tempo comum; o registro combinado aceita todas as análises.</p>
      <div class="mg-list"><p class="muted">Carregando…</p></div>
      <div class="mg-add">
        <button type="button" class="btn btn-sm mg-add-btn">+ Adicionar arquivo…</button>
        <input type="file" class="mg-file hidden" accept="${ACCEPT}" multiple />
        <span class="muted mg-add-msg"></span>
      </div>
      <label class="mg-mode">Alinhamento
        <select name="mode" class="select">${MODES.map((m) => `<option value="${m.id}" title="${escapeHtml(m.help)}" ${m.id === (spec?.mode || DEFAULT_MODE) ? "selected" : ""}>${m.label}</option>`).join("")}</select>
      </label>
      <p class="muted mg-mode-help"></p>
      <div class="mg-preview"></div>
      <div class="mg-warn hidden"></div>
      <p class="dlg-error"></p>
      <div class="dlg-actions">
        <button value="cancel" class="btn" formnovalidate>Fechar</button>
        <button value="ok" class="btn btn-primary">Juntar</button>
      </div>
    </form>`;
  const form = dlg.querySelector("form");
  const list = dlg.querySelector(".mg-list");
  const err = dlg.querySelector(".dlg-error");
  const modeSel = form.elements.mode;
  const modeHelp = dlg.querySelector(".mg-mode-help");
  const syncHelp = () => {
    modeHelp.textContent = MODES.find((m) => m.id === modeSel.value)?.help || "";
  };
  modeSel.addEventListener("change", () => {
    syncHelp();
    schedulePreview();
  });
  syncHelp();

  // ---- pré-visualização: candidatos, compatibilidade do GPS e qualidade de tempo
  const previewEl = dlg.querySelector(".mg-preview");
  const warnEl = dlg.querySelector(".mg-warn");
  let previewGen = 0;
  let lastPreview = null;

  function currentBody() {
    const rows = Array.from(list.querySelectorAll("tr[data-id]")).filter((tr) => tr.querySelector(".mg-use").checked);
    const ref = form.querySelector('input[name="mgref"]:checked')?.value;
    return {
      rows,
      body: {
        mode: modeSel.value,
        reference: rows.some((tr) => tr.dataset.id === ref) ? ref : rows[0]?.dataset.id,
        records: rows.map((tr) => ({
          id: tr.dataset.id,
          label: tr.querySelector(".mg-label").value.trim(),
          offset_ms: Number(tr.querySelector(".mg-offset").value) || 0,
        })),
      },
    };
  }

  function renderPreview(pv) {
    lastPreview = pv;
    if (!pv) {
      previewEl.innerHTML = "";
      warnEl.classList.add("hidden");
      return;
    }
    const cand = (r, k) => {
      if (r.id === pv.reference) return "ref.";
      const v = r.candidates_ms?.[k];
      return v == null ? "—" : `${v > 0 ? "+" : ""}${fmtNum(v, { decimals: 1 })} ms`;
    };
    previewEl.innerHTML = `
      <table class="phasor-table mg-pv-table">
        <thead><tr><th>Registro</th><th>Início (.cfg) · tempo</th>
          <th class="num" title="Deslocamento pelo horário absoluto">GPS</th><th class="num">Trigger</th><th class="num" title="Início da perturbação">Perturbação</th></tr></thead>
        <tbody>${pv.records.map((r) => `
          <tr class="${r.absolute_status !== "ok" ? "mg-bad" : ""}">
            <td>${escapeHtml(r.label)}</td>
            <td><span class="mg-start">${escapeHtml(r.start_time || "data/hora inválida")}</span><br>
              <span class="muted mg-tq" title="Fuso (time_code), qualidade do relógio (tmq_code) e segundo bissexto do .cfg">${escapeHtml(r.time_summary || "")}</span></td>
            <td class="num">${cand(r, "absolute")}${r.absolute_status !== "ok" ? `<br><span class="mg-status">${escapeHtml(STATUS_TEXT[r.absolute_status] || "")}</span>` : ""}</td>
            <td class="num">${cand(r, "trigger")}</td>
            <td class="num">${cand(r, "onset")}</td>
          </tr>`).join("")}</tbody>
      </table>
      ${(pv.notes || []).map((n) => `<p class="phasor-hint">${escapeHtml(n)}</p>`).join("")}`;
    showGpsWarning(pv.mode === "absolute" && !pv.absolute_ok
      ? { message: pv.absolute_problems.map((p) => `${p.label}: ${p.message}`).join("; "), forceable: pv.absolute_forceable }
      : null);
  }

  /** Aviso de GPS incompatível: sugere "Início da perturbação"; não troca o modo sozinho. */
  function showGpsWarning(w) {
    if (!w) {
      warnEl.classList.add("hidden");
      warnEl.innerHTML = "";
      return;
    }
    warnEl.innerHTML = `
      <b>Horários absolutos (GPS) incompatíveis.</b> ${escapeHtml(w.message)}.
      Os registros provavelmente não estão sincronizados – use <b>Início da perturbação</b>.
      <div class="mg-warn-actions">
        <button type="button" class="btn btn-sm btn-primary mg-use-onset">Usar Início da perturbação</button>
        ${w.forceable ? '<button type="button" class="btn btn-sm mg-force">Juntar mesmo assim (GPS)</button>' : ""}
      </div>`;
    warnEl.classList.remove("hidden");
  }

  warnEl.addEventListener("click", (e) => {
    if (e.target.closest(".mg-use-onset")) {
      modeSel.value = "onset";
      syncHelp();
      schedulePreview();
    } else if (e.target.closest(".mg-force")) {
      submit(true);
    }
  });

  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 200);
  }

  async function runPreview() {
    const { rows, body } = currentBody();
    if (rows.length < 2) {
      renderPreview(null);
      return;
    }
    const gen = ++previewGen;
    previewEl.innerHTML = '<p class="muted">Calculando alinhamentos…</p>';
    try {
      const pv = await fetchJson("/api/merge/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (gen === previewGen) renderPreview(pv);
    } catch (ex) {
      if (gen === previewGen) previewEl.innerHTML = `<p class="dlg-error">${escapeHtml(ex.message)}</p>`;
    }
  }
  list.addEventListener("change", (e) => {
    if (e.target.matches(".mg-use, input[name=mgref]")) schedulePreview();
  });

  async function refresh() {
    let records = [];
    try {
      records = (await fetchJson("/api/records")).records.filter((r) => !r.merged);
    } catch (e) {
      list.innerHTML = `<p class="dlg-error">${escapeHtml(e.message)}</p>`;
      return;
    }
    if (!records.length) {
      list.innerHTML = '<p class="muted">Nenhuma oscilografia aberta. Use “Adicionar arquivo…”.</p>';
      return;
    }
    // Depois de adicionar arquivos, preserva o que o usuário já marcou/editou.
    const before = new Map(Array.from(list.querySelectorAll("tr[data-id]")).map((tr) => [tr.dataset.id, {
      use: tr.querySelector(".mg-use").checked,
      label: tr.querySelector(".mg-label").value,
      offset_ms: tr.querySelector(".mg-offset").value,
    }]));
    const refBefore = form.querySelector('input[name="mgref"]:checked')?.value;
    let checked;
    if (before.size) {
      checked = new Set([...before].filter(([, v]) => v.use).map(([id]) => id));
    } else if (preselect?.length) {
      checked = new Set(preselect);
    } else {
      checked = new Set(spec ? [...prev.keys()] : records.slice(0, 2).map((r) => r.id));
      if (!spec && current && !current.merge) checked.add(current.id);
    }
    added.forEach((id) => checked.add(id));
    added.clear();
    const ids = new Set(records.map((r) => r.id));
    const refId = [refBefore, spec?.reference, current && !current.merge ? current.id : null]
      .find((id) => id && ids.has(id)) || records[0].id;
    list.innerHTML = `
      <table class="phasor-table mg-table">
        <thead><tr><th></th><th>Rótulo</th><th>Arquivo</th><th class="num">Trigger</th><th class="num">Taxa</th><th title="Registro de referência (tempo zero)">Ref.</th><th class="num" title="Ajuste manual somado ao alinhamento">Ajuste (ms)</th></tr></thead>
        <tbody>${records.map((r) => {
          const b = before.get(r.id);
          const p = b || prev.get(r.id);
          const label = b ? b.label : p?.label || r.station || r.device || "";
          return `<tr data-id="${r.id}">
            <td><input type="checkbox" class="mg-use" ${checked.has(r.id) ? "checked" : ""}/></td>
            <td><input class="an-input mg-label" maxlength="40" value="${escapeHtml(label)}"/></td>
            <td class="mg-file-name" title="${escapeHtml(r.source_name || "")}">${escapeHtml((r.source_name || "").slice(0, 38))}<br><span class="muted">${escapeHtml(r.device || "")} · ${formatTime(r.duration_s)}</span></td>
            <td class="num">${escapeHtml((r.trigger_time || "").slice(11, 23))}</td>
            <td class="num">${fmtNum(r.sample_rate_hz, { decimals: 0 })} Hz</td>
            <td><input type="radio" name="mgref" value="${r.id}" ${r.id === refId ? "checked" : ""}/></td>
            <td class="num"><input class="an-input mg-offset" type="number" step="0.1" value="${p?.offset_ms ?? 0}"/></td>
          </tr>`;
        }).join("")}</tbody>
      </table>`;
    schedulePreview();
  }

  // adicionar arquivos (.cfg/.dat, .cff, .zip, pastas) sem trocar o registro exibido;
  // os novos já entram marcados
  const addBtn = dlg.querySelector(".mg-add-btn");
  const fileInput = dlg.querySelector(".mg-file");
  const addMsg = dlg.querySelector(".mg-add-msg");
  const added = new Set();
  async function addSources(src) {
    addMsg.textContent = "";
    try {
      const res = await openSources({ ...src, purpose: "add", busy: (m) => { addMsg.innerHTML = m || ""; } });
      if (!res) return;
      res.records.forEach((r) => added.add(r.id));
      await refresh();
    } catch (e) {
      addMsg.textContent = e.message;
    }
  }
  activeAdd = addSources;
  dlg.addEventListener("close", () => {
    if (activeAdd === addSources) activeAdd = null;
  }, { once: true });
  addBtn.addEventListener("click", async () => {
    if (IS_DESKTOP) {
      try {
        const paths = await pickComtradeFiles({ title: "Adicionar oscilografia" });
        if (paths.length) addSources({ paths });
        return;
      } catch (e) {
        console.warn(e);
      }
    }
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = "";
    if (files.length) addSources({ files });
  });

  async function submit(force = false) {
    err.textContent = "";
    const { rows, body } = currentBody();
    if (rows.length < 2) {
      err.textContent = "Marque pelo menos dois registros.";
      return;
    }
    const ok = form.querySelector('button[value="ok"]');
    ok.disabled = true;
    ok.textContent = "Juntando…";
    try {
      const meta = await fetchJson("/api/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, force }),
      });
      dlg.close();
      onMerged(meta);
    } catch (ex) {
      if (ex.status === 409 && ex.detail) {
        // GPS incompatível: avisa e deixa o usuário decidir (não troca o modo sozinho)
        showGpsWarning({ message: (ex.detail.problems || []).map((p) => `${p.label}: ${p.message}`).join("; "),
                         forceable: ex.detail.forceable });
      } else {
        err.textContent = ex.message;
      }
    } finally {
      ok.disabled = false;
      ok.textContent = "Juntar";
    }
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (e.submitter?.value === "cancel") {
      dlg.close();
      return;
    }
    // GPS sabidamente incompatível: não tenta juntar, mostra o aviso
    if (modeSel.value === "absolute" && lastPreview && lastPreview.mode === "absolute" && !lastPreview.absolute_ok) {
      showGpsWarning({ message: lastPreview.absolute_problems.map((p) => `${p.label}: ${p.message}`).join("; "),
                       forceable: lastPreview.absolute_forceable });
      warnEl.scrollIntoView({ block: "nearest" });
      return;
    }
    submit(false);
  };
  refresh();
  dlg.showModal();
}

/** Resumo do alinhamento para a barra lateral. */
export function mergeInfoHtml(meta) {
  const spec = meta.merge;
  if (!spec) return "";
  const modeName = (id) => MODES.find((m) => m.id === id)?.label || id;
  const rows = spec.records.map((r) => {
    const c = r.candidates_ms || {};
    const tip = `GPS: ${fmtMs(c.absolute)} · Trigger: ${fmtMs(c.trigger)} · Perturbação: ${fmtMs(c.onset)}`
      + (r.onset_channel ? ` (detectado em ${r.onset_channel})` : "")
      + (r.time_summary ? `\nTempo: ${r.time_summary}` : "");
    const isRef = r.id === spec.reference;
    return `<tr title="${escapeHtml(tip)}"><td>${escapeHtml(r.label)}${isRef ? ' <span class="muted">ref.</span>' : ""}</td>
      <td class="num">${isRef ? "0" : fmtMs(r.shift_ms)}</td>
      <td>${isRef ? "" : escapeHtml(modeName(r.mode_used))}${r.offset_ms ? ` ${r.offset_ms > 0 ? "+" : ""}${fmtNum(r.offset_ms, { decimals: 1 })} ms` : ""}</td></tr>
      ${!isRef && r.mode_used !== "absolute" && r.clock_error_ms != null && Math.abs(r.clock_error_ms) > 1 ? `<tr><td colspan="3" class="mg-clock">relógio do arquivo difere ${fmtMs(r.clock_error_ms)}</td></tr>` : ""}`;
  }).join("");
  return `<div class="mg-info">
    <table class="mg-info-table"><tbody>${rows}</tbody></table>
    ${(spec.notes || []).map((n) => `<p class="phasor-hint">${escapeHtml(n)}</p>`).join("")}
    <button type="button" class="link-btn mg-adjust">Ajustar alinhamento…</button>
  </div>`;
}
