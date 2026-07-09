import { loadData, buildPlan, availableComponents, sourcesFor, intermediatesFor, targets, allSourcesFor, editionsFor, componentCaveat, docUrl, k8sVersionsFor, k8sChainFor, compatibleWorkloadVersions, tkgReleaseFor, tcaSourcesFor, k8sDefaultsForTca } from "./planner.js?v=37";

const el = (id) => document.getElementById(id);
const DONE_KEY = "tcp-upgrade-done";

let DATA = null;
let currentPlan = null;
let phaseIndex = 0;
let lastPlanKey = null; // source|target|edition of the last generated plan — see generate()
let fullStackOn = true;
let sourceChoice = {}; // componentId -> user-picked current version (when the guide lists several)
let k8sChoice = { mgmt: null, workload: null }; // phase -> user-picked current Kubernetes version
let doneSet = new Set(JSON.parse(localStorage.getItem(DONE_KEY) || "[]"));

function saveDone() {
  localStorage.setItem(DONE_KEY, JSON.stringify([...doneSet]));
}

// ---------- Wizard ----------

function sourceLabel(v) {
  return DATA.paths.sourceLabels?.[v] || `TCP ${v}`;
}

function currentEdition() {
  return document.querySelector('input[name="edition"]:checked')?.value || Object.keys(DATA.sequence)[0];
}

// Clean version label: "src → tgt" only when the source is a single version;
// when the guide lists several possible patches (contains / , or "or"), show just "→ tgt".
function verSpan(src, tgt) {
  const multi = !src || src === "NA" || /[\/,]|\bor\b/.test(src);
  return multi ? `→ ${escape(tgt)}` : `${escape(src)} → ${escape(tgt)}`;
}

// Split a matrix cell like "4.1.0.2 / 4.1.1" or "8.0b or 8.0 U1" into individual versions.
function parseVersions(cell) {
  if (!cell || cell === "NA") return [];
  return cell.split(/\s*(?:\/|,|\bor\b)\s*/).map((s) => s.trim()).filter(Boolean);
}

// Full resolved route incl. intermediate platform hops, e.g.
// "TCI-CDE 2.7 → TCI-CDE 3.0 → TCP 5.0.2"
function routeString(edition, source, target) {
  const hops = intermediatesFor(DATA, edition, source, target);
  return [sourceLabel(source), ...hops.map(sourceLabel), `TCP ${target}`].join(" → ");
}

function sourceUniverse() {
  const seen = new Set();
  const out = [];
  for (const t of targets(DATA)) for (const s of allSourcesFor(DATA, t)) if (!seen.has(s)) { seen.add(s); out.push(s); }
  return out;
}

function groupedSourceOptions() {
  const all = sourceUniverse();
  const tcp = all.filter((s) => !s.startsWith("TCI-CDE"));
  const cde = all.filter((s) => s.startsWith("TCI-CDE"));
  let html = `<option value="">— Select source version —</option>`;
  if (tcp.length) html += `<optgroup label="Telco Cloud Platform">` + tcp.map((s) => `<option value="${s}">${escape(sourceLabel(s))}</option>`).join("") + `</optgroup>`;
  if (cde.length) html += `<optgroup label="Telco Cloud Infrastructure – Cloud Director Edition">` + cde.map((s) => `<option value="${s}">${escape(sourceLabel(s))}</option>`).join("") + `</optgroup>`;
  return html;
}

// ---- Progressive wizard: Source → Destination → Workload → Components ----

function initWizard() {
  el("source").innerHTML = groupedSourceOptions();
  el("source").value = "";
  el("source").addEventListener("change", onSourceChange);
  el("destination").addEventListener("change", onDestChange);
  el("edition").addEventListener("change", onEditionChange);
  el("generate").addEventListener("click", generate);
  onSourceChange(); // collapse downstream steps until a source is picked
}

function setStepsVisible(upTo) {
  // upTo: 1=source only, 2=+dest, 3=+workload, 4=+components+actions
  el("step2").hidden = upTo < 2;
  el("step3").hidden = upTo < 3;
  el("step4").hidden = upTo < 4;
  el("wizActions").hidden = upTo < 4;
}

function onSourceChange() {
  const source = el("source").value;
  sourceChoice = {}; // new source release => reset per-component version picks
  k8sChoice = { mgmt: null, workload: null };
  if (!source) { setStepsVisible(1); el("generate").disabled = true; return; }

  // Destinations reachable from this source (some edition supports it).
  const valid = targets(DATA).filter((t) => editionsFor(DATA, source, t).length > 0);
  const dst = el("destination");
  const prev = dst.value;
  dst.innerHTML = valid.map((t) => `<option value="${t}">TCP ${escape(t)}</option>`).join("");
  dst.value = valid.includes(prev) ? prev : valid[0] || "";
  el("destHint").textContent = valid.length > 1
    ? `${valid.length} destination versions available from ${sourceLabel(source)}.`
    : `This is the destination documented for ${sourceLabel(source)}.`;
  setStepsVisible(2);
  onDestChange();
}

function onDestChange() {
  const source = el("source").value;
  const target = el("destination").value;
  k8sChoice = { mgmt: null, workload: null }; // Kubernetes hop tables are target-specific
  if (!target) { setStepsVisible(2); el("generate").disabled = true; return; }

  // Workload types valid for this source+destination.
  const eds = editionsFor(DATA, source, target);
  const prev = currentEdition();
  el("edition").innerHTML = eds
    .map((ed) => `<label class="seg-opt"><input type="radio" name="edition" value="${ed}" ${ed === prev || (eds.length === 1) ? "checked" : ""}/><span>${escape(ed)} — ${escape(DATA.sequence[ed].label.split("(")[0].trim())}</span></label>`)
    .join("");
  // Ensure exactly one selected when prev isn't among options.
  if (!document.querySelector('input[name="edition"]:checked') && eds.length) {
    document.querySelector('input[name="edition"]').checked = true;
  }
  setStepsVisible(3);
  onEditionChange();
}

function onEditionChange() {
  const source = el("source").value;
  const target = el("destination").value;
  const edition = currentEdition();
  if (!edition) { setStepsVisible(3); el("generate").disabled = true; return; }

  const note = el("pathNote");
  note.hidden = false;
  note.className = "path-note";
  note.innerHTML = `Path: <strong>${escape(routeString(edition, source, target))}</strong>`;

  renderComponents(edition, source, target);
  applyTcaK8sDefaultsAndRefresh(target); // seed the Kubernetes pickers from the (nominal or overridden) TCA version
  setStepsVisible(4);
  validateGenerate();
}

// The current TCA version in effect: the user's override if they picked one on the TCA row,
// otherwise the nominal version implied by the TCP source.
function currentTcaVersion() {
  return sourceChoice["tca"] || DATA.versions.components.tca?.[el("source").value];
}

// Some TCA versions have a guide-confirmed, single fixed starting Kubernetes version (e.g. TCA
// 2.3 must already be at 1.24.10) — pre-fill the mgmt/workload pickers with it so the user
// doesn't have to look up a raw Kubernetes patch number themselves. Always resets both pickers
// (rather than only filling blanks) so a changed TCA selection doesn't leave a stale, likely-
// mismatched Kubernetes choice behind. TCA versions without a documented fixed value (3.1/3.2/
// 3.3) clear back to manual selection.
function applyTcaK8sDefaultsAndRefresh(target) {
  const defaults = k8sDefaultsForTca(DATA, target, currentTcaVersion());
  k8sChoice.mgmt = defaults?.mgmt || null;
  k8sChoice.workload = defaults?.workload || null;

  const mgmtSel = document.querySelector('.ck-k8ssel[data-phase="mgmt"]');
  if (mgmtSel) {
    mgmtSel.value = k8sChoice.mgmt || "";
    const wrap = mgmtSel.closest(".ck-k8s");
    const existingNote = wrap.querySelector(".ck-k8s-note");
    if (existingNote) existingNote.remove();
    if (defaults) {
      mgmtSel.insertAdjacentHTML("afterend", `<span class="ck-k8s-note">(auto-filled: TCA ${escape(currentTcaVersion())} environments start here — change if yours differs)</span>`);
    }
  }
  refreshWorkloadPicker(target);
  refreshMgmtTkgLabel(target);
  validateGenerate();
}

// Components whose exact upgrade path depends on the user's current Kubernetes version,
// mapped to the k8s-hops.json phase key ("mgmt" or "workload") that applies to them.
const K8S_PICKER_PHASE = { "tkg-mgmt": "mgmt", "tkg-workload": "workload" };

function renderComponents(edition, source, target) {
  const comps = availableComponents(DATA, edition, source);
  const core = comps.filter((c) => !c.fullStack);
  const infra = comps.filter((c) => c.fullStack);
  const hasFS = !!DATA.sequence[edition].hasFullStack && infra.length > 0;

  let html = `<div class="ck-group"><div class="ck-group-head">${escape(edition)} layer</div>` +
    core.map((c) => ckRow(c, target)).join("") + `</div>`;

  if (hasFS) {
    html += `<div class="ck-group"><label class="ck-group-head toggle"><input type="checkbox" id="fsMaster" ${fullStackOn ? "checked" : ""}/> Infrastructure layer — full-stack upgrade</label>`;
    html += fullStackOn
      ? infra.map((c) => ckRow(c, target)).join("")
      : `<p class="ck-skip">Skipped — upgrading the ${escape(edition)} layer only. Check the box to also upgrade Aria, NSX, and vSphere.</p>`;
    html += `</div>`;
  }

  el("components").innerHTML = html;
  const master = el("fsMaster");
  if (master) master.addEventListener("change", () => { fullStackOn = master.checked; renderComponents(edition, source, target); });
  // Current-version dropdowns: remember the choice. Changing TCA's re-seeds the Kubernetes
  // pickers, since a different TCA source implies a different (or no longer known) starting
  // Kubernetes version.
  document.querySelectorAll(".ck-srcsel").forEach((sel) => {
    sel.addEventListener("change", () => {
      sourceChoice[sel.dataset.comp] = sel.value || null;
      if (sel.dataset.comp === "tca") applyTcaK8sDefaultsAndRefresh(target);
      validateGenerate();
    });
  });
  // Current-Kubernetes-version dropdowns (Tanzu Management/Workload Cluster): required once checked.
  // The workload picker's options depend on the chosen management version — see refreshWorkloadPicker.
  document.querySelectorAll(".ck-k8ssel").forEach((sel) => {
    sel.addEventListener("change", () => {
      k8sChoice[sel.dataset.phase] = sel.value || null;
      if (sel.dataset.phase === "mgmt") { refreshWorkloadPicker(target); refreshMgmtTkgLabel(target); }
      validateGenerate();
    });
  });
  refreshWorkloadPicker(target); // populate/restore the workload picker's filtered options
  document.querySelectorAll('#components input[data-comp]').forEach((cb) => {
    cb.addEventListener("change", validateGenerate);
  });
  validateGenerate();
}

// The workload Kubernetes-version picker's valid options depend on the chosen management
// cluster version (TCA's "Workload Cluster Compatibility" tables). Rebuilds its <option> list
// in place — called on initial render and whenever the management picker changes.
function refreshWorkloadPicker(target) {
  const sel = document.querySelector('.ck-k8ssel[data-phase="workload"]');
  if (!sel) return;
  const wrap = sel.closest(".ck-k8s");
  const existingNote = wrap.querySelector(".ck-k8s-note");
  if (existingNote) existingNote.remove();

  const allOpts = k8sVersionsFor(DATA, target, "workload");
  const mgmtChosen = k8sChoice.mgmt;
  if (!mgmtChosen) {
    sel.disabled = true;
    sel.innerHTML = `<option value="">— select management cluster version first —</option>`;
    k8sChoice.workload = null;
    return;
  }

  const compat = compatibleWorkloadVersions(DATA, target, mgmtChosen);
  const opts = compat || allOpts;
  sel.disabled = false;
  const chosen = k8sChoice.workload && opts.includes(k8sChoice.workload) ? k8sChoice.workload : "";
  k8sChoice.workload = chosen || null;
  sel.innerHTML = `<option value="">— select —</option>` +
    opts.map((o) => `<option value="${o}" ${o === chosen ? "selected" : ""}>${escape(o)}</option>`).join("");

  const msg = compat
    ? `only versions compatible with management cluster ${mgmtChosen} are shown`
    : `no published compatibility data for management cluster ${mgmtChosen} — showing all workload versions; confirm compatibility against the live page`;
  sel.insertAdjacentHTML("afterend", `<span class="ck-k8s-note">(${escape(msg)})</span>`);
}

// The management cluster's TKG release is precise once a Kubernetes version is chosen (TCA
// publishes a distinct TKG sub-release per management version) — updates the row in place.
function tkgTargetLabel(target) {
  return DATA.versions.targets?.[target]?.["tkg-mgmt"] || DATA.versions.components["tkg-mgmt"]?.[target] || target;
}

// Don't show the (fixed, known) target release until the source is also known — a one-sided
// "→ 2.5.2" reads as a finished answer even though it's only half the picture. And once a
// version IS chosen, distinguish "not published for this one" (e.g. 1.28.7/1.28.4, which never
// get a TKG label in the guide) from "nothing chosen yet" — those are different states and were
// previously showing the same misleading "select below" message even after a pick was made.
function mgmtTkgLabelHTML(target) {
  const tkgSrc = tkgReleaseFor(DATA, target, k8sChoice.mgmt);
  const tgt = tkgTargetLabel(target);
  if (tkgSrc) return `TKG release ${escape(tkgSrc)} &rarr; ${escape(tgt)}`;
  if (k8sChoice.mgmt) {
    return `TKG release: <span class="ck-k8s-note">not published by the guide for Kubernetes ${escape(k8sChoice.mgmt)}</span> &rarr; ${escape(tgt)}`;
  }
  return `TKG release: <span class="ck-k8s-note">select your current Kubernetes version below</span>`;
}

function refreshMgmtTkgLabel(target) {
  const span = document.querySelector(".ck-tkgver");
  if (!span) return;
  span.innerHTML = mgmtTkgLabelHTML(target);
}

// Blocks Generate until every checked tkg-mgmt/tkg-workload row has a Kubernetes version chosen
// (only when this target/phase actually has a compatibility table — falls back to the static
// per-TCP-source caveat otherwise, so a future target without k8s-hops data never gets stuck).
function validateGenerate() {
  const checked = new Set([...document.querySelectorAll('#components input[data-comp]:checked')].map((c) => c.dataset.comp));
  let missing = false;
  for (const [compId, phase] of Object.entries(K8S_PICKER_PHASE)) {
    if (!checked.has(compId)) continue;
    const sel = document.querySelector(`.ck-k8ssel[data-phase="${phase}"]`);
    if (!sel) continue; // no compatibility table for this target/phase — nothing to require
    const ok = !!k8sChoice[phase];
    sel.classList.toggle("ck-k8s-missing", !ok);
    if (!ok) missing = true;
  }
  document.querySelectorAll(".ck-srcsel").forEach((sel) => {
    if (!checked.has(sel.dataset.comp)) { sel.classList.remove("ck-k8s-missing"); return; }
    const ok = !!sel.value;
    sel.classList.toggle("ck-k8s-missing", !ok);
    if (!ok) missing = true;
  });
  el("generate").disabled = missing;
}

function ckK8sPicker(componentId, target) {
  const phase = K8S_PICKER_PHASE[componentId];
  if (!phase) return "";
  const opts = k8sVersionsFor(DATA, target, phase);
  if (!opts.length) return "";
  // Workload's <option> list is filled in by refreshWorkloadPicker (depends on the mgmt pick).
  if (phase === "workload") {
    return `<div class="ck-k8s">Current Kubernetes version: <select class="ck-k8ssel" data-phase="workload" required></select></div>`;
  }
  const chosen = k8sChoice[phase] || "";
  const options = `<option value="">— select —</option>` +
    opts.map((o) => `<option value="${o}" ${o === chosen ? "selected" : ""}>${escape(o)}</option>`).join("");
  return `<div class="ck-k8s">Current Kubernetes version: <select class="ck-k8ssel" data-phase="${phase}" required>${options}</select></div>`;
}

function ckRow(c, target) {
  const tgt = DATA.versions.targets?.[target]?.[c.id] || DATA.versions.components[c.id]?.[target] || target;
  // TCA: the TCP source implies a single nominal TCA version, but the guide documents several
  // valid TCA sources for this target independent of that mapping — offer the full override
  // list (not just "/"-separated alternates for this exact TCP source) in case the live
  // environment's TCA patch has drifted from the nominal bundle.
  const opts = c.id === "tca" ? tcaSourcesFor(DATA, target) : parseVersions(c.sourceVersion);
  let ver;
  if (opts.length > 1) {
    // The guide lists several possible source versions for this component (including TCA, where
    // the TCP source implies a nominal version but the live environment's patch may have drifted)
    // — require an explicit pick rather than silently defaulting to one, so the user always
    // actively confirms what they're actually on (same reasoning as the Kubernetes pickers below).
    const chosen = sourceChoice[c.id] || "";
    const options = `<option value="" ${chosen ? "" : "selected"}>— select —</option>` +
      opts.map((o) => `<option value="${escape(o)}" ${o === chosen ? "selected" : ""}>${escape(o)}</option>`).join("");
    const title = c.id === "tca" ? "Select your current TCA version (the version implied by your TCP source is listed among the options)" : "Select your current version";
    ver = `<span class="ck-ver ck-pick" title="${title}"><select class="ck-srcsel" data-comp="${c.id}" required>${options}</select> &rarr; ${escape(tgt)}</span>`;
  } else {
    ver = `<span class="ck-ver">${verSpan(c.sourceVersion, tgt)}</span>`;
  }
  // Disambiguate from the "Current Kubernetes version" picker below: this line is the Tanzu
  // Kubernetes Grid product release, not the Kubernetes version running inside the cluster.
  // Management: TCA publishes a distinct TKG sub-release per Kubernetes version, so this is
  // precise once a version is picked (see refreshMgmtTkgLabel). Workload: no such per-version
  // label is published, so this stays the coarse, nominal TCP-level bookend.
  if (c.id === "tkg-mgmt") {
    ver = `<span class="ck-ver ck-tkgver" title="Tanzu Kubernetes Grid release matching your chosen Kubernetes version">${mgmtTkgLabelHTML(target)}</span>`;
  } else if (c.id === "tkg-workload") {
    ver = `<span class="ck-ver" title="Nominal Tanzu Kubernetes Grid release for this TCP upgrade overall — TCA doesn't publish a distinct TKG label per workload Kubernetes version the way it does for the management cluster">TKG release (nominal) ${verSpan(c.sourceVersion, tgt)}</span>`;
  }
  const lock = c.mandatory ? ` <span class="ck-lock" title="Mandatory dependency — cannot be skipped">Required</span>` : "";
  const gate = !c.mandatory && c.gate ? `<span class="ck-gate">${escape(c.gate)}</span>` : "";
  const dis = c.mandatory ? "checked disabled" : "checked";
  const id = `ck-${c.id}`;
  const k8sPicker = ckK8sPicker(c.id, target);
  return `<div class="ck${c.mandatory ? " locked" : ""}"><input type="checkbox" id="${id}" data-comp="${c.id}" ${dis}/> <label class="ck-name" for="${id}">${escape(c.name)}${lock}</label>${ver}${gate}${k8sPicker}</div>`;
}

// ---------- Generate ----------

function showWizard() {
  el("wizardCard").hidden = false;
  el("contentActions").hidden = true;
  el("runbook").innerHTML = "";
  el("wizardCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

// Format a k8sChainFor() result into the same string-array shape the static componentCaveats
// use, so it renders through the existing listSection/mdList path.
function formatK8sChain(result, label) {
  const hops = result.waypoints;
  const out = [`Computed from TCA's compatibility table for your current ${label} Kubernetes version (${hops[0]} → ${result.finalTarget}):`];
  for (let i = 0; i < hops.length - 1; i++) out.push(`${i + 1}. ${hops[i]} → ${hops[i + 1]}`);
  if (result.prerequisite) out.push(`Prerequisite: ${result.prerequisite}`);
  if (result.note) out.push(result.note);
  return out;
}

function generate() {
  const edition = currentEdition();
  const source = el("source").value;
  const target = el("destination").value;
  // Remember which phase the user was actually looking at (by id, not index) so a regenerate for
  // the same upgrade can put them back on it — insertions/removals elsewhere in the sequence would
  // otherwise silently bump them to an unrelated phase at the same numeric position.
  const priorCardId = currentPlan?.cards[phaseIndex]?.id;
  // Selected = checked component boxes (data-comp); the infra master toggle is excluded.
  const selected = new Set([...document.querySelectorAll('#components input[data-comp]:checked')].map((c) => c.dataset.comp));
  // Capture any current-version picks (defaults to the shown option if untouched).
  document.querySelectorAll('.ck-srcsel').forEach((sel) => { sourceChoice[sel.dataset.comp] = sel.value; });
  currentPlan = buildPlan(DATA, edition, source, target, selected);
  // Apply the user's chosen current version so each phase reads "<chosen> → <target>".
  currentPlan.cards.forEach((card) => { if (sourceChoice[card.id]) card.sourceVersion = sourceChoice[card.id]; });
  // Replace the static per-TCP-source caveat with the exact computed hop chain for the
  // Tanzu phases, using the Kubernetes version the user picked in the wizard.
  for (const [compId, phase] of Object.entries(K8S_PICKER_PHASE)) {
    const card = currentPlan.cards.find((c) => c.id === compId);
    const chosen = k8sChoice[phase];
    if (!card || !chosen) continue;
    const result = k8sChainFor(DATA, target, phase, chosen);
    if (result) {
      card.k8sChain = formatK8sChain(result, phase === "mgmt" ? "management cluster" : "workload cluster");
      // The card's own sourceVersion/targetVersion are the TKG *product* release (e.g. 2.1.1 →
      // 2.5.2) — keep the Kubernetes version the user actually picked alongside it, since the
      // summary and phase header otherwise only show the TKG label and lose this entirely.
      card.k8sVersion = { from: chosen, to: result.finalTarget };
    }
  }
  // A regenerate for the *same* source/destination/workload (i.e. the user hit "Change options"
  // and only adjusted which components/versions are included, then re-generated) keeps progress —
  // doneSet is keyed by component id, which is stable across a regenerate, so any phase that still
  // exists in the new plan keeps its done mark; phases that no longer exist correctly drop theirs
  // (there's nothing to preserve — they're not part of the plan anymore). A genuinely different
  // source/destination/workload is a different upgrade path entirely, so that starts fresh.
  const planKey = `${source}|${target}|${edition}`;
  const sameUpgrade = planKey === lastPlanKey;
  lastPlanKey = planKey;
  if (sameUpgrade) {
    const validIds = new Set(currentPlan.cards.map((c) => c.id));
    doneSet = new Set([...doneSet].filter((id) => validIds.has(id)));
    const samePhaseIdx = priorCardId ? currentPlan.cards.findIndex((c) => c.id === priorCardId) : -1;
    phaseIndex = samePhaseIdx >= 0 ? samePhaseIdx : Math.min(phaseIndex, currentPlan.cards.length - 1);
  } else {
    doneSet = new Set();
    phaseIndex = 0;
  }
  saveDone();
  setActiveNav("plan");
  el("wizardCard").hidden = true;
  el("contentActions").hidden = false;
  renderWalkthrough();
  el("runbook").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Walkthrough render ----------

function cmdHTML(commands) {
  const text = Array.isArray(commands) ? commands.join("\n") : commands;
  return `<pre class="cmd">${escape(text)}</pre>`;
}

function listSection(title, items, cls) {
  if (!items || !items.length) return "";
  return `<div class="sec ${cls || ""}"><h4>${escape(title)}</h4><ul>${items.map((i) => `<li>${escape(i)}</li>`).join("")}</ul></div>`;
}

function calloutSection(title, text, cls) {
  if (!text) return "";
  return `<div class="callout ${cls}"><span class="callout-t">${escape(title)}</span> ${escape(text)}</div>`;
}


function snippetsHTML(snippets) {
  if (!snippets || !snippets.length) return "";
  return `<div class="sec snippets"><h4>Reference snippets</h4>` + snippets.map((s) => {
    let h = `<div class="snippet"><p class="snip-label">${escape(s.label)}</p>`;
    if (s.note) h += `<p class="snip-note">${escape(s.note)}</p>`;
    h += cmdHTML(s.commands) + `</div>`;
    return h;
  }).join("") + `</div>`;
}

function phaseBodyHTML(card) {
  let body = "";
  if (card.summary) body += `<p class="intro">${escape(card.summary)}</p>`;
  if (card.conditional) body += calloutSection("Applies only if", card.conditional, "cond");
  const cav = card.k8sChain || (currentPlan && componentCaveat(DATA, currentPlan.target, currentPlan.source, card.id));
  if (Array.isArray(cav)) body += listSection("Required version sequence", cav, "impact");
  else if (cav) body += calloutSection("Required version sequence", cav, "impact");
  if (card.kind === "checklist") body += listSection("Checklist", card.checklist, "checklist-sec");
  body += listSection("Prerequisites", card.prerequisites, "prereq");
  body += calloutSection("Service impact", card.impact, "impact");
  body += calloutSection("Rollback", card.rollback, "rollback");
  body += listSection("Key considerations", card.considerations, "consider");
  body += snippetsHTML(card.snippets);
  if (card.doc) body += `<p class="doc-note">All detailed guidance is provided in the official documentation — <a class="doc-link" href="${card.doc}" target="_blank" rel="noopener">View Documentation</a></p>`;
  return body;
}

function selectionSummaryHTML(plan) {
  const comps = plan.cards.filter((c) => c.kind !== "checklist");
  const hasFS = !!DATA.sequence[plan.edition]?.hasFullStack;
  const hasInfra = plan.cards.some((c) => c.fullStack);
  const scope = hasFS ? (hasInfra ? "Full-stack (includes infrastructure layer)" : "CNF layer only") : null;
  const items = comps.map((c) => {
    const k8s = c.k8sVersion
      ? `<span class="sc-ver sc-k8s">Kubernetes ${escape(c.k8sVersion.from)} &rarr; ${escape(c.k8sVersion.to)}</span>` : "";
    return `<div class="sum-item"><span class="sc-name">${escape(c.name)}</span><span class="sc-vers"><span class="sc-ver">${verSpan(c.sourceVersion, c.targetVersion)}</span>${k8s}</span></div>`;
  }).join("");
  return `<section class="summary-card">
    <div class="summary-head"><h3>Components to upgrade</h3><span class="sc-count">${comps.length}</span>${scope ? `<span class="sc-scope">${escape(scope)}</span>` : ""}</div>
    <div class="sum-list">${items}</div>
  </section>`;
}

function stepperHTML(plan) {
  return `<div class="stepper">` + plan.cards.map((c, i) => {
    const state = doneSet.has(c.id) ? "done" : i === phaseIndex ? "current" : "todo";
    return `<button class="pstep ${state}" data-i="${i}" title="${escape(c.name)}">
      <span class="pdot">${doneSet.has(c.id) ? "✓" : i + 1}</span>
      <span class="plabel">${escape(c.name)}</span>
    </button>`;
  }).join("") + `</div>`;
}

function allDone(plan) {
  return plan.cards.every((c) => doneSet.has(c.id));
}

// Builds the static top (path + Your selection + stepper) once; the phase panel swaps in place.
function renderWalkthrough() {
  const plan = currentPlan;
  const n = plan.cards.length;
  const doneCount = plan.cards.filter((c) => doneSet.has(c.id)).length;
  const guideHome = docUrl(DATA, plan.target, "home");
  const head = `<div class="plan-head">
      <span class="pb-label">Upgrade path</span>
      <h2>${escape(routeString(plan.edition, plan.source, plan.target))}</h2>
      <p class="plan-workload">${escape(plan.editionLabel)} · <strong>${n} phases</strong> · <span id="doneCount">${doneCount}</span> complete</p>
      <p class="plan-framing">This runbook outlines the high-level steps to upgrade the required and optional components of VMware Telco Cloud Platform. For detailed instructions, refer to the corresponding component documentation linked in each phase.${guideHome ? ` <a href="${guideHome}" target="_blank" rel="noopener">Open the full TCP ${escape(plan.target)} Upgrade Guide →</a>` : ""}</p>
    </div>`;

  el("runbook").innerHTML = head + selectionSummaryHTML(plan) + stepperHTML(plan) + `<div id="phaseHost"></div>`;
  document.querySelectorAll(".pstep").forEach((b) => {
    b.addEventListener("click", () => { phaseIndex = Number(b.dataset.i); renderPhase(); });
  });
  renderPhase();
}

// Swaps only the phase card (+ completion banner) and refreshes stepper state — no page jump.
function renderPhase() {
  const plan = currentPlan;
  const n = plan.cards.length;
  const card = plan.cards[phaseIndex];
  const doneCount = plan.cards.filter((c) => doneSet.has(c.id)).length;
  // The runbook is "complete" once the final phase is marked done.
  const complete = doneSet.has(plan.cards[n - 1].id);
  const msg = doneCount === n ? `Upgrade complete — all ${n} phases done.` : `You've reached the end — ${doneCount} of ${n} phases marked done.`;

  const banner = complete
    ? `<div class="complete-banner"><span class="cb-msg"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg> ${msg}</span><button id="restartBtn" class="cb-btn">Start a new plan</button></div>`
    : "";
  const phasePanel = `<article class="phase-card">
      <header class="phase-head">
        <span class="phase-tag">Phase ${phaseIndex + 1} of ${n}${doneSet.has(card.id) ? " · ✓ done" : ""}</span>
        <h3>${escape(card.title)}</h3>
        ${card.kind !== "checklist" ? `<span class="ver">${verSpan(card.sourceVersion, card.targetVersion)}</span>` : ""}
        ${card.k8sVersion ? `<span class="ver ver-k8s">Kubernetes ${escape(card.k8sVersion.from)} &rarr; ${escape(card.k8sVersion.to)}</span>` : ""}
        ${card.formerly ? `<span class="formerly">formerly ${escape(card.formerly)}</span>` : ""}
      </header>
      <div class="phase-body">${phaseBodyHTML(card)}</div>
      <div class="phase-nav">
        <button id="prevPhase" class="ghost-btn" ${phaseIndex === 0 ? "disabled" : ""}>← Back</button>
        <span class="phase-count">${phaseIndex + 1} / ${n}</span>
        ${phaseIndex < n - 1
          ? `<button id="nextPhase" class="primary-btn">${doneSet.has(card.id) ? "Next →" : "Mark done &amp; Next →"}</button>`
          : complete
            ? `<span class="phase-done-note">✓ All phases complete</span>`
            : `<button id="nextPhase" class="primary-btn">Mark done &amp; Finish ✓</button>`}
      </div>
    </article>`;

  el("phaseHost").innerHTML = banner + phasePanel;

  // Refresh stepper dots/states in place.
  document.querySelectorAll(".pstep").forEach((b, i) => {
    const c = plan.cards[i];
    b.className = "pstep " + (doneSet.has(c.id) ? "done" : i === phaseIndex ? "current" : "todo");
    const dot = b.querySelector(".pdot");
    if (dot) dot.textContent = doneSet.has(c.id) ? "✓" : i + 1;
  });
  const dc = el("doneCount");
  if (dc) dc.textContent = doneCount;

  // Keep the current step visible in the horizontal stepper without scrolling the page.
  document.querySelector(".pstep.current")?.scrollIntoView({ inline: "center", block: "nearest" });

  const prev = el("prevPhase"), next = el("nextPhase"), restart = el("restartBtn");
  if (prev) prev.addEventListener("click", () => { if (phaseIndex > 0) { phaseIndex--; renderPhase(); } });
  if (restart) restart.addEventListener("click", () => {
    // Unlike "Change options" (which regenerates in place and preserves progress for an
    // unchanged upgrade), "Start a new plan" always promises a clean slate — force the next
    // generate() to treat it as a different upgrade even if the user re-picks identical values.
    lastPlanKey = null;
    doneSet = new Set();
    saveDone();
    showWizard();
  });
  if (next) next.addEventListener("click", () => {
    doneSet.add(currentPlan.cards[phaseIndex].id); saveDone();
    if (phaseIndex < currentPlan.cards.length - 1) phaseIndex++;
    renderPhase();
    // If the runbook just completed, bring the banner (rendered above the panel) into view.
    document.querySelector(".complete-banner")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

// ---------- Alternate views ----------

function setActiveNav(view) {
  document.querySelectorAll(".nav-link").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
}

function renderComponentsView() {
  setActiveNav("components");
  el("wizardCard").hidden = true;
  el("contentActions").hidden = true;
  const releases = DATA.versions.releases;
  const rows = Object.entries(DATA.versions.components)
    .map(([id, map]) => {
      const meta = DATA.components[id] || {};
      const name = meta.doc ? `<a href="${meta.doc}" target="_blank" rel="noopener">${escape(meta.name || id)}</a>` : escape(meta.name || id);
      const cells = releases.map((r) => `<td>${escape(map[r] || "—")}</td>`).join("");
      return `<tr><td>${name}</td>${cells}</tr>`;
    })
    .join("");
  el("runbook").innerHTML = `<div class="view-wrap">
    <h2>Component Version Matrix</h2>
    <p>Supported component versions per Telco Cloud Platform release.</p>
    <table class="matrix"><thead><tr><th>Component</th>${releases.map((r) => `<th>${r}</th>`).join("")}</tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="fine">${escape(DATA.versions.notes?.patches || "")}</p>
  </div>`;
}

function renderPathView() {
  setActiveNav("path");
  el("wizardCard").hidden = true;
  el("contentActions").hidden = true;
  const blocks = targets(DATA).map((t) => {
    const eds = Object.keys(DATA.sequence)
      .map((ed) => {
        const srcs = sourcesFor(DATA, ed, t);
        if (!srcs.length) return "";
        const lis = srcs.map((s) => {
          const hops = intermediatesFor(DATA, ed, s, t);
          const route = [sourceLabel(s), ...hops.map(sourceLabel), `TCP ${t}`].join(" → ");
          return `<li>${escape(route)}</li>`;
        }).join("");
        return `<h4>${escape(DATA.sequence[ed].label)}</h4><ul>${lis}</ul>`;
      })
      .join("");
    return `<h3>Target: TCP ${escape(t)}</h3>${eds}`;
  }).join("");
  const notes = (DATA.paths.notes || []).map((n) => `<li>${escape(n)}</li>`).join("");
  el("runbook").innerHTML = `<div class="view-wrap">
    <h2>Supported Upgrade Paths</h2>
    ${blocks}
    <h3>Important notes</h3><ul>${notes}</ul>
  </div>`;
}

function wireNav() {
  document.querySelectorAll(".nav-link").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const view = a.dataset.view;
      if (view === "components") renderComponentsView();
      else if (view === "path") renderPathView();
      else {
        setActiveNav("plan");
        if (currentPlan) { el("wizardCard").hidden = true; el("contentActions").hidden = false; renderWalkthrough(); }
        else showWizard();
      }
    });
  });
}

// ---------- Full-runbook export ----------

function fullRunbookHTML(plan) {
  let html = `<h1>${escape(plan.editionLabel)} — Upgrade Runbook</h1>
    <p><strong>Upgrade path:</strong> ${escape(routeString(plan.edition, plan.source, plan.target))}</p>
    <p>${escape(plan.editionSummary)}</p>`;
  plan.cards.forEach((c, i) => {
    html += `<article class="phase-card pdf"><header class="phase-head"><span class="phase-tag">Phase ${i + 1} of ${plan.cards.length}</span><h3>${escape(c.title)}</h3></header><div class="phase-body">${phaseBodyHTML(c)}</div></article>`;
  });
  return html;
}

function exportPdf() {
  if (!currentPlan) return flashBtn("exportPdf", "Generate first");
  if (typeof window.html2pdf === "undefined") { window.print(); return; }
  const holder = document.createElement("div");
  holder.className = "pdf-holder";
  holder.innerHTML = fullRunbookHTML(currentPlan);
  document.body.appendChild(holder);
  const name = `TCP-upgrade-${currentPlan.edition}-${currentPlan.source}-to-${currentPlan.target}.pdf`.replace(/\s+/g, "");
  flashBtn("exportPdf", "Generating…");
  window.html2pdf()
    .set({ margin: 10, filename: name, image: { type: "jpeg", quality: 0.95 }, html2canvas: { scale: 2 }, jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }, pagebreak: { mode: ["css", "avoid-all"] } })
    .from(holder).save()
    .then(() => { holder.remove(); flashBtn("exportPdf", "Saved"); })
    .catch(() => { holder.remove(); flashBtn("exportPdf", "Failed — try Print"); });
}

// ---------- Markdown export (full) ----------

function mdList(title, items) {
  if (!items || !items.length) return [];
  return [`**${title}:**`, ...items.map((i) => `- ${i}`), ""];
}

function mdSnippets(snippets) {
  if (!snippets || !snippets.length) return [];
  const out = ["**Reference snippets:**"];
  snippets.forEach((s) => {
    out.push(`- ${s.label}`);
    if (s.note) out.push(`  > ${s.note}`);
    const cmd = Array.isArray(s.commands) ? s.commands.join("\n") : s.commands;
    out.push("  ```\n  " + cmd.split("\n").join("\n  ") + "\n  ```");
  });
  out.push("");
  return out;
}

function planToMarkdown(plan) {
  const guideHome = docUrl(DATA, plan.target, "home");
  const out = [`# ${plan.editionLabel} — Upgrade Runbook`, `**Upgrade path:** ${routeString(plan.edition, plan.source, plan.target)}`, ""];
  out.push("_This runbook outlines the high-level steps to upgrade the required and optional components of VMware Telco Cloud Platform. For detailed instructions, refer to the corresponding component documentation linked in each phase._");
  if (guideHome) out.push(`📘 [Full TCP ${plan.target} Upgrade Guide](${guideHome})`);
  out.push("", plan.editionSummary, "");
  const doneCount = plan.cards.filter((c) => doneSet.has(c.id)).length;
  out.push(`**Progress:** ${doneCount} / ${plan.cards.length} phases complete`, "", "## Phases");
  plan.cards.forEach((c, i) => out.push(`- [${doneSet.has(c.id) ? "x" : " "}] Phase ${i + 1}: ${c.title}`));
  out.push("", "---", "");
  plan.cards.forEach((card, i) => {
    out.push(`## Phase ${i + 1}: ${card.title}${doneSet.has(card.id) ? " ✅" : ""}`);
    if (card.kind !== "checklist") out.push(`_Version: ${card.sourceVersion && card.sourceVersion !== "NA" ? card.sourceVersion + " → " : "→ "}${card.targetVersion}_`);
    if (card.k8sVersion) out.push(`_Kubernetes: ${card.k8sVersion.from} → ${card.k8sVersion.to}_`);
    if (card.conditional) out.push(`> **Conditional:** ${card.conditional}`);
    const cav = card.k8sChain || componentCaveat(DATA, plan.target, plan.source, card.id);
    if (Array.isArray(cav)) out.push(...mdList("Required version sequence", cav));
    else if (cav) out.push(`> **Required version sequence:** ${cav}`);
    if (card.summary) out.push("", card.summary, "");
    if (card.kind === "checklist") out.push(...mdList("Checklist", card.checklist));
    out.push(...mdList("Prerequisites", card.prerequisites));
    if (card.impact) out.push(`**Service impact:** ${card.impact}`, "");
    if (card.rollback) out.push(`**Rollback:** ${card.rollback}`, "");
    out.push(...mdList("Key considerations", card.considerations));
    out.push(...mdSnippets(card.snippets));
    if (card.doc) out.push(`All detailed guidance is provided in the official documentation — [View Documentation](${card.doc})`, "");
  });
  out.push("---", `_Generated by the TCP Upgrade Planner. Verify against the official Broadcom Techdocs before executing._`);
  return out.join("\n");
}

async function copyMarkdown() {
  if (!currentPlan) return flashBtn("copyMd", "Generate first");
  const md = planToMarkdown(currentPlan);
  try { await navigator.clipboard.writeText(md); flashBtn("copyMd", "✓ Copied!"); }
  catch {
    const ta = document.createElement("textarea"); ta.value = md; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove();
    flashBtn("copyMd", ok ? "✓ Copied!" : "Copy failed");
  }
}

function flashBtn(id, msg) {
  const btn = el(id); if (!btn) return;
  if (!btn.dataset.html) btn.dataset.html = btn.innerHTML; // preserve icon markup
  btn.textContent = msg;
  setTimeout(() => { btn.innerHTML = btn.dataset.html; }, 1600);
}

// ---------- Misc ----------

function escape(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function initTheme() {
  const saved = localStorage.getItem("tcp-theme") || "light";
  document.documentElement.dataset.theme = saved;
  setThemeLabel(saved);
  el("themeToggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("tcp-theme", next);
    setThemeLabel(next);
  });
}

function setThemeLabel(theme) {
  const lbl = el("themeLabel");
  if (lbl) lbl.textContent = theme === "dark" ? "Light" : "Dark";
}

async function main() {
  initTheme();
  el("print").addEventListener("click", () => window.print());
  el("copyMd").addEventListener("click", copyMarkdown);
  el("exportPdf").addEventListener("click", exportPdf);
  el("changeOpts").addEventListener("click", () => { setActiveNav("plan"); showWizard(); });
  try {
    DATA = await loadData();
    initWizard();
    wireNav();
  } catch (e) {
    el("runbook").innerHTML = `<div class="placeholder"><h2>Could not load data</h2><p>${escape(e.message)}</p></div>`;
    console.error(e);
  }
}

main();
