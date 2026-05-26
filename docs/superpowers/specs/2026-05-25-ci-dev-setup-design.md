# CI & Dev Setup Design

**Date:** 2026-05-25  
**Status:** Approved

## Goal

Add a local pre-commit safety net and a GitHub Actions CI pipeline so every commit and every PR is verified before it lands on `main`.

## Decisions

- **Linter + formatter:** Biome (replaces ESLint + Prettier, single binary, zero-config start)
- **Pre-commit tool:** simple-git-hooks (minimal, no abstraction layers)
- **Pre-commit behavior:** fail-and-fix (not auto-fix — intentional, see Pre-commit Hooks section)
- **CI scope:** lean single job — Biome check, Vitest with coverage, vite build, npm audit
- **Coverage on PRs:** `davelosert/vitest-coverage-report` GitHub Action (no external service)
- **Coverage thresholds:** not set initially — run CI once to establish baseline, add later

---

## Components

### 1. Biome

**Package:** `@biomejs/biome` (dev dependency)

Initialize with `npx biome init` to generate `biome.json` at repo root. Two adjustments to defaults:

- Enable `formatter` and `linter` in check mode (so `biome check .` catches both in one pass)
- Add `node_modules` and `dist` to `ignore` list

Biome auto-detects `.jsx` files — no extra JSX config needed.

**Usage:**
- Check only (used in hook + CI): `npx biome check .`
- Fix a file after a failed hook: `npx biome check --write <file>` then `git add <file>`

### 2. Pre-commit Hooks (simple-git-hooks)

**Package:** `simple-git-hooks` (dev dependency)

Configured via a `"simple-git-hooks"` key in `package.json` — no extra config file.

**Pre-commit hook:**
```
npx biome check . && npm test
```

**Behavior: fail-and-fix.** If Biome finds issues, the commit is blocked. You fix the file manually, re-stage it, and re-commit. This is intentional — it preserves commit hygiene and avoids silently staging files you didn't intend to include.

**Why not auto-fix?** The auto-fix approach (`biome check --write . && git add -u`) stages all modified tracked files, which breaks workflows where unstaged changes are deliberately left out of a commit. The clean solution for selective auto-staging would be `lint-staged`, but that adds complexity. Fail-and-fix is the right tradeoff here.

**Important:** Never use `git commit --no-verify` to bypass the hook. If the hook is blocking, fix the issue — don't skip it.

**Hook installation:** A `postinstall` script in `package.json` runs `npx simple-git-hooks` automatically after `npm install`, so hooks are set up for anyone who clones the repo.

### 3. GitHub Actions CI

**File:** `.github/workflows/ci.yml`

**Triggers:** `push` and `pull_request` on all branches.

**Permissions:** `pull-requests: write` (required for the coverage comment action).

**Single job — steps in order:**

| Step | Command | Purpose |
|------|---------|---------|
| Checkout | `actions/checkout@v4` | Get the code |
| Setup Node | `actions/setup-node@v4` with Node 20 LTS | Runtime |
| Install | `npm ci` | Clean install from lockfile — catches undeclared deps |
| Lint + format | `npx biome check .` | Same check as pre-commit hook |
| Tests + coverage | `npx vitest run --coverage` | Runs all tests, writes coverage summary |
| Build | `npx vite build` | Catches production build failures that tests won't catch |
| Audit | `npm audit --audit-level=high` | Flags known CVEs in dependencies |
| Coverage comment | `davelosert/vitest-coverage-report@v2` | Posts coverage table as PR comment (no-op on plain pushes) |

Steps run sequentially. A failure in any step fails the job and blocks the PR.

### 4. Vitest Coverage Config

**Package:** `@vitest/coverage-v8` (dev dependency — V8 provider, no instrumentation overhead)

Coverage configured in `vite.config.js` under the `test.coverage` key:

```js
coverage: {
  provider: 'v8',
  reporter: ['text', 'json-summary'],
}
```

- `text` — prints the coverage table in CI logs
- `json-summary` — required by `davelosert/vitest-coverage-report` to generate the PR comment

**Thresholds:** not configured initially. Run CI on the first PR to see the baseline, then add `thresholds` to this config block.

### 5. Branch Protection

After the first CI run succeeds, enable branch protection on `main` via `gh`:

```bash
gh api repos/{owner}/{repo}/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["ci"]}' \
  --field enforce_admins=false \
  --field required_pull_request_reviews=null \
  --field restrictions=null
```

This requires the CI job (named `ci` in the workflow) to pass before any PR can be merged to `main`.

---

## CLAUDE.md Updates

Add to the `## Git commits` section or a new `## Dev workflow` section:

- Pre-commit hook runs `biome check . && npm test` — if it fails, fix the issue, re-stage, re-commit
- To fix a Biome error: `npx biome check --write <file>`, then `git add <file>`
- Never use `git commit --no-verify` to bypass the hook

---

## What This Does Not Cover

- Coverage thresholds (add after seeing baseline)
- Multi-Node-version matrix (not needed at this scale)
- Deployment pipeline (Phase 2 / AWS)
- Codecov or other external coverage tracking services
