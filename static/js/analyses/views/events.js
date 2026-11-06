/** Aba "Eventos": sequência de eventos (mudanças dos canais digitais). */
import { escapeHtml, fmtNum } from "../../core/bus.js";
import { formatTime } from "../../api.js";

const HIDE_KEY = "oscilo.analysis.events.hidden";
const CAT_CLASS = {
  trip: "ev-trip",
  pickup: "ev-pickup",
  breaker: "ev-breaker",
  block: "ev-block",
  reclose: "ev-reclose",
  teleprot: "ev-teleprot",
  other: "ev-other",
};

export default {
  id: "events",
  title: "Eventos",
  analysisId: "events",
  refetchOn: ["record", "selection"],
  range: "selection-or-view",

  create(root, ctx) {
    let hidden;
    try {
      hidden = new Set(JSON.parse(localStorage.getItem(HIDE_KEY) || "[]"));
    } catch {
      hidden = new Set();
    }
    root.innerHTML = `
      <div class="imp-controls"><div class="imp-loops ev-filters"></div>
        <input type="search" class="channel-search ev-search" placeholder="Filtrar canal…" /></div>
      <div class="hm-wrap ev-wrap"></div>
      <p class="an-empty hidden"></p>
    `;
    const filters = root.querySelector(".ev-filters");
    const search = root.querySelector(".ev-search");
    const wrap = root.querySelector(".ev-wrap");
    const emptyEl = root.querySelector(".an-empty");
    let last = null;

    filters.addEventListener("change", (e) => {
      const cat = e.target.dataset.cat;
      if (!cat) return;
      if (e.target.checked) hidden.delete(cat);
      else hidden.add(cat);
      try {
        localStorage.setItem(HIDE_KEY, JSON.stringify([...hidden]));
      } catch {
        /* ignora */
      }
      draw();
    });
    search.addEventListener("input", () => draw());
    wrap.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-t]");
      if (!tr) return;
      ctx.setCursor(Number(tr.dataset.t));
      if (e.target.closest(".ev-add")) ctx.addChannel(Number(tr.dataset.index));
    });

    function draw() {
      const res = last;
      if (!res) return;
      const counts = {};
      res.events.forEach((ev) => {
        counts[ev.category] = (counts[ev.category] || 0) + 1;
      });
      filters.innerHTML = Object.entries(res.categories)
        .filter(([cat]) => counts[cat])
        .map(([cat, label]) => `<label class="imp-chip ${CAT_CLASS[cat]}"><input type="checkbox" data-cat="${cat}" ${hidden.has(cat) ? "" : "checked"}/> ${escapeHtml(label)} (${counts[cat]})</label>`)
        .join("");
      const q = search.value.trim().toLowerCase();
      const rows = res.events.filter((ev) => !hidden.has(ev.category) && (!q || ev.name.toLowerCase().includes(q)));
      const hasTrig = res.trigger_s != null;
      if (!res.events.length) {
        wrap.innerHTML = `<p class="an-empty">Nenhum canal digital mudou de estado ${res.scope === "range" ? "no intervalo" : "no registro"}.</p>`;
        return;
      }
      wrap.innerHTML = `
        <table class="phasor-table ev-table">
          <thead><tr><th class="num">${hasTrig ? "t − trigger" : "t"}</th><th>Canal</th><th>Mudança</th><th></th></tr></thead>
          <tbody>${rows.map((ev) => `
            <tr data-t="${ev.time_s}" data-index="${ev.index}" class="${CAT_CLASS[ev.category]}" title="${escapeHtml(ev.absolute || formatTime(ev.time_s))} – clique para levar o cursor">
              <td class="num">${hasTrig ? `${fmtNum(ev.rel_trigger_ms, { decimals: 1 })} ms` : formatTime(ev.time_s)}</td>
              <td><span class="ev-dot"></span>${escapeHtml(ev.name)}</td>
              <td>${escapeHtml(ev.action)} <span class="muted">${ev.from}→${ev.to}</span></td>
              <td><button type="button" class="link-btn ev-add" title="Mostrar o canal na oscilografia">+</button></td>
            </tr>`).join("")}</tbody>
        </table>
        <p class="muted hm-note">${rows.length} de ${res.events.length} eventos · ${res.channels.filter((c) => c.changes).length} canais com mudança.
        Categoria pelo nome do canal (TRIP/OPER → trip, PART → partida, DJ/52 → disjuntor…).</p>`;
    }

    return {
      render(res) {
        emptyEl.classList.add("hidden");
        last = res;
        draw();
      },
      clear(message) {
        last = null;
        filters.innerHTML = "";
        wrap.innerHTML = "";
        emptyEl.textContent = message;
        emptyEl.classList.remove("hidden");
      },
    };
  },
};
