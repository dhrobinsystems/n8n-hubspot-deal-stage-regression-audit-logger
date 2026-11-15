#!/usr/bin/env node
// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Generates workflow.json from src/core/*.js. Each Code node receives the core modules it needs
 * (imports and `export` stripped) plus a short block of node logic; HTTP Request nodes execute the
 * requests those Code nodes plan. Secrets are only read from $env inside node expressions.
 *
 *   npm run build:workflow     regenerate
 *   npm run check:workflow     fail when workflow.json is out of date
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKFLOW_PATH = join(ROOT, 'workflow.json');
export const WORKFLOW_NAME = 'n8n-hubspot-deal-stage-regression-audit-logger';
export const WEBHOOK_PATH = 'deal-stage-regression';
export const LICENSE_LINE = 'DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.';

export const NODE = Object.freeze({
  webhook: 'Deal Stage Change Webhook',
  validate: 'Validate Intake',
  respond: 'Respond to Webhook',
  accepted: 'Intake Accepted?',
  raise: 'Raise If Misconfigured',
  manual: 'Manual Run',
  manualBatch: 'Build Manual Batch',
  route: 'Load Config & Route',
  isDemo: 'Demo Mode?',
  demo: 'Run Demo Audit',
  account: 'HubSpot: Get Account Details',
  enforce: 'Enforce Sandbox & Plan Reads',
  pipelines: 'HubSpot: Get Deal Pipelines',
  owners: 'HubSpot: List Owners',
  planDeals: 'Plan Deal Reads',
  getDeal: 'HubSpot: Get Deal With Stage History',
  tagDeals: 'Tag Deal Responses',
  detect: 'Detect Stage Regressions',
  found: 'Regressions Found?',
  needWait: 'Reason Grace Period?',
  wait: 'Wait for Regression Reason',
  planRecheck: 'Plan Reason Re-check',
  recheck: 'HubSpot: Re-read Regression Reason',
  tagRecheck: 'Tag Re-check Responses',
  build: 'Build Audit Records',
  planAudit: 'Plan Audit Table Writes',
  needAudit: 'Audit Table Writes Needed?',
  airtable: 'Audit Table: Upsert Rows (Airtable)',
  tagAudit: 'Tag Audit Table Results',
  planTasks: 'Plan Owner Tasks',
  needTasks: 'Owner Tasks Needed?',
  createTask: 'HubSpot: Create Owner Task',
  tagTasks: 'Tag Task Results',
  alert: 'Build Leadership Alert',
  needAlert: 'Send Leadership Alert?',
  slack: 'Slack: Notify Sales Leadership',
  finalize: 'Finalize Run',
  errorTrigger: 'On Workflow Error',
  buildFailure: 'Build Redacted Failure Alert',
  needFailure: 'Failure Alert Enabled?',
  sendFailure: 'Slack: Send Failure Alert',
  note: 'Read Me: Safety Defaults',
});

const MODULES = {
  config: 'src/core/config.js',
  intake: 'src/core/intake.js',
  stages: 'src/core/stages.js',
  hubspot: 'src/core/hubspot.js',
  regression: 'src/core/regression.js',
  auditTable: 'src/core/auditTable.js',
  slack: 'src/core/slack.js',
  mocks: 'src/core/mocks.js',
  pipeline: 'src/core/pipeline.js',
};
const ENGINE = ['config', 'stages', 'hubspot', 'regression', 'auditTable', 'slack'];
const ALL = Object.keys(MODULES);

export function stripModuleSyntax(source) {
  return source
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];[ \t]*\r?\n/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?function|const|let|class)/gm, '')
    .replace(new RegExp(`^// ${LICENSE_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n`, 'm'), '');
}

function topLevelNames(source) {
  const names = [];
  const pattern = /^(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|class)\s+([A-Za-z_$][\w$]*))/gm;
  let match;
  while ((match = pattern.exec(source))) names.push(match[1] || match[2]);
  return names;
}

const HELPERS = `
// ---- n8n node helpers ----
function nodeOutputs(name) {
  try {
    const reference = $(name);
    if (reference && reference.isExecuted === false) return [];
    return reference.all().map((item) => item.json);
  } catch (error) {
    return [];
  }
}
function firstOutput(name) {
  const outputs = nodeOutputs(name);
  return outputs.length ? outputs[0] : null;
}
function countPlanned(name) {
  return nodeOutputs(name).filter((json) => !json.skip).length;
}
function assertStageComplete(stage, expected, received) {
  if (expected !== received) throw new Error('Regression audit stopped: the ' + stage + ' stage planned ' + expected + ' request(s) but received ' + received + ' response(s).');
}
function runNow() {
  const route = firstOutput(${JSON.stringify(NODE.route)});
  const parsed = route ? Date.parse(route.now) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}
`;

export function embed(moduleKeys, logic) {
  const seen = new Map();
  const parts = [];
  for (const key of moduleKeys) {
    const source = stripModuleSyntax(readFileSync(join(ROOT, MODULES[key]), 'utf8'));
    for (const name of topLevelNames(source)) {
      if (seen.has(name)) throw new Error(`Top-level name "${name}" is declared in both ${seen.get(name)} and ${MODULES[key]}`);
      seen.set(name, MODULES[key]);
    }
    parts.push(`// ---- ${MODULES[key]} (embedded by scripts/build-workflow.js) ----\n${source.trim()}\n`);
  }
  for (const name of [...topLevelNames(HELPERS), ...topLevelNames(logic.trim())]) if (seen.has(name)) throw new Error(`"${name}" collides with ${seen.get(name)}`);
  return [`// ${LICENSE_LINE}`, '// Generated by scripts/build-workflow.js. Edit src/core and rebuild instead of editing here.', ...parts, HELPERS.trim(), '', '// ---- node logic ----', logic.trim(), ''].join('\n');
}

const N = (name) => JSON.stringify(NODE[name]);

const LOGIC = {
  validate: `
const crypto = require('crypto');
const config = loadAuditConfig($env);
const { errors } = validateAuditConfig(config);
const item = $input.first().json;
const hmacBase64 = (secret, text) => crypto.createHmac('sha256', secret).update(text, 'utf8').digest('base64');
const result = validateIntake({ headers: item.headers || {}, body: item.body, method: 'POST' }, config, errors, $getWorkflowStaticData('global'), resolveNow(config), hmacBase64);
return [{ json: { ...result, trigger: 'webhook' } }];`,
  raise: `
if ($input.first().json.configError) {
  const { errors } = validateAuditConfig(loadAuditConfig($env));
  throw new Error('Configuration invalid:\\n- ' + errors.join('\\n- '));
}
return [];`,
  manualBatch: `
const config = loadAuditConfig($env);
const now = resolveNow(config);
if (config.mode === 'demo') return [{ json: { trigger: 'manual', events: [], requestId: 'manual-' + now.toString(36) } }];
if (!config.manualTestDealIds.length) throw new Error('Set MANUAL_TEST_DEAL_IDS (comma-separated sandbox deal IDs) to run this workflow manually.');
const events = config.manualTestDealIds.map((dealId) => ({ eventId: null, dealId, newStageId: null, occurredAt: null, source: 'manual' }));
return [{ json: { trigger: 'manual', events, requestId: 'manual-' + now.toString(36) } }];`,
  route: `
const config = loadAuditConfig($env);
const { errors, warnings } = validateAuditConfig(config);
if (errors.length) throw new Error('Configuration invalid:\\n- ' + errors.join('\\n- '));
const item = $input.first().json;
return [{ json: { mode: config.mode, trigger: item.trigger, requestId: item.requestId, events: item.events, now: new Date(resolveNow(config)).toISOString(), safety: describeSafety(config), warnings, request: buildAccountDetailsRequest(config) } }];`,
  demo: `
const config = loadAuditConfig($env);
const route = $input.first().json;
const result = await runDemo({ config, events: route.trigger === 'manual' ? null : route.events, state: $getWorkflowStaticData('global'), requestId: route.requestId });
return [{ json: { stage: 'built', source: 'demo', records: result.records, counters: result.counters, waitMinutes: result.waitMinutes, auditResults: result.auditResults, taskResults: result.taskResults, taskCandidates: recordsNeedingTasks(result.records, config).map((record) => record.auditKey) } }];`,
  enforce: `
const config = loadAuditConfig($env);
const gate = enforceSandbox($input.first().json, config);
if (!gate.ok) throw new Error(gate.reason);
return [{ json: { portal: { portalId: gate.portalId, uiDomain: gate.uiDomain }, pipelinesRequest: buildPipelinesRequest(config), ownersRequest: buildOwnersRequest(config) } }];`,
  planDeals: `
const config = loadAuditConfig($env);
const route = firstOutput(${N('route')});
const dealIds = [...new Set(route.events.map((event) => event.dealId))];
return dealIds.map((dealId) => ({ json: { dealId, request: buildDealReadRequest(config, dealId) }, pairedItem: { item: 0 } }));`,
  tagDeals: `
return $input.all().map((item, index) => ({ json: parseDealResponse($(${N('planDeals')}).itemMatching(index).json.dealId, item.json), pairedItem: { item: index } }));`,
  detect: `
const config = loadAuditConfig($env);
const deals = $input.all().map((item) => item.json);
if (deals.length && deals.every((deal) => !deal.found)) throw new Error('No deal could be read (first error: ' + deals[0].error + '). Check the token scopes and the deal IDs.');
const index = buildStageIndex(firstOutput(${N('pipelines')}));
const evaluations = evaluateEvents(firstOutput(${N('route')}).events, deals, index, config);
const recheckIds = dealsNeedingRecheck(evaluations);
const waitMinutes = recheckIds.length && config.reason.graceMinutes > 0 ? config.reason.graceMinutes : 0;
const regressions = evaluations.filter((entry) => entry.outcome === 'regression').length;
return [{ json: { stage: 'detected', evaluations, recheckIds, waitMinutes, hasRegressions: regressions ? 'yes' : 'no', waitDecision: waitMinutes > 0 ? 'wait' : 'now' } }];`,
  planRecheck: `
const config = loadAuditConfig($env);
const { recheckIds } = firstOutput(${N('detect')});
return recheckIds.map((dealId) => ({ json: { dealId, request: buildReasonReadRequest(config, dealId) }, pairedItem: { item: 0 } }));`,
  tagRecheck: `
return $input.all().map((item, index) => ({ json: parseDealResponse($(${N('planRecheck')}).itemMatching(index).json.dealId, item.json), pairedItem: { item: index } }));`,
  build: `
const config = loadAuditConfig($env);
const detected = firstOutput(${N('detect')});
const rechecks = nodeOutputs(${N('tagRecheck')});
assertStageComplete('reason re-check', countPlanned(${N('planRecheck')}), rechecks.length);
const evaluations = applyReasonRechecks(detected.evaluations, rechecks, config);
const ownerPages = nodeOutputs(${N('owners')});
const owners = buildOwnerIndex({ results: ownerPages.flatMap((page) => page.results || []) }, { includeEmail: config.audit.includeOwnerEmail });
const portal = firstOutput(${N('enforce')}).portal;
const records = buildAuditRecords(evaluations, owners, portal, config, runNow());
appendStaticRows($getWorkflowStaticData('global'), records, config);
return [{ json: { stage: 'built', source: 'hubspot', records, counters: summarizeEvaluations(evaluations), waitMinutes: detected.waitMinutes, taskCandidates: recordsNeedingTasks(records, config).map((record) => record.auditKey) } }];`,
  planAudit: `
const config = loadAuditConfig($env);
const { records } = $input.first().json;
if (!records.length || !airtableEnabled(config) || config.dryRun) return [{ json: { stage: 'audit', skip: true } }];
return buildAirtableUpsertRequests(records, config).map((plan) => ({ json: { stage: 'audit', ...plan }, pairedItem: { item: 0 } }));`,
  tagAudit: `
return $input.all().map((item, index) => ({ json: parseAirtableResponse($(${N('planAudit')}).itemMatching(index).json, item.json), pairedItem: { item: index } }));`,
  planTasks: `
const config = loadAuditConfig($env);
const built = firstOutput(${N('build')});
const candidates = recordsNeedingTasks(built.records, config);
if (config.dryRun || !candidates.length) return [{ json: { stage: 'tasks', skip: true } }];
return candidates.map((record) => ({ json: { stage: 'tasks', auditKey: record.auditKey, request: buildOwnerTaskRequest(config, record, runNow()) }, pairedItem: { item: 0 } }));`,
  tagTasks: `
return $input.all().map((item, index) => ({ json: parseCreateResponse($(${N('planTasks')}).itemMatching(index).json.auditKey, item.json), pairedItem: { item: index } }));`,
  alert: `
const config = loadAuditConfig($env);
const route = firstOutput(${N('route')});
const built = firstOutput(${N('build')}) || firstOutput(${N('demo')});
let auditResults = built.auditResults || [];
let taskResults = built.taskResults || [];
if (built.source === 'hubspot') {
  auditResults = nodeOutputs(${N('tagAudit')});
  assertStageComplete('audit table', countPlanned(${N('planAudit')}), auditResults.length);
  taskResults = nodeOutputs(${N('tagTasks')});
  assertStageComplete('owner task', countPlanned(${N('planTasks')}), taskResults.length);
}
const alerted = recordsToAlert(built.records, config);
const message = alerted.length ? buildLeadershipAlert({ records: built.records, alerted, auditResults, taskResults, config, requestId: route.requestId }) : null;
const slack = resolveSlackTarget(config);
const totals = buildRunTotals({ counters: built.counters, auditResults, taskCandidates: built.taskCandidates, taskResults, alerted });
return [{ json: { source: built.source, send: message && slack.target !== 'preview' ? 'yes' : 'no', slackTarget: slack.target, slackReason: message ? slack.reason : 'no regressions matched the alert rules', message, totals, skipReasons: built.counters.skipReasons || {}, records: built.records } }];`,
  finalize: `
const config = loadAuditConfig($env);
const route = firstOutput(${N('route')});
const alert = firstOutput(${N('alert')});
const detected = firstOutput(${N('detect')});
let totals;
let source;
let records = [];
if (alert) {
  totals = alert.totals;
  source = alert.source;
  records = alert.records;
} else {
  source = 'hubspot';
  totals = buildRunTotals({ counters: summarizeEvaluations(detected.evaluations) });
}
const staticData = $getWorkflowStaticData('global');
const today = source === 'hubspot' ? recordDailyCounters(staticData, totals, runNow()) : (staticData.regressionDailyCounters || {})[route.now.slice(0, 10)];
const delivered = nodeOutputs(${N('slack')}).length > 0;
if (totals.auditWriteFailures > 0 || totals.taskFailures > 0) {
  throw new Error(totals.auditWriteFailures + ' audit table write(s) and ' + totals.taskFailures + ' owner task(s) failed in request ' + route.requestId + '. Successful writes were kept.');
}
return [{ json: {
  requestId: route.requestId,
  safety: route.safety,
  totals,
  today,
  slack: alert ? (delivered ? 'sent to the ' + alert.slackTarget + ' webhook' : 'not sent: ' + alert.slackReason) : 'not sent: no regressions',
  regressions: records.map((record) => ({ dealId: record.dealId, dealName: record.dealName, from: record.previousStage, to: record.newStage, type: record.transitionType, severity: record.severity, reasonStatus: record.reasonStatus })),
} }];`,
  buildFailure: `
const config = loadAuditConfig($env);
const data = $input.first().json || {};
const execution = data.execution || {};
const message = buildFailureAlert({
  errorMessage: execution.error && execution.error.message,
  lastNode: execution.lastNodeExecuted,
  executionId: execution.id,
  workflowName: data.workflow && data.workflow.name,
  config,
  secrets: [config.hubspot.token, config.audit.airtableToken, config.webhook.secret, config.webhook.appClientSecret],
});
const slack = resolveSlackTarget(config);
return [{ json: { send: slack.target === 'preview' ? 'no' : 'yes', slackTarget: slack.target, message } }];`,
};

function nodeId(name) {
  const hex = createHash('sha256').update(`${WORKFLOW_NAME}:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function code(name, position, modules, logic, notes) {
  return { parameters: { mode: 'runOnceForAllItems', jsCode: embed(modules, logic) }, id: nodeId(name), name, type: 'n8n-nodes-base.code', typeVersion: 2, position, ...(notes ? { notes, notesInFlow: false } : {}) };
}

function condition(name, position, leftValue, rightValue) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ id: nodeId(`${name}:condition`), leftValue, rightValue, operator: { type: 'string', operation: 'equals' } }],
        combinator: 'and',
      },
      options: {},
    },
    id: nodeId(name), name, type: 'n8n-nodes-base.if', typeVersion: 2, position,
  };
}

function http(name, position, { method, url, auth, body, continueOnError = false, batching = false, pagination = null, retries = 3, notes }) {
  const parameters = { method, url, options: { timeout: 20000 } };
  if (auth) { parameters.sendHeaders = true; parameters.headerParameters = { parameters: [{ name: 'Authorization', value: auth }] }; }
  if (body) { parameters.sendBody = true; parameters.specifyBody = 'json'; parameters.jsonBody = body; }
  if (batching) parameters.options.batching = { batch: { batchSize: 5, batchInterval: 1000 } };
  if (pagination) parameters.options.pagination = pagination;
  return {
    parameters, id: nodeId(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position,
    retryOnFail: true, maxTries: retries, waitBetweenTries: 2000,
    ...(continueOnError ? { onError: 'continueRegularOutput' } : {}),
    ...(notes ? { notes, notesInFlow: false } : {}),
  };
}

const HUBSPOT_AUTH = '=Bearer {{ $env.HUBSPOT_PRIVATE_APP_TOKEN }}';
const AIRTABLE_AUTH = '=Bearer {{ $env.AIRTABLE_TOKEN }}';
const SLACK_URL = "={{ $json.slackTarget === 'production' ? $env.SLACK_WEBHOOK_URL : $env.SLACK_SANDBOX_WEBHOOK_URL }}";
const OWNER_PAGINATION = {
  pagination: {
    paginationMode: 'updateAParameterInEachRequest',
    parameters: { parameters: [{ type: 'qs', name: 'after', value: "={{ $response.body.paging && $response.body.paging.next ? $response.body.paging.next.after : '' }}" }] },
    paginationCompleteWhen: 'other',
    completeExpression: '={{ !($response.body.paging && $response.body.paging.next && $response.body.paging.next.after) }}',
    limitPagesFetched: true,
    maxRequests: 10,
    requestInterval: 200,
  },
};

const STICKY = `## Deal stage regression audit logger: safety defaults
- **Demo mode** while HUBSPOT_PRIVATE_APP_TOKEN is a placeholder: bundled fictional deals, no network.
- **DRY_RUN=true**: detects and logs to n8n static data; no HubSpot tasks, no Airtable rows.
- **SANDBOX_MODE=true**: refuses production portals; Slack goes only to SLACK_SANDBOX_WEBHOOK_URL.
- Webhook auth: shared secret (constant time) or HubSpot v3 signature. Event IDs are de-duplicated.
- Reason grace period: regressions without a reason are re-checked after REASON_GRACE_MINUTES.
- Failure alerts are redacted.

${LICENSE_LINE}`;

export function buildWorkflow() {
  const x = (column) => column * 230;
  const nodes = [
    { parameters: { httpMethod: 'POST', path: WEBHOOK_PATH, responseMode: 'responseNode', options: {} }, id: nodeId(NODE.webhook), name: NODE.webhook, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [x(0), 200], webhookId: nodeId(`${NODE.webhook}:id`) },
    code(NODE.validate, [x(1), 200], ['config', 'intake'], LOGIC.validate, 'Shared secret (constant time) or HubSpot v3 signature, event extraction and 24-hour event-ID de-duplication. Needs NODE_FUNCTION_ALLOW_BUILTIN=crypto.'),
    { parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.response) }}', options: { responseCode: '={{ $json.statusCode }}' } }, id: nodeId(NODE.respond), name: NODE.respond, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [x(2), 40] },
    condition(NODE.accepted, [x(2), 240], "={{ $json.accepted ? 'yes' : 'no' }}", 'yes'),
    code(NODE.raise, [x(3), 420], ['config'], LOGIC.raise, 'Fails the execution after a 503, so the error branch alerts.'),
    { parameters: {}, id: nodeId(NODE.manual), name: NODE.manual, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [x(0), 520] },
    code(NODE.manualBatch, [x(1), 520], ['config'], LOGIC.manualBatch, 'Demo: bundled events. HubSpot mode: MANUAL_TEST_DEAL_IDS (latest stage change of each deal).'),
    code(NODE.route, [x(3), 240], ['config', 'hubspot'], LOGIC.route, 'Validates configuration and pins one clock for the run.'),
    condition(NODE.isDemo, [x(4), 240], '={{ $json.mode }}', 'demo'),
    code(NODE.demo, [x(5), 40], ALL, LOGIC.demo, 'Bundled fictional deals behind a mock HubSpot. No network.'),
    http(NODE.account, [x(5), 340], { method: 'GET', url: '={{ $json.request.url }}', auth: HUBSPOT_AUTH, notes: 'GET /account-info/v3/details for the sandbox check.' }),
    code(NODE.enforce, [x(6), 340], ['config', 'hubspot'], LOGIC.enforce, 'Stops unless the portal is a sandbox or developer test account (SANDBOX_MODE=true).'),
    http(NODE.pipelines, [x(7), 340], { method: 'GET', url: '={{ $json.pipelinesRequest.url }}', auth: HUBSPOT_AUTH, notes: 'GET /crm/v3/pipelines/deals. Stage order comes from displayOrder.' }),
    http(NODE.owners, [x(8), 340], { method: 'GET', url: `={{ $(${N('enforce')}).first().json.ownersRequest.url }}`, auth: HUBSPOT_AUTH, pagination: OWNER_PAGINATION, notes: 'GET /crm/v3/owners (paginated) to resolve owner and "changed by" names.' }),
    code(NODE.planDeals, [x(9), 340], ['config', 'hubspot'], LOGIC.planDeals),
    http(NODE.getDeal, [x(10), 340], { method: 'GET', url: '={{ $json.request.url }}', auth: HUBSPOT_AUTH, continueOnError: true, batching: true, notes: 'Deal properties plus dealstage and reason history (propertiesWithHistory). An unreadable deal is reported, the rest continue.' }),
    code(NODE.tagDeals, [x(11), 340], ['config', 'hubspot'], LOGIC.tagDeals),
    code(NODE.detect, [x(12), 340], ENGINE, LOGIC.detect, 'Finds the stage change in history, compares stage order and checks the regression reason.'),
    condition(NODE.found, [x(13), 340], '={{ $json.hasRegressions }}', 'yes'),
    condition(NODE.needWait, [x(14), 240], '={{ $json.waitDecision }}', 'wait'),
    { parameters: { amount: '={{ $json.waitMinutes }}', unit: 'minutes' }, id: nodeId(NODE.wait), name: NODE.wait, type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [x(15), 140], webhookId: nodeId(`${NODE.wait}:id`), notes: 'Gives the rep REASON_GRACE_MINUTES to fill in the reason before it counts as missing.', notesInFlow: false },
    code(NODE.planRecheck, [x(16), 140], ['config', 'hubspot'], LOGIC.planRecheck),
    http(NODE.recheck, [x(17), 140], { method: 'GET', url: '={{ $json.request.url }}', auth: HUBSPOT_AUTH, continueOnError: true, batching: true }),
    code(NODE.tagRecheck, [x(18), 140], ['config', 'hubspot'], LOGIC.tagRecheck),
    code(NODE.build, [x(19), 240], ENGINE, LOGIC.build, 'Builds audit records and upserts them into the static-data table.'),
    code(NODE.planAudit, [x(20), 240], ENGINE, LOGIC.planAudit, 'Airtable upserts only when AUDIT_TABLE_PROVIDER=airtable and DRY_RUN=false.'),
    condition(NODE.needAudit, [x(21), 240], "={{ $json.skip ? 'skip' : 'run' }}", 'run'),
    http(NODE.airtable, [x(22), 140], { method: 'PATCH', url: '={{ $json.request.url }}', auth: AIRTABLE_AUTH, body: '={{ JSON.stringify($json.request.body) }}', continueOnError: true, batching: true, notes: 'Upsert keyed on "Audit Key": retried webhooks never duplicate rows.' }),
    code(NODE.tagAudit, [x(23), 140], ['auditTable'], LOGIC.tagAudit),
    code(NODE.planTasks, [x(24), 240], ENGINE, LOGIC.planTasks, 'One owner task per regression without a valid reason (CREATE_OWNER_TASKS=true, DRY_RUN=false).'),
    condition(NODE.needTasks, [x(25), 240], "={{ $json.skip ? 'skip' : 'run' }}", 'run'),
    http(NODE.createTask, [x(26), 140], { method: 'POST', url: '={{ $json.request.url }}', auth: HUBSPOT_AUTH, body: '={{ JSON.stringify($json.request.body) }}', continueOnError: true, retries: 2, notes: 'POST /crm/v3/objects/tasks associated with the deal (type 216).' }),
    code(NODE.tagTasks, [x(27), 140], ['config', 'hubspot'], LOGIC.tagTasks),
    code(NODE.alert, [x(28), 240], ENGINE, LOGIC.alert, 'Applies ALERT_MIN_SEVERITY, ALERT_MIN_AMOUNT and ALERT_ONLY_MISSING_REASON and picks the Slack target.'),
    condition(NODE.needAlert, [x(29), 240], '={{ $json.send }}', 'yes'),
    http(NODE.slack, [x(30), 140], { method: 'POST', url: SLACK_URL, body: '={{ JSON.stringify($json.message) }}', retries: 2, notes: 'The webhook URL is read from $env at request time. Swap for an email node if leadership prefers email.' }),
    code(NODE.finalize, [x(31), 340], ['config', 'auditTable', 'regression', 'stages', 'hubspot'], LOGIC.finalize, 'Daily counters, run summary, and a failed execution when any audit row or owner task failed.'),
    { parameters: {}, id: nodeId(NODE.errorTrigger), name: NODE.errorTrigger, type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [x(0), 820] },
    code(NODE.buildFailure, [x(1), 820], ['config', 'slack'], LOGIC.buildFailure, 'Redacts tokens, secrets and webhook URLs before alerting.'),
    condition(NODE.needFailure, [x(2), 820], '={{ $json.send }}', 'yes'),
    http(NODE.sendFailure, [x(3), 720], { method: 'POST', url: SLACK_URL, body: '={{ JSON.stringify($json.message) }}', retries: 2 }),
    { parameters: { content: STICKY, height: 340, width: 560, color: 4 }, id: nodeId(NODE.note), name: NODE.note, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x(0), -300] },
  ];

  const link = (...branches) => ({ main: branches.map((targets) => targets.map((node) => ({ node, type: 'main', index: 0 }))) });
  const connections = {
    [NODE.webhook]: link([NODE.validate]),
    [NODE.validate]: link([NODE.respond, NODE.accepted]),
    [NODE.accepted]: link([NODE.route], [NODE.raise]),
    [NODE.manual]: link([NODE.manualBatch]),
    [NODE.manualBatch]: link([NODE.route]),
    [NODE.route]: link([NODE.isDemo]),
    [NODE.isDemo]: link([NODE.demo], [NODE.account]),
    [NODE.demo]: link([NODE.alert]),
    [NODE.account]: link([NODE.enforce]),
    [NODE.enforce]: link([NODE.pipelines]),
    [NODE.pipelines]: link([NODE.owners]),
    [NODE.owners]: link([NODE.planDeals]),
    [NODE.planDeals]: link([NODE.getDeal]),
    [NODE.getDeal]: link([NODE.tagDeals]),
    [NODE.tagDeals]: link([NODE.detect]),
    [NODE.detect]: link([NODE.found]),
    [NODE.found]: link([NODE.needWait], [NODE.finalize]),
    [NODE.needWait]: link([NODE.wait], [NODE.build]),
    [NODE.wait]: link([NODE.planRecheck]),
    [NODE.planRecheck]: link([NODE.recheck]),
    [NODE.recheck]: link([NODE.tagRecheck]),
    [NODE.tagRecheck]: link([NODE.build]),
    [NODE.build]: link([NODE.planAudit]),
    [NODE.planAudit]: link([NODE.needAudit]),
    [NODE.needAudit]: link([NODE.airtable], [NODE.planTasks]),
    [NODE.airtable]: link([NODE.tagAudit]),
    [NODE.tagAudit]: link([NODE.planTasks]),
    [NODE.planTasks]: link([NODE.needTasks]),
    [NODE.needTasks]: link([NODE.createTask], [NODE.alert]),
    [NODE.createTask]: link([NODE.tagTasks]),
    [NODE.tagTasks]: link([NODE.alert]),
    [NODE.alert]: link([NODE.needAlert]),
    [NODE.needAlert]: link([NODE.slack], [NODE.finalize]),
    [NODE.slack]: link([NODE.finalize]),
    [NODE.errorTrigger]: link([NODE.buildFailure]),
    [NODE.buildFailure]: link([NODE.needFailure]),
    [NODE.needFailure]: link([NODE.sendFailure], []),
  };

  return {
    name: WORKFLOW_NAME,
    nodes,
    connections,
    active: false,
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' },
    pinData: {},
    meta: { templateCredsSetupCompleted: false, license: LICENSE_LINE },
    tags: [],
  };
}

export function serializeWorkflow() {
  return `${JSON.stringify(buildWorkflow(), null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const output = serializeWorkflow();
  if (process.argv.includes('--check')) {
    if (readFileSync(WORKFLOW_PATH, 'utf8') !== output) {
      console.error('workflow.json is out of date. Run "npm run build:workflow".');
      process.exit(1);
    }
    console.log('workflow.json is up to date.');
  } else {
    writeFileSync(WORKFLOW_PATH, output);
    console.log(`Wrote ${WORKFLOW_PATH} (${buildWorkflow().nodes.length} nodes, ${Math.round(Buffer.byteLength(output) / 1024)} KB)`);
  }
}
