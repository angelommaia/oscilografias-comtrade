/**
 * Diálogo "Juntar registros": escolhe 2–6 oscilografias abertas nesta sessão,
 * o modo de alinhamento (início da perturbação, trigger ou horário GPS) e
 * ajustes manuais; o backend cria um registro combinado que passa a ser o
 * registro atual (todas as análises funcionam sobre ele).
 */
import { IS_DESKTOP, fetchJson, formatTime, loadFromPath, loadFromUpload, pickComtradeFile } from "./api.js";
import { escapeHtml, fmtNum } from "./core/bus.js";

const MODES = [
  { id: "onset", label: "Início da perturbação", help: "Para registros sem sincronismo: alinha o primeiro instante em que tensões/correntes variam em cada registro." },
  { id: "trigger", label: "Trigger", help: "Alinha os instantes de trigger gravados nos arquivos." },
  { id: "absolute", label: "Horário dos arquivos (GPS)", help: "Usa a data/hora de início de cada .cfg – para registradores sincronizados." },
];

const fmtMs = (v) => (v == null ? "—" : `${fmtNum(v, { decimals: 1 })} ms`);

export function openMergeDialog({ current, onMerged }) {
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
        Os sinais são reamostrados numa base de tempo comum; o registro combinado aceita todas as análises.</p>
      <div class="mg-list"><p class="muted">Carregando…</p></div>
      <div class="mg-add">
        <button type="button" class="btn btn-sm mg-add-btn">+ Adicionar arquivo…</button>
        <input type="file" class="mg-file hidden" accept=".cfg,.CFG,.dat,.DAT" multiple />
        <span class="muted mg-add-msg"></span>
      </div>
      <label class="mg-mode">Alinhamento
        <select name="mode" class="select">${MODES.map((m) => `<option value="${m.id}" title="${escapeHtml(m.help)}" ${m.id === (spec?.mode || "onset") ? "selected" : ""}>${m.label}</option>`).join("")}</select>
      </label>
      <p class="muted mg-mode-help"></p>
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
  modeSel.addEventListener("change", syncHelp);
  syncHelp();

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
    const checked = new Set(spec ? [...prev.keys()] : records.slice(0, 2).map((r) => r.id));
    if (!spec && current && !current.merge) checked.add(current.id);
    const refId = spec?.reference || (current && !current.merge ? current.id : records[0].id);
    list.innerHTML = `
      <table class="phasor-table mg-table">
        <thead><tr><th></th><th>Rótulo</th><th>Arquivo</th><th class="num">Trigger</th><th class="num">Taxa</th><th title="Registro de referência (tempo zero)">Ref.</th><th class="num" title="Ajuste manual somado ao alinhamento">Ajuste (ms)</th></tr></thead>
        <tbody>${records.map((r) => {
          const p = prev.get(r.id);
          const label = p?.label || r.station || r.device || "";
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
  }

  // adicionar arquivo sem trocar o registro exibido
  const addBtn = dlg.querySelector(".mg-add-btn");
  const fileInput = dlg.querySelector(".mg-file");
  const addMsg = dlg.querySelector(".mg-add-msg");
  addBtn.addEventListener("click", async () => {
    if (IS_DESKTOP) {
      try {
        const path = await pickComtradeFile();
        if (!path) return;
        addMsg.textContent = "Lendo…";
        await loadFromPath(path);
        addMsg.textContent = "";
        refresh();
        return;
      } catch (e) {
        console.warn(e);
      }
    }
    fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    const cfg = files.find((f) => /\.cfg$/i.test(f.name));
    const dat = files.find((f) => /\.dat$/i.test(f.name));
    fileInput.value = "";
    if (!cfg || !dat) {
      addMsg.textContent = "Selecione o .cfg e o .dat juntos.";
      return;
    }
    addMsg.textContent = "Enviando…";
    try {
      await loadFromUpload(cfg, dat);
      addMsg.textContent = "";
      refresh();
    } catch (e) {
      addMsg.textContent = e.message;
    }
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (e.submitter?.value === "cancel") {
      dlg.close();
      return;
    }
    err.textContent = "";
    const rows = Array.from(list.querySelectorAll("tr[data-id]")).filter((tr) => tr.querySelector(".mg-use").checked);
    if (rows.length < 2) {
      err.textContent = "Marque pelo menos dois registros.";
      return;
    }
    const ref = form.querySelector('input[name="mgref"]:checked')?.value;
    const body = {
      mode: modeSel.value,
      reference: rows.some((tr) => tr.dataset.id === ref) ? ref : rows[0].dataset.id,
      records: rows.map((tr) => ({
        id: tr.dataset.id,
        label: tr.querySelector(".mg-label").value.trim(),
        offset_ms: Number(tr.querySelector(".mg-offset").value) || 0,
      })),
    };
    const ok = form.querySelector('button[value="ok"]');
    ok.disabled = true;
    ok.textContent = "Juntando…";
    try {
      const meta = await fetchJson("/api/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      dlg.close();
      onMerged(meta);
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      ok.disabled = false;
      ok.textContent = "Juntar";
    }
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
    const tip = `Horário: ${fmtMs(c.absolute)} · Trigger: ${fmtMs(c.trigger)} · Perturbação: ${fmtMs(c.onset)}`
      + (r.onset_channel ? ` (detectado em ${r.onset_channel})` : "");
    const isRef = r.id === spec.reference;
    return `<tr title="${escapeHtml(tip)}"><td>${escapeHtml(r.label)}${isRef ? ' <span class="muted">ref.</span>' : ""}</td>
      <td class="num">${isRef ? "0" : fmtMs(r.shift_ms)}</td>
      <td>${isRef ? "" : escapeHtml(modeName(r.mode_used))}${r.offset_ms ? ` ${r.offset_ms > 0 ? "+" : ""}${fmtNum(r.offset_ms, { decimals: 1 })} ms` : ""}</td></tr>
      ${!isRef && r.clock_error_ms != null && Math.abs(r.clock_error_ms) > 1 ? `<tr><td colspan="3" class="mg-clock">relógio do arquivo difere ${fmtMs(r.clock_error_ms)}</td></tr>` : ""}`;
  }).join("");
  return `<div class="mg-info">
    <table class="mg-info-table"><tbody>${rows}</tbody></table>
    ${(spec.notes || []).map((n) => `<p class="phasor-hint">${escapeHtml(n)}</p>`).join("")}
    <button type="button" class="link-btn mg-adjust">Ajustar alinhamento…</button>
  </div>`;
}
