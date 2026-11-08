/** Valor do canal no cursor, ao lado do nome da faixa (formato compacto pt-BR). */

export function formatDecimalBR(value, decimals = 4) {
  if (value == null || Number.isNaN(value)) return null;
  const abs = Math.abs(value);
  const d = abs >= 10000 ? 1 : abs >= 1000 ? 2 : abs >= 100 ? 3 : decimals;
  return value.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function instantValueHtml(index) {
  return `<span class="instant-value" data-instant="${index}">—</span>`;
}

export function setInstantValue(el, value, unit, kind) {
  if (value == null || Number.isNaN(value)) {
    el.textContent = "—";
    el.classList.remove("on");
    return;
  }
  if (kind === "digital") {
    const on = value >= 0.5;
    el.textContent = on ? "1" : "0";
    el.classList.toggle("on", on);
    return;
  }
  el.textContent = `${formatDecimalBR(value)}${unit ? ` ${unit}` : ""}`;
}

export function clearInstantValue(el) {
  setInstantValue(el, null, "", "analog");
}
