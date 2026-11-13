/** Modelo de faixas do gráfico (sem DOM, testável com `node --test`).
 *
 * Um layout por registro: lista ordenada de faixas, cada uma com
 * `{id, channels: [id…], height: px|null, yZoom: {eixo: [lo, hi]}}`.
 * Ids de canal são strings: "12" (analógico/digital do registro) ou
 * "derived:<chave>" (grandezas calculadas). Tudo é JSON puro (serializável
 * para um futuro "salvar sessão").
 *
 * Regras de sobreposição:
 * - só canais analógicos se sobrepõem (digitais e grandezas calculadas ficam
 *   em faixa própria);
 * - mesma unidade (kV e V contam como V) compartilha o eixo; uma segunda
 *   unidade vai para o eixo da direita; uma terceira é recusada. */

import { baseUnit } from "./instant-value.js";

export const MAX_UNITS = 2;

export function createLayout() {
  return { tracks: [], seq: 0 };
}

function newTrack(layout, channels) {
  layout.seq += 1;
  return { id: `t${layout.seq}`, channels: [...channels], height: null, yZoom: {} };
}

/** Eixo de um canal: unidade-base ("kV" → "V"); sem unidade → "". */
export function axisKey(meta) {
  return baseUnit(meta?.unit || "").unit;
}

export function trackIndexOf(layout, trackId) {
  return layout.tracks.findIndex((t) => t.id === trackId);
}

export function trackOfChannel(layout, chId) {
  return layout.tracks.find((t) => t.channels.includes(String(chId))) || null;
}

function removeChannel(layout, chId) {
  const id = String(chId);
  for (const t of layout.tracks) {
    const i = t.channels.indexOf(id);
    if (i >= 0) t.channels.splice(i, 1);
  }
  layout.tracks = layout.tracks.filter((t) => t.channels.length);
}

/** Acerta o layout com os canais exibidos (ordem de `shown` para os novos,
 * que entram no fim); some quem não está mais exibido. */
export function syncLayout(layout, shown) {
  const want = new Set(shown.map(String));
  for (const t of layout.tracks) t.channels = t.channels.filter((c) => want.has(c));
  layout.tracks = layout.tracks.filter((t) => t.channels.length);
  const have = new Set(layout.tracks.flatMap((t) => t.channels));
  for (const id of shown.map(String)) {
    if (!have.has(id)) {
      layout.tracks.push(newTrack(layout, [id]));
      have.add(id);
    }
  }
  return layout;
}

/** Eixos da faixa na ordem em que aparecem: [{key, channels: [id…]}]. */
export function axesOf(track, metaOf) {
  const axes = [];
  for (const id of track.channels) {
    const key = axisKey(metaOf(id));
    let ax = axes.find((a) => a.key === key);
    if (!ax) {
      ax = { key, channels: [] };
      axes.push(ax);
    }
    ax.channels.push(id);
  }
  return axes;
}

/** Pode sobrepor `chIds` na faixa `trackId`? → {ok, reason}. */
export function canOverlay(layout, trackId, chIds, metaOf) {
  const target = layout.tracks.find((t) => t.id === trackId);
  if (!target) return { ok: false, reason: "Faixa não encontrada." };
  const ids = chIds.map(String).filter((id) => !target.channels.includes(id));
  if (!ids.length) return { ok: false, reason: "O canal já está nesta faixa." };
  const kinds = [...target.channels, ...ids].map((id) => metaOf(id)?.kind);
  if (kinds.some((k) => k === "digital")) return { ok: false, reason: "Canais digitais não se sobrepõem: ficam em faixa própria." };
  if (kinds.some((k) => k !== "analog")) return { ok: false, reason: "Grandezas calculadas ficam em faixa própria." };
  const units = new Set([...target.channels, ...ids].map((id) => axisKey(metaOf(id))));
  if (units.size > MAX_UNITS) {
    const list = [...units].map((u) => u || "sem unidade").join(", ");
    return { ok: false, reason: `No máximo ${MAX_UNITS} unidades por faixa (ficaria com ${list}).` };
  }
  return { ok: true, reason: "" };
}

/** Sobrepõe canais na faixa alvo (tirando-os de onde estavam). */
export function overlayChannels(layout, trackId, chIds, metaOf) {
  const check = canOverlay(layout, trackId, chIds, metaOf);
  if (!check.ok) return check;
  const target = layout.tracks.find((t) => t.id === trackId);
  const ids = chIds.map(String).filter((id) => !target.channels.includes(id));
  ids.forEach((id) => removeChannel(layout, id)); // a faixa alvo não contém os ids: não some
  target.channels.push(...ids);
  return check;
}

/** Sobrepõe a faixa inteira `srcId` na faixa `targetId`. */
export function overlayTrack(layout, srcId, targetId, metaOf) {
  if (srcId === targetId) return { ok: false, reason: "Mesma faixa." };
  const src = layout.tracks.find((t) => t.id === srcId);
  if (!src) return { ok: false, reason: "Faixa não encontrada." };
  return overlayChannels(layout, targetId, [...src.channels], metaOf);
}

/** Move a faixa para a posição `pos` (índice de inserção na lista ATUAL,
 * 0 … n; "antes da faixa pos"). */
export function moveTrack(layout, trackId, pos) {
  const from = trackIndexOf(layout, trackId);
  if (from < 0) return false;
  const [t] = layout.tracks.splice(from, 1);
  const to = pos > from ? pos - 1 : pos;
  layout.tracks.splice(Math.max(0, Math.min(to, layout.tracks.length)), 0, t);
  return from !== to;
}

/** Põe canais numa faixa nova na posição `pos` (índice de inserção na lista
 * atual), tirando-os de onde estavam. Devolve a faixa nova. */
export function insertChannels(layout, chIds, pos) {
  const ids = chIds.map(String);
  const anchor = layout.tracks[pos] || null; // faixa que fica logo abaixo
  ids.forEach((id) => removeChannel(layout, id));
  let at = anchor ? layout.tracks.indexOf(anchor) : layout.tracks.length;
  if (at < 0) at = Math.min(pos, layout.tracks.length);
  const t = newTrack(layout, ids);
  layout.tracks.splice(at, 0, t);
  return t;
}

/** Vários canais, cada um na sua faixa, a partir da posição `pos` (na ordem
 * dada), tirando-os de onde estavam. */
export function insertChannelsEach(layout, chIds, pos) {
  const ids = chIds.map(String);
  // âncora: a primeira faixa a partir de `pos` que continua existindo depois
  // de tirar os canais movidos
  const moving = new Set(ids);
  const anchor = layout.tracks.slice(pos).find((t) => t.channels.some((c) => !moving.has(c))) || null;
  ids.forEach((id) => removeChannel(layout, id));
  const at = anchor ? layout.tracks.indexOf(anchor) : layout.tracks.length;
  const fresh = ids.map((id) => newTrack(layout, [id]));
  layout.tracks.splice(at, 0, ...fresh);
  return fresh;
}

/** Retira um canal de uma faixa sobreposta: volta a ter faixa própria logo
 * abaixo (ou é removido com `close`). */
export function detachChannel(layout, trackId, chId, { close = false } = {}) {
  const t = layout.tracks.find((x) => x.id === trackId);
  const id = String(chId);
  if (!t || !t.channels.includes(id)) return null;
  const at = layout.tracks.indexOf(t);
  t.channels = t.channels.filter((c) => c !== id);
  if (!t.channels.length) layout.tracks.splice(at, 1);
  if (close) return null;
  const nt = newTrack(layout, [id]);
  layout.tracks.splice(t.channels.length ? at + 1 : at, 0, nt);
  return nt;
}

/** Separa todos os canais de uma faixa sobreposta, um por faixa, na mesma posição. */
export function splitTrack(layout, trackId) {
  const at = trackIndexOf(layout, trackId);
  if (at < 0) return;
  const t = layout.tracks[at];
  if (t.channels.length < 2) return;
  const parts = t.channels.map((id) => newTrack(layout, [id]));
  layout.tracks.splice(at, 1, ...parts);
}

/** Onde soltar: dado o ponteiro sobre a faixa `i` (fração vertical `rel`,
 * 0 = topo), devolve {action: "insert", pos} ou {action: "overlay", index}.
 * O meio (25 %–75 %) sobrepõe quando a faixa aceita; o resto insere. */
export function dropTarget(i, rel, overlayAllowed) {
  if (overlayAllowed && rel > 0.25 && rel < 0.75) return { action: "overlay", index: i };
  return { action: "insert", pos: rel < 0.5 ? i : i + 1 };
}
