# Versora

[![CI](https://github.com/ClearLotus001/Versora/actions/workflows/ci-review-gates.yml/badge.svg)](https://github.com/ClearLotus001/Versora/actions/workflows/ci-review-gates.yml)
[![Latest release](https://img.shields.io/github/v/release/ClearLotus001/Versora?display_name=tag)](https://github.com/ClearLotus001/Versora/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4)](https://github.com/ClearLotus001/Versora/releases/latest)
[![License](https://img.shields.io/github/license/ClearLotus001/Versora)](./LICENSE)

[中文](./README.md) · [English](./README.en.md)

**See every change clearly.** Versora is an open-source file comparison tool for Windows. It brings text files, Excel workbooks, Git versions, and SVN revisions into one review workspace.

Use it to compare two local files directly or let it detect the version-control source on each side. You can inspect history, working-copy changes, and line attribution without switching tools.

## Get Versora

Download the latest Windows installer from [GitHub Releases](https://github.com/ClearLotus001/Versora/releases/latest). The installed app includes:

- English and Simplified Chinese interfaces
- In-app update checks, downloads, and installation
- Optional TortoiseSVN external Diff Viewer integration

## Quick start

After installing and launching Versora, choose a workflow from the home screen:

| Entry point | Use it for | What Versora does |
|---|---|---|
| **Open working-copy file** | Review one versioned or local file | Detect its source; compare repository and working-copy content, or open local content directly |
| **Compare two files** | Compare any two local text files or workbooks | Detect each side independently; both files must have the same extension |
| **Connect to TortoiseSVN** | Open diffs directly from TortoiseSVN | Configure all-file, text-only, or workbook-only integration |

In the diff view, switch layouts, search content, and navigate change hunks. When a file comes from Git or SVN, the header revision picker also lets you browse its history.

Each comparison opens in its own file tab. Switch or close comparisons in the tab bar; returning to a file restores its revisions, search, layout, scroll position, and worksheet state without reloading. **New comparison** and **Home** let you open more files while keeping existing tabs.

## Features

### Text comparison

- Unified, side-by-side, and stacked layouts
- Line-level and character-level diff highlighting
- Syntax highlighting and visible whitespace
- Unchanged-region folding, full-text search, go-to-line, and hunk navigation
- Text selection, copying, and line-range actions
- Git/SVN source indicators and line attribution

### Excel workbook comparison

- A purpose-built grid for `.xlsx`, `.xlsm`, `.xltx`, and `.xltm`
- Sheet, row, column, cell, and formula changes
- Strict and content modes to preserve or ignore whitespace-only differences
- Formula bar, frozen panes, hidden rows and columns, sheet tabs, and diff-region navigation
- Minimap and multiple workbook layouts
- Rust-accelerated parsing and diff computation
- Virtual scrolling and on-demand rendering for smooth navigation through large comparisons

### Git, SVN, and local files

| Source | Default comparison | History | Line attribution |
|---|---|---|---|
| Git working-tree file | Repository version ↔ working tree | File commits, `HEAD`, working tree | Git blame |
| SVN working copy | Repository revision ↔ working copy | Revision history, working copy | SVN blame |
| Plain local file | Use the selected local content directly | Unavailable | Hidden |

Each side of a two-file comparison is detected independently. For example, a Git revision can be compared with a plain local file, or both sides can browse their own histories.

> **Safety boundary:** All Git operations are read-only. Versora does not run `checkout`, `add`, `commit`, or `reset`, and it does not mutate repository state.

## Usage

### Review a working-copy file

1. Select **Open working-copy file** on the home screen.
2. Choose a Git, SVN, or plain local file.
3. Wait for Versora to detect the source and prepare the default comparison.
4. Use the header revision picker to browse history. It remains hidden for plain local files.

### Compare two local files

1. Select **Compare two files** on the home screen.
2. Drop or choose the base and comparison files.
3. Make sure they have the same extension and are not the same file.
4. Select **Compare files**.

If either side belongs to a Git repository or SVN working copy, Versora keeps history switching available for that side.

### Connect to TortoiseSVN

Select **Connect to TortoiseSVN** on the installed Windows app's home screen, then choose all-file, text-only, or workbook-only integration. Matching comparisons launched from TortoiseSVN will then open directly in Versora.

Opening diffs for different files from **Show log** adds tabs in the same window and preserves existing comparisons. Tabs remain available until you close them or exit the app.

## Support and scope

| Area | Current support |
|---|---|
| Operating system | Windows |
| Interface languages | English, Simplified Chinese |
| Text | Locally readable text files; two-file comparison requires matching extensions |
| Workbooks | OOXML formats: `.xlsx`, `.xlsm`, `.xltx`, `.xltm` |
| Version control | Git working trees, SVN working copies, and revision history |
| External integration | TortoiseSVN Diff Viewer |

Versora currently focuses on **reviewing changes**. Directory-tree comparison, three-way comparison, editable merging, automatic conflict resolution, and repository write operations are outside the current scope.

## Local development

### Requirements

- Windows
- Node.js 24+
- npm
- Rust stable for workbook parsing and comparison, full verification, and Windows installer builds

Desktop workbook comparison uses Rust with indexed disk storage and on-demand reads. `npm run dev:app` requires the native parser before startup; it builds missing artifacts and stops with an error if the build fails.

### Start the development app

```bash
git clone https://github.com/ClearLotus001/Versora.git
cd Versora
npm ci
npm run dev:app
```

`dev:app` checks or builds the workbook parser before starting Vite, Electron, and watch compilation for the Electron main process.

npm 12 requires approval before running dependency install scripts. This project approves Electron and esbuild in `package.json`. If dependencies were installed before those approvals and startup reports `Electron failed to install correctly`, run `npm rebuild electron esbuild`, then restart `npm run dev:app`.

### Common commands

| Command | Purpose |
|---|---|
| `npm run dev:app` | Start the complete desktop development environment |
| `npm run verify:static` | Run ESLint, unused-export checks, and TypeScript checks |
| `npm run test:workbook:unit` | Run Node tests that do not require Rust artifacts |
| `npm run test:workbook:rust` | Build native artifacts and run Rust integration tests |
| `npm run test:e2e` | Run Playwright end-to-end tests |
| `npm run verify:ci` | Reproduce CI static checks, Rust checks, tests, and the app build |
| `npm run build:app` | Build the renderer and Electron main process |
| `npm run build:win` | Build the Windows installer and update assets |

## Architecture

Versora separates content sourcing from comparison and rendering:

```text
Local files  ─┐
Git objects   ─┼─> source materialization ─> DiffData ─> text/workbook analysis ─> viewer
SVN revisions ─┤
External CLI  ─┘
```

The primary stack is Electron, React, TypeScript, Vite, Tailwind CSS, Rust, and Playwright.

```text
Versora/
├── electron/       # Electron main process, Git/SVN sources, installer, updates
├── shared/         # Contracts shared by main and renderer processes
├── src/            # React UI, text viewer, and workbook viewer
├── rust/           # Workbook parsing and comparison
├── tests/          # Unit, contract, and end-to-end tests
├── scripts/        # Build, verification, and release scripts
└── docs/           # Architecture and visual-semantics documentation
```

Further reading:

- [Comparison-source architecture](./docs/comparison-sources.md)
- [Workbook visual semantics](./docs/workbook-visual-semantics.md)

## Contributing

Issues and pull requests are welcome. Before submitting a change:

1. Create a focused branch from `main`.
2. Add or update tests for behavior changes.
3. Run at least `npm run verify:static` and the tests relevant to your change.
4. Use the [pull request template](./.github/pull_request_template.md) to record scope, verification evidence, and rollback details.

## Releases

The version in `package.json` must match the Git tag. Pushing a `v*` tag starts the [Release workflow](./.github/workflows/release.yml), which runs static checks, Node tests, Rust tests, and app builds before publishing the Windows installer and automatic-update assets.

```bash
npm version patch --no-git-tag-version
git add -A
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

## License

Versora is open source under the [MIT License](./LICENSE).
