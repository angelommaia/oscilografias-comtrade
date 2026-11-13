// Modelo de faixas: rode com `node --test static/js/tests` (Node 22+, sem pacotes).
import test from "node:test";
import assert from "node:assert/strict";

import {
  axesOf, canOverlay, createLayout, detachChannel, dropTarget, insertChannels, insertChannelsEach, moveTrack,
  overlayChannels, overlayTrack, splitTrack, syncLayout, trackOfChannel,
} from "../tracks-layout.js";

const META = {
  1: { kind: "analog", unit: "A" }, 2: { kind: "analog", unit: "A" }, 3: { kind: "analog", unit: "A" },
  4: { kind: "analog", unit: "kV" }, 5: { kind: "analog", unit: "V" }, 6: { kind: "analog", unit: "Hz" },
  7: { kind: "digital", unit: "" }, "derived:p": { kind: "derived", unit: "MW" },
};
const metaOf = (id) => META[id];
const order = (L) => L.tracks.map((t) => t.channels.join("+"));

function abc() {
  return syncLayout(createLayout(), ["1", "2", "3"]);
}

test("sync acrescenta no fim, mantém a ordem existente e remove fechados", () => {
  const L = abc();
  moveTrack(L, L.tracks[2].id, 0);
  assert.deepEqual(order(L), ["3", "1", "2"]);
  syncLayout(L, ["1", "2", "3", "4"]);
  assert.deepEqual(order(L), ["3", "1", "2", "4"]);
  syncLayout(L, ["1", "3", "4"]);
  assert.deepEqual(order(L), ["3", "1", "4"]);
  assert.equal(JSON.parse(JSON.stringify(L)).tracks.length, 3); // serializável
});

test("reordenar: Ic para cima", () => {
  const L = abc();
  const ic = trackOfChannel(L, 3).id;
  moveTrack(L, ic, 0);
  assert.deepEqual(order(L), ["3", "1", "2"]);
  const L2 = abc();
  moveTrack(L2, trackOfChannel(L2, 3).id, 1);
  assert.deepEqual(order(L2), ["1", "3", "2"]);
  moveTrack(L2, trackOfChannel(L2, 1).id, 3); // para o fim
  assert.deepEqual(order(L2), ["3", "2", "1"]);
});

test("sobrepor faixa e canal; mesma unidade compartilha eixo", () => {
  const L = abc();
  assert.ok(overlayTrack(L, trackOfChannel(L, 2).id, trackOfChannel(L, 1).id, metaOf).ok);
  assert.deepEqual(order(L), ["1+2", "3"]);
  assert.ok(overlayChannels(L, trackOfChannel(L, 1).id, ["3"], metaOf).ok);
  assert.deepEqual(order(L), ["1+2+3"]);
  assert.deepEqual(axesOf(L.tracks[0], metaOf).map((a) => a.key), ["A"]);
});

test("segunda unidade vai para outro eixo; kV e V são o mesmo eixo; terceira é recusada", () => {
  const L = syncLayout(createLayout(), ["1", "4", "5", "6"]);
  const t1 = trackOfChannel(L, 1).id;
  assert.ok(overlayChannels(L, t1, ["4"], metaOf).ok);
  assert.ok(overlayChannels(L, t1, ["5"], metaOf).ok);
  assert.deepEqual(axesOf(trackOfChannel(L, 1), metaOf).map((a) => [a.key, a.channels]), [["A", ["1"]], ["V", ["4", "5"]]]);
  const r = canOverlay(L, t1, ["6"], metaOf);
  assert.equal(r.ok, false);
  assert.match(r.reason, /No máximo 2 unidades/);
  assert.equal(overlayChannels(L, t1, ["6"], metaOf).ok, false);
  assert.deepEqual(order(L), ["1+4+5", "6"]);
});

test("digitais e calculadas não se sobrepõem", () => {
  const L = syncLayout(createLayout(), ["1", "7", "derived:p"]);
  assert.match(canOverlay(L, trackOfChannel(L, 1).id, ["7"], metaOf).reason, /digitais/);
  assert.match(canOverlay(L, trackOfChannel(L, 7).id, ["1"], metaOf).reason, /digitais/);
  assert.match(canOverlay(L, trackOfChannel(L, 1).id, ["derived:p"], metaOf).reason, /calculadas/);
});

test("inserir canal da lista entre faixas (novo ou já aberto)", () => {
  const L = abc();
  insertChannels(L, ["4"], 1);
  assert.deepEqual(order(L), ["1", "4", "2", "3"]);
  insertChannels(L, ["3"], 0); // já aberto: muda de lugar
  assert.deepEqual(order(L), ["3", "1", "4", "2"]);
  overlayChannels(L, trackOfChannel(L, 1).id, ["2"], metaOf);
  insertChannels(L, ["2"], 4); // tira da sobreposta e põe no fim
  assert.deepEqual(order(L), ["3", "1", "4", "2"]);
});

test("retirar canal da faixa sobreposta e separar", () => {
  const L = abc();
  const t = trackOfChannel(L, 1).id;
  overlayChannels(L, t, ["2", "3"], metaOf);
  detachChannel(L, t, "2");
  assert.deepEqual(order(L), ["1+3", "2"]);
  detachChannel(L, t, "3", { close: true });
  assert.deepEqual(order(L), ["1", "2"]);
  overlayChannels(L, trackOfChannel(L, 1).id, ["2"], metaOf);
  splitTrack(L, trackOfChannel(L, 1).id);
  assert.deepEqual(order(L), ["1", "2"]);
});

test("alvo de soltura: meio sobrepõe, bordas inserem", () => {
  assert.deepEqual(dropTarget(2, 0.5, true), { action: "overlay", index: 2 });
  assert.deepEqual(dropTarget(2, 0.1, true), { action: "insert", pos: 2 });
  assert.deepEqual(dropTarget(2, 0.9, true), { action: "insert", pos: 3 });
  assert.deepEqual(dropTarget(2, 0.4, false), { action: "insert", pos: 2 });
});

test("vários canais da lista entre faixas: uma faixa para cada, na ordem", () => {
  const L = abc();
  insertChannelsEach(L, ["4", "5"], 1);
  assert.deepEqual(order(L), ["1", "4", "5", "2", "3"]);
  insertChannelsEach(L, ["3", "1"], 0); // já abertos: mudam de lugar
  assert.deepEqual(order(L), ["3", "1", "4", "5", "2"]);
  insertChannelsEach(L, ["4"], 3); // âncora = faixa "5" (a "4" sai)
  assert.deepEqual(order(L), ["3", "1", "4", "5", "2"]);
  overlayChannels(L, trackOfChannel(L, 1).id, ["2"], metaOf);
  insertChannelsEach(L, ["1", "2"], 5);
  assert.deepEqual(order(L), ["3", "4", "5", "1", "2"]);
});
