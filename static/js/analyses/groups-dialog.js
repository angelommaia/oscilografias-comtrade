/** Diálogo para montar manualmente um grupo trifásico (Va/Vb/Vc ou Ia/Ib/Ic). */
import { escapeHtml } from "../core/bus.js";
import { addGroup } from "./api.js";

export function openGroupDialog(dialog, record, onSaved) {
  const unitsV = new Set(["v", "kv", "mv"]);
  const unitsI = new Set(["a", "ka", "ma"]);
  const form = dialog.querySelector("form");
  const qtySel = form.querySelector('[name="quantity"]');
  const errEl = form.querySelector(".dlg-error");
  errEl.textContent = "";

  const fill = () => {
    const q = qtySel.value;
    const set = q === "V" ? unitsV : unitsI;
    const preferred = record.analog_channels.filter((c) => set.has((c.unit || "").toLowerCase()));
    const others = record.analog_channels.filter((c) => !set.has((c.unit || "").toLowerCase()));
    const opts = (list) => list.map((c) => `<option value="${c.index}">${escapeHtml(c.name)}${c.unit ? ` (${escapeHtml(c.unit)})` : ""}</option>`).join("");
    const html = `<optgroup label="Unidade ${q === "V" ? "V/kV" : "A/kA"}">${opts(preferred)}</optgroup>${others.length ? `<optgroup label="Outros">${opts(others)}</optgroup>` : ""}`;
    ["a", "b", "c"].forEach((ph, i) => {
      const sel = form.querySelector(`[name="${ph}"]`);
      sel.innerHTML = html;
      if (preferred[i]) sel.value = String(preferred[i].index);
    });
  };
  qtySel.onchange = fill;
  fill();

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (e.submitter?.value === "cancel") {
      dialog.close();
      return;
    }
    const data = new FormData(form);
    try {
      const res = await addGroup(record.id, {
        quantity: data.get("quantity"),
        label: String(data.get("label") || ""),
        a: Number(data.get("a")),
        b: Number(data.get("b")),
        c: Number(data.get("c")),
      });
      dialog.close();
      onSaved(res);
    } catch (err) {
      errEl.textContent = err.message;
    }
  };
  dialog.showModal();
}
