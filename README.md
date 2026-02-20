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
