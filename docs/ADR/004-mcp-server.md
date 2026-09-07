# 004. Serve MCP from the CLI

## Status

Accepted. `gyazo_search` implemented; the remaining tools are not.

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

## Consequences

- The result payload is the fields a model can act on: `image_id`,
  `permalink_url`, `url`, `thumb_url`, `mimeType`, `created_at`, `alt_text`,
  `ocr`, `metadata`. Absent fields stay absent.
- No `uri` field, unlike upstream: it points at an MCP resource, and this
  server does not serve resources yet.
- `gyazo_image`, `gyazo_latest_image` and `gyazo_upload` are not implemented.
  Upstream also compresses image content with sharp, which is a heavier
  dependency than this CLI wants for now.
- The tests speak JSON-RPC to the built CLI over a pipe against a stub API, so
  they cover the framing as well as the tool. CI additionally runs a handshake
  against a production install with hoisting turned off, because `--mcp-server`
  is the only path that loads the SDK.
