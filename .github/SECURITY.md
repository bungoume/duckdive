# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's security advisories: open the
repository's **Security** tab and choose **Report a vulnerability**
(https://github.com/bungoume/duckdive/security/advisories/new). Do not open a public issue
for a security problem. You will get an acknowledgement, and a fix or a decision, through the
advisory thread.

In scope: the extension itself (everything that ends up in `dist/`), the build, packaging and
e2e scripts, and the dependency and CI setup in this repository.

## How releases are protected

- Every dependency is pinned to an exact version in `package.json`; `pnpm-lock.yaml` records
  an integrity hash per package, and CI installs with `--frozen-lockfile`.
- pnpm enforces a 3-day cooldown (`minimumReleaseAge`) on direct and transitive dependencies;
  only explicitly approved packages may bypass it (`@duckdb/duckdb-wasm` currently). It refuses a release whose
  publish evidence is weaker than an earlier one (`trustPolicy: no-downgrade`) and never runs a
  dependency's install scripts unless it is allow-listed.
- The pnpm release itself is pinned with the hash of its tarball (`package.json#packageManager`).
- Every GitHub Action is pinned to a commit SHA, workflows run with a read-only token, and every
  binary CI downloads is verified against a pinned sha256.
- Renovate proposes updates with the same cooldown, exempts DuckDB (Wasm and CLI), and raises
  security updates immediately.
- CodeQL scans the TypeScript sources and the workflows on every push and pull request.
