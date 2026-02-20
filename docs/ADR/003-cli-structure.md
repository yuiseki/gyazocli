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
  - Currently supported key: `token` (masked output)
- `gyazo list` (alias: `gyazo ls`)
  - Options:
    - `-p, --page <number>` (default: `1`)
    - `-l, --limit <number>` (default: `20`)
    - `-j, --json`
    - `-H, --hour <yyyy-mm-dd-hh>` (reads hourly cache only)
- `gyazo get <image_id>`
  - Options:
    - `-j, --json`
    - `--no-cache`
- `gyazo search <query>`
  - Options:
    - `-j, --json`
- `gyazo sync`
  - Options:
    - `--days <number>` (default: `1`)
    - `--max-pages <number>` (default: `10`)
- `gyazo import <type> <dir>`
  - Supported types: `json`, `hourly`

### 3. Output and Behavior Notes
- `-j, --json` is available only on `list`, `get`, and `search`.
- There are no global `--plain` or `--verbose` flags in current implementation.
- Authenticated commands call token resolution before API access.

## Consequences
- Docs now match the command UX shipped in code.
- Users can rely on CLI help output and docs without cross-project noise.
