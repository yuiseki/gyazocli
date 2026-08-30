# @yuiseki/gyazocli

Gyazo Memory CLI for AI Secretary.

## Install

```bash
npm i -g @yuiseki/gyazocli
```

## Usage

```bash
gyazo config set token your_personal_gyazo_access_token_here
gyazo sync --days 10
gyazo --help
```

### Shorthands

The first argument may stand on its own when it is unambiguous. A Gyazo
image ID is 32 hex characters, so it can never be mistaken for a path.

```bash
gyazo path/to/image.png                              # same as: gyazo upload path/to/image.png
gyazo 49a008e2f254f513063b6ec4d3082940               # same as: gyazo get 49a008e2f254f513063b6ec4d3082940
gyazo https://gyazo.com/49a008e2f254f513063b6ec4d3082940   # same as above
```

Subcommand names always win, so `gyazo search` stays `gyazo search` even
if a file of that name exists in the working directory.

### Detail

- `gyazo config set token <token>`: Save your access token
- `gyazo config get token|me`: Show saved token (masked) or `me` profile info
- `gyazo ls` (`gyazo list`): List images (`--date`/`--today`, `--photos`, `--uploaded`, `-H` available; `--photos/--uploaded` can be combined with `--date`/`--today`)
- `gyazo search <query>`: Search images
- `gyazo get <image_id|url>`: Show image details (`--ocr`, `--objects`, `-j` available). Accepts a bare image ID, a `https://gyazo.com/<id>` permalink, or a `https://i.gyazo.com/<id>.png` URL
- `gyazo apps|domains|tags|locations`: Show rankings
- `gyazo summary`: Show day-by-day weekly summary in Markdown (`##`/`###` headings, image count, apps, domains, tags, locations per day)
- `gyazo stats`: Show weekly summary
- `gyazo upload [path]`: Upload an image (uses stdin when path is omitted). Prints the permalink URL alone; use `-j` for the full response
- `gyazo sync`: Sync cache

Date range notes:
- Default range for `apps|domains|tags|locations|stats` is from 8 days ago to yesterday
- Use `--today` for today only, or `--date <yyyy|yyyy-mm|yyyy-mm-dd>` for a custom range

JSON output:
- `-j, --json` is available for `config get`, `ls`, `get`, `search`, `apps`, `domains`, `tags`, `locations`, `summary`, and `upload`

Exit codes:
- `0` on success, `1` on a usage error or a failed API call

Environment variables:
- `GYAZO_ACCESS_TOKEN`: access token (takes precedence over the saved config)
- `GYAZO_CACHE_DIR`: cache location
- `GYAZO_API_ORIGIN` / `GYAZO_UPLOAD_ORIGIN`: override the API endpoints (used by the test suite)

## Development

### Build

```bash
npm install
npm run build
```

### Test

```bash
npm test
```

### Link local CLI with npm link

```bash
# from this repository root
npm link

# verify linked command
gyazo --version
```

Unlink when finished:

```bash
npm unlink -g @yuiseki/gyazocli
```
