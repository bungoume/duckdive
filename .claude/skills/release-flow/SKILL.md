---
name: release-flow
description: How a duckdive version is cut and what the tag does, plus the commit-message convention. Read before bumping the version, tagging, writing release notes or making a commit.
---

# Commits and releases

## Commit messages

A subject is a plain sentence saying what changed, in the present tense, no prefix and no issue
number ("The listing and DuckDB agree on the URL style"). Conventional Commits are not used here,
nothing parses the messages, and no attribution or co-author trailers are added. A body is optional;
when the change needs one, it says why, not what the diff already shows.

## Cutting a release

1. Move the `[Unreleased]` entries of `CHANGELOG.md` under a `## [X.Y.Z] - YYYY-MM-DD` heading. The
   workflow reads that section verbatim as the release notes, so it has to stand on its own.
2. Set the same version in `package.json` — `vite.config.ts` copies it into the manifest — and
   commit.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`.

The tag runs `.github/workflows/release.yml`: it refuses a tag that does not match `package.json`,
runs typecheck, lint and the unit tests, builds the store zip through `scripts/pack.mjs` and creates
the GitHub Release with the zip attached. The zip is what is uploaded to the Chrome Web Store by
hand.

## Tags do not move

A pushed tag and a published release are never rewritten, deleted or force-pushed. Something wrong
in a release is fixed by the next version. The version is written in `package.json` only; nothing
else holds a copy. The store accepts digits and dots, so no `-beta` suffixes.
