import { fetchJson } from "../api.js";

export function fetchAnalysesCatalog() {
  return fetchJson("/api/analyses");
}

export function runAnalysis(recordId, analysisId, body) {
  return fetchJson(`/api/records/${recordId}/analyses/${encodeURIComponent(analysisId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function addGroup(recordId, group) {
  return fetchJson(`/api/records/${recordId}/groups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(group),
  });
}

export function removeGroup(recordId, groupId) {
  return fetchJson(`/api/records/${recordId}/groups/${encodeURIComponent(groupId)}`, {
    method: "DELETE",
  });
}
