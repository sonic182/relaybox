---
name: new-release
description: "Cut a new Relaybox release: choose the SemVer version, bump it everywhere the app reports it, move CHANGELOG.md's Unreleased notes into a dated section, then commit and tag. Use when asked to bump the version, prepare or cut a release, or tag X.Y.Z. Not for adding changelog notes to an ordinary feature or fix PR."
---

# New release

Relaybox has no release tooling: the version is a hand-edited literal in several files, and
`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) with
[SemVer](https://semver.org/spec/v2.0.0.html). Tags are the bare version (`0.2.0`, not
`v0.2.0`); the changelog's comparison links depend on that.

## 1. Choose the version

Find the last release with `git describe --tags --abbrev=0` (or the newest `## [X.Y.Z]` in
`CHANGELOG.md`), then read `## [Unreleased]` and `git log <last-tag>..HEAD`.

While the major version is `0`: bump the **minor** for new features or any breaking change
(API shapes, env vars, migrations that need operator action), and the **patch** for fixes
only. If the user named a version, use it; if the changes make the choice unclear, ask.

## 2. Bump the version

Edit exactly these places; nothing else carries the app's version:

| File | What to change |
| --- | --- |
| `package.json` | `"version"` |
| `public/swagger.yml` | `info.version` (served at `/redoc` and `/swagger.json`) |
| `src/mcp/server.ts` | `version` in `new McpServer({ name: 'relaybox', ... })` |
| `src/dev-mcp.ts` | `version` in `new McpServer({ name: 'relaybox-dev', ... })` |

Leave these alone; they are not the app version:

- `version: '0.0.1'` in `tests/integration/mcp.test.ts`: the test client's own identity.
- `node-version` and pnpm `version` in `.github/workflows/ci.yml`.
- The Evolution API reference version (`2.4.0`) in `docs/internal/roadmap.md`.
- `pnpm-lock.yaml`: it does not record the root package's version.

Then confirm no stale copy remains:

```bash
rg -n -F '<old-version>' package.json public/swagger.yml src
```

If this finds a new place that holds the app version, bump it and add it to the table above.

## 3. Update CHANGELOG.md

1. Rename the current `## [Unreleased]` content into `## [X.Y.Z] YYYY-MM-DD` (today's date),
   and leave an empty `## [Unreleased]` above it.
2. Group entries under `### Added`, `### Changed`, `### Deprecated`, `### Removed`,
   `### Fixed`, `### Security`, in that order, dropping empty groups. Write user-facing
   entries; skip refactors, tests and CI-only changes unless they affect users.
3. If Unreleased is empty or incomplete, draft entries from `git log <last-tag>..HEAD` and
   the merged PRs, and show them to the user before committing.
4. Call out schema/migration, environment-variable, and Evolution API contract changes
   explicitly, since operators must act on them.
5. Update the link references at the bottom:

```markdown
[Unreleased]: https://github.com/sonic182/relaybox/compare/X.Y.Z...HEAD
[X.Y.Z]: https://github.com/sonic182/relaybox/compare/<previous>..X.Y.Z
```

## 4. Verify

Run `pnpm run typecheck`, `pnpm run lint` and `pnpm run build`. No test asserts the version,
so the test suite needs no local run for a version-only change.

## 5. Commit and tag

Commit only the release changes, with a lowercase subject:

```bash
git commit -am "release X.Y.Z"
git tag -a X.Y.Z -m "X.Y.Z"
```

Committing and tagging locally is fine once the user has asked for the release. Pushing the
branch or tag, and creating a GitHub release, publish it: ask first, then
`git push origin main X.Y.Z`.
