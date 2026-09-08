# 005. Module layout

## Status

Accepted.

## Context

`src/index.ts` had grown to about 2950 lines. It held the commander
definitions for sixteen commands, and underneath them the text formatting, the
date handling, the cache walks, the rankings and the printers. Finding the code
behind a command meant scrolling, and two unrelated concerns often sat a few
lines apart.

The tests made the move safe: all of them spawn the built CLI and assert on its
output, so nothing here depends on the internal shape, and a behaviour change
during the move would fail them.

## Decision

```
src/
  index.ts              commander definitions, and the entry dispatch
  api.ts                HTTP against Gyazo
  storage.ts            reading and writing the cache files
  config.ts             environment
  credentials.ts        the access token
  ids.ts                image and collection IDs out of what was typed
  options.ts            numeric option validation
  format.ts             reading and presenting the fields of an image
  dates.ts              local days, ranges, hourly bucket keys
  mcp.ts                the MCP server
  services/
    memory.ts           the cache, and the API walks that fill it
    analytics.ts        rankings, summaries, the stats markdown
    images.ts           showing captures, and the upload helpers
    collections.ts      collections
```

Dependencies run one way: `services/` may use the modules above it, and
nothing above `services/` reaches back down into it. Within `services/`,
`analytics` and `images` may use `memory`, and `collections` may use `images`.

Two placements are worth recording, because they were both the second attempt.
`mergeImageForDisplay` and `shouldEnrichForLocationDisplay` sound like display
code but live in `format.ts`: the cache walks need them too, and leaving them
with the printers made `memory` and `images` depend on each other in both
directions. `parsePositiveIntegerOption` is its own module rather than part of
either `dates` or `index`, because the date handling and the commands both use
it and it reports failure by exiting.

## Consequences

- `index.ts` is about 1180 lines and is almost entirely command definitions.
- `noUnusedLocals` and `noUnusedParameters` are on. The move left dozens of
  imports behind for functions that were no longer there, and that class of
  leftover should fail the build.
- The MCP server no longer reaches into the command file for ID handling; it
  imports `ids.ts` like everything else.
- A command's implementation is now spread over more files than before. The
  commander definition stays the place to start reading, and it names what it
  calls.
