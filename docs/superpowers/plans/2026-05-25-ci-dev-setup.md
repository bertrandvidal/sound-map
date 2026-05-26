# CI & Dev Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Biome linting/formatting, simple-git-hooks pre-commit hook, GitHub Actions CI with coverage reporting, and branch protection on `main`.

**Architecture:** Biome replaces ESLint + Prettier as a single binary. simple-git-hooks wires a pre-commit hook that runs Biome check and the test suite. GitHub Actions runs the same checks plus a production build and npm audit in a clean environment, posting a coverage summary as a PR comment via `davelosert/vitest-coverage-report-action`. Branch protection on `main` enforces CI passing before merge.

**Tech Stack:** Biome, simple-git-hooks, Vitest v1 + @vitest/coverage-v8, GitHub Actions, `davelosert/vitest-coverage-report-action@v2`

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `biome.json` | Create | Biome lint + format config |
| `package.json` | Modify | Add `@biomejs/biome`, `simple-git-hooks` deps; add `postinstall`, `build` scripts; add `simple-git-hooks` config |
| `vite.config.js` | Modify | Add `coverage` block with provider, reporters, include, thresholds |
| `.github/workflows/ci.yml` | Create | CI workflow: biome → vitest → build → audit → coverage comment |
| `CLAUDE.md` | Modify | Add dev workflow section: hook behavior, fix commands, no `--no-verify` |
| All `src/**` and `server/**` files | Modify | Auto-formatted by Biome to enforce consistent style |

---

## Task 1: Install Biome and generate config

**Files:**
- Create: `biome.json`
- Modify: `package.json`

- [ ] **Step 1: Install Biome**

```bash
npm install --save-dev @biomejs/biome
```

Expected: `@biomejs/biome` appears in `devDependencies` in `package.json`.

- [ ] **Step 2: Initialize Biome config**

```bash
npx biome init
```

Expected: `biome.json` created at repo root.

- [ ] **Step 3: Update biome.json**

Open `biome.json`. Leave the `$schema` line exactly as `biome init` generated it. Add or replace all other keys so the file matches this structure:

```json
{
  "$schema": "https://biomejs.dev/schemas/X.Y.Z/schema.json",
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  },
  "organizeImports": {
    "enabled": true
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "files": {
    "ignore": ["node_modules", "dist"]
  }
}
```

The `$schema` URL shown above is illustrative — use the exact URL that `biome init` wrote (it encodes the installed Biome version).

- [ ] **Step 4: Commit**

```bash
git add biome.json package.json package-lock.json
git commit -m "$(cat <<'EOF'
Add Biome for linting and formatting

Why: Replaces ESLint + Prettier with a single fast binary. Zero external
config for JSX — Biome detects .jsx automatically.

How: npm install @biomejs/biome, biome init, configured 2-space indent,
recommended linter rules, ignore node_modules and dist.

Tests: N/A — tooling config only
EOF
)"
```

---

## Task 2: Apply Biome formatting to the existing codebase

Biome will reformat existing files to enforce consistent style. This is a one-time cleanup commit that separates formatting noise from future logical changes.

**Files:**
- Modify: all `src/**/*.{js,jsx}`, `server/index.js`

- [ ] **Step 1: Auto-fix the whole codebase**

```bash
npx biome check --write .
```

Expected: Biome modifies several files (formatting, import organization). No errors.

- [ ] **Step 2: Verify no remaining issues**

```bash
npx biome check .
```

Expected: exits 0 with no errors or warnings. If any remain, they are lint violations that need manual fixes — read the error message and fix the flagged line.

- [ ] **Step 3: Run tests to confirm nothing broke**

```bash
npm test
```

Expected: 14 tests pass (2 test files, no failures).

- [ ] **Step 4: Commit all reformatted files**

```bash
git add src/ server/
git commit -m "$(cat <<'EOF'
Apply Biome formatting to existing codebase

Why: One-time cleanup to establish consistent style baseline. Separating
formatting from logic changes keeps future diffs readable.

How: npx biome check --write . applied to all src/ and server/ files.
No logic changed — formatting only.

Tests: All 14 tests pass after reformatting
EOF
)"
```

---

## Task 3: Configure Vitest coverage

**Files:**
- Modify: `vite.config.js`

Note: `@vitest/coverage-v8@1.6.1` is already in `devDependencies` (installed during design phase baseline run). No install needed.

- [ ] **Step 1: Add coverage config to vite.config.js**

Replace the entire file with:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/geo.js', 'src/spotify.js'],
      thresholds: {
        statements: 90,
        branches: 75,
        functions: 100,
      },
    },
  },
})
```

- [ ] **Step 2: Run tests with coverage to verify thresholds pass**

```bash
npx vitest run --coverage
```

Expected output includes a coverage table showing:
- `geo.js`: ~92% statements, ~93% branches, 100% functions
- `spotify.js`: 100% statements, ~75% branches, 100% functions

Expected: exits 0 (thresholds met). If it exits non-zero with a threshold error, re-check the `include` paths exactly match `src/geo.js` and `src/spotify.js`.

- [ ] **Step 3: Commit**

```bash
git add vite.config.js
git commit -m "$(cat <<'EOF'
Configure Vitest coverage with thresholds

Why: Enforces quality gates on the two tested logic files. Coverage scoped
to src/geo.js and src/spotify.js — React components and server require
React Testing Library / integration tests before they can be included.

How: Added coverage block to vite.config.js: v8 provider, json-summary
reporter (for PR comment action), thresholds at 90/75/100 stmt/branch/fn.

Tests: npx vitest run --coverage passes all thresholds
EOF
)"
```

---

## Task 4: Install and configure simple-git-hooks

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install simple-git-hooks**

```bash
npm install --save-dev simple-git-hooks
```

- [ ] **Step 2: Update package.json**

Replace the `scripts` block and add the `simple-git-hooks` config key. The full updated `package.json` (non-dependency fields):

```json
{
  "name": "sound-map",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "server": "node server/index.js",
    "start": "concurrently \"npm run dev\" \"npm run server\"",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "postinstall": "npx simple-git-hooks"
  },
  "simple-git-hooks": {
    "pre-commit": "npx biome check . && npm test"
  }
}
```

Leave `dependencies` and `devDependencies` as-is (only add `simple-git-hooks` to devDependencies from the install step above).

- [ ] **Step 3: Install the git hook**

```bash
npx simple-git-hooks
```

Expected output: `[INFO] Successfully set the pre-commit with command: npx biome check . && npm test`

- [ ] **Step 4: Verify the hook file exists**

```bash
cat .git/hooks/pre-commit
```

Expected: file contains `npx biome check . && npm test`

- [ ] **Step 5: Test that the hook blocks a bad commit**

Create a temporary file with a Biome violation (unused variable):

```bash
echo "const unused = 1;" > /tmp/test-hook.js
cp /tmp/test-hook.js src/test-hook.js
git add src/test-hook.js
git commit -m "test: should be blocked by hook"
```

Expected: commit is blocked. Biome prints an error about the unused variable. Exit code non-zero.

- [ ] **Step 6: Clean up the test file**

```bash
git restore --staged src/test-hook.js
rm src/test-hook.js
```

- [ ] **Step 7: Commit the hook config**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
Add simple-git-hooks pre-commit hook

Why: Blocks commits that fail Biome check or break tests. Fail-and-fix
approach — auto-fix was rejected to preserve intentional unstaged changes.
Never bypass with git commit --no-verify.

How: simple-git-hooks configured in package.json. postinstall script
installs the hook automatically after npm install. pre-commit runs
biome check . && npm test.

Tests: Verified hook blocks a commit with an unused variable lint error
EOF
)"
```

---

## Task 5: Create GitHub Actions CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflows directory**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: Create ci.yml**

Create `.github/workflows/ci.yml` with this exact content:

```yaml
name: CI

on:
  push:
  pull_request:

permissions:
  pull-requests: write

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: actions/setup-node@v6
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Lint and format check
        run: npx biome check .

      - name: Run tests with coverage
        run: npx vitest run --coverage

      - name: Build
        run: npm run build

      - name: Audit dependencies
        run: npm audit --audit-level=high

      - name: Post coverage comment
        uses: davelosert/vitest-coverage-report-action@v2
```

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
Add GitHub Actions CI workflow

Why: CI runs in a clean environment, cannot be bypassed with --no-verify,
and enforces branch protection. vite build catches production failures
that unit tests miss. npm audit catches CVEs. Coverage comment posts
a summary table on every PR.

How: Single job (ci) on ubuntu-latest, Node 20 LTS. Steps: checkout,
setup-node with npm cache, npm ci, biome check, vitest --coverage,
vite build, npm audit, coverage PR comment.

Tests: Will be verified by the first CI run after push
EOF
)"
git push
```

Expected: GitHub Actions workflow starts. Watch progress at:
```bash
gh run list --limit 3
gh run watch
```

Expected CI result: all steps green. If `npm audit` fails with a high-severity CVE, run `npm audit` locally to investigate and either `npm audit fix` or add an `.npmrc` audit exception with justification.

---

## Task 6: Enable branch protection on main

Run this only after Task 5's CI run completes successfully (the job name `ci` must appear in GitHub's list of known status checks).

**Files:** none (GitHub API change only)

- [ ] **Step 1: Enable branch protection**

```bash
gh api \
  --method PUT \
  repos/bertrandvidal/sound-map/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["ci"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

Expected: JSON response with `"url"` field containing the protection URL. No error.

- [ ] **Step 2: Verify protection is active**

```bash
gh api repos/bertrandvidal/sound-map/branches/main/protection \
  --jq '.required_status_checks.contexts'
```

Expected: `["ci"]`

---

## Task 7: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add dev workflow section to CLAUDE.md**

Insert the following new section after the `## Git commits` section (before `## Superpowers`):

```markdown
## Dev workflow

A pre-commit hook runs automatically on every `git commit`:

```bash
npx biome check . && npm test
```

If the hook blocks your commit:
- **Biome error:** run `npx biome check --write <file>`, then `git add <file>` and re-commit
- **Test failure:** fix the failing test or the code, then re-commit

Never use `git commit --no-verify` to bypass the hook — fix the issue instead.

The same checks run in GitHub Actions CI on every push and PR. PRs cannot be merged to `main` until CI passes.
```

- [ ] **Step 2: Run tests to confirm nothing broken**

```bash
npm test
```

Expected: 14 tests pass.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
Document dev workflow and pre-commit hook behavior in CLAUDE.md

Why: Agents and contributors need to know the hook is fail-and-fix,
how to recover from a blocked commit, and that --no-verify is off-limits.

How: Added Dev workflow section to CLAUDE.md with hook command, fix
instructions, and CI context.

Tests: N/A — documentation only
EOF
)"
```
