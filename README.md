# actual-plaid-sync

Sync bank transactions from [Plaid](https://plaid.com) into a self-hosted [Actual Budget](https://actualbudget.org) server, including pending transactions.

Connect each bank through a local browser page, choose which accounts to sync, then run manually or on a schedule. Configuration lives in `.env` and `accounts.yaml`; transaction state lives in Actual. No separate database is needed.

| Command | What it does |
|---|---|
| `mise run link` | Opens a local bank-connection flow and prints an access token to save in `.env`. Run once per bank login. |
| `mise run link:update` | Lets you choose a configured bank token, then opens Plaid's repair flow. |
| `mise run accounts` | Lists Plaid and Actual accounts and writes suggested mappings to `accounts.yaml` for you to edit. |
| `mise run sync` | Imports, updates, and removes transactions in the mapped Actual accounts. Set `DRY_RUN=true` to preview those changes. |

**A plain `sync` changes transactions unless you set `DRY_RUN=true`.** The walkthrough below starts with previews enabled.

## Prerequisites

- **Docker** — installed and running, to host the temporary Actual server.
- **[mise](https://mise.jdx.dev)** — installs the project’s Node and pnpm versions and runs its tasks.

## Try it with fake bank data

Use Plaid Sandbox and a temporary Actual server to learn the workflow. You will also need a Plaid account. Run the commands below from the checkout directory.

### 1. Set up the project

```bash
git clone https://github.com/msheiny/actual-plaid-sync
cd actual-plaid-sync
mise trust
mise install
```

Create a file named `.env` in this directory with:

```dotenv
PLAID_ENV=sandbox
PLAID_CLIENT_ID=replace-with-your-client-id
PLAID_SECRET=replace-with-your-sandbox-secret
PLAID_ACCESS_TOKENS=
ACTUAL_SERVER_URL=http://localhost:5006
ACTUAL_PASSWORD=replace-with-your-test-server-password
ACTUAL_SYNC_ID=replace-with-your-test-budget-sync-id
DRY_RUN=true
```

Get your client ID and Sandbox secret from the [Plaid Dashboard](https://dashboard.plaid.com), under **Developers → Keys**. Fill in the Actual values after the next step; the access token comes from step 3.

Mise loads `.env` for each task. The `link`, `accounts`, and `sync` tasks also install project dependencies and build the CLI before running it.

### 2. Create a test budget

```bash
mise run actual:start
```

Open <http://localhost:5006>, set a server password, create a budget, and add an account named **Checking**.

In the budget, open **Settings → Show advanced settings → IDs** and copy **Sync ID**. Set `ACTUAL_PASSWORD` and `ACTUAL_SYNC_ID` in `.env`. Use the server login password and the **Sync ID**, not the Budget ID.

This server is temporary: `mise run actual:stop` deletes it and its data. Keep `.env` pointed at this test server throughout the Sandbox walkthrough.

### 3. Connect a fake bank

```bash
mise run link
```

Open <http://localhost:8484>, click **Connect bank**, and use the Sandbox credentials shown on the page (`user_good` / `pass_good`).

The terminal prints a line like `PLAID_ACCESS_TOKENS=access-sandbox-...`. Replace the empty `PLAID_ACCESS_TOKENS=` line in `.env` with that line.

### 4. Choose accounts to sync

```bash
mise run accounts
```

This reads both services and creates **`accounts.yaml` in the checkout directory**. Open that file in your editor. **It is git-ignored**, as is `.env`, so it will not appear in `git status` and some editors may hide it.

Review the suggested matches. If nothing matches, the file contains `REPLACE_WITH_ACTUAL_ACCOUNT_NAME` placeholders. Replace them with your Actual account names and remove entries you do not want to sync. For example, to sync only Sandbox Checking into the test account:

```yaml
accounts:
  - plaid: "0000"      # Plaid Checking's mask; keep the quotes
    actual: Checking  # Your Actual account name
```

If some accounts match, unmatched Plaid accounts appear as comments. Add a mapping for any you want to include. See [Accounts file](#accounts-file) for the full format.

**Rerunning `accounts` preserves an existing file.** It prints fresh suggestions for you to apply manually. `ACCOUNTS_FILE` can select a different file path.

### 5. Preview, then import

Preview the planned transaction changes:

```bash
DRY_RUN=true mise run sync
```

This still connects to Plaid and Actual, but does not import, update, or delete transactions. After reviewing the output, import them:

```bash
DRY_RUN=false mise run sync
```

These prefixes override `.env` for that invocation only. The `.env` above keeps previews enabled for subsequent plain `mise run sync` commands. To make imports the normal behavior, change its line to `DRY_RUN=false`.

Refresh Actual to see the transactions. If Plaid reports `PRODUCT_NOT_READY`, wait a minute and retry. Running the import again should add nothing unless new transactions have arrived.

When finished:

```bash
mise run actual:stop
```

## Use real bank accounts

### 1. Configure Production and your Actual server

Obtain Production access and a Production secret through the [Plaid Dashboard](https://dashboard.plaid.com). Check the plan's current pricing and connection limits there before linking real banks. Plaid calls each bank login an **Item**; one Item can contain several accounts.

Update `.env`:

- Set `PLAID_ENV=production` and use your Production `PLAID_SECRET`.
- Set `ACTUAL_SERVER_URL` to your real server URL, such as `https://actual.example.com`.
- Set `ACTUAL_PASSWORD` and `ACTUAL_SYNC_ID` for that server and budget.
- Add `ACTUAL_ENCRYPTION_PASSWORD` if the budget is end-to-end encrypted.
- Keep `DRY_RUN=true` while setting up.

Use a server version compatible with the bundled Actual API:

| Project version | Bundled `@actual-app/api` | Actual server series |
|---|---|---|
| `0.1.x` | `26.9.0` | `26.9.x` |

A migration mismatch fails with `out-of-sync-migrations` and a hint showing the versions.

### 2. Connect banks and review mappings

1. Run `mise run link` for each bank login. Replace the Sandbox token in `.env` with the Production tokens, separated by commas: `PLAID_ACCESS_TOKENS=access-production-aaa,access-production-bbb`.
2. If you used the Sandbox walkthrough, rename its `accounts.yaml` to `accounts.sandbox.yaml` before continuing. Otherwise, the existing file will be preserved.
3. Run `mise run accounts` and edit the new `accounts.yaml`. Include only the accounts you want this tool to sync.
4. Run `DRY_RUN=true mise run sync` and review the changes.
5. Run `DRY_RUN=false mise run sync` to apply them.

By default, sync fetches the last **30 days**. Set `SYNC_DAYS` to an integer from `1` to `730` to change that window. Linking requests up to 730 days of history; the history actually available depends on the bank.

**Use dedicated Actual accounts for this sync.** It may delete an uncleared imported transaction that Plaid no longer reports, treating it as a cancelled hold. That can include transactions from another bank importer. Read [pending transaction behavior](#how-pending-transactions-are-handled) before using it with existing transactions.

### 3. Schedule sync (optional)

You can run `sync` manually or schedule it. Set `DRY_RUN=false` in the environment used by your scheduler to apply changes.

For Kubernetes, [`deploy/cronjob.yaml`](deploy/cronjob.yaml) includes a Secret, an accounts ConfigMap, and a CronJob scheduled every 6 hours.

1. In the Secret, replace every `change-me` value with your Production settings. Remove `ACTUAL_ENCRYPTION_PASSWORD` if unused. The example sets `DRY_RUN` to `"false"`, so scheduled runs apply changes.
2. Replace the ConfigMap's sample `accounts.yaml` content with your reviewed file, preserving YAML indentation.
3. Use a release image tag compatible with your Actual server; pin its digest for reproducible deployments.
4. Apply the file. Keep the filled-in file private because it contains credentials.

```bash
kubectl apply -f deploy/cronjob.yaml
```

For example, the ConfigMap section maps Plaid accounts to Actual account names like this. Replace the example values with your reviewed mappings:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: actual-plaid-sync-accounts
data:
  accounts.yaml: |
    accounts:
      - plaid: "1234"           # Plaid mask; keep the quotes
        actual: Chase Checking # Actual account name
      - plaid: BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp
        actual: Joint Visa
```

The `|` embeds the accounts file as text; keep everything beneath it indented as shown. The supplied CronJob mounts this ConfigMap at `/config` and sets `ACCOUNTS_FILE=/config/accounts.yaml`. After editing mappings, reapply the manifest so future runs use the updated file.

To run immediately and watch the output:

```bash
kubectl create job --from=cronjob/actual-plaid-sync actual-plaid-sync-manual
kubectl logs -f job/actual-plaid-sync-manual
```

Choose a new Job name for each manual run, or delete the previous Job first. Each mapped account logs a summary, such as `Chase Checking: 5 added, 2 posted, 1 amount updated, 1 cancelled hold, 0 skipped`.

## Run sync with Docker

The image supports `linux/amd64` and `linux/arm64`. After creating `.env` and `accounts.yaml` with the setup steps above, you can preview a sync with:

```bash
docker run --rm --network host --env-file .env \
  -e DRY_RUN=true \
  -e ACCOUNTS_FILE=/config/accounts.yaml \
  -v "$PWD/accounts.yaml:/config/accounts.yaml:ro" \
  ghcr.io/msheiny/actual-plaid-sync:0.1.0 sync
```

Change `-e DRY_RUN=true` to `-e DRY_RUN=false` to apply changes. The accounts file must already exist for this read-only mount. Host networking lets the container reach an Actual server at `localhost:5006`; your container runtime must support it.

## Repair a bank connection

If a run reports `ITEM_LOGIN_REQUIRED`, `PENDING_EXPIRATION`, or `PENDING_DISCONNECT`, repair the existing login. Logs identify its position in `PLAID_ACCESS_TOKENS` and its last characters, such as `Bank 2 (…a1b2)`.

Run the dedicated update task:

```bash
mise run link:update
```

Choose the numbered bank identified by the failing sync log, then open the printed URL and complete the bank's prompts. The picker reads `PLAID_ACCESS_TOKENS` from `.env` and displays each token's position and last four characters. If only one token is configured, it is selected automatically. Update mode keeps the existing access token, so you do not need to replace it in `.env` or the deployment Secret. Prefer repairing a connection over creating a new Item.

For scripts or other non-interactive use, run `mise run link:update -- --access-token <token>`. An explicit `--access-token` still overrides `LINK_ACCESS_TOKEN` and the picker.

## Configuration reference

Mise reads `.env`; direct CLI use reads the process environment, and the Docker example loads `.env` with `--env-file`. Defaults below apply when a variable is unset or blank. **`DRY_RUN` defaults to `false` (apply changes); the walkthrough explicitly sets it to `true` (preview).**

| Variable | Used by | Default | Meaning |
|---|---|---|---|
| `PLAID_CLIENT_ID` | all | required | Plaid client ID |
| `PLAID_SECRET` | all | required | Secret for the selected Plaid environment |
| `PLAID_ENV` | all | required | `sandbox` or `production` |
| `PLAID_COUNTRY_CODES` | link | `US` | Comma-separated country codes |
| `PLAID_ACCESS_TOKENS` | accounts, sync, link:update | required for accounts and sync | Comma-separated tokens, one per bank login; update mode presents them in its picker |
| `ACTUAL_SERVER_URL` | accounts, sync | required | Actual server URL |
| `ACTUAL_PASSWORD` | accounts, sync | required | Actual server login password |
| `ACTUAL_SYNC_ID` | accounts, sync | required | Budget's Sync ID from Settings → Show advanced settings → IDs |
| `ACTUAL_ENCRYPTION_PASSWORD` | accounts, sync | unset | Password for an end-to-end encrypted budget |
| `ACCOUNTS_FILE` | accounts, sync | `accounts.yaml` | Output file for `accounts`; input file for `sync`. Relative paths start at the working directory. |
| `SYNC_DAYS` | sync | `30` | Days of history to fetch, from `1` to `730` |
| `DRY_RUN` | sync | `false` | `true`: preview transaction changes and skip billable refresh. `false`: apply them. |
| `PLAID_REFRESH_TRANSACTIONS` | sync | `false` | Refresh each bank before fetching transactions; skipped during dry runs. Accepts `true`, `false`, `1`, or `0`. |
| `LINK_PORT` | link | `8484` | Port for the local Link page |
| `LINK_HOST` | link | `127.0.0.1` | Address the Link server listens on |
| `LINK_ACCESS_TOKEN` | link:update / link --update | unset | Existing token to repair; bypasses the `PLAID_ACCESS_TOKENS` picker |
| `LOG_LEVEL` | all | `info` | `debug`, `info`, `warn`, or `error` |

Exit codes: `0` success, `1` runtime failure, `2` invalid configuration or command usage. During sync, a failed bank or mapping does not stop healthy accounts from syncing; the command still exits with `1`.

### Optional transaction refresh

To request fresh bank data before importing, set `PLAID_REFRESH_TRANSACTIONS=true` in `.env` or pass it for one run:

```bash
PLAID_REFRESH_TRANSACTIONS=true DRY_RUN=false mise run sync
```

Sync checks `/item/get` for the Transactions product, then waits for `/transactions/refresh` to finish before fetching that token's transactions. Refresh runs once per configured token, before pagination, subject to the existing retry policy (up to four attempts for transient failures). An Item without Transactions initialized skips refresh with a `TRANSACTIONS_NOT_INITIALIZED` warning and proceeds with the normal transaction fetch. `DRY_RUN=true` skips both the product check and refresh and previews cached data.

If the product check or refresh fails, sync logs a warning and fetches transactions normally for the same bank using Plaid's cached data. A refresh failure alone does not fail the run; normal fetch and import error handling still applies. Logs use the existing masked bank identifiers and safe Plaid errors.

[Plaid refresh](https://plaid.com/docs/api/products/transactions/#transactionsrefresh) requires separate product access through the Dashboard or your account manager and has a separate add-on fee model. Capital One (`ins_128026`) Items containing only non-depository accounts return `PRODUCTS_NOT_SUPPORTED`. Refresh typically adds under 10 seconds per bank, but can take 30 seconds or more. Allow extra time for all banks and retries in network and scheduler timeouts; the example CronJob has a 900-second deadline. This client does not set an HTTP timeout.

### Accounts file

`sync` processes only the accounts listed in this file:

```yaml
accounts:
  - plaid: "1234"            # Plaid mask (last digits); keep the quotes
    actual: Chase Checking   # Actual account name
  - plaid: BxBXxLj1m4HMXBm9WZZmCWVbPjX16EHwv99vp
    actual: Joint Visa
```

- `plaid`: an account ID from the `accounts` output, or a quoted digits-only mask. Use an ID when accounts share a mask or no mask is available. Unquoted masks are rejected because YAML can interpret them as numbers and drop leading zeros. The explicit form `{ id: ... }` is also accepted.
- `actual`: the name of an open Actual account, matched without regard to case or surrounding whitespace. Update the file if you rename the account.
- Each Plaid account and each Actual account can appear only once.
- If you link a bank from scratch again, review the mappings because account IDs may change.

## How pending transactions are handled

- Pending transactions arrive **uncleared**; posted transactions arrive **cleared**.
- When Plaid links a posted transaction to its pending version, the existing Actual row gets the posted ID, amount, date, and cleared flag. Your payee, category, and notes are kept.
- Changes to a pending amount or date update the existing row while it remains uncleared.
- An uncleared imported row that disappears from Plaid is treated as a cancelled hold and deleted. To avoid deleting rows near the start of the fetch window, this only applies to rows dated at least 3 days after the window starts. Older rows get a log notice for manual review.
- Reconciled transactions and split parents are skipped when an update or deletion would affect them, with a log notice.
- A pending transaction you delete in Actual can return when it posts, because the posted transaction has a new ID.
- Actual may match a new import to a manually entered uncleared transaction. If the hold is later cancelled, that matched row may be deleted. The sync logs a warning when an import matches an existing row.
- If Plaid does not link the pending and posted versions, the posted transaction is imported separately. The old pending row is removed under the cancelled-hold rules above; its category and other edits do not transfer to the new row.

## Development

```bash
mise run install      # install project dependencies before checks
mise run check        # lint, typecheck, and unit tests
mise run build        # install dependencies and compile to dist/
```

Node and pnpm versions are pinned in `mise.toml` and `mise.lock`. `mise tasks` lists all tasks. Unit tests use test configuration rather than your bank credentials.

For end-to-end tests, set `PLAID_SANDBOX_CLIENT_ID` and `PLAID_SANDBOX_SECRET` in `.env` or your shell, then use a fresh test server (the test sets its own password):

```bash
mise run actual:start
mise run build
mise run e2e
mise run actual:stop
```

Stop any previous test server before starting this one. Without the two Sandbox variables, the sync test suite is skipped. CI runs it when repository secrets of the same names are available.

### Optional GitHub CI secrets

In your GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret** and add these values from **Plaid Dashboard → Developers → Keys**:

| Repository secret | Value |
| --- | --- |
| `PLAID_SANDBOX_CLIENT_ID` | Your Plaid client ID |
| `PLAID_SANDBOX_SECRET` | Your Plaid **Sandbox** secret |

CI creates a disposable Actual server with the test password in the workflow and generates its own Sandbox access token. Production credentials, existing bank access tokens, and your real Actual server credentials are unnecessary. Without these two secrets, the end-to-end test skips; lint, typecheck, unit tests, and Docker checks still run. Fork pull requests also skip this test because GitHub does not provide repository secrets to them.

## Releasing

Create and push a version tag, using the version being released:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release workflow publishes `ghcr.io/msheiny/actual-plaid-sync:0.1.0` and `:0.1`, with SBOM and provenance attestations. Pushes to `main` also publish `:edge` and `:sha-<short>`.

After the first publish, make the package public in GitHub: **Packages → actual-plaid-sync → Package settings → Change visibility → Public**.

When updating `@actual-app/api`, update the compatibility table above and the Actual server images in `.github/workflows/ci.yml` and the `actual:start` task in `mise.toml`.
