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
gyazo https://gyazo.com/collections/21ca16a1023c667a7a437be561a65018  # same as: gyazo collection <id>
```

A collection ID is 32 hex characters just like an image ID, so a bare ID is read
as an image. Only the `/collections/<id>` URL form is unambiguous. When a command
is given the wrong kind of ID it points at the other one.

Subcommand names always win, so `gyazo search` stays `gyazo search` even
if a file of that name exists in the working directory.

### Detail

- `gyazo config set token <token>`: Save your access token
- `gyazo config get token|me`: Show saved token (masked) or `me` profile info
- `gyazo ls` (`gyazo list`): List images (`--date`/`--today`, `--photos`, `--uploaded`, `-H` available; `--photos/--uploaded` can be combined with `--date`/`--today`)
- `gyazo search <query>`: Search images
- `gyazo collection <collection_id|url>` (`col`, `cols`, `collections`): Show a collection and the images in it (`--sort added|created|captured`, `-A`, `-j` available)
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

### Anonymous access

A Gyazo ID is long enough to act as the key to the image, so public images and
collections read fine with no token. An access token, on the other hand, allows
things this CLI does not expose (deleting, for one), so the way to give an agent
read-only access is to give it no token at all.

```bash
gyazo collection <id>               # uses the token if there is one, otherwise reads anonymously
gyazo collection <id> --anonymous   # ignores the token even when one is configured
```

Anonymous reads have limits worth knowing:

- A collection or image set to `only_me` returns 404, indistinguishable from one
  that does not exist. That is deliberate: it keeps the ID from confirming what
  exists.
- An image with `metadata_is_public: false` still returns 200, but `metadata` and
  `created_at` come back `null`, so OCR, EXIF and location are gone. The web
  endpoint withholds these even from the owner's token; `gyazo get` uses
  `api.gyazo.com` for that reason.

Exit codes:
- `0` on success, `1` on a usage error or a failed API call

Environment variables:
- `GYAZO_ACCESS_TOKEN`: access token (takes precedence over the saved config)
- `GYAZO_CACHE_DIR`: cache location
- `GYAZO_API_ORIGIN` / `GYAZO_UPLOAD_ORIGIN` / `GYAZO_WEB_ORIGIN`: override the endpoints (used by the test suite)

## MCP server

`gyazo --mcp-server` runs the CLI as a Model Context Protocol server over
stdio, so an MCP client can search your captures. `--mcp`, `mcp-server` and
`mcp` start the same thing.

```bash
gyazo --mcp-server
```

It needs an access token before it starts, from `gyazo config set token` or
from `GYAZO_ACCESS_TOKEN` in the client's environment. stdout carries only
JSON-RPC; anything meant for a human goes to stderr.

Configured in a client:

```json
{
  "mcpServers": {
    "gyazo": {
      "command": "npx",
      "args": ["-y", "@yuiseki/gyazocli", "--mcp-server"],
      "env": { "GYAZO_ACCESS_TOKEN": "your_access_token" }
    }
  }
}
```

### Query syntax

Bare words match the OCR text, title and description. These operators were
checked against the live API, each with a value that should match, reading the
results back from the detail endpoint to confirm the filter had applied:

| Operator | Matches |
| --- | --- |
| `has:exif` | photographs rather than screenshots |
| `has:location` | captures with coordinates |
| `address:広島`, `address:Hiroshima`, `address:730-0041` | the reverse-geocoded address of a capture with GPS, in any language or case, postal codes included |
| `app:"Gyazo Android"` | the application the capture came from |
| `title:`, `url:`, `desc:` | the page it was captured from |
| `ocr:` | the text in the image |
| `type:png` | the file type |
| `since:2026-08-30 until:2026-08-31` | the upload date |
| `-address:広島` | negation |
| `OR` | alternation; terms are ANDed otherwise |

To narrow to photographs, reach for `has:exif`. The application does not tell
them apart: `app:"Gyazo Android"` includes screenshots and screen recordings
from the same phone, and one page of `app:"Gyazo Android" -has:exif` came back
as 68 gif and 30 png against 2 jpg.

`has:exif` and `has:location` overlap without either containing the other. A
photo taken indoors has EXIF and no coordinates; 86 captures here carry
coordinates without the EXIF flag. `has:exif OR has:location` is the widest
reading of "a photo".

There is no coordinate or radius search. `location:`, `geo:`, `near:`,
`bbox:`, `city:`, `lat:` and the like all return nothing, exactly as an
invented operator does, so search by place with `address:`.

### Tools

- `gyazo_search`: full-text search over your captures. Arguments: `query`
  (required, up to 200 characters), `page` (default 1), `per` (default 20,
  max 100), `include_location`. See the query syntax below.
- `gyazo_image`: metadata for one capture. Argument: `id_or_url` (required),
  which accepts a bare 32-character ID, a `https://gyazo.com/<id>` permalink or
  a direct image URL.
- `gyazo_latest_image`: metadata for the capture uploaded most recently. No
  arguments.
- `gyazo_list`: the captures, newest first, with the same options as
  `gyazo list`: `page`, `limit`, `date`, `today`, `hour`, `photos`, `uploaded`,
  `max_pages`, `use_cache`. No arguments means the most recent page.
- `gyazo_summary`: what a day or a range adds up to, with the same options as
  `gyazo summary`: `date`, `today`, `limit`, `max_pages`, `use_cache`. No
  arguments means the week up to yesterday.
- `gyazo_recent`: what arrived since a moment or since a capture you have
  already seen. Arguments: `minutes`, `since`, `after_image_id`, `limit`,
  `max_pages`. No arguments means the last 30 minutes.
- `gyazo_collection`: a collection and the captures in it. Arguments:
  `id_or_url` (required), `sort` (`added`, `created` or `captured`), `page` and
  `per`. Reports `total_image_count`, `returned_image_count` and `truncated`.
- `gyazo_collections`: the collections, with their IDs, filtered by `query`
  against their names.
- `gyazo_image_content`: the pixels of one capture, as image content.
  Arguments: `id_or_url` (required), `width` (default 1024), `format`
  (`webp` or `jpeg`) and `max_bytes`.

All of them are read-only. Everything except `gyazo_image_content` returns
metadata rather than image bytes: URLs, timestamps, OCR text, title, source
application and page, and location when the capture carries one. URLs, timestamp, OCR text, title, source application and page, and
location when the capture carries one. A capture with a location gets a `location` holding
`latitude`, `longitude`, `country_code` and an address in Japanese and
English, each with its `locality` and `admin1`, plus `altitude_m` and
`heading_deg` where the response carries the raw EXIF, which is the case for
captures read through a collection. `captured_at` is when the shutter was
pressed, as distinct from the upload time in `created_at`.

For the pixels, `gyazo_image_content` returns a width-limited rendition, one
capture at a time. Returning image bytes from the list and search tools is
what made this awkward in practice, so those stay metadata-only.

Tool names and arguments follow
[nota/gyazo-mcp-server](https://github.com/nota/gyazo-mcp-server), so a client
already configured against that server can point at this one instead. Its
`gyazo_upload` is deliberately absent: nothing here can write to your Gyazo
account until there is a reason for it to.

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

### Release

Push a `v*` tag and Actions stages the package on npm, where a maintainer
approves it with 2FA. See [RELEASE.md](RELEASE.md).

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
