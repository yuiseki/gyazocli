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

### 4. Hourly Metadata Extract Cache Layout
- Path patterns:
  - `<cacheRoot>/hourly/<YYYY>/<MM>/<DD>/<HH>-apps.json`
  - `<cacheRoot>/hourly/<YYYY>/<MM>/<DD>/<HH>-domains.json`
  - `<cacheRoot>/hourly/<YYYY>/<MM>/<DD>/<HH>-tags.json`
  - `<cacheRoot>/hourly/<YYYY>/<MM>/<DD>/<HH>-locations.json`
- File content:
  - JSON object keyed by `image_id`.
  - Value is string array of extracted metadata tokens for that command.
  - Example:
    - `apps`: `{ "<imageId>": ["Chrome"] }`
    - `domains`: `{ "<imageId>": ["x.com"] }`
    - `tags`: `{ "<imageId>": ["ゆいせきのコーデ", "ゆいせきの自撮り"] }`
    - `locations`: `{ "<imageId>": ["東京都台東区竜泉"] }`
- Purpose:
  - Avoid repeated full image-cache scans when computing rankings.
  - Preserve negative results (`[]`) per image so commands do not re-fetch detail repeatedly.

### 5. Cache Update Behavior in Commands
- `gyazo get <image_id>`:
  - Uses cached detail by default.
  - `--no-cache` forces API fetch and rewrites cache.
- `gyazo list --date <...>`:
  - Reads image IDs from hourly index cache files in the target day/month/year range.
  - If the range has no hourly cache entries, it warms cache from API list pages and then reads from cache.
- `gyazo sync`:
  - Fetches list pages (`per_page=100`) for a bounded date range.
  - Skips detail fetch when cached record already has `ocr`.
  - Writes/merges hourly index files.
- `gyazo apps`, `gyazo domains`, `gyazo tags`, `gyazo locations`:
  - Default target range is from 8 days ago to yesterday.
  - `--today` targets only today.
  - `--date` can target a specific day/month/year.
  - With default cache mode:
    - Read ranking from hourly metadata extract caches for fast aggregation.
    - If `<HH>-*.json` is missing but `<HH>.json` exists, build it once from image cache and persist.
    - If the target range has no hourly cache data, run API-based warming once, then read from cache.
  - With `--no-cache`:
    - Force API-based warming by scanning list pages (`per_page=100`) in the target date range.
    - Update both hourly image index (`<HH>.json`) and hourly metadata extract caches (`<HH>-*.json`).
    - Ranking is computed from warmed image cache data for that run (no historical cache merge).
- `gyazo stats`:
  - Default window is from 8 days ago to yesterday (`7` days), output is Markdown.
  - Section rows are rendered as bullet lists (`- <label>: <count>`), not tables.
  - Aggregates upload time bands and rankings of apps/domains/tags from hourly caches.
  - Uses the same hourly metadata extract cache mechanism as ranking commands.
  - If cache data for the target window is absent, warming is triggered once, then summary is built from cache.
- `gyazo summary`:
  - Default window is from 8 days ago to yesterday (`7` days).
  - Outputs day-by-day Markdown sections with `image count` plus rankings of apps/domains/tags/locations.
  - Uses hourly index cache to discover images per day, then builds rankings from image cache records.
  - If image-cache metadata is insufficient, warming via list/detail fetch is triggered through ranking warmers.

## Consequences
- Cache is portable and independent from the repository working tree.
- Large historical datasets remain manageable on filesystem.
- Ranking commands become significantly faster on repeated runs due to hourly extracted metadata cache.
- Cache freshness depends on command behavior (`get --no-cache`, `sync`, and ranking command warming).
