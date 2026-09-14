# actual-plaid-sync — Design

Date: 2026-09-13
Status: Approved (user's Actual server: v26.9.0, matching the pinned API)

## Goal

A TypeScript CLI that syncs bank transactions from Plaid into a self-hosted Actual Budget server. It runs as a stateless Kubernetes CronJob configured entirely by env vars, with a one-time local `link` command to connect banks.

Replaces `infiniteluke/actualplaid` (abandoned, no OAuth) and `RickyV33/plaid-importer-actual-budget` (permanent web app, broken OAuth) and avoids `noelpena/plaid-actual-sync`'s stateful cursor + lossy pending handling.

## Non-goals (v1)

- Persistent state of any kind (no PVC, no cursor, no database). Actual itself is the state.
- Heuristic pending→posted matching for banks that don't send `pending_transaction_id` (Capital One, USAA). They still work via the cancel path; see Sync step 6.
- Webhooks, a permanent web UI, multi-user support, multiple budgets per run.
- Automated release tooling (release-please). Releases are manual git tags.

## Key facts from research

- Plaid OAuth banks (Chase) work in desktop web Link **without** a `redirect_uri`; no HTTPS setup needed.
- Plaid Trial plan: 10 production Items; removing an Item does not free a slot. Relinking must use update mode.
- `days_requested` can only be set at link time (default 90, max 730). `link` sets 730.
- When a pending transaction posts, Plaid issues a **new** `transaction_id`; the posted txn's `pending_transaction_id` points to the old one. Amount and name may change.
- Plaid amounts: positive = money leaving the account, for all account types (including credit cards and loans).
- `@actual-app/api` `importTransactions` dedups on `imported_id`, skips reconciled matches, and never updates amount/date on match. `updateTransaction` accepts arbitrary fields including `imported_id` (verified in source, `loot-core/src/server/api.ts`).
- `@actual-app/api` depends on native `better-sqlite3` and resolves files via `__dirname`: cannot be bundled; needs a glibc image.
- `plaid` npm (v47) and `@actual-app/api` are both CommonJS with bundled types.

## Commands

| Command | Where it runs | What it does |
|---|---|---|
| `link` | Laptop, once per bank | Starts a local HTTP server (default `http://localhost:8484`), serves Plaid Link, exchanges the public token, prints `PLAID_ACCESS_TOKENS` value and the item's accounts (id, name, mask, type). |
| `link --update` | Laptop | Update mode for an existing access token (`LINK_ACCESS_TOKEN` env or `--access-token`). No token exchange; same token and Item slot. Enables account selection. |
| `accounts` | Laptop or cluster | Lists Plaid accounts (per token) alongside Actual accounts; prints a suggested `ACCOUNT_MAP` line matching by name/mask where obvious. |
| `sync` | CronJob (image default) | Runs the sync described below. |

`link` shuts the server down after success (or on Ctrl+C). It uses a static `client_user_id` (`actual-plaid-sync`). Products: `transactions`. Country codes from `PLAID_COUNTRY_CODES` (default `US`).

## Configuration (env vars)

Validated with zod per command. All problems are reported at once; exit code 2.

| Var | Required for | Default | Notes |
|---|---|---|---|
| `PLAID_CLIENT_ID` | all | — | |
| `PLAID_SECRET` | all | — | Sandbox and production secrets differ |
| `PLAID_ENV` | all | — | `sandbox` \| `production` |
| `PLAID_COUNTRY_CODES` | link | `US` | comma list |
| `PLAID_ACCESS_TOKENS` | sync, accounts | — | comma list, one per bank login (Item) |
| `ACCOUNT_MAP` | sync | — | comma list of `plaidAccountId:actualAccountId` |
| `ACTUAL_SERVER_URL` | sync, accounts | — | |
| `ACTUAL_PASSWORD` | sync, accounts | — | |
| `ACTUAL_SYNC_ID` | sync, accounts | — | Settings → Advanced → Sync ID |
| `ACTUAL_ENCRYPTION_PASSWORD` | — | unset | only for E2E-encrypted budgets |
| `SYNC_DAYS` | sync | `30` | Plaid fetch window |
| `DRY_RUN` | sync | `false` | print planned changes, write nothing |
| `LINK_PORT` | link | `8484` | |
| `LINK_HOST` | link | `127.0.0.1` | set `0.0.0.0` inside Docker |
| `LINK_ACCESS_TOKEN` | link --update | — | token to repair; `--access-token` flag overrides |
| `LOG_LEVEL` | all | `info` | `debug` \| `info` \| `warn` \| `error` |

Plaid accounts not in `ACCOUNT_MAP` are skipped with one info log line each. One Plaid transactions call sequence per access token, never per account.

## Sync

### Architecture

- `fetch`: Plaid `/transactions/get` for `[today − SYNC_DAYS, today]`, paging via `count`/`offset` until `total_transactions`. One call sequence per token.
- `load`: Actual `getTransactions(accountId, today − SYNC_DAYS − 30, today)` for each mapped account. The extra 30 days of lookback finds pending rows dated before the window.
- `planSync(plaidTxns, actualTxns, window) → Plan`: **pure function**, no I/O. Returns `{ updates, imports, deletes, notices }` per account.
- `execute(plan)`: applies the plan via `updateTransaction`, `importTransactions`, `deleteTransaction`. With `DRY_RUN=true`, prints the plan and skips this step.

### Field mapping (Plaid → Actual)

| Actual field | Source |
|---|---|
| `amount` | `Math.round(plaid.amount * -100)` — integer cents, sign flipped. Correct for depository, credit, and loan accounts alike. |
| `date` | `authorized_date ?? date` (stable across pending→posted) |
| `payee_name` | `merchant_name ?? name` |
| `imported_payee` | `name` |
| `imported_id` | `transaction_id` |
| `cleared` | `!pending` |

`importTransactions` is always called with `{ reimportDeleted: false }` so user-deleted transactions stay deleted.

### Plan steps (per mapped account)

Index Actual rows by `imported_id`. Let `P` = posted Plaid txns, `Q` = pending Plaid txns, `trusted range` = `[windowStart + 3 days, today]`.

1. **Fetch** Plaid window (all pages); drop unmapped accounts.
2. **Load** Actual rows for the extended range.
3. **Pending → posted:** for each `p ∈ P` where `p.pending_transaction_id` matches an Actual row and `p.transaction_id` does not: update that row with `{ imported_id: p.transaction_id, amount, date, cleared: true }`. Payee, category, notes untouched.
4. **Pending amount/date changed:** for each `q ∈ Q` matching an uncleared Actual row whose amount or date differs: update `{ amount, date }`.
5. **New:** every `P ∪ Q` txn with no Actual row (after steps 3–4) → import.
6. **Cancelled holds:** uncleared Actual rows with a non-null `imported_id` that is not in `P ∪ Q` and was not consumed by step 3:
   - dated inside the trusted range → delete
   - dated before the trusted range → notice only (cannot distinguish "posted outside window" from "cancelled")
7. **Push:** `shutdown()` (syncs to server) in `finally`.

Safety rules applied to steps 3, 4, 6:

- Rows with `reconciled: true` are never mutated or deleted → notice.
- Split parents (`is_parent`) are never mutated or deleted → notice.

Updates run before imports, so a crashed run is safely redone by the next run. Running the plan a second time against the resulting state must produce an empty plan (idempotency).

Banks without `pending_transaction_id`: the posted txn imports as new (step 5) and the pending row is deleted as a cancelled hold (step 6). No duplicates; category edits on the pending row are lost.

### Actual lifecycle

1. `mkdtemp` under `os.tmpdir()` for `dataDir`.
2. `init({ dataDir, serverURL, password, verbose: false })`.
3. `downloadBudget(syncId, { password: encryptionPassword })`.
4. Plan + execute.
5. `finally`: `shutdown()`, remove temp dir, `process.exit(code)`.

## Error handling

| Situation | Behavior |
|---|---|
| Invalid/missing config | List all problems, exit 2, no network calls |
| `ITEM_LOGIN_REQUIRED`, `PENDING_EXPIRATION`, `PENDING_DISCONNECT` | Error log naming the token (`…a1b2`) and "run `link --update`"; continue other tokens; final exit 1 |
| `PRODUCT_NOT_READY` | Warning; skip token; does not fail the run |
| Plaid 429 / 5xx / network | 3 retries with exponential backoff; then treated as a failed token |
| Actual `invalid-password`, `network-failure`, `budget-not-found` | Fatal, exit 1, one-line hint |
| Actual `out-of-sync-migrations` | Fatal, exit 1, hint including bundled API version and `getServerVersion()` if available |
| `importTransactions` returns `errors` | Log each; account counted as failed; exit 1 |

Exit codes: `0` success, `1` any token/account/Actual failure, `2` config error. Partial success still pushes changes for healthy accounts.

## Logging

- Plain text lines to stdout, level from `LOG_LEVEL`.
- One summary per account: `Chase Checking: 5 added, 2 posted, 1 amount updated, 1 cancelled hold, 0 skipped`.
- Secrets never logged; access tokens shown as last 4 chars only.

## Project layout

```
src/cli.ts              commander wiring
src/config.ts           zod env schemas per command
src/log.ts              leveled logger + secret masking
src/plaid/client.ts     PlaidApi construction, retries, error classification
src/plaid/transactions.ts  windowed fetch with paging
src/plaid/accounts.ts
src/actual/session.ts   withBudget(fn): temp dir, init, download, shutdown
src/sync/mapping.ts     Plaid txn → Actual txn
src/sync/plan.ts        planSync (pure)
src/sync/run.ts         fetch → load → plan → execute/dry-run → summary
src/link/server.ts      node:http server (GET /, POST /api/link-token, POST /api/exchange)
src/link/page.html      loads Plaid Link JS, calls the API
src/commands/accounts.ts
test/                   mirrors src/
deploy/cronjob.yaml     example CronJob + Secret
```

ESM (`"type": "module"`), `import * as api from '@actual-app/api'`, default-import interop for `plaid`.

## Tooling

- `mise.toml`: Node 24 LTS, pnpm 12 (aqua backend). `mise.lock` committed.
- Tasks: `check` (lint + typecheck + test), `build`, `test`, `lint`, `link`, `sync`.
- TypeScript 7 `tsc` to `dist/`. No bundler.
- `commander`, `zod` v4, `vitest`, `biome`.
- pnpm build-script allowlist includes `better-sqlite3`.
- `@actual-app/api` pinned to an exact version (26.9.0 initially).

## Container image

- Multi-stage `node:24-trixie-slim`, **base images pinned by digest**.
- pnpm installed from its standalone release binary, verified with `sha256sum -c`.
- `pnpm install --frozen-lockfile`, `tsc`, `pnpm deploy --prod` into runtime stage.
- Runs as `node` (uid 1000). `ENTRYPOINT ["node", "dist/cli.js"]`, `CMD ["sync"]`.
- Compatible with `readOnlyRootFilesystem: true` given an `emptyDir` at `/tmp`.
- Platforms: `linux/amd64`, `linux/arm64` (QEMU; better-sqlite3 prebuilds avoid compilation).
- Published to `ghcr.io/msheiny/actual-plaid-sync`.

## CI/CD (GitHub Actions)

- **All actions outside the `actions/` org pinned to full commit SHA** with a version comment.
- `ci.yml` (PRs + main): `jdx/mise-action`, `pnpm install --frozen-lockfile`, `mise run check`, Docker build without push.
- `e2e` job: Plaid Sandbox item via `/sandbox/public_token/create` + `actualbudget/actual-server` service container (pinned by digest); runs `sync` twice; asserts no duplicates. Skipped when Plaid sandbox secrets are absent.
- `release.yml`: push to `main` → `:edge`, `:sha-<short>`; tag `vX.Y.Z` → `:X.Y.Z`, `:X.Y`. Provenance (`mode=max`) and SBOM. Permissions: `contents: read`, `packages: write`, `id-token: write`, `attestations: write`.
- Renovate: `pinDigests: true`; `@actual-app/api` never automerged and labeled for manual review.
- One-time manual step: set the GHCR package visibility to public.

## Testing

- `planSync` table-driven unit tests: new posted, new pending, pending→posted, hold amount change, cancelled hold inside vs outside trusted range, reconciled skip, split skip, idempotency (second plan is empty), bank without `pending_transaction_id`.
- `mapping` tests: sign conversion for depository and credit accounts, float rounding (e.g. `0.1 + 0.2` style amounts), date and payee fallbacks.
- `config` tests: missing vars reported together, `ACCOUNT_MAP` parsing errors.
- E2E in CI as described above.
- `link` page: manual test in Sandbox (`user_good` / `pass_good`), documented in README.

## Open items

- Confirm the user's Actual server version; adjust the pinned `@actual-app/api` if older than 26.9.0.
