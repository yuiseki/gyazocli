# 004. Serve MCP from the CLI

## Status

Accepted. `gyazo_search`, `gyazo_image` and `gyazo_latest_image` implemented,
all read-only and all metadata only. `gyazo_upload` deliberately not.

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

## Read-only by construction

`gyazo_upload` is not implemented and no other tool writes. There is no need
for it yet, and a server that cannot write cannot be talked into writing. Every
tool carries `readOnlyHint`, and a test asserts that the tool list contains
nothing else.

## Consequences

- The result payload is the fields a model can act on: `image_id`,
  `permalink_url`, `url`, `thumb_url`, `mimeType`, `created_at`, `alt_text`,
  `ocr`, `metadata`, `exif_normalized`. Absent fields stay absent.
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
