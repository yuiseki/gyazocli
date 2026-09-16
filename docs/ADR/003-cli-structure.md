# ADR 003: CLI Command Structure and Interface

## Status
Accepted

## Context
The current `gyazocli` implementation uses flat top-level commands (not nested under `images`). Documentation should reflect the command tree implemented in `src/index.ts`.

The commands are defined in `src/index.ts`; what they call lives in the modules described in [ADR 005](005-module-layout.md).

## Decision
Adopt and document the existing top-level command structure.

### 1. Program Metadata
- Binary name: `gyazo`
- Version: `0.9.0`
- Description: `Gyazo Memory CLI for AI Secretary`

### 2. Commands
- `gyazo config set <key> <value>`
  - Currently supported key: `token`
  - Options:
    - `--no-verify` (save a token without checking it against the API first)
  - A token is checked against `/api/users/me` before it is saved, and nothing
    is written when Gyazo rejects it
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
    - `--date <yyyy|yyyy-mm|yyyy-mm-dd>` (reads date range from hourly cache; warms from API if needed)
    - `--today` (target today only)
    - `--max-pages <number>` (default: `100`, used for `--date`/`--today` warming)
    - `--photos` (alias of `search has:location`, can be combined with `--date`/`--today`)
    - `--uploaded` (alias of `search gyazocli_uploads`, can be combined with `--date`/`--today`)
    - `--no-cache`
- `gyazo get <image_id>`
  - Options:
    - `-j, --json`
    - `--ocr`
    - `--objects`
    - `--no-cache`
- `gyazo search [query]`
  - Options:
    - `-p, --page <number>` (default: `1`)
    - `-l, --limit <number>` (default: `20`)
    - `-j, --json`
    - `--no-cache`
- `gyazo triage [query]`
  - Markdown for reading a search result capture by capture: the image ID as
    `#`, one `##` heading per field it carries, captures separated by `---`
  - Options:
    - `-q, --query <query>` (the query, also accepted as a bare argument)
    - `-p, --page <number>` (default: `1`)
    - `-l, --limit <number>` (default: `20`)
    - `--color <auto|always|never>` (default: `auto`, meaning a terminal)
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
- `gyazo locations`
  - Default range: from 8 days ago to yesterday
  - Options:
    - `--date <yyyy|yyyy-mm|yyyy-mm-dd>`
    - `--today` (target today only)
    - `-l, --limit <number>` (default: `10`, max: `10`)
    - `--max-pages <number>` (default: `10`)
    - `-j, --json`
    - `--no-cache`
- `gyazo summary`
  - Default range: from 8 days ago to yesterday
  - Shows day-by-day Markdown sections (`### YYYY-MM-DD`) with:
    - `image count`
    - rankings of apps/domains/tags/locations
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
  - Section rows are rendered as bullet lists (`- <label>: <count>`) for terminal readability.
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
    - `--query <query>` (fill from a search instead of the listing; not with
      `--date` or `--days`, because the range belongs inside the query)
    - `--refresh` (fetch every capture again, even one already cached)
    - `--continue` (resume the last walk of this query, with `--query`)
- `gyazo import <type> <dir>`
  - Supported types: `json`, `hourly`

### 3. Output and Behavior Notes
- Timestamps are printed on the reader's own clock. The API sends UTC, and
  until 2026-09-16 the display lifted the digits out of the string, so a
  capture taken at 18:09 in Tokyo was listed as 09:09. The `--date`, `--hour`
  and `--today` filters were always local; only the display was wrong.
- `-j, --json` is available on `config get`, `list`, `get`, `search`, `apps`, `domains`, `tags`, `locations`, and `summary`.
- `summary` default output is Markdown with headings (`## Gyazo Summary`, `### YYYY-MM-DD`) and nested bullet lists.
- There are no global `--plain` or `--verbose` flags in current implementation.
- Authenticated commands call token resolution before API access.

## Consequences
- Docs now match the command UX shipped in code.
- Users can rely on CLI help output and docs without cross-project noise.
