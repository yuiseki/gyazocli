# ADR 002: Caching Strategy and Storage Structure

## Status
Accepted

## Context
`gyazocli` caches image detail and hourly indices on local disk so repeated lookups avoid unnecessary API calls and historical lookups can be served quickly.

## Decision
Store cache files under XDG-style user cache location by default, with an environment override.

### 1. Cache Root
`getCacheDir()` resolves cache root as:
1. `GYAZO_CACHE_DIR` (if set)
2. `${XDG_CACHE_HOME}/gyazocli` (if `XDG_CACHE_HOME` is set)
3. `~/.cache/gyazocli`

### 2. Image Cache Layout
- Path pattern: `<cacheRoot>/images/<firstChar>/<secondChar>/<imageId>.json`
- Example: `~/.cache/gyazocli/images/a/1/a1b2c3d4.json`
- Purpose: Avoid a single large flat directory.

### 3. Hourly Index Layout
- Path pattern: `<cacheRoot>/hourly/<YYYY>/<MM>/<DD>/<HH>.json`
- File content: JSON array of image IDs for that hour.
- Used by `gyazo list --hour <yyyy-mm-dd-hh>`.

### 4. Cache Update Behavior in Commands
- `gyazo get <image_id>`:
  - Uses cached detail by default.
  - `--no-cache` forces API fetch and rewrites cache.
- `gyazo sync`:
  - Fetches list pages (`per_page=100`) for a bounded date range.
  - Skips detail fetch when cached record already has `ocr`.
  - Writes/merges hourly index files.

## Consequences
- Cache is portable and independent from the repository working tree.
- Large historical datasets remain manageable on filesystem.
- Cache freshness depends on command behavior (`get --no-cache` and `sync`).
