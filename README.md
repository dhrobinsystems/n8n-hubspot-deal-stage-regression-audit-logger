# n8n-hubspot-deal-stage-regression-audit-logger

> DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.

An n8n workflow that watches HubSpot deal stage changes and catches **regressions**: deals that move backwards in the pipeline, for example from "Contract Sent" or "Decision Maker Bought-In" back to "Qualified To Buy" or "Appointment Scheduled". For each regression it:

1. **Checks the reason.** It verifies that a mandatory regression reason property is filled in, after a short grace period so the rep has time to type it.
2. **Handles a missing reason.** It flags the audit row and creates a HubSpot task for the deal owner.
3. **Logs the event** to an audit tracking table: deal ID, deal name, owner, previous stage, new stage, timestamp, regression reason and more.
4. **Alerts sales leadership** in Slack.

I built it because pipeline regressions are where forecast accuracy quietly erodes. A deal that slips from contract back to discovery without a reason changes the forecast while nobody sees why. Leadership should see that move the same day, with the reason attached or flagged as missing.

Out of the box it is **offline and read-only**:

- While `HUBSPOT_PRIVATE_APP_TOKEN` is a placeholder, it runs against bundled fictional deals (Acme Corp, Example Company Inc.) and makes no network calls.
- `DRY_RUN=true` and `SANDBOX_MODE=true` stay on unless they are explicitly set to `false`.

---

## Contents

1. [Architecture overview](#architecture-overview)
2. [How regressions are detected](#how-regressions-are-detected)
3. [The mandatory regression reason](#the-mandatory-regression-reason)
4. [Audit tracking table](#audit-tracking-table)
5. [Leadership notification](#leadership-notification)
6. [Safety model](#safety-model)
7. [Prerequisites](#prerequisites)
8. [Installation](#installation)
9. [Webhook setup guide](#webhook-setup-guide)
10. [Environment variables](#environment-variables)
11. [Node reference](#node-reference)
12. [Error handling](#error-handling)
13. [CLI, tests and lint](#cli-tests-and-lint)
14. [Repository layout](#repository-layout)
15. [Limits and what I could not verify](#limits-and-what-i-could-not-verify)
16. [Disclaimer and license](#️-disclaimer--liability-limitation)

---

## Architecture overview

```
HubSpot (workflow "Send a webhook" or app webhook subscription on dealstage)
   │
   ▼
Deal Stage Change Webhook ─▶ Validate Intake ─┬─▶ Respond to Webhook (202 / 200 duplicate / 400 / 401 / 503)
                                              └─▶ Intake Accepted? ─no─▶ Raise If Misconfigured
Manual Run ─▶ Build Manual Batch ──────────────────────┐ yes
                                                       ▼
                       Load Config & Route ─▶ Demo Mode? ─yes─▶ Run Demo Audit ──────────────────────────┐
                                                     │ no                                                 │
  HubSpot: Get Account Details ▶ Enforce Sandbox & Plan Reads                                             │
  ▶ HubSpot: Get Deal Pipelines ▶ HubSpot: List Owners ▶ Plan Deal Reads                                  │
  ▶ HubSpot: Get Deal With Stage History ▶ Tag Deal Responses ▶ Detect Stage Regressions                  │
  ▶ Regressions Found? ─no──────────────────────────────────────────────────────────────────▶ Finalize Run│
        │ yes                                                                                             │
  ▶ Reason Grace Period? ─yes─▶ Wait for Regression Reason ▶ Plan Reason Re-check                         │
        │ no                    ▶ HubSpot: Re-read Regression Reason ▶ Tag Re-check Responses             │
  ▶ Build Audit Records ◀──────────────────────────────────────────┘                                      │
  ▶ Plan Audit Table Writes ▶ Audit Table: Upsert Rows (Airtable) ▶ Tag Audit Table Results               │
  ▶ Plan Owner Tasks ▶ HubSpot: Create Owner Task ▶ Tag Task Results                                      │
  ▶ Build Leadership Alert ◀──────────────────────────────────────────────────────────────────────────────┘
  ▶ Send Leadership Alert? ▶ Slack: Notify Sales Leadership ▶ Finalize Run

On Workflow Error ▶ Build Redacted Failure Alert ▶ Failure Alert Enabled? ▶ Slack: Send Failure Alert
```

- **Intake.** The webhook authenticates the request, either with a shared-secret header or HubSpot's v3 signature. It extracts `dealstage` change events, drops replayed event IDs and answers straight away.
- **Context.** One run reads the pipeline definitions (stage order comes from `displayOrder`, so custom pipelines work), the owner list and each deal **with its stage and reason history**. HubSpot's stage-change webhook carries only the new stage, so the previous stage comes from `propertiesWithHistory`.
- **Detection.** The workflow locates the exact change in the history, finds the stage it came from and classifies the transition.
- **Reason check.** It checks the reason property. If any reason is missing, a Wait node pauses for `REASON_GRACE_MINUTES` and the reason is read again.
- **Outputs.** Audit rows go to the tracking table, owners get tasks for missing reasons, and leadership gets one Slack message per batch.

All logic lives in `src/core/*.js`, and `scripts/build-workflow.js` embeds it into the Code nodes of `workflow.json`. The HTTP Request nodes execute the requests those Code nodes plan. The Node.js mirror (`src/core/pipeline.js`) runs the same functions in the same order. The tests run the generated workflow in a simulator and require the same records, Airtable rows, HubSpot tasks and Slack payload as the mirror.

---

## How regressions are detected

| Transition | Example | Counted as a regression? | Severity |
|---|---|---|---|
| `regression` | Contract Sent → Appointment Scheduled (4 stages back) | yes, when stages back ≥ `REGRESSION_MIN_STEPS` | `high` when ≥ `HIGH_SEVERITY_STEPS`, else `normal` |
| `reopened` | Closed Won → Contract Sent | yes (`TRACK_REOPENED_DEALS=true`) | high |
| `closed_reversal` | Closed Won → Closed Lost | yes (`TRACK_CLOSED_REVERSALS=true`) | high |
| `forward` | Qualified To Buy → Presentation Scheduled | no | none |
| `closed` | Contract Sent → Closed Lost | no; losing a deal is not a regression | none |
| `pipeline_change` | Renewals → Sales Pipeline | only with `PIPELINE_CHANGE_POLICY=probability` and a drop in win probability | normal |
| `unknown_stage` | a stage missing from the pipelines API | no; the event is skipped and counted | none |

"Stages back" counts **open** stages between the two positions, so closed stages never inflate the count. `PIPELINE_IDS` limits monitoring to specific pipelines.

---

## The mandatory regression reason

1. **Create the property.** In HubSpot go to *Settings → Properties → Deal properties → Create property*. Use the label "Regression Reason" and the internal name `deal_regression_reason`. A dropdown works best for reporting (for example: budget frozen, champion left, timeline slipped, scope change, competitor re-evaluation, data correction). Multi-line text also works. If you use another internal name, set `REGRESSION_REASON_PROPERTY` to it.
2. **Understand what counts as a reason.** A reason is valid only when both of these are true:
   - It is at least `REASON_MIN_LENGTH` characters long (3 by default; dropdown values pass easily).
   - It was written **after the deal entered the later stage it fell back from**.

   A reason left over from an earlier regression counts as **stale**, which is treated like missing. Without this check, a deal that regressed in March would carry the March reason into every later regression.
3. **Set the grace period.** Reps usually move the stage first and type the reason a minute later. With `REASON_GRACE_MINUTES=15` (the default), a regression without a reason pauses on the n8n **Wait** node, then the reason is read again. Only after that second read does it count as missing. Set it to `0` to judge immediately.
4. **Missing reason handling path.** When the reason is missing or stale:
   - the audit row gets `Reason Status = missing` (or `stale`)
   - the Slack alert flags it with :warning:
   - a HubSpot task is created for the deal owner ("Add a regression reason: …", due in `TASK_DUE_HOURS`), when `CREATE_OWNER_TASKS=true`

   To make the alert only about undocumented regressions, set `ALERT_ONLY_MISSING_REASON=true`.

---

## Audit tracking table

| Column | Example |
|---|---|
| Audit Key | `9001:1794822600000` (deal ID and change timestamp; the upsert key) |
| Deal ID / Deal Name / Deal URL | `9001` / Acme Corp - Platform Rollout / record link |
| Pipeline | Sales Pipeline |
| Previous Stage / New Stage | Contract Sent / Appointment Scheduled |
| Transition / Steps Back / Severity | regression / 4 / high |
| Amount / Currency | 120000 / USD |
| Owner / Owner Email | Avery Example / (only with `INCLUDE_OWNER_EMAIL=true`) |
| Changed By / Change Source | Avery Example / CRM_UI |
| Regressed At / Detected At | ISO timestamps |
| Regression Reason / Reason Status | Budget frozen until the next fiscal year / provided |
| Run Mode | dry_run, sandbox or live |

There are two providers:

- **`AUDIT_TABLE_PROVIDER=static`** (default, no setup). The newest `STATIC_AUDIT_ROW_LIMIT` rows (200) are kept in n8n workflow static data, keyed by Audit Key. This is good for trials. n8n only persists static data for active, production executions.
- **`AUDIT_TABLE_PROVIDER=airtable`** (durable).
  1. Create a table named `Deal Stage Regressions` (or set `AIRTABLE_TABLE_NAME`) with the columns above. Text fields work everywhere, and `typecast: true` lets Airtable convert values into number, date and single-select fields.
  2. Create a personal access token with `data.records:write` on that base.
  3. Set `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID`.

  Rows are **upserted on "Audit Key"**, so a retried webhook updates the existing row instead of adding a duplicate.

To use a different table (Google Sheets, a database, n8n Data Tables), replace the **Audit Table: Upsert Rows (Airtable)** node. The record fields are already flat in `records` on **Build Audit Records**.

---

## Leadership notification

**Slack: Notify Sales Leadership** posts one Block Kit message per batch. Each regression shows:

- the deal (linked), the amount, the stage move and the pipeline
- the owner, who changed the stage and when
- the reason, or a :warning: flag when it is missing or stale

The footer summarises the audit-row and owner-task outcome.

| Setting | Effect |
|---|---|
| `ALERT_MIN_SEVERITY=high` | Only high-severity regressions |
| `ALERT_MIN_AMOUNT=50000` | Only deals at or above an amount |
| `ALERT_ONLY_MISSING_REASON=true` | Only undocumented regressions |
| `ALERT_MAX_LISTED=10` | How many deals one message lists |

Production Slack (`SLACK_WEBHOOK_URL`) is used only when `DRY_RUN=false` and `SANDBOX_MODE=false`. Otherwise alerts go to `SLACK_SANDBOX_WEBHOOK_URL`, or are only logged while that is a placeholder.

**Email instead of Slack.** Replace the Slack node with n8n's *Send Email* node. Use `{{ $json.message.text }}` as the subject, and build the body from `{{ $json.records }}` on **Build Leadership Alert**.

---

## Safety model

| Layer | Default | Effect |
|---|---|---|
| Demo mode | on while the token is a placeholder | Bundled fictional deals behind a mock HubSpot, no network |
| `DRY_RUN` | `true` | Detects, logs to static data and alerts the sandbox channel. No HubSpot tasks, no Airtable rows. |
| `SANDBOX_MODE` | `true` | Reads `/account-info/v3/details` and stops unless the portal is `SANDBOX` or `DEVELOPER_TEST`, or matches `HUBSPOT_SANDBOX_PORTAL_ID`. Production Slack is never used. |
| Live-mode lock | | When `DRY_RUN=false` and `SANDBOX_MODE=false`, the workflow refuses to start with a placeholder token |
| Webhook authentication | shared secret | Constant-time comparison, at least 24 characters. HubSpot v3 signatures are checked with a 5-minute timestamp window. Wrong credentials get `401`. Misconfiguration gets `503` and fails the execution, so the error branch alerts. |
| Replay protection | 24 hours | Event IDs are remembered in static data. Replays get `200 duplicates` and are not processed. |
| Idempotent audit rows | | Airtable upsert on Audit Key, and the static table is keyed too |
| No credentials in the export | | Every token and webhook URL is read from `$env` inside HTTP expressions. No node stores credentials, and successful executions are not saved. |
| Redacted failure alerts | | Tokens, secrets, Slack URLs and token query parameters are removed |
| Privacy | | Owner emails stay out of the audit table unless `INCLUDE_OWNER_EMAIL=true` |

---

## Prerequisites

- **n8n** 1.x (self-hosted, or any plan with environment variables), with these nodes: Webhook v2, Respond to Webhook v1.1, Code v2, IF v2, Wait v1.1, HTTP Request v4.2 and Error Trigger.
- **n8n host settings:**
  - `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, so Code nodes and expressions can read `$env`
  - `NODE_FUNCTION_ALLOW_BUILTIN=crypto`, so the intake node can verify signatures
  - a persistent database, so waiting executions survive restarts
- **A HubSpot private app**, starting in a sandbox or developer test account, with:
  - `crm.objects.deals.read` (deals, pipelines and property history)
  - `crm.objects.owners.read`
  - the write scope your portal requires for creating tasks associated with deals, only if `CREATE_OWNER_TASKS=true`. Check the task permissions in the private app's scope list.
- **Slack incoming webhooks:** one for a test channel and one for the sales-leadership channel.
- **Optional:** an Airtable base and personal access token.
- **Node.js 20+** for the CLI, tests and lint. There are no npm dependencies.

---

## Installation

1. **Try the demo locally:**
   ```bash
   npm run verify      # lint + workflow freshness check + 35 tests
   npm run demo        # 8 fictional stage changes, 5 regressions, no network
   ```
2. **Import into n8n.** In n8n choose *Workflows → Import from File* and pick `workflow.json`. It imports inactive. Run **Manual Run** to see the demo; **Finalize Run** shows the summary.
3. **Configure n8n.** Set the host settings above and the variables from `.env.example`, then restart n8n. Code nodes cannot read files, so everything arrives through `$env`.
4. **Create the reason property** in your HubSpot sandbox (see [above](#the-mandatory-regression-reason)).
5. **Run a sandbox dry run.** Set the sandbox token, `WEBHOOK_SECRET` (for example from `openssl rand -hex 24`), `SLACK_SANDBOX_WEBHOOK_URL` and `MANUAL_TEST_DEAL_IDS`. Move a test deal backwards, then run **Manual Run**. Manual runs audit the latest stage change of each listed deal.
6. **Connect the webhook** (next section) and activate the workflow.
7. **Enable writes in the sandbox.** Set `DRY_RUN=false`, and optionally `AUDIT_TABLE_PROVIDER=airtable`. Check the Airtable rows and owner tasks, then replay a webhook and confirm the row count does not change.
8. **Go to production.** Use the production token, set `SANDBOX_MODE=false`, `DRY_RUN=false` and `SLACK_WEBHOOK_URL`.

---

## Webhook setup guide

Both options post to `https://<your-n8n-host>/webhook/deal-stage-regression`, the production URL shown on the **Deal Stage Change Webhook** node.

### Option A: HubSpot workflow "Send a webhook" (recommended, `WEBHOOK_AUTH_MODE=shared_secret`)

1. **Create the workflow.** In HubSpot go to *Automation → Workflows → Create workflow → Deal-based*.
2. **Set the enrollment trigger.** Use *Deal stage* "is any of" all stages of the monitored pipelines, or *Property value changed: Deal stage*. Turn on **re-enrollment** for the deal stage trigger, so every stage change fires.
3. **Add the action.** Add **Send a webhook**:
   - method `POST`
   - webhook URL: the n8n production URL
   - authentication: *API key*, with the key name `x-webhook-secret` (or your `WEBHOOK_SECRET_HEADER`) and the value `WEBHOOK_SECRET`, placed in the request header
   - request body: include the **Record ID**. The workflow accepts `objectId`, `hs_object_id` or `dealId`.
4. **Turn the workflow on.** Each call audits the deal's latest stage change from its history.

HubSpot workflow webhooks are available on Operations Hub Professional or Enterprise. Check your portal's tier.

### Option B: HubSpot app webhook subscription (`WEBHOOK_AUTH_MODE=hubspot_v3`)

1. **Subscribe.** In your HubSpot developer app (or project app), add the webhook target URL and subscribe to **Deal → Property change → `dealstage`**.
2. **Set the signature variables:**
   - `HUBSPOT_APP_CLIENT_SECRET`: the app's client secret
   - `WEBHOOK_PUBLIC_URL`: the exact URL HubSpot calls, including the scheme and path

   The intake verifies `X-HubSpot-Signature-v3`: base64 HMAC-SHA256 of `POST` + URL + body + `X-HubSpot-Request-Timestamp`. Requests older than `WEBHOOK_MAX_AGE_MINUTES` are rejected.
3. **Install the app** in the portal. Events arrive in batches (`[{ eventId, objectId, propertyName: "dealstage", propertyValue, occurredAt, … }]`), and each event is matched to its own change in the stage history.

**Testing without HubSpot.** You can send the sample payload yourself:

```bash
curl -X POST "https://<your-n8n-host>/webhook-test/deal-stage-regression" \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: YOUR_WEBHOOK_SECRET" \
  --data @fixtures/sample-webhook-events.json
```

In demo mode the sample events match the bundled deals.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `HUBSPOT_PRIVATE_APP_TOKEN` | `YOUR_HUBSPOT_PRIVATE_APP_TOKEN` | Private app token. A placeholder means demo mode. |
| `HUBSPOT_BASE_URL` | `https://api.hubapi.com` | API base URL |
| `HUBSPOT_SANDBOX_PORTAL_ID` | placeholder | Portal that `SANDBOX_MODE` also accepts |
| `DRY_RUN` / `SANDBOX_MODE` | `true` / `true` | Safety switches |
| `WEBHOOK_AUTH_MODE` | `shared_secret` | `shared_secret` or `hubspot_v3` |
| `WEBHOOK_SECRET` / `WEBHOOK_SECRET_HEADER` | `YOUR_WEBHOOK_SECRET` / `x-webhook-secret` | Shared-secret authentication |
| `HUBSPOT_APP_CLIENT_SECRET` / `WEBHOOK_PUBLIC_URL` | placeholders | v3 signature verification |
| `WEBHOOK_MAX_AGE_MINUTES` / `MAX_EVENTS_PER_REQUEST` | `5` / `100` | Signature window and batch cap |
| `PIPELINE_IDS` | empty (all) | Pipelines to monitor |
| `REGRESSION_MIN_STEPS` / `HIGH_SEVERITY_STEPS` | `1` / `2` | Detection threshold and severity |
| `TRACK_REOPENED_DEALS` / `TRACK_CLOSED_REVERSALS` | `true` / `true` | Closed → open, and won → lost |
| `PIPELINE_CHANGE_POLICY` | `ignore` | `ignore` or `probability` |
| `REGRESSION_REASON_PROPERTY` | `deal_regression_reason` | Mandatory reason property |
| `REASON_MIN_LENGTH` / `REASON_GRACE_MINUTES` | `3` / `15` | Reason validity and grace period |
| `CREATE_OWNER_TASKS` / `TASK_DUE_HOURS` | `true` / `24` | Missing-reason handling path |
| `AUDIT_TABLE_PROVIDER` | `static` | `static` or `airtable` |
| `AIRTABLE_TOKEN` / `AIRTABLE_BASE_ID` / `AIRTABLE_TABLE_NAME` | placeholders / `Deal Stage Regressions` | Airtable table |
| `STATIC_AUDIT_ROW_LIMIT` / `INCLUDE_OWNER_EMAIL` | `200` / `false` | Static-table size, owner-email privacy |
| `SLACK_WEBHOOK_URL` / `SLACK_SANDBOX_WEBHOOK_URL` | `YOUR_SLACK_WEBHOOK_URL` / placeholder | Leadership and test channels |
| `ALERT_MIN_SEVERITY` / `ALERT_MIN_AMOUNT` / `ALERT_ONLY_MISSING_REASON` / `ALERT_MAX_LISTED` | `normal` / `0` / `false` / `10` | Alert filters |
| `MANUAL_TEST_DEAL_IDS` | placeholder | Deals that **Manual Run** audits in HubSpot mode |
| `AUDIT_NOW` | empty | Testing only: pins the clock |

---

## Node reference

| Node | Notes |
|---|---|
| **Deal Stage Change Webhook** | `POST /webhook/deal-stage-regression`, responds through **Respond to Webhook** |
| **Validate Intake** | Authentication, event extraction and de-duplication. Uses `require('crypto')`. |
| **Respond to Webhook** | Status from `$json.statusCode`. Runs on a parallel branch, so processing continues after the reply. |
| **HubSpot: Get Account Details** | Sandbox check. Header `=Bearer {{ $env.HUBSPOT_PRIVATE_APP_TOKEN }}`. |
| **HubSpot: Get Deal Pipelines** | `GET /crm/v3/pipelines/deals` |
| **HubSpot: List Owners** | `GET /crm/v3/owners`, paginated (up to 10 pages of 500) |
| **HubSpot: Get Deal With Stage History** | `GET /crm/v3/objects/deals/{id}?properties=…&propertiesWithHistory=dealstage,<reason>`. Batched at 5 per second. Continues on error, so an unreadable deal is skipped and counted. |
| **Detect Stage Regressions** | Classification and the first reason check |
| **Wait for Regression Reason** | Resumes after `REASON_GRACE_MINUTES` minutes (`amount: {{ $json.waitMinutes }}`, unit minutes) |
| **HubSpot: Re-read Regression Reason** | Reads only the reason property and its history |
| **Build Audit Records** | Flat audit rows, plus the static-table upsert |
| **Audit Table: Upsert Rows (Airtable)** | `PATCH /v0/{base}/{table}` with `performUpsert` on "Audit Key". Batches of 10. Header `=Bearer {{ $env.AIRTABLE_TOKEN }}`. |
| **HubSpot: Create Owner Task** | `POST /crm/v3/objects/tasks`, associated with the deal (type 216) |
| **Slack: Notify Sales Leadership** | URL `={{ $json.slackTarget === 'production' ? $env.SLACK_WEBHOOK_URL : $env.SLACK_SANDBOX_WEBHOOK_URL }}` |
| **Finalize Run** | Daily counters (30 days) and the run summary. Fails the execution if any audit row or owner task failed. |
| **On Workflow Error → Slack: Send Failure Alert** | Set *Workflow Settings → Error Workflow* to this workflow, or copy these four nodes into a dedicated error workflow |

All HTTP nodes retry 2 to 3 times, 2 seconds apart.

---

## Error handling

| Symptom | Meaning | Action |
|---|---|---|
| `401` from the webhook | Wrong secret, or an invalid or expired v3 signature | Check the header name and value, `WEBHOOK_PUBLIC_URL` and the app client secret. |
| `503`, plus a failure alert | Configuration invalid | The alert and execution error list each problem. |
| `200` with `duplicates` | A replayed batch | Nothing to do. |
| "SANDBOX_MODE=true, but the connected portal…" | Production token in sandbox mode | Use the sandbox token or set `SANDBOX_MODE=false` on purpose. |
| "No deal could be read" | Every deal read failed | Check the token scopes and the deal IDs. |
| Skipped events with `stage_change_not_in_history` | The change is not in the deal's stage history | Usually a deleted deal or a test payload. The event is counted and skipped. |
| Execution fails at **Finalize Run** | An Airtable row or owner task failed | Successful writes were kept, and the Slack alert was already sent. Fix the cause (Airtable columns, task scope) and re-send the event. Rows are upserted. |

---

## CLI, tests and lint

| Command | Purpose |
|---|---|
| `npm run demo` (`-- --json` for full output) | Offline demo |
| `npm run replay -- fixtures/sample-webhook-events.json [--no-wait]` | Replay a saved webhook payload through the configured environment. State persists in `data/state.json`. |
| `npm run audit:deals -- 123,456` | Audit the latest stage change of specific deals |
| `npm run lint` | Syntax, JSON, license headers, secrets, example-only emails and documentation voice |
| `npm test` | 35 tests |
| `npm run check:workflow` / `npm run build:workflow` | Check or regenerate `workflow.json` from `src/core` |

The tests cover:

- **`tests/regression.test.js`:**
  - configuration safety
  - shared-secret and v3-signature intake, event extraction and replay protection
  - every transition type and detection switch
  - locating changes in history
  - provided, missing, too-short and stale reasons
  - sandbox enforcement and task payloads
  - Airtable upsert batching and the static table
  - alert filters, alert content and redaction
  - the demo classification
  - sandbox writes with idempotent replays
  - Slack delivery and HTTP retries
- **`tests/workflow.test.js`** runs `workflow.json` in `tests/n8n-simulator.js`. The simulator executes the real Code node source, IF and HTTP expressions, pagination, paired items, continue-on-error, Wait nodes and static data. The tests cover:
  - demo parity with the Node.js mirror
  - a full write run whose records, Airtable rows, HubSpot tasks and Slack payload equal the mirror's
  - dry-run behaviour
  - replay de-duplication
  - forward-only batches
  - grace period off
  - `401`, `503`, sandbox refusal, a failing Airtable write and the redacted error alert

---

## Repository layout

```
├── workflow.json                 generated n8n export (42 nodes)
├── .env.example                  every variable with safe defaults
├── fixtures/
│   └── sample-webhook-events.json  fictional HubSpot app webhook batch
├── src/
│   ├── core/
│   │   ├── config.js             loading, validation, safety switches, Slack target
│   │   ├── intake.js             shared secret, v3 signature, event extraction, replay protection
│   │   ├── stages.js             stage index, transition classification, history lookup
│   │   ├── regression.js         detection, reason checks, audit records, alert and task rules
│   │   ├── hubspot.js            HubSpot requests, sandbox check, owners, tasks
│   │   ├── auditTable.js         Airtable upserts, static table, daily counters
│   │   ├── slack.js              leadership alert, redacted failure alert
│   │   ├── pipeline.js           Node.js mirror and HTTP client
│   │   └── mocks.js              fictional demo portal, HubSpot and Airtable mocks
│   └── index.js                  CLI
├── scripts/
│   ├── build-workflow.js         embeds src/core into workflow.json
│   └── lint.js                   dependency-free lint
├── tests/                        node:test suites and the n8n simulator
├── DISCLAIMER.md
└── LICENSE
```

---

## Limits and what I could not verify

I tested against in-memory HubSpot and Airtable mocks and a workflow simulator, not against a live n8n instance, a live portal or the live Airtable API. Before relying on it, please confirm the following in your own environment:

- **v3 signatures and the raw body.** n8n hands Code nodes the parsed JSON body. The intake re-serialises it compactly, which matches HubSpot's compact payloads, but any re-encoding along the way breaks the signature. If verification fails while the secret is right, use Option A (shared secret), or enable the webhook's *Raw Body* option and adapt **Validate Intake** to read it.
- **n8n parameter names.** These follow the documented formats as I understand them; open each node after import and check:
  - the Wait node (`amount` and `unit`)
  - the HTTP Request pagination block
  - continue-on-error output items
  - `$('Node').itemMatching()` pairing
- **Waiting executions.** A run waiting on the grace period holds an n8n execution, so heavy regression days create many waiting executions. Keep a persistent database.
- **Property history.** `propertiesWithHistory` returns the history HubSpot retains. Very old changes or bulk imports may not appear, and those events are skipped.
- **Owner list.** It is read once per run, up to 5,000 owners.
- **Task scope.** The exact private-app scope for creating tasks depends on your HubSpot account, so check it when you create the app.

---

## Author

**DH Robin | dhRobin Systems**: [https://dhrobinsystems.com](https://dhrobinsystems.com)

I build revenue infrastructure: pipeline governance, CRM data integrity and automation for HubSpot portals. Issues and pull requests are welcome.

---

## ⚠️ Disclaimer & Liability Limitation

Use at your own risk. The code, workflows, and scripts provided in this repository (`n8n-hubspot-deal-stage-regression-audit-logger`) are for educational and architectural demonstration purposes.

* **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts.
* **No Warranty:** All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement.
* **Production Testing Required:** Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox) with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled before connecting live HubSpot credentials. Treat every owner task, audit row and leadership alert as visible to the people it names.
* **Third-Party APIs & Compliance:** Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), and security policies of HubSpot, Slack, Airtable and any connected services. That includes confirming who may see deal names, amounts, owner names and regression reasons, keeping owner emails out of the audit table unless permitted, and applying your retention policy to the audit table.

The full disclaimer is also available in [DISCLAIMER.md](https://github.com/dhrobinsystems/n8n-hubspot-deal-stage-regression-audit-logger/blob/main/DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](https://github.com/dhrobinsystems/n8n-hubspot-deal-stage-regression-audit-logger/blob/main/LICENSE).

License: MIT © 2026 dhRobin Systems

DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
