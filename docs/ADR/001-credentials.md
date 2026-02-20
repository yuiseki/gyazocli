# ADR 001: Credential Management and Configuration

## Status
Accepted

## Context
`gyazocli` needs a credential flow that works in both local shell usage and automation. The implementation currently supports loading values from environment variables and persisting an access token in a local config file.

## Decision
Use `GYAZO_ACCESS_TOKEN` as the primary runtime credential, with a local fallback file for convenience.

### 1. Supported Environment Variables
- `GYAZO_ACCESS_TOKEN`: Personal access token used for API requests.
- `GYAZO_CLIENT_ID`: Parsed from env for future OAuth use (not used by current commands).
- `GYAZO_CLIENT_SECRET`: Parsed from env for future OAuth use (not used by current commands).
- `GYAZO_CACHE_DIR`: Optional cache directory override (used by storage logic).

### 2. `.env` Loading Behavior
- `dotenv` is used via `dotenv.config()`.
- `.env` is loaded from the current working directory by default.
- If the same key is already set in process environment, that value takes precedence.

### 3. Local Stored Token
- File path: `~/.config/gyazo/credentials.json`
- Supported key for CLI config commands: `token`
- `gyazo config set token <value>` stores `GYAZO_ACCESS_TOKEN` in the file.
- `gyazo config get token` prints a masked token value.

### 4. Access Token Resolution Order
When an authenticated command runs:
1. `GYAZO_ACCESS_TOKEN` from environment/config object
2. Stored token from `~/.config/gyazo/credentials.json`
3. Exit with an error and instructions

## Consequences
- Token management works without requiring shell profile edits.
- CI and non-interactive usage can rely on environment variables only.
- OAuth client fields are documented but currently unused by CLI commands.
