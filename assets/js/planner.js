// Loads the curated data and resolves an ordered upgrade runbook.

export async function loadData() {
  const files = ["versions", "components", "sequence", "paths", "steps", "docs", "k8s-hops"];
  const [versions, components, sequence, paths, steps, docs, k8sHops] = await Promise.all(
    files.map((f) => fetch(`data/${f}.json`, { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error(`Failed to load data/${f}.json (${r.status})`);
      return r.json();
    }))
  );
  return { versions, components, sequence, paths, steps, docs, k8sHops };
}

// The TCA release that corresponds to a TCP target (drives which k8s-hops.json table applies).
export function tcaTargetFor(data, tcpTarget) {
  return data.versions.components.tca?.[tcpTarget];
}

// Every TCA source version the target's guide documents an upgrade path from — independent of
// the single TCP-source-implied value, for overriding when the live TCA patch has drifted.
export function tcaSourcesFor(data, tcpTarget) {
  return data.versions.tcaSourcesByTarget?.[tcpTarget] || [];
}

// The guide-confirmed starting Kubernetes versions ({mgmt, workload}) for a given TCA source, if
// the guide documents a single fixed value (only true for some sources, e.g. TCA 2.3) — null
// when the guide instead describes a range (e.g. TCA 3.1/3.2/3.3), so callers should leave the
// Kubernetes-version picker to manual selection rather than guess.
export function k8sDefaultsForTca(data, tcpTarget, tcaVersion) {
  const tca = tcaTargetFor(data, tcpTarget);
  return data.k8sHops?.[tca]?.tcaK8sDefaults?.[tcaVersion] || null;
}

// Known current-Kubernetes-version options for a phase ("mgmt" or "workload") at a TCP target.
export function k8sVersionsFor(data, tcpTarget, phase) {
  const tca = tcaTargetFor(data, tcpTarget);
  return Object.keys(data.k8sHops?.[tca]?.[phase]?.chains || {});
}

// Workload-cluster current-version options that are actually compatible with a chosen
// management-cluster current version, per TCA's "Workload Cluster Compatibility" tables.
// Returns null when no compatibility data is published for that management version — callers
// should fall back to the full k8sVersionsFor(..., "workload") list in that case, not an
// empty/blocked picker, since the guide simply doesn't cover it (not "nothing is compatible").
export function compatibleWorkloadVersions(data, tcpTarget, mgmtVersion) {
  const tca = tcaTargetFor(data, tcpTarget);
  const compat = data.k8sHops?.[tca]?.mgmtWorkloadCompat;
  if (!compat || !mgmtVersion || !compat[mgmtVersion]) return null;
  return compat[mgmtVersion];
}

// The precise TKG release for a chosen *management-cluster* Kubernetes version, per TCA's
// "Management Cluster (vX) (TKG Y)" table headers. Only management versions have a published
// per-version TKG label (workload versions don't) — returns null when unpublished (e.g. the
// transitional 1.28.4/1.28.7 management versions) so callers can fall back honestly.
export function tkgReleaseFor(data, tcpTarget, mgmtVersion) {
  const tca = tcaTargetFor(data, tcpTarget);
  return data.k8sHops?.[tca]?.mgmt?.tkgRelease?.[mgmtVersion] || null;
}

// Full hop chain (array of waypoint versions, inclusive of start/end) plus any notes for a
// chosen current Kubernetes version. Returns null if unknown (e.g. no selection yet).
export function k8sChainFor(data, tcpTarget, phase, version) {
  const tca = tcaTargetFor(data, tcpTarget);
  const table = data.k8sHops?.[tca]?.[phase];
  if (!table || !version || !table.chains[version]) return null;
  return {
    waypoints: table.chains[version],
    finalTarget: table.finalTarget,
    note: table.notes?.[version] || table.interleave?.[version] || null,
    prerequisite: table.prerequisite || null,
  };
}

// Version-aware deep link to the official upgrade-guide page for a component/section.
export function docUrl(data, target, id) {
  const docs = data.docs;
  if (!docs) return null;
  const ver = docs.versionSlug?.[target] || (target || "").replace(/\./g, "-");
  const guide = `${docs.base}/${ver}/${docs.guidePath}`;
  const guideHome = `${docs.base}/${ver}/${docs.guidePath}.html`; // home sits beside the guide dir
  if (id === "home") return guideHome;
  if (docs.componentPages?.[id]) return `${guide}/${docs.upgradingPath}/${docs.componentPages[id]}`;
  if (docs.guidePages?.[id]) return `${guide}/${docs.guidePages[id]}`;
  return guideHome;
}

// Some phases are split from a single matrix row (e.g. TKG mgmt/workload share the "tkg" row).
const VERSION_ALIAS = { "tkg-mgmt": "tkg", "tkg-workload": "tkg" };

// The component's version at a given source release (via matrix, honoring split-phase aliases).
function sourceVersion(data, id, source) {
  const map = data.versions.components[id] || data.versions.components[VERSION_ALIAS[id]];
  return map?.[source];
}

// Target version string for a component at a given destination.
// Prefer the verbatim procedure-target map; fall back to the historical matrix column.
function componentTarget(data, id, target) {
  const t = data.versions.targets?.[target]?.[id];
  if (t) return t;
  const map = data.versions.components[id];
  if (map && map[target] && map[target] !== "NA") return map[target];
  return target;
}

function inject(text, version) {
  if (text == null) return text;
  if (Array.isArray(text)) return text.map((t) => inject(t, version));
  return String(text).replaceAll("{target}", version);
}

// Deep-inject {target} into a raw card (single-source content model).
function resolveCard(raw, version) {
  const out = {
    summary: inject(raw.summary, version),
    prerequisites: inject(raw.prerequisites, version),
    impact: inject(raw.impact, version),
    rollback: inject(raw.rollback, version),
    considerations: inject(raw.considerations, version),
    checklist: inject(raw.checklist, version),
  };
  if (raw.snippets) {
    out.snippets = raw.snippets.map((s) => ({
      label: inject(s.label, version),
      note: inject(s.note, version),
      commands: inject(s.commands, version),
    }));
  }
  return out;
}

// Moves Tanzu Kubernetes Workload Cluster to sit immediately after Tanzu Kubernetes Management
// Cluster in a *display* list — AKO sits between them in the guide's real execution order (a real
// dependency: management cluster upgrades, then AKO, then workload cluster), so this must only
// ever affect how selection/summary views group the pair visually, never the actual phase sequence
// buildPlan() produces (which iterates sequence.json directly, independent of this function).
export function groupTanzuForDisplay(items) {
  const mgmtIdx = items.findIndex((i) => i.id === "tkg-mgmt");
  const wlIdx = items.findIndex((i) => i.id === "tkg-workload");
  if (mgmtIdx === -1 || wlIdx === -1 || wlIdx === mgmtIdx + 1) return items;
  const out = items.slice();
  const [workload] = out.splice(wlIdx, 1);
  out.splice(out.findIndex((i) => i.id === "tkg-mgmt") + 1, 0, workload);
  return out;
}

// Components available for an edition at a given source version:
// must apply to the edition AND not be "NA" in that source release.
export function availableComponents(data, edition, source) {
  const seq = data.sequence[edition];
  if (!seq) return [];
  return groupTanzuForDisplay(seq.order
    .filter((o) => {
      const id = o.id;
      const meta = data.components[id] || {};
      if (!meta.appliesTo || !meta.appliesTo.includes(edition)) return false;
      const map = data.versions.components[id];
      // No version row at all (e.g. tkg-mgmt/workload, aria-products) → always available.
      if (!map) return true;
      const v = map[source];
      // Source not present as a matrix column (e.g. TCI-CDE editions) → can't determine NA,
      // so include the component rather than dropping it.
      if (v === undefined) return true;
      return v !== "NA";
    })
    .map((o) => ({
      id: o.id,
      name: data.components[o.id]?.name || o.id,
      gate: data.components[o.id]?.gate,
      mandatory: !!data.components[o.id]?.mandatory,
      fullStack: !!o.fullStack,
      sourceVersion: sourceVersion(data, o.id, source),
    })));
}

// Build the ordered list of cards for the chosen edition/source/target.
// `selected` is a Set of component ids to include (omit => include all available).
export function buildPlan(data, edition, source, target, selected) {
  const cards = [];
  const tgtVer = target;

  const pushComponent = (id, extra = {}) => {
    const meta = data.components[id] || {};
    const raw = data.steps[id];
    if (!raw) return;
    const version = componentTarget(data, id, target);
    const card = {
      id,
      name: meta.name || raw.title || id,
      formerly: meta.formerly,
      kind: raw.kind,
      doc: docUrl(data, target, id) || raw.doc || meta.doc,
      title: inject(raw.title, version),
      sourceVersion: sourceVersion(data, id, source),
      targetVersion: version,
      ...resolveCard(raw, version),
      ...extra,
    };
    cards.push(card);
  };

  // Always-first cross-cutting cards.
  pushComponent("prerequisites");
  pushComponent("snapshot-backup");

  // Ordered component sequence for the edition, limited to the selected set.
  const seq = data.sequence[edition];
  for (const item of seq.order) {
    if (selected && !selected.has(item.id)) continue;
    pushComponent(item.id, item.conditional ? { conditional: item.conditional } : {});
  }

  // Always-last card.
  pushComponent("post-upgrade");

  return {
    edition,
    editionLabel: seq.label,
    editionSummary: seq.summary,
    source,
    target: tgtVer,
    cards,
  };
}

// All destination versions this dataset documents.
export function targets(data) {
  return data.paths.targets || [];
}

// Allowed source versions for an edition + destination.
export function sourcesFor(data, edition, target) {
  return data.paths.byTarget?.[target]?.[edition]?.sources || [];
}

// Mandatory intermediate platform hops for a given source + destination, if any.
export function intermediatesFor(data, edition, source, target) {
  return data.paths.byTarget?.[target]?.[edition]?.via?.[source] || [];
}

// Union of all sources valid for ANY edition at a destination (for the source-first step).
export function allSourcesFor(data, target) {
  const t = data.paths.byTarget?.[target];
  if (!t) return [];
  const seen = new Set();
  const out = [];
  for (const ed of Object.keys(t)) {
    for (const s of t[ed].sources || []) if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

// Which editions support this source at this destination (e.g. TCI-CDE => VNF only).
export function editionsFor(data, source, target) {
  const t = data.paths.byTarget?.[target] || {};
  return Object.keys(t).filter((ed) => (t[ed].sources || []).includes(source));
}

// Component-level version caveat for a source (e.g. the VCD chain for TCI-CDE 2.2).
export function componentCaveat(data, target, source, componentId) {
  return data.paths.byTarget?.[target]?.componentCaveats?.[source]?.[componentId];
}
