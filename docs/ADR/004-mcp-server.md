# 004. Serve MCP from the CLI

## Status

Accepted. Nine tools, all read-only: `gyazo_search`, `gyazo_image`,
`gyazo_image_content`, `gyazo_latest_image`, `gyazo_list`, `gyazo_recent`,
`gyazo_summary`, `gyazo_collection`, `gyazo_collections`. `gyazo_upload`
deliberately not.

## Context

nota/gyazo-mcp-server is the official MCP server for Gyazo, and it works: a
client reached it through a tunnel and searched captures. It is published from
the nota organization, though, which we cannot publish to, so following it
means keeping a fork in step with it.

The CLI already holds everything such a server needs: the access token, the
API client, the cache, and the search that `gyazo search` uses.

## Decision

Serve MCP from this CLI, started with `gyazo --mcp-server` (also `--mcp`,
`mcp-server`, `mcp`), rather than shipping a second executable.

- Dispatched before commander parses. The server owns stdout for the whole
  process, which does not fit inside a command action that shares stdout with
  the usual human-readable output.
- The MCP SDK is required lazily, so every other command keeps its startup
  time.
- Tool names and argument shapes follow nota/gyazo-mcp-server, so a client
  configured against it keeps working when it is pointed here.
- The token is resolved the same way as for every other command, and the
  server exits with a message on stderr when there is none, rather than
  starting and failing every call.

## Metadata, not image bytes

Upstream returns image content as base64, compressing it with sharp to fit.
Trying that from a real client showed the ambition does not pay off: the bytes
are awkward to move through MCP and the model gets little from them that the
metadata does not already say. Gyazo captures carry OCR text, a title, the
application and page they came from, and sometimes a location, which is the
part a model can actually reason about.

So every tool here returns metadata and URLs, and none returns pixels. A
client that wants to show a capture opens the URL in the result. This also
drops sharp from the dependency list entirely.

## Pixels, after all, for one capture at a time

Metadata-only held for lists and searches and turned out to be too strict for
a single capture. The use case that matters is a person walking somewhere
unfamiliar saying "look at this": GPS and OCR give the place and the letters,
not what they are looking at.

`gyazo_image_content` is a separate tool rather than a flag on `gyazo_image`,
so a call that only wants metadata cannot come back with a megabyte. It
returns a width-limited rendition from Gyazo's own resize route, which needs
no credentials, so there is still no image library here. 1024px is about 130 KB
as webp. Over `max_bytes` it refuses and says what to change, rather than
sending something the host will drop.

## Differential retrieval

Four captures in a row, then "look at what I just captured", is not a question
`gyazo_latest_image` can answer. `gyazo_recent` takes a window in minutes, an
explicit `since`, or `after_image_id` as a watermark, and returns what came
after. A watermark that cannot be found is reported: returning everything
walked would read as "all of this is new".

## Read-only by construction

`gyazo_upload` is not implemented and no other tool writes. There is no need
for it yet, and a server that cannot write cannot be talked into writing. Every
tool carries `readOnlyHint`, and a test asserts that the tool list contains
nothing else.

## The same answers as the CLI

`gyazo_list` and `gyazo_summary` take the options their commands take, down to
the defaults, because a client that knows `gyazo list --date 2026-02-20
--photos` should not have to learn a second vocabulary. The names are
snake_case, which is what tool arguments look like: `max_pages`, `use_cache`.

The query behind each one moved into the services, so the command and the tool
call the same function. `listCaptures`, `buildSummary` and `readCollection`
answer the question; the command prints the answer and the tool serialises it.
Copying a query into a second caller is how two callers start disagreeing.

Validation stayed with each caller. Which options contradict each other is the
same question in both places, but the answers differ in kind: the CLI reports
and exits, and a server must not exit over one bad argument. `parseDateOption`
and `parseHourOption` grew non-exiting variants for that reason, and the
exiting ones are now thin wrappers over them.

## Consequences

- The result payload is the fields a model can act on: `image_id`,
  `permalink_url`, `url`, `thumb_url`, `mimeType`, `created_at`, `alt_text`,
  `ocr`, `location`, `metadata`. Absent fields stay absent, and a null field
  counts as absent.
- `location` and `ocr` are read from under `metadata`, which is where Gyazo
  puts them. The top-level `exif_normalized` and `ocr` are null in every
  response this CLI receives, and reading those was why coordinates never
  appeared in any payload. Fixtures written from the shape the code expected
  hid it; they now come from real responses.
- No `uri` field, unlike upstream: it points at an MCP resource, and this
  server does not serve resources yet.
- `gyazo_latest_image` takes no arguments, while upstream declared a `name`
  property on it. Unknown properties are dropped, so a client configured
  against upstream still works.
- The id handling moved to `src/ids.ts`, so the server can turn a URL into an
  ID without loading commander and every command with it.
- The tests speak JSON-RPC to the built CLI over a pipe against a stub API, so
  they cover the framing as well as the tool. CI additionally runs a handshake
  against a production install with hoisting turned off, because `--mcp-server`
  is the only path that loads the SDK.
