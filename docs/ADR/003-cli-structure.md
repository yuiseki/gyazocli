# ADR 003: CLI Command Structure and Interface

## Status
Accepted

## Context
The current `gyazocli` implementation uses flat top-level commands (not nested under `images`). Documentation should reflect the command tree implemented in `src/index.ts`.

## Decision
Adopt and document the existing top-level command structure.

### 1. Program Metadata
- Binary name: `gyazo`
- Version: `1.0.0`
- Description: `Gyazo Memory CLI for AI Secretary`

### 2. Commands
- `gyazo config set <key> <value>`
  - Currently supported key: `token`
- `gyazo config get <key>`
  - `token` is masked
  - `me` fetches `/api/users/me`
  - Options:
    - `-j, --json`
- `gyazo list` (alias: `gyazo ls`)
  - Options:
    - `-p, --page <number>` (default: `1`)
    - `-l, --limit <number>` (default: `20`)
    - `-j, --json`
    - `-H, --hour <yyyy-mm-dd-hh>` (reads hourly cache only)
    - `--photos` (alias of `search has:location`)
    - `--uploaded` (alias of `search gyazocli_uploads`)
    - `--no-cache`
- `gyazo get <image_id>`
  - Options:
    - `-j, --json`
    - `--ocr`
    - `--objects`
    - `--no-cache`
- `gyazo search [query]`
  - Options:
    - `-j, --json`
    - `--no-cache`
- `gyazo apps`
  - Default range: from 8 days ago to yesterday
  - Options:
    - `--date <yyyy|yyyy-mm|yyyy-mm-dd>`
    - `--today` (target today only)
    - `-l, --limit <number>` (default: `10`, max: `10`)
    - `--max-pages <number>` (default: `10`)
    - `-j, --json`
    - `--no-cache`
- `gyazo domains`
  - Default range: from 8 days ago to yesterday
  - Options:
    - `--date <yyyy|yyyy-mm|yyyy-mm-dd>`
    - `--today` (target today only)
    - `-l, --limit <number>` (default: `10`, max: `10`)
    - `--max-pages <number>` (default: `10`)
    - `-j, --json`
    - `--no-cache`
- `gyazo tags`
  - Default range: from 8 days ago to yesterday
  - Options:
    - `--date <yyyy|yyyy-mm|yyyy-mm-dd>`
    - `--today` (target today only)
    - `-l, --limit <number>` (default: `10`, max: `10`)
    - `--max-pages <number>` (default: `10`)
    - `-j, --json`
    - `--no-cache`
- `gyazo stats`
  - Default range: from 8 days ago to yesterday
  - Default behavior: weekly Markdown summary.
  - Options:
    - `--date <yyyy|yyyy-mm|yyyy-mm-dd>` (window end date anchor; default: yesterday)
    - `--days <number>` (default: `7`)
    - `--top <number>` (default: `10`)
    - `--max-pages <number>` (default: `10`)
    - `--no-cache`
- `gyazo upload [path]`
  - Options:
    - `--title <title>`
    - `--app <app>` (default: `gyazocli`)
    - `--url <url>`
    - `--timestamp <unix_timestamp>`
    - `--desc <desc>` (`#gyazocli_uploads` is always appended)
- `gyazo sync`
  - Options:
    - `--days <number>` (default: `1`, used when `--date` is omitted)
    - `--date <yyyy|yyyy-mm|yyyy-mm-dd>`
    - `--max-pages <number>` (default: `10`)
- `gyazo import <type> <dir>`
  - Supported types: `json`, `hourly`

### 3. Output and Behavior Notes
- `-j, --json` is available on `config get`, `list`, `get`, `search`, `apps`, `domains`, and `tags`.
- There are no global `--plain` or `--verbose` flags in current implementation.
- Authenticated commands call token resolution before API access.

## Consequences
- Docs now match the command UX shipped in code.
- Users can rely on CLI help output and docs without cross-project noise.
