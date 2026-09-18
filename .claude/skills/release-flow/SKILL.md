---
name: release-flow
description: How a duckdive version is cut and what the release pull request does, plus the commit-message convention. Read before writing a commit message, merging the release pull request or writing release notes.
---

# Commits and releases

## Commit messages

Conventional Commits, because release-please reads them to decide the next version and to write
`CHANGELOG.md`. After the type the subject is a plain sentence saying what changed, in the present
tense, with no issue number (`feat: the listing and DuckDB agree on the URL style`). No attribution
or co-author trailers are added. A body is optional; when the change needs one, it says why, not
what the diff already shows.

| type                                       | changelog section | version |
| ------------------------------------------ | ----------------- | ------- |
| `feat`                                     | Added             | minor   |
| `fix`                                      | Fixed             | patch   |
| `perf`                                     | Performance       | patch   |
| `refactor`, `build`, `ci`                  | Internal          | none    |
| `chore`, `docs`, `test`, `style`, `revert` | not shown         | none    |

A `!` after the type (`feat!`) marks a breaking change; below 1.0.0 it bumps the minor rather than
the major (`bump-minor-pre-major` in `.github/release-please-config.json`).

The changelog records what shipped, not what happened on main. A fix for something introduced since
the last release never reached anyone, so it is a `chore`: the reader of the release does not know
the bug existed. Reverting something that did ship is a `fix`.

Entries are one line saying what changed. What a feature is for and how it works belongs in
`README.md`.

## Cutting a release

release-please keeps one pull request open (`chore(main): release X.Y.Z`) and rewrites it on every
push to main with the next version, the new `CHANGELOG.md` section and the release notes. Nothing
is published until it is merged, so that pull request is the `[Unreleased]` section in reviewable
form.

Merging it is the release. `.github/workflows/release.yml` tags the version and creates the GitHub
Release with the changelog section as its notes; its second job builds the store zip through
`scripts/pack.mjs` and attaches it. The zip is what is uploaded to the Chrome Web Store by hand.

The version lives in `package.json` (`vite.config.ts` copies it into the manifest) and in
`.github/release-please-manifest.json`. release-please writes both: no version is edited and no tag
is pushed by hand.

## Tags do not move

A pushed tag and a published release are never rewritten, deleted or force-pushed. Something wrong
in a release is fixed by the next version. The store accepts digits and dots, so no `-beta`
suffixes.
