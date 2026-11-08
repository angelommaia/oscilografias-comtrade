/**
 * Diálogo "Relatório": junta resumo automático, eventos, medições C1/C2,
 * figuras (oscilografia visível e gráfico da aba de análise) e o texto do
 * analista, e gera DOCX/HTML no backend. Na versão desktop o arquivo é gravado
 * direto no caminho escolhido; no navegador é baixado.
 */
import { IS_DESKTOP, fetchJson, pickSavePath, postForBlob } from "./api.js";

const STORE_KEY = "oscilo.report.form";
const TEXT_FIELDS = ["title", "occurrence", "analyst"];
const DEFAULT_TITLE = "Relatório de análise de perturbação";

function loadStored() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveStored(data) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    /* ignora */
  }
}

function summaryParams() {
  try {
    return JSON.parse(localStorage.getItem("oscilo.analysis.params.summary") || "{}");
  } catch {
    return {};
  }
}

/** Maior gráfico (canvas) da aba de análise aberta, sobre fundo branco. */
function captureDock() {
  const panel = document.querySelector("#analysis-dock:not(.hidden) .an-panel:not(.hidden)");
  if (!panel) return null;
  const canvases = Array.from(panel.querySelectorAll("canvas")).filter((c) => c.clientWidth > 50 && c.clientHeight > 50);
  if (!canvases.length) return null;
  const src = canvases.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  const g = out.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(src, 0, 0);
  const tab = document.querySelector(".dock-tab.active")?.textContent?.trim() || "Análise";
  return { caption: tab, data: out.toDataURL("image/png") };
}

function baseName(path) {
  const name = (path || "relatorio").split(/[\\/]/).pop().replace(/\.cfg$/i, "");
  return name.replace(/[<>:"|?*]+/g, "_") || "relatorio";
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function printHtml(html) {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(frame);
  frame.onload = () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } finally {
      setTimeout(() => frame.remove(), 60_000);
    }
  };
  frame.srcdoc = html;
}

export function openReportDialog(ctx) {
  const dialog = document.getElementById("report-dialog");
  const form = dialog.querySelector("form");
  const errEl = form.querySelector(".dlg-error");
  const hint = form.querySelector(".rp-hint");
  errEl.textContent = "";

  if (!ctx.record) {
    alert("Abra uma oscilografia antes de gerar o relatório.");
    return;
  }
  const stored = loadStored();
  form.elements.title.value = stored.title || DEFAULT_TITLE;
  form.elements.occurrence.value = stored.recordId === ctx.record.id ? stored.occurrence || "" : "";
  form.elements.analyst.value = stored.analyst || "";
  if (stored.recordId === ctx.record.id) {
    form.elements.comments.value = stored.comments || "";
    form.elements.conclusion.value = stored.conclusion || "";
  } else {
    form.elements.comments.value = "";
    form.elements.conclusion.value = "";
  }
  const c = ctx.fixedCursors;
  const hasCursors = c.c1 != null || c.c2 != null;
  form.elements.s_cursors.disabled = !hasCursors;
  form.elements.s_cursors.checked = hasCursors;
  hint.textContent = hasCursors
    ? "As medições C1/C2 usam os canais exibidos na oscilografia."
    : "Dica: fixe C1 e C2 (teclas 1 e 2) para incluir medições entre cursores.";

  const persist = () => saveStored({
    ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, form.elements[k].value])),
    comments: form.elements.comments.value,
    conclusion: form.elements.conclusion.value,
    recordId: ctx.record.id,
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const action = e.submitter?.value;
    persist();
    if (action === "cancel") {
      dialog.close();
      return;
    }
    errEl.textContent = "";
    const images = [];
    // figuras sempre no tema claro (impressão/Word)
    ctx.withLightTheme(() => {
      if (form.elements.fig_view.checked) {
        const data = ctx.captureView();
        if (data) images.push({ caption: "Oscilografia – canais exibidos", data });
      }
      if (form.elements.fig_dock.checked) {
        const img = captureDock();
        if (img) images.push(img);
      }
    });
    const fmt = action === "docx" ? "docx" : "html";
    const body = {
      format: fmt,
      title: form.elements.title.value,
      occurrence: form.elements.occurrence.value,
      analyst: form.elements.analyst.value,
      comments: form.elements.comments.value,
      conclusion: form.elements.conclusion.value,
      sections: {
        summary: form.elements.s_summary.checked,
        protection: form.elements.s_protection.checked,
        events: form.elements.s_events.checked,
        cursors: form.elements.s_cursors.checked,
        figures: images.length > 0,
      },
      voltage_group: ctx.voltageGroupId,
      current_group: ctx.currentGroupId,
      summary_params: summaryParams(),
      cursors: hasCursors ? { t1: c.c1, t2: c.c2, channels: ctx.selectedChannels().slice(0, 64) } : null,
      images,
      source_name: ctx.sourceName,
    };
    const buttons = form.querySelectorAll(".dlg-actions button");
    buttons.forEach((b) => (b.disabled = true));
    const url = `/api/records/${ctx.record.id}/report`;
    const fileName = `${baseName(ctx.sourceName)}_relatorio.${fmt}`;
    try {
      if (action === "print") {
        const blob = await postForBlob(url, body);
        printHtml(await blob.text());
        dialog.close();
        return;
      }
      if (IS_DESKTOP) {
        let path = null;
        let dialogOk = false;
        try {
          path = await pickSavePath(fileName, fmt === "docx" ? "Documento do Word" : "Página HTML", [fmt]);
          dialogOk = true;
        } catch (err) {
          console.warn("Diálogo Salvar indisponível, baixando:", err);
        }
        if (dialogOk && !path) return; // cancelado pelo usuário
        if (path) {
          const res = await fetchJson(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, save_path: path }),
          });
          dialog.close();
          alert(`Relatório salvo em:\n${res.saved}`);
          return;
        }
      }
      download(await postForBlob(url, body), fileName);
      dialog.close();
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  };
  dialog.showModal();
}
