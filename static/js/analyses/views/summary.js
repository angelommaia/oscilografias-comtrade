/** Aba "Resumo": caracterização automática da perturbação. */
import { escapeHtml, fmtNum } from "../../core/bus.js";
import { formatTime } from "../../api.js";

export default {
  id: "summary",
  title: "Resumo",
  analysisId: "summary",
  refetchOn: ["record", "groups"],
  range: "none",

  create(root, ctx) {
    root.innerHTML = `<div class="sm-wrap"></div><p class="an-empty hidden"></p>`;
    const wrap = root.querySelector(".sm-wrap");
    const emptyEl = root.querySelector(".an-empty");

    root.addEventListener("click", (e) => {
      const el = e.target.closest("[data-goto]");
      if (el) ctx.setCursor(Number(el.dataset.goto));
      if (e.target.closest(".sm-report")) ctx.openReport();
    });

    const go = (t, trig) => {
      if (t == null) return "—";
      const rel = trig != null ? ` <span class="muted">(${fmtNum((t - trig) * 1e3, { decimals: 1 })} ms)</span>` : "";
      return `<button type="button" class="link-btn sm-t" data-goto="${t}" title="Levar o cursor até este instante">${formatTime(t)}</button>${rel}`;
    };
    const ms = (v) => (v == null ? "—" : `${fmtNum(v, { decimals: 1 })} ms`);
    const kv = (rows) => `<table class="phasor-table sm-kv"><tbody>${rows
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${v}</td></tr>`).join("")}</tbody></table>`;

    function render(res) {
      const trig = res.trigger_s;
      const f = res.fault;
      const parts = [];
      if (f) {
        let tipo = escapeHtml(f.type || "indeterminado");
        if (f.energization) {
          tipo = `Energização <span class="muted">(corrente pré-evento nula${f.second_harmonic_pct != null ? `; 2ª harmônica ${fmtNum(f.second_harmonic_pct, { decimals: 1 })}%` : ""})</span>`;
        }
        parts.push(`<h4 class="sm-h">Perturbação</h4>${kv([
          ["Início", go(f.start_t, trig)],
          ["Fim", f.end_t != null ? go(f.end_t, trig) : "após o fim do registro"],
          ["Duração", ms(f.duration_ms)],
          ["Tipo", `<b class="sm-type">${tipo}</b>`],
          ["Grupo de corrente", escapeHtml(res.current_group?.label || "—")],
        ])}`);
      }
      if (res.currents.length) {
        parts.push(`<h4 class="sm-h">Correntes</h4><table class="phasor-table"><thead><tr><th>Fase</th><th class="num">Pré (RMS)</th><th class="num">Máx RMS</th><th class="num">Pico</th><th class="num">Interrupção</th></tr></thead><tbody>
          ${res.currents.map((c) => `<tr><td title="${escapeHtml(c.channel)}">${c.phase}</td>
            <td class="num">${fmtNum(c.pre_rms, { unit: c.unit, si: true })}</td>
            <td class="num"><span data-goto="${c.max_rms_t}" class="sm-click">${fmtNum(c.max_rms, { unit: c.unit, si: true })}</span></td>
            <td class="num"><span data-goto="${c.peak_t}" class="sm-click">${fmtNum(c.peak, { unit: c.unit, si: true })}</span></td>
            <td class="num">${c.interruption_t != null ? go(c.interruption_t, null) : "—"}</td></tr>`).join("")}
        </tbody></table>`);
      }
      if (res.voltages.length) {
        parts.push(`<h4 class="sm-h">Tensões <span class="muted">${escapeHtml(res.voltage_group?.label || "")}</span></h4><table class="phasor-table"><thead><tr><th>Fase</th><th class="num">Pré (RMS)</th><th class="num">Mín RMS</th><th class="num">Afundamento</th></tr></thead><tbody>
          ${res.voltages.map((v) => `<tr><td title="${escapeHtml(v.channel)}">${v.phase}</td>
            <td class="num">${fmtNum(v.pre_rms, { unit: v.unit, si: true })}</td>
            <td class="num"><span data-goto="${v.min_rms_t}" class="sm-click">${fmtNum(v.min_rms, { unit: v.unit, si: true })}</span></td>
            <td class="num">${v.sag_pct != null ? `${fmtNum(v.sag_pct, { decimals: 1 })}%` : "—"}</td></tr>`).join("")}
        </tbody></table>`);
      }
      const p = res.protection || {};
      const ev = (k, label) => (p[k] ? [label, `${go(p[k].t, trig)}<br><span class="muted">${escapeHtml(p[k].channel)}</span>`] : [label, null]);
      const poles = p.interruption_after_trip_ms
        ? Object.entries(p.interruption_after_trip_ms).map(([ph, v]) => `${ph}: ${ms(v)}`).join(" · ")
        : null;
      const protRows = [
        ev("pickup", "Primeira partida"),
        ev("trip", "Primeiro trip"),
        ["Início → partida", p.pickup_delay_ms != null ? ms(p.pickup_delay_ms) : null],
        ["Tempo de atuação", p.trip_time_ms != null ? `<b>${ms(p.trip_time_ms)}</b>` : null],
        ev("breaker_open", "Disjuntor aberto"),
        ["Trip → disjuntor aberto", p.breaker_time_ms != null ? ms(p.breaker_time_ms) : null],
        ["Trip → interrupção (corrente)", poles],
        ev("reclose_cmd", "Comando de religamento"),
        ev("breaker_close", "Disjuntor fechado"),
        ["Retorno da corrente", p.reclose_current_t != null ? go(p.reclose_current_t, trig) : null],
        ["Tempo morto", p.dead_time_ms != null ? ms(p.dead_time_ms) : null],
      ];
      parts.push(`<h4 class="sm-h">Proteção</h4>${protRows.some(([, v]) => v) ? kv(protRows) : '<p class="muted">Nenhum evento de proteção identificado nos canais digitais.</p>'}`);
      if (res.notes.length) {
        parts.push(`<ul class="sm-notes">${res.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`);
      }
      parts.push(`<div class="sm-actions"><button type="button" class="btn btn-primary btn-sm sm-report">Gerar relatório…</button>
        <span class="muted">Estimativa automática: confira na oscilografia.</span></div>`);
      wrap.innerHTML = parts.join("");
    }

    return {
      render(res) {
        emptyEl.classList.add("hidden");
        render(res);
      },
      clear(message) {
        wrap.innerHTML = "";
        emptyEl.textContent = message;
        emptyEl.classList.remove("hidden");
      },
    };
  },
};
