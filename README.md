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

### Detail

- `gyazo config set token <token>`: Save your access token
- `gyazo config get token|me`: Show saved token (masked) or `me` profile info
- `gyazo ls` (`gyazo list`): List images (`--date`/`--today`, `--photos`, `--uploaded`, `-H` available; `--photos/--uploaded` can be combined with `--date`/`--today`)
- `gyazo search <query>`: Search images
- `gyazo get <image_id>`: Show image details (`--ocr`, `--objects`, `-j` available)
- `gyazo apps|domains|tags|locations`: Show rankings
- `gyazo stats`: Show weekly summary
- `gyazo upload [path]`: Upload an image (uses stdin when path is omitted)
- `gyazo sync`: Sync cache

Date range notes:
- Default range for `apps|domains|tags|locations|stats` is from 8 days ago to yesterday
- Use `--today` for today only, or `--date <yyyy|yyyy-mm|yyyy-mm-dd>` for a custom range

JSON output:
- `-j, --json` is available for `config get`, `ls`, `get`, `search`, `apps`, `domains`, `tags`, and `locations`

## Development

### Build

```bash
npm install
npm run build
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
