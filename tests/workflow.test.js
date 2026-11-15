// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LICENSE_LINE, NODE, serializeWorkflow, WORKFLOW_PATH } from '../scripts/build-workflow.js';
import { runWorkflow } from './n8n-simulator.js';
import { createDemoEvents, createMockAirtable, createMockHubSpot, DEMO_NOW } from '../src/core/mocks.js';
import { loadAuditConfig } from '../src/core/config.js';
import { extractEvents } from '../src/core/intake.js';
import { processEvents, runDemo } from '../src/core/pipeline.js';

const workflow = JSON.parse(readFileSync(WORKFLOW_PATH, 'utf8'));
const SECRET = 'test-shared-secret-long-enough-value';
const SANDBOX_HOOK = 'https://hooks.slack.com/services/EXAMPLE/SANDBOX/EXAMPLE';
const ENV = { HUBSPOT_PRIVATE_APP_TOKEN: 'test-hubspot-token', WEBHOOK_SECRET: SECRET, AUDIT_NOW: DEMO_NOW, SLACK_SANDBOX_WEBHOOK_URL: SANDBOX_HOOK };
const WRITE_ENV = { ...ENV, DRY_RUN: 'false', AUDIT_TABLE_PROVIDER: 'airtable', AIRTABLE_TOKEN: 'test-airtable-token', AIRTABLE_BASE_ID: 'appEXAMPLE000001' };
const ACCOUNT = { portalId: 12345678, accountType: 'SANDBOX', uiDomain: 'app.hubspot.com' };

function services(options = {}) {
  const hubspot = createMockHubSpot({ account: ACCOUNT, ...options.hubspot });
  const airtable = createMockAirtable(options.airtable);
  const slack = [];
  const http = async (request) => {
    if (request.url.startsWith('https://api.hubapi.com/')) {
      assert.equal(request.headers.Authorization, 'Bearer test-hubspot-token');
      return hubspot.request(request);
    }
    if (request.url.startsWith('https://api.airtable.com/')) {
      assert.equal(request.headers.Authorization, 'Bearer test-airtable-token');
      return airtable.request(request);
    }
    slack.push(request);
    return { status: 200, body: 'ok' };
  };
  return { hubspot, airtable, slack, http };
}

const webhook = (body, headers = { 'x-webhook-secret': SECRET }) => ({ startNode: NODE.webhook, triggerItems: [{ json: { headers, params: {}, query: {}, body } }] });

test('workflow.json is exactly what the build script produces', () => {
  assert.equal(readFileSync(WORKFLOW_PATH, 'utf8'), serializeWorkflow());
});

test('structure: required node types, inactive, valid connections, everything reachable', () => {
  assert.equal(workflow.active, false);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  const types = new Set(workflow.nodes.map((node) => node.type));
  for (const type of ['webhook', 'code', 'if', 'wait', 'httpRequest', 'respondToWebhook', 'errorTrigger']) assert.ok(types.has(`n8n-nodes-base.${type}`), type);
  const names = new Set(workflow.nodes.map((node) => node.name));
  for (const [source, { main }] of Object.entries(workflow.connections)) {
    assert.ok(names.has(source));
    for (const branch of main) for (const connection of branch) assert.ok(names.has(connection.node), connection.node);
  }
  const reachable = new Set();
  const visit = (name) => { if (reachable.has(name)) return; reachable.add(name); for (const branch of (workflow.connections[name] || { main: [] }).main) for (const c of branch) visit(c.node); };
  [NODE.webhook, NODE.manual, NODE.errorTrigger].forEach(visit);
  assert.deepEqual(workflow.nodes.map((node) => node.name).filter((name) => !reachable.has(name)), [NODE.note]);
});

test('no embedded credentials or hardcoded endpoints, and the license line in every Code node', () => {
  const text = JSON.stringify(workflow);
  assert.ok(!/pat-(?:na|eu)\d-/.test(text));
  assert.ok(!/hooks\.slack\.com\/services\/T/.test(text));
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.httpRequest') {
      assert.match(node.parameters.url, /\$json\.|\$env\.|\$\(/, node.name);
      assert.ok(!/https?:\/\//.test(node.parameters.url), `${node.name} has no hardcoded URL`);
      const header = node.parameters.headerParameters && node.parameters.headerParameters.parameters[0];
      if (header) assert.match(header.value, /\$env\./);
      assert.equal(node.credentials, undefined);
    }
    if (node.type === 'n8n-nodes-base.code') assert.ok(node.parameters.jsCode.startsWith(`// ${LICENSE_LINE}`), node.name);
  }
  assert.ok(workflow.nodes.find((node) => node.name === NODE.note).parameters.content.includes(LICENSE_LINE));
});

test('manual run in demo mode matches the Node.js demo without any HTTP', async () => {
  const run = await runWorkflow(workflow, { env: {}, http: async () => { throw new Error('demo must not call HTTP'); } });
  const mirror = await runDemo({ config: loadAuditConfig({}) });
  assert.deepEqual(run.output(NODE.demo)[0].records.map((record) => ({ ...record, detectedAt: null })), mirror.records.map((record) => ({ ...record, detectedAt: null })));
  const summary = run.output(NODE.finalize)[0];
  assert.equal(summary.totals.regressions, 5);
  assert.equal(summary.totals.tasksCreated, 0);
  assert.equal(run.staticData.regressionAuditRows.length, 5, 'the static audit table lives in workflow static data');
});

test('webhook with writes: parity with the mirror, the Wait node, Airtable rows, owner tasks and the sandbox alert', async () => {
  const n8n = services();
  const run = await runWorkflow(workflow, { env: WRITE_ENV, http: n8n.http, ...webhook(createDemoEvents()) });
  const mirror = services();
  const expected = await processEvents({ config: loadAuditConfig(WRITE_ENV), events: extractEvents(createDemoEvents(), 100).events, hubspotHttp: mirror.hubspot.request, airtableHttp: mirror.airtable.request, now: Date.parse(DEMO_NOW), requestId: run.responses[0].body.requestId });

  assert.equal(run.responses[0].statusCode, 202);
  assert.deepEqual(run.waits, [{ node: NODE.wait, amount: 15, unit: 'minutes' }]);
  assert.deepEqual(run.output(NODE.build)[0].records, expected.records);
  assert.deepEqual(n8n.airtable.rows, mirror.airtable.rows);
  assert.deepEqual(n8n.hubspot.tasks, mirror.hubspot.tasks);
  assert.equal(n8n.slack.length, 1);
  assert.equal(n8n.slack[0].url, SANDBOX_HOOK);
  assert.deepEqual(n8n.slack[0].body, expected.message);
  const summary = run.output(NODE.finalize)[0];
  assert.equal(summary.totals.auditRowsWritten, 5);
  assert.equal(summary.totals.tasksCreated, 2);
  assert.equal(summary.slack, 'sent to the sandbox webhook');
});

test('DRY_RUN never reaches the Airtable or task nodes', async () => {
  const n8n = services();
  const run = await runWorkflow(workflow, { env: { ...ENV, AUDIT_TABLE_PROVIDER: 'airtable', AIRTABLE_TOKEN: 'test-airtable-token', AIRTABLE_BASE_ID: 'appEXAMPLE000001' }, http: n8n.http, ...webhook(createDemoEvents()) });
  assert.ok(!run.executed.includes(NODE.airtable));
  assert.ok(!run.executed.includes(NODE.createTask));
  assert.equal(n8n.airtable.calls.length, 0);
  assert.equal(n8n.hubspot.tasks.length, 0);
  assert.equal(n8n.slack.length, 1, 'the alert still goes to the sandbox webhook');
});

test('replayed webhooks are de-duplicated through static data', async () => {
  const staticData = {};
  const first = services();
  await runWorkflow(workflow, { env: ENV, http: first.http, staticData, ...webhook(createDemoEvents()) });
  const second = services();
  const replay = await runWorkflow(workflow, { env: ENV, http: second.http, staticData, ...webhook(createDemoEvents()) });
  assert.equal(replay.responses[0].statusCode, 200);
  assert.equal(replay.responses[0].body.duplicates, 8);
  assert.ok(!replay.executed.includes(NODE.route));
  assert.equal(second.hubspot.calls.length, 0);
});

test('forward-only batches skip straight to Finalize without waiting or alerting', async () => {
  const n8n = services();
  const forward = createDemoEvents().filter((event) => ['9003', '9006'].includes(String(event.objectId)));
  const run = await runWorkflow(workflow, { env: ENV, http: n8n.http, ...webhook(forward) });
  assert.ok(!run.executed.includes(NODE.wait));
  assert.ok(!run.executed.includes(NODE.alert));
  assert.equal(run.output(NODE.finalize)[0].totals.notRegression, 2);
  assert.equal(n8n.slack.length, 0);
});

test('REASON_GRACE_MINUTES=0 skips the Wait node and re-check', async () => {
  const run = await runWorkflow(workflow, { env: { ...ENV, REASON_GRACE_MINUTES: '0' }, http: services().http, ...webhook(createDemoEvents()) });
  assert.ok(!run.executed.includes(NODE.wait));
  assert.equal(run.output(NODE.build)[0].records.find((record) => record.dealId === '9005').reasonStatus, 'missing', 'no grace, no late reason');
});

test('401 on a wrong secret; 503 plus a failed execution when misconfigured; sandbox refusal', async () => {
  const n8n = services();
  const denied = await runWorkflow(workflow, { env: ENV, http: n8n.http, ...webhook(createDemoEvents(), { 'x-webhook-secret': 'wrong' }) });
  assert.equal(denied.responses[0].statusCode, 401);
  assert.equal(n8n.hubspot.calls.length, 0);
  await assert.rejects(runWorkflow(workflow, { env: { ...ENV, WEBHOOK_SECRET: 'short' }, http: n8n.http, ...webhook(createDemoEvents()) }), /Configuration invalid/);
  const production = services({ hubspot: { account: { portalId: 1, accountType: 'STANDARD' } } });
  await assert.rejects(runWorkflow(workflow, { env: ENV, http: production.http, ...webhook(createDemoEvents()) }), /SANDBOX_MODE=true, but the connected portal/);
  assert.deepEqual(production.hubspot.calls.map((call) => call.path), ['/account-info/v3/details']);
});

test('a failing audit table write still alerts leadership, then fails the execution', async () => {
  const n8n = services({ airtable: { fail: true } });
  await assert.rejects(runWorkflow(workflow, { env: WRITE_ENV, http: n8n.http, ...webhook(createDemoEvents()) }), /1 audit table write\(s\) and 0 owner task\(s\) failed/);
  assert.equal(n8n.slack.length, 1);
  assert.match(JSON.stringify(n8n.slack[0].body), /some failed/);
});

test('the error branch posts a redacted failure alert to the sandbox webhook', async () => {
  const n8n = services();
  const failure = { execution: { id: '42', lastNodeExecuted: NODE.getDeal, error: { message: 'Unauthorized for Bearer test-hubspot-token' } }, workflow: { name: workflow.name } };
  const run = await runWorkflow(workflow, { env: ENV, http: n8n.http, startNode: NODE.errorTrigger, triggerItems: [{ json: failure }] });
  assert.ok(run.executed.includes(NODE.sendFailure));
  assert.equal(n8n.slack[0].url, SANDBOX_HOOK);
  assert.ok(!JSON.stringify(n8n.slack[0].body).includes('test-hubspot-token'));
});
