# Research Knowledge Dashboard Online

Public, read-only GitHub Pages snapshot of the Local Research Knowledge Dashboard.

Live URL: <https://benzkanin41-alt.github.io/research-knowledge-dashboard/>

## Safety contract

- Local Dashboard is authoritative and must not be edited by this project.
- Export reads a temporary SQLite backup and a temporary copy of the Local runtime.
- The public snapshot keeps all investor-facing screens and text.
- Absolute local paths, session tokens, source hashes, SQLite files, OCR caches, and original PDF/MD files are excluded.
- Prices are SET snapshots captured at deploy time.
- No scheduled deployment is configured. Publish only after an explicit user instruction.

## Build and validation

```powershell
.\publish_online.ps1 -LocalRoot $env:RESEARCH_DASHBOARD_LOCAL_ROOT -BuildOnly
```

## Publish after explicit approval

```powershell
.\publish_online.ps1 -LocalRoot $env:RESEARCH_DASHBOARD_LOCAL_ROOT
```

The generated website is kept under `work/site` locally and is pushed as a replaceable `snapshot` branch. The `main` branch contains only the exporter, validation tools, and the Pages workflow.
