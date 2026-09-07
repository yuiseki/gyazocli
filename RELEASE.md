# Releasing

A release is cut by pushing a `v*` tag. Everything else is automated, except
the last step, which is deliberately not: nothing reaches npm until a
maintainer approves it with 2FA.

## What happens when you push a tag

`.github/workflows/release.yml` runs and, in this order:

1. Checks out the tag.
2. Installs Node 24 and the latest npm.
3. Refuses to go on if the tag and the `version` in `package.json` disagree.
4. `npm ci`, `npm run build`, `npx vitest run`.
5. `npm stage publish`, which uploads the tarball with a provenance statement
   signed by GitHub Actions and leaves it staged, not public.

Authentication is npm trusted publishing over OIDC. There is no npm token
stored in this repository or in its secrets.

## Steps

```bash
# 1. bump the version in all three places
npm version <patch|minor|major> --no-git-tag-version
# then edit these to the same number:
#   src/index.ts                    .version('x.y.z')
#   docs/ADR/003-cli-structure.md   - Version: `x.y.z`

# 2. check it locally
npm run build
npx vitest run

# 3. commit, tag, push
git commit -am "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

The three copies of the version number are a hand-maintained duplication, so
a test runs `gyazo --version` and compares it with `package.json`. If you miss
one, CI fails before the release job can stage anything.

## Approving the staged release

The release job prints the stage id. Approve it either on npmjs.com, under the
package's Staged Packages tab, or from a machine with npm 11.15.0 or newer:

```bash
npm stage list @yuiseki/gyazocli
npm stage approve <stage-id>
```

Both ask for 2FA. Only after this is the version installable.

## Checking the result

```bash
npm view @yuiseki/gyazocli version
cd "$(mktemp -d)" && npm init -y >/dev/null
npm install --omit=dev --install-strategy=nested @yuiseki/gyazocli
./node_modules/.bin/gyazo --version
npm audit signatures
```

`--install-strategy=nested` turns off hoisting, so the CLI can only resolve
the dependencies it declares itself. CI runs the same check on every pull
request, which is what catches an import that is missing from `package.json`.

## Also write a GitHub release

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file notes.md
```

## If the release job fails

- `403 OIDC permission denied for this action`: the trusted publisher on
  npmjs.com does not allow what the job asked for. Configurations created from
  2026-09-03 allow `npm stage publish` only, and direct `npm publish` is a
  separate opt-in. Keep the narrow permission and stage.
- `422 Failed to validate repository information`: npm checks the provenance
  signature against the repository the package claims, so `package.json` must
  keep its `repository` field pointing at this repository.
- The tag/version check failed: the tag and `package.json` disagree. Fix the
  version, then move the tag, or tag the next patch version.

## Trusted publisher settings

Configured once, on npmjs.com under the package's Access settings:

- Organization or user: `yuiseki`
- Repository: `gyazocli`
- Workflow filename: `release.yml`
- Environment: empty
- Permissions: `npm stage publish`
