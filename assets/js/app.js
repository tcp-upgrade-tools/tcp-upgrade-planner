import { loadData, buildPlan, availableComponents, sourcesFor, intermediatesFor, targets, allSourcesFor, editionsFor, componentCaveat, docUrl } from "./planner.js?v=23";

const el = (id) => document.getElementById(id);
const DONE_KEY = "tcp-upgrade-done";

let DATA = null;
let currentPlan = null;
let phaseIndex = 0;
let fullStackOn = true;
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
  setStepsVisible(4);
  el("generate").disabled = false;
}

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
}

function ckRow(c, target) {
  const tgt = DATA.versions.targets?.[target]?.[c.id] || DATA.versions.components[c.id]?.[target] || target;
  const ver = `<span class="ck-ver">${verSpan(c.sourceVersion, tgt)}</span>`;
  const lock = c.mandatory ? ` <span class="ck-lock" title="Mandatory dependency — cannot be skipped">Required</span>` : "";
  const gate = !c.mandatory && c.gate ? `<span class="ck-gate">${escape(c.gate)}</span>` : "";
  const dis = c.mandatory ? "checked disabled" : "checked";
  return `<label class="ck${c.mandatory ? " locked" : ""}"><input type="checkbox" data-comp="${c.id}" ${dis}/> <span class="ck-name">${escape(c.name)}${lock}</span>${ver}${gate}</label>`;
}

// ---------- Generate ----------

function showWizard() {
  el("wizardCard").hidden = false;
  el("contentActions").hidden = true;
  el("runbook").innerHTML = "";
  el("wizardCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function generate() {
  const edition = currentEdition();
  const source = el("source").value;
  const target = el("destination").value;
  // Selected = checked component boxes (data-comp); the infra master toggle is excluded.
  const selected = new Set([...document.querySelectorAll('#components input[data-comp]:checked')].map((c) => c.dataset.comp));
  currentPlan = buildPlan(DATA, edition, source, target, selected);
  phaseIndex = 0;
  // Start every generated runbook fresh — no carry-over of completion from a previous run.
  doneSet = new Set();
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
  const cav = currentPlan && componentCaveat(DATA, currentPlan.target, currentPlan.source, card.id);
  if (cav) body += calloutSection("Required version sequence", cav, "impact");
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
  const hasInfra = plan.cards.some((c) => ["nsx", "vcenter", "esxi", "vsan", "aria-orchestrator"].includes(c.id));
  const scope = hasFS ? (hasInfra ? "Full-stack (incl. infrastructure)" : "CNF layer only") : "Full deployment";
  const rows = comps.map((c) => {
    return `<li><span class="sc-name">✓ ${escape(c.name)}</span><span class="sc-ver">${verSpan(c.sourceVersion, c.targetVersion)}</span></li>`;
  }).join("");
  return `<section class="summary-card">
    <h3>Your selection</h3>
    <div class="summary-grid">
      <div><span class="sk">Route</span><span class="sv">${escape(routeString(plan.edition, plan.source, plan.target))}</span></div>
      <div><span class="sk">Workload</span><span class="sv">${escape(plan.edition)}</span></div>
      <div><span class="sk">Scope</span><span class="sv">${escape(scope)}</span></div>
      <div><span class="sk">Phases</span><span class="sv">${plan.cards.length}</span></div>
    </div>
    <div class="summary-comps"><span class="sk">Components to upgrade (${comps.length})</span><ul>${rows}</ul></div>
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

function renderWalkthrough() {
  const plan = currentPlan;
  const n = plan.cards.length;
  const card = plan.cards[phaseIndex];
  const doneCount = plan.cards.filter((c) => doneSet.has(c.id)).length;
  const complete = allDone(plan);

  const guideHome = docUrl(DATA, plan.target, "home");
  const head = `<div class="plan-head">
      <h2>${escape(plan.editionLabel)}</h2>
      <div class="path-banner"><span class="pb-label">Upgrade path</span> <strong>${escape(routeString(plan.edition, plan.source, plan.target))}</strong></div>
      <p class="plan-framing">This runbook outlines the high-level steps to upgrade the required and optional components of VMware Telco Cloud Platform. For detailed instructions, refer to the corresponding component documentation linked in each phase.${guideHome ? ` <a href="${guideHome}" target="_blank" rel="noopener">Open the full TCP ${escape(plan.target)} Upgrade Guide →</a>` : ""}</p>
      <p class="plan-summary">This upgrade has <strong>${n} phases</strong>. ${doneCount} complete. Walk through them in order — do not skip any.</p>
      <p class="targets-note">${escape(DATA.versions.targetsNote || "")}</p>
    </div>`;

  const banner = complete
    ? `<div class="complete-banner"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg> Upgrade complete — all ${n} phases done.</div>`
    : "";

  const phasePanel = `<article class="phase-card">
      <header class="phase-head">
        <span class="phase-tag">Phase ${phaseIndex + 1} of ${n}${doneSet.has(card.id) ? " · ✓ done" : ""}</span>
        <h3>${escape(card.title)}</h3>
        ${card.kind !== "checklist" ? `<span class="ver">${verSpan(card.sourceVersion, card.targetVersion)}</span>` : ""}
        ${card.formerly ? `<span class="formerly">formerly ${escape(card.formerly)}</span>` : ""}
      </header>
      <div class="phase-body">${phaseBodyHTML(card)}</div>
      <div class="phase-nav">
        <button id="prevPhase" class="ghost-btn" ${phaseIndex === 0 ? "disabled" : ""}>← Back</button>
        <span class="phase-count">${phaseIndex + 1} / ${n}</span>
        ${phaseIndex < n - 1
          ? `<button id="nextPhase" class="primary-btn">${doneSet.has(card.id) ? "Next →" : "Mark done &amp; Next →"}</button>`
          : `<button id="nextPhase" class="primary-btn">${complete ? "Finish ✓" : "Mark done &amp; Finish ✓"}</button>`}
      </div>
    </article>`;

  el("runbook").innerHTML = head + banner + selectionSummaryHTML(plan) + stepperHTML(plan) + phasePanel;
  wireWalkthrough();
}

function wireWalkthrough() {
  document.querySelectorAll(".pstep").forEach((b) => {
    b.addEventListener("click", () => { phaseIndex = Number(b.dataset.i); renderWalkthrough(); scrollPhase(); });
  });
  const prev = el("prevPhase"), next = el("nextPhase");
  if (prev) prev.addEventListener("click", () => { if (phaseIndex > 0) { phaseIndex--; renderWalkthrough(); scrollPhase(); } });
  if (next) next.addEventListener("click", () => {
    const card = currentPlan.cards[phaseIndex];
    doneSet.add(card.id); saveDone();
    if (phaseIndex < currentPlan.cards.length - 1) phaseIndex++;
    renderWalkthrough(); scrollPhase();
  });
}

function scrollPhase() {
  el("runbook").scrollIntoView({ behavior: "smooth", block: "start" });
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
    if (card.conditional) out.push(`> **Conditional:** ${card.conditional}`);
    const cav = componentCaveat(DATA, plan.target, plan.source, card.id);
    if (cav) out.push(`> **Required version sequence:** ${cav}`);
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
