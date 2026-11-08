// Janela "Sobre o Oscilo": versão (lida do backend, fonte única em
// src-tauri/tauri.conf.json), autoria, links e licença.
// Links externos: no desktop abrem no navegador padrão (plugin opener, só https);
// na web, em nova aba.

import { IS_DESKTOP, fetchJson } from "./api.js";

let info = null;

async function loadInfo() {
  if (!info) {
    try {
      info = await fetchJson("/api/health");
    } catch {
      info = { version: "?", desktop: IS_DESKTOP };
    }
  }
  return info;
}

/** Abre um link https fora da janela do Oscilo. */
export async function openExternal(url) {
  if (!/^https:\/\//i.test(url)) return;
  if (IS_DESKTOP) {
    const invoke = window.__TAURI__?.core?.invoke || window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) return;
    try {
      await invoke("plugin:opener|open_url", { url });
    } catch (err) {
      alert(`Não foi possível abrir o navegador:\n${err}`);
    }
    return;
  }
  window.open(url, "_blank", "noopener");
}

export async function openAboutDialog() {
  const dialog = document.getElementById("about-dialog");
  const data = await loadInfo();
  dialog.querySelector(".ab-version").textContent = `Versão ${data.version}`;
  dialog.querySelector(".ab-edition").textContent = data.desktop ? "Versão desktop" : "Versão web (navegador)";
  if (!dialog.open) dialog.showModal();
}

export async function initAbout() {
  const dialog = document.getElementById("about-dialog");
  const statusVersion = document.getElementById("status-version");
  // links: nova aba na web; no desktop o clique é interceptado
  dialog.querySelectorAll("a.ab-link").forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener";
    a.addEventListener("click", (e) => {
      if (!IS_DESKTOP) return;
      e.preventDefault();
      openExternal(a.href);
    });
  });
  document.getElementById("open-about").addEventListener("click", openAboutDialog);
  statusVersion.addEventListener("click", openAboutDialog);
  const data = await loadInfo();
  statusVersion.textContent = `v${data.version}`;
  statusVersion.title = `Oscilo ${data.version} – sobre o programa`;
}
