const INSTANT_DECIMALS = 4;
const INSTANT_INT_WIDTH = 8;

export function formatDecimalBR(value, decimals = INSTANT_DECIMALS, intWidth = INSTANT_INT_WIDTH) {
  if (value == null || Number.isNaN(value)) return null;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const [intPart, fracPart = ""] = abs.toFixed(decimals).split(".");
  const paddedInt = intPart.padStart(intWidth, "\u00a0");
  return `${sign}${paddedInt},${fracPart}`;
}

export function formatInstantParts(value, unit, kind, timeS) {
  if (value == null || Number.isNaN(value) || timeS == null || Number.isNaN(timeS)) {
    return { x: "—", y: "—" };
  }

  let xNum;
  if (kind === "digital") {
    const digit = value >= 0.5 ? "1" : "0";
    xNum = digit.padStart(INSTANT_INT_WIDTH, "\u00a0") + ",0000";
  } else {
    xNum = formatDecimalBR(value);
  }

  const x = kind === "digital" ? xNum : `${xNum} ${unit || ""}`.trimEnd();
  const y = `${formatDecimalBR(timeS)} s`;
  return { x, y };
}

export function instantValueHtml(index) {
  return `
    <div class="instant-value" data-instant="${index}">
      <div class="instant-row">
        <span class="instant-label">X:</span>
        <span class="instant-num instant-x">—</span>
      </div>
      <div class="instant-row">
        <span class="instant-label">Y:</span>
        <span class="instant-num instant-y">—</span>
      </div>
    </div>
  `;
}

export function setInstantValue(el, value, unit, kind, timeS) {
  const xEl = el.querySelector(".instant-x");
  const yEl = el.querySelector(".instant-y");
  if (!xEl || !yEl) return;

  const parts = formatInstantParts(value, unit, kind, timeS);
  xEl.textContent = parts.x;
  yEl.textContent = parts.y;
}

export function clearInstantValue(el) {
  setInstantValue(el, null, "", "analog", null);
}
