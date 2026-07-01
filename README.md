# VMware Telco Cloud Platform — Upgrade Planner

The **TCP Upgrade Planner** is a self-contained, static web tool that generates a guided,
**step-by-step upgrade runbook** for **VMware Telco Cloud Platform (TCP)**. Pick your source and
target version and the components you run, and get the upgrade phases in the correct order — with
detailed guidance, warnings, snapshot/backup reminders, and deep links to the official Broadcom
Techdocs.

Look and feel is inspired by the [VCF Upgrade Planner](https://vmware.github.io/vcf-upgrade-planner/index.html),
with an added sticky progress sidebar, per-step completion tracking, a component version matrix, and
a print/export-to-PDF view.

## Features

- **Workload aware** — separate ordered sequences for **CNF** and **VNF** workloads.
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

> ⚠️ This planner is an aid. **Always confirm against the official Broadcom Techdocs** before
> executing an upgrade.

## Deploy

Pushing to `main` publishes the repo root to **GitHub Pages** via
`.github/workflows/pages.yml`. Enable Pages (Settings → Pages → Source: GitHub Actions) once.
