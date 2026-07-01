# VMware Telco Cloud Platform — Upgrade Planner

A self-contained, static web app that turns the 300+ page **VMware Telco Cloud Platform (TCP)**
documentation into a guided, **step-by-step upgrade runbook**. Pick your edition and source/target
version, and get the components to upgrade in the correct order — with detailed steps, warnings,
snapshot/backup reminders, and deep links to the official Broadcom Techdocs.

Look and feel is inspired by the [VCF Upgrade Planner](https://vmware.github.io/vcf-upgrade-planner/index.html),
with an added sticky progress sidebar, per-step completion tracking, a component version matrix, and
a print/export-to-PDF view.

## Features

- **Edition aware** — separate ordered sequences for **CNF** (Tanzu Kubernetes) and **VNF**
  (Cloud Director Edition) workloads.
- **Source → target selection** 
- **Consolidated steps** — per-component procedures curated from the PDF so you rarely need the
  original guide; every card links back to official docs.
- **Cross-cutting cards** — Pre-Upgrade Checklist + Snapshot/Backup first, Post-Upgrade Checklist last.
- **Progress tracking** — mark steps done; state persists in `localStorage`.
- **Components** view 
- **Upgrade Path** view — all supported source→target routes and important notes.
- **Dark/light theme**, responsive layout, and a clean **Print → PDF** stylesheet.

## Run locally

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

No build step — pure HTML/CSS/ES-module JavaScript with JSON data.

## Project layout

```
index.html
assets/css/style.css
assets/js/app.js          # UI, navigation, state, rendering
assets/js/planner.js      # data loading + plan resolution
data/
  versions.json           # component version matrix per TCP release
  components.json          # component metadata + official doc links
  sequence.json            # ordered upgrade sequence per edition (CNF / VNF)
  paths.json               # supported source→target paths + intermediate hops
  steps.json               # detailed per-component upgrade steps
tools/extract.py          # one-off PDF → text helper used to curate the data
.github/workflows/pages.yml
```

## Data source & accuracy

All content is curated from `vmware-telco-cloud-platform-5-1.pdf` (TCP 5.1 documentation bundle:
Release Notes + Upgrade Guide). The PDF mixes 5.1 release notes with 5.0.2-era upgrade-guide text;
upgrade *procedures* are version-stable while *target versions* were reconciled to 5.1
(e.g. TKG 2.5.4 / Kubernetes 1.33.1, Avi LB 30.2.3.1, AKO 1.13.3, NSX 4.2.2.1, TCA 3.3.0.1).

> ⚠️ This planner is an aid. **Always confirm against the official Broadcom Techdocs** before
> executing an upgrade. Some component deep links point to the product documentation hub where a
> precise per-procedure URL was not available.

To re-extract source text from the PDF:

```bash
python3 tools/extract.py                 # dump the Upgrade Guide region
python3 tools/extract.py "Upgrade NSX"   # dump text around a keyword
```

## Deploy

Pushing to `main` publishes the repo root to **GitHub Pages** via
`.github/workflows/pages.yml`. Enable Pages (Settings → Pages → Source: GitHub Actions) once.
