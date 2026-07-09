# CLAUDE.md — Project context for the TCP Upgrade Planner

Context for Claude Code (and humans). Open this repo in Claude Code on any machine and this file is
auto-loaded, so you can continue building from anywhere after `git clone`.

## What this is
A static web **VMware Telco Cloud Platform (TCP) Upgrade Planner** (vanilla HTML/CSS/ES-module JS +
JSON, **no build step**). The user picks their environment (source → destination version, workload,
components) and the tool generates *their* exact ordered, trackable upgrade runbook, linking each
phase to the authoritative Broadcom doc. It's a personalized plan + execution tracker that bridges to
the docs — not a docs replacement. Inspired by VMware's VCF upgrade planner.

## Hosting / URLs (live)
- **Live tool:** https://tcp-upgrade-tools.github.io/tcp-upgrade-planner/
- **Repo:** https://github.com/tcp-upgrade-tools/tcp-upgrade-planner (GitHub **org**, no personal
  username in the URL; repo was transferred off the personal account).
- GitHub Pages via Actions (`.github/workflows/pages.yml`), auto-deploys on push to `main`.
- **Deploy gotcha:** the workflow uses `concurrency: cancel-in-progress`, and Pages cancels a
  re-deploy of an already-deployed commit SHA → re-running the *same* commit shows "Deployment
  cancelled" (harmless). A real new commit deploys green. Don't manually re-trigger the same SHA.
- **Run locally:** `python3 -m http.server 8080` then open the printed localhost URL.

## Design — VMware Clarity language
- Font: authentic **Clarity City** via `@cds/city@1.1.0` CDN (see `<link>` in index.html), with
  Inter/system fallback.
- **Light** Clarity header (white bar, colored brand mark, accent-underline nav tabs).
- Palette: action-blue `#0072a3`, cool-gray neutrals, green `#318700`/amber status; tuned dark theme.
  Uppercase Clarity buttons, 4px radii. No emojis in the GUI (inline SVG icons only).

## UX flow
- **Progressive wizard** (each step reveals the next): Source → Destination → Workload → Components →
  Generate. Nothing pre-selected. Source dropdown lists all sources grouped (TCP releases +
  TCI – Cloud Director Edition). Workload is derived from source (TCI-CDE sources are VNF-only).
- **Component selection** grouped by layer: mandatory (locked) + optional toggles with flowchart gate
  questions, plus an "Infrastructure layer — full-stack upgrade" master toggle (the flowchart's
  Full-Stack Yes/No; all-or-nothing). Multi-version source cells (e.g. NSX `4.1.0.2 / 4.1.1`) render
  a dropdown to pick the current version; single-value cells show plain text.
- **Never silently default an ambiguous "current version" picker — always require an explicit pick.**
  Every `<select class="ck-srcsel">` rendered for a multi-option matrix cell (`ckRow` in app.js)
  starts on a blank `"— select —"` placeholder, is marked `required`, and blocks the Generate
  button (`validateGenerate`) until the user actively chooses — same treatment as the Kubernetes
  current-version pickers (`ckK8sPicker`). This applies even to TCA, which used to be a special
  case pre-filled to the TCP-source-implied nominal version (e.g. TCP 4.0 → TCA 3.1, per the guide's
  own matrix row) — that value is accurate, but a silent default is still a silent default: the user
  never had to confirm it. Removed as a user-directed fix (2026-07). If you're tempted to re-add a
  "confident default" exception for some future component, don't — ask first.
- **"Change options" regenerates in place and preserves progress; "Start a new plan" always resets.**
  Both buttons call `showWizard()` (just un-hides the still-populated wizard, doesn't touch state),
  so the actual reset-vs-preserve decision happens in `generate()`, keyed off whether
  source|target|edition matches the *last* generated plan (`lastPlanKey`). Same upgrade (user only
  touched component/version selections) → `doneSet` is filtered to intersect the new plan's card
  ids (phases that no longer exist correctly lose their done-mark; phases that still exist keep
  theirs — this works because `doneSet` is keyed by component id, not phase index, so it's already
  resilient to reordering) and `phaseIndex` is re-resolved by the *id* of the phase the user was
  previously viewing, not its raw numeric position (insertions/removals elsewhere in the sequence
  shift indices without changing what phase you're looking at). Different upgrade, or the "Start a
  new plan" button specifically (it force-sets `lastPlanKey = null` before showing the wizard, since
  its label promises a clean slate even if the user re-picks identical values) → full reset. Added
  as a user-directed fix (2026-07) after "Change options" was found to silently discard all marked-
  done progress on every regenerate, identical selections or not.
- **Kubernetes version vs. TKG product version — both must be shown, they're not the same thing.**
  `card.sourceVersion`/`targetVersion` for `tkg-mgmt`/`tkg-workload` is the Tanzu Kubernetes Grid
  *product* release (e.g. `2.1.1 → 2.5.2`, from the `tkg` matrix row). The Kubernetes version the
  user actually picked (and its computed final target, from `k8sChainFor`) is a separate fact,
  stored on the card as `card.k8sVersion = { from, to }` (set in `generate()`). Both are rendered in
  three places: the "Components to upgrade" summary (`selectionSummaryHTML`, `.sc-k8s`), the
  per-phase header (`.ver-k8s`), and the Markdown export (`_Kubernetes: X → Y_` line). Only the TKG
  line existed originally — the Kubernetes line was missing everywhere until a user-reported fix
  (2026-07); if you add a new render surface for these cards, wire both.
- **Runbook**: H2 title is the **upgrade path** (e.g. `TCP 3.0 → TCP 5.0.2`), workload as subtitle;
  then compact "Your selection"; a horizontal stepper; then one phase panel at a time. Back/Next swap
  ONLY the phase panel in place (`renderWalkthrough` builds the static top once; `renderPhase` swaps
  `#phaseHost`) — no jump to top.
- **Finish**: completion = the final phase marked done (not every phase). Shows the "Upgrade complete"
  banner + "Start a new plan".
- Per-phase content (single-source model): summary + Prerequisites (bullets) + Service impact +
  Rollback + Key considerations (bullets) + Reference snippets (commands) + "View Documentation".
- Exports: PDF (html2pdf.js), Copy Markdown, Print. Components matrix + Upgrade Path views. Light
  default theme + dark toggle. Progress resets on each Generate.

## Data model (two destinations: 5.0.2 and 5.1; target-keyed for future versions)
Two targets are documented: **TCP 5.0.2** and **TCP 5.1**, each from its own per-release doc bundle
PDF (see "Source PDFs" below — same filename pattern, different content per release, do not assume
the filename alone identifies which release a PDF documents). Data is keyed `byTarget` so adding a
future target = one `versions.json` component column + one `paths.json` byTarget block + a
`docs.json` versionSlug entry. Component **target versions come from each target's own matrix
column**:
- 5.0.2: NSX 4.2.1.3, TKG 2.5.2, Avi 30.2.2, AKO 1.12.3, TCA 3.3.0.1, VCD 10.6.1, ESXi/vCenter/vSAN
  8.0 U3d, Aria Ops 8.18.6, Logs 8.18.3, Networks 6.13, vSphere Rep/LSR 9.0.2.
- 5.1: NSX 4.2.2.1, TKG 2.5.4, Avi 30.2.3, AKO 1.13.3, TCA 3.4, Harbor 2.13.1, VCD 10.6.1 (unchanged),
  ESXi/vCenter/vSAN 8.0 U3 (unchanged), Aria Ops/Logs 8.18.3 (unchanged), Networks 6.13 (unchanged),
  vSphere Rep/LSR 9.0.2 (unchanged). The 5.1 guide flags TCA (+Airgap/Harbor), TKG, and Avi as
  *mandatory* to upgrade; other components may stay on their 5.0/5.0.1 versions — noted in
  `paths.json`'s global `notes`.

TKG is split into `tkg-mgmt`/`tkg-workload`; their source version aliases to the `tkg` matrix row
(`VERSION_ALIAS` in planner.js) so e.g. TCP 3.0 shows `2.1.1 → 2.5.2`.

`bma` (Bare Metal Automation) has real versions through TCP 5.0.2 but **no 5.1 cell** — confirmed
by a full-document search of the TCP 5.1 PDF (not just the upgrade-guide chapter), zero hits for
"Bare Metal Automation" anywhere in it. Per the user (project owner), this is real: BMA was
discontinued as of TCP 5.1 — customers use their own third-party tooling instead. `versions.json`
reflects this as `"5.1": "Discontinued"` (not a blank/omitted key), with a `notes.bma` explanation;
the Components Matrix view renders whatever string is there directly (`app.js` `renderComponentsView`
iterates `Object.entries(DATA.versions.components)` — every row shows, whether or not it's also in
`components.json`'s selectable-component list).

`k8s-hops.json`'s `mgmtWorkloadCompat` map now has entries for management versions `1.28.4` and
`1.28.7` too (not just the "real" published-table versions) — derived from the Workload Cluster
Kubernetes Version table's per-row "Upgrade Management Cluster vX->v1.28.11" step annotations, since
those two management versions are transitional/pass-through and have no compatibility table of
their own. Without an entry, `compatibleWorkloadVersions()` falls back to the *unfiltered* full
workload list (intentional fallback for genuinely unpublished cases — see its doc comment in
planner.js), which was wrongly offering workload starting points that require management to already
be at its final target (1.28.11) even when management was still shown at 1.28.4/1.28.7. If you add a
new transitional/pass-through version anywhere in this file, check whether the same gap exists.

Paths: for 5.0.2 (guide p239), CNF sources 3.0/4.0/4.0.1/5.0/5.0.1 → 5.0.2. VNF same + TCI-CDE 3.0
(direct), 2.7 (→ 3.0 → 5.0.2 platform hop), 2.2 (direct; VCD component chain
`10.3.3.x → 10.4.3 → 10.6.1` shown as a caveat in the Cloud Director phase). For **5.1** (guide p218),
the guide only documents direct upgrades from **5.0 and 5.0.1** (plus the same TCI-CDE chain) — no
direct path from 3.0/4.0/4.0.1/5.0.2 is documented, so those sources are simply not offered as
sources when 5.1 is the target (see the global note pointing users at 5.0.2 first).

**Kubernetes / Photon OS caveats (per TCP source, on `tkg-mgmt`/`tkg-workload`):** TCP source version
maps 1:1 to a TCA source version (see the `tca` row in `versions.json`: 3.0→2.3, 4.0→3.1,
4.0.1→3.1.1, 5.0→3.2, 5.0.1→3.3), so there's no separate "pick your TCA version" control — the TCP
source you pick already implies it (noted in `steps.json`'s `tca.considerations`). Two upstream TCA
guides each document a small number of *dedicated* per-source hop-chain walkthroughs (not every
source gets one — the rest only have the generic compatibility tables):
- **TCA 3.3.0.1 guide** (`vmware-telco-cloud-automation-3-3-0-1.pdf`, target for TCP 5.0.2): dedicated
  walkthroughs exist for TCA 2.3 (`componentCaveats["3.0"]`, an 8-step management + 8-step workload
  sequence) and TCA 3.1.1 (`componentCaveats["4.0.1"]`). TCA 3.2 (`componentCaveats["5.0"]`) has no
  dedicated walkthrough — only a guide note that 3.1.1 and 3.2.0 share the same workload starting
  point (K8s 1.26.14) — so that caveat is a plain string pointing at the live compatibility tables
  rather than a numbered sequence. TCA 3.3 (TCP 5.0.1) has neither a dedicated walkthrough nor an
  explicit overlap note, so it's left to the generic `steps.json` considerations only (no
  `componentCaveats` entry).
- **TCA 3.4 guide** (`vmware-telco-cloud-automation-3-4.pdf`, target for TCP 5.1): one dedicated
  walkthrough, "Upgrade 3.2/3.3 Cluster to 3.4", covers both TCA 3.2 (`5.1`'s `componentCaveats["5.0"]`)
  and TCA 3.3 (`componentCaveats["5.0.1"]`) — the guide treats them identically. It also has an
  explicit prerequisite (bring workload clusters to K8s 1.27.15 *before* starting the TCA 3.4
  migration, on your current TCA release) that the numbered steps assume is already done — captured
  as a separate bullet ahead of the numbered sequence.

All of the above are `componentCaveats` entries (arrays of strings, rendered as a numbered list via
`listSection`/`.sec.impact` in `app.js`/`style.css` — `componentCaveat()` values can be either a
plain string, rendered via `calloutSection`, or an array; check `Array.isArray(cav)` at both
`app.js` call sites before assuming one shape) in the relevant target's `byTarget` block. Crossing
Kubernetes 1.27 also moves the Tanzu node OS from Photon OS 3 to Photon OS 5 in both guides
identically, which has real CNF impact (kernel param rename `vfio_pci.disable_resets` →
`vfio_pci_core.disable_resets`, driver package naming convention change, CSARs need conditional
`infra_requirements` per OS) — repeated in each hop-chain caveat above, plus a shorter,
source-agnostic version in `steps.json`'s `tkg-mgmt`/`tkg-workload` `considerations` for everyone
else. Where a guide's own numbers are internally inconsistent (e.g. the TCA 2.3 walkthrough's
workload path never lands exactly on the 1.26.8 the management-cluster table requires before its
1.27.5 hop), the caveat says so explicitly rather than silently picking one number — never invent
a reconciliation the guide doesn't state.

Upgrade order (from the guide's flowchart images):
- **CNF:** Airgap → TCA → Harbor → Avi → TKG Mgmt → AKO → TKG Workload → [Full Stack?] → Aria
  Orchestrator → NSX → vCenter → ESXi → vSAN.
- **VNF:** VCD → vSphere Replication → LSR → NSX → vCenter → ESXi → vSAN → Aria → Avi.

## Doc links — version-aware deep links (all verified 200)
`data/docs.json` + `docUrl(data, target, id)` build per-phase URLs: base + versionSlug (5.0.2 →
`5-0-2`) + guidePath + `upgrading-...-from-2-0-to-2-1` + component page slug. Guide **home** =
`.../{guidePath}.html` (sits beside the guide dir; special-cased). Cross-cutting: prerequisites →
Overview, snapshot-backup → overview/snapshot-and-backup-requirements.html, post-upgrade →
post-upgrade-checklist.html. NOTE: Avi Load Balancer's real slug is `upgrade-ako-for-non-airgap.html`
(a Broadcom quirk, verified).

## Files
- `index.html` · `assets/css/style.css` · `assets/js/planner.js` (loadData, availableComponents,
  buildPlan, sourcesFor/intermediatesFor/allSourcesFor/editionsFor/componentCaveat/targets/docUrl,
  sourceVersion + VERSION_ALIAS) · `assets/js/app.js` (wizard, walkthrough, exports, views).
- `data/`: `versions.json` (matrix + targets), `components.json` (meta + mandatory + gate),
  `sequence.json` (CNF/VNF order + fullStack flags), `paths.json` (byTarget + componentCaveats +
  sourceLabels + sourceGroups), `steps.json` (per-phase single-source content), `docs.json`
  (version-aware doc URLs).
- `tools/extract.py` (thin `pdftotext -layout` wrapper; run
  `python3 tools/extract.py {tcp502,tcp51,tca,tca34}` to re-dump a chapter) + its curated output
  `tools/upgrade_guide_text_5-0-2.txt`, `tools/upgrade_guide_text_5-1.txt`,
  `tools/tca_upgrade_text.txt`, `tools/tca34_upgrade_text.txt` (Photon OS + Kubernetes hop chapters
  only, not the full 700+-page TCA guides). `.github/workflows/pages.yml`, `.nojekyll`, `README.md`.

## Source PDFs
Four PDFs are committed as source-of-truth (all in the repo root, all real, sizeable files —
don't be surprised by the diff size when they change):
- `vmware-telco-cloud-platform-5-0-2.pdf` — per-release doc bundle whose Upgrade Guide chapter
  covers **TCP 5.0.2** only, despite the shared filename pattern.
- `vmware-telco-cloud-platform-5-1.pdf` — per-release doc bundle whose Upgrade Guide chapter
  covers **TCP 5.1** only.
- `vmware-telco-cloud-automation-3-3-0-1.pdf` — full TCA 3.3.0.1 guide (TCA target for TCP 5.0.2),
  used only for its "Migrating from Photon OS 3 to Photon OS 5" and Kubernetes
  upgrade-compatibility chapters (see the Kubernetes / Photon OS caveats above).
- `vmware-telco-cloud-automation-3-4.pdf` — full TCA 3.4 guide (TCA target for TCP 5.1), same
  chapters, same purpose, for the 5.1-side caveats.

Broadcom's PDF filenames encode the *doc bundle* release, not necessarily a single target version
inside it — verify a PDF's actual "This Platform Upgrade Guide describes the process of upgrading
Telco Cloud Platform to release X.Y" sentence before trusting its filename.

## Conventions / gotchas
- **Cache busting:** index.html references style.css/app.js with `?v=N`; app.js imports planner.js
  with `?v=N`; bump N on any JS/CSS change (drifts over time — check index.html for the current
  number, don't trust an old value written here). `data/*.json` fetched with `cache: "no-store"`.
- **The curated `tools/*_text.txt` extracts are NOT the full source — verify against the actual PDF
  before calling something in `data/*.json` invented.** `tools/extract.py`'s `tca`/`tca34` modes
  slice a hand-picked line range out of `pdftotext -layout` output for the Kubernetes-hops chapter.
  Those ranges are narrower than the real chapter: for TCA 3.3.0.1, the curated range ends *before*
  both the "Management Clusters/Workload Cluster Compatibility Cluster Operations" tables (full PDF
  ~line 12040) and the dedicated "Upgrade 2.3 Cluster to 3.3.0.1" / "Upgrade 3.1.1 Cluster to
  3.3.0.1" walkthroughs (full PDF ~line 12858–12908, printed pages 266–268) that several
  `componentCaveats` entries in `paths.json` are actually sourced from. A verification pass that
  only greps the curated `.txt` file will find zero hits for those sections and wrongly conclude the
  caveats are fabricated — they aren't; they're just outside the curated slice. If a `.txt`-based
  check flags something as unsourced/invented, re-run `pdftotext -layout <pdf> -` (or `pdfinfo` +
  `Read` with a `pages` range to view it visually) on the **full** PDF before concluding it's a bug.
  This actually happened during a full-repo audit (2026-07) — two "fabrication" findings were false
  positives from this exact gap.
- **pdftotext -layout table cells that wrap across multiple physical lines are ambiguous — visually
  inspect the PDF page (`Read` with a `pages` range) before trusting a linearized reading.** Found
  during the same audit: several Kubernetes workload hop-chain cells in the TCA compatibility tables
  span 2+ wrapped lines per column, and naively reading the linearized text produced a self-
  contradictory parse (one column's continuation appeared to skip an earlier waypoint another column
  visibly passed through). Rendering the actual PDF page as an image and reading the real table grid
  resolved it in every case and is the more reliable method whenever a table cell wraps.
- CSS MUST keep `[hidden]{display:none!important}` — otherwise `display:flex/grid` overrides the HTML
  `hidden` attribute (this bug made the toolbar show on the landing page).
- All external doc links open a new tab (`target="_blank" rel="noopener"`).
- Content source-of-truth: `tools/upgrade_guide_text.txt` (from the TCP 5.1 PDF) + the version matrix.
- **Core principle (user-enforced): NEVER invent steps, versions, or tables — everything must trace
  to the TCP upgrade guide.** Confirm design choices before building. Prefer generic wording (avoid
  "Tanzu" / "Cloud Director" in UI labels and README).

## Verifying UI changes without chromium-cli/playwright
On at least one machine this repo was worked from, `chromium-cli` wasn't installed and `pip
install playwright` failed (sandboxed, no network egress to PyPI) — but a local Chrome.app was
present. Fallback that worked: launch `Google Chrome.app` headless with
`--headless=new --remote-debugging-port=PORT --user-data-dir=<scratch dir>`, then drive it with a
short pure-stdlib Python script that speaks the Chrome DevTools Protocol directly (HTTP `PUT
/json/new?<url>` to open a tab — note **PUT**, not GET, on recent Chrome; a raw WebSocket client
using only `socket`/`struct`/`base64` for the handshake and frame (un)masking; `Runtime.evaluate`
with `awaitPromise: true` to run an async driver script in-page and get a JSON result back). This
reproduces real DOM events (`dispatchEvent(new Event('change', {bubbles:true}))` on selects/
checkboxes/radios — this app is vanilla JS, not React, so a plain property set + change event is
enough, no synthetic-event library needed) end-to-end, including clicking Generate and reading the
rendered runbook. Check for both `Runtime.exceptionThrown` and `Log.entryAdded` (level `error`)
during the session — ignore a `favicon.ico` 404, that's harmless. If `chromium-cli`/playwright ARE
available next time, prefer those; this is only the no-network fallback.

## Continuing from another computer
1. `git clone https://github.com/tcp-upgrade-tools/tcp-upgrade-planner`
2. Open the folder in Claude Code (this `CLAUDE.md` loads automatically).
3. `python3 -m http.server 8080` to preview; edit; commit; push to `main` → auto-deploys to Pages.
4. You need write access to the `tcp-upgrade-tools` org repo and `gh auth login` (or a PAT) to push.
