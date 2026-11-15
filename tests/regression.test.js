// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { isPlaceholder, loadAuditConfig, readBooleanEnv, resolveSlackTarget, validateAuditConfig } from '../src/core/config.js';
import { extractEvents, filterDuplicateEvents, validateIntake, verifyHubSpotSignatureV3 } from '../src/core/intake.js';
import { buildStageIndex, classifyTransition, locateStageChange } from '../src/core/stages.js';
import { buildOwnerIndex, buildOwnerTaskRequest, enforceSandbox, parseDealResponse } from '../src/core/hubspot.js';
import { evaluateReason, recordsToAlert } from '../src/core/regression.js';
import { appendStaticRows, buildAirtableUpsertRequests, toAirtableFields } from '../src/core/auditTable.js';
import { buildFailureAlert, buildLeadershipAlert, redactSecrets } from '../src/core/slack.js';
import { createDemoEvents, createMockAirtable, createMockHubSpot, DEMO_NOW, DEMO_PIPELINES } from '../src/core/mocks.js';
import { processEvents, runAuditLogger, runDemo, createHttpClient } from '../src/core/pipeline.js';
import { parseDotEnv } from '../src/index.js';

const NOW = Date.parse(DEMO_NOW);
const SECRET = 'test-shared-secret-long-enough-value';
const hmacBase64 = (secret, text) => createHmac('sha256', secret).update(text, 'utf8').digest('base64');
const INDEX = buildStageIndex(DEMO_PIPELINES);
const DETECTION = loadAuditConfig({}).detection;
const HUBSPOT_ENV = { HUBSPOT_PRIVATE_APP_TOKEN: 'test-hubspot-token', WEBHOOK_SECRET: SECRET, AUDIT_NOW: DEMO_NOW };
const SANDBOX_ACCOUNT = { portalId: 12345678, accountType: 'SANDBOX', uiDomain: 'app-eu1.hubspot.com' };
const demoEvents = () => extractEvents(createDemoEvents(), 100).events;

/* ---------- configuration ---------- */

test('placeholders in the YOUR_... style are recognised, including inside URLs', () => {
  for (const value of ['YOUR_HUBSPOT_PRIVATE_APP_TOKEN', 'YOUR_WEBHOOK_SECRET', 'https://hooks.slack.com/services/YOUR_SLACK_PATH', '', null, 'changeme']) assert.equal(isPlaceholder(value), true, String(value));
  assert.equal(isPlaceholder('test-hubspot-token'), false);
  assert.equal(readBooleanEnv('flase', true), true);
  assert.equal(readBooleanEnv('off', true), false);
});

test('an empty environment is demo mode with every safety default on and no errors', () => {
  const config = loadAuditConfig({});
  assert.equal(config.mode, 'demo');
  assert.equal(config.dryRun, true);
  assert.equal(config.sandboxMode, true);
  assert.equal(config.audit.provider, 'static');
  assert.deepEqual(validateAuditConfig(config).errors, []);
  assert.equal(resolveSlackTarget(config).target, 'preview');
});

test('live mode needs a real token; HubSpot mode needs a strong secret; v3 mode needs the client secret and URL', () => {
  assert.match(validateAuditConfig(loadAuditConfig({ DRY_RUN: 'false', SANDBOX_MODE: 'false' })).errors.join('\n'), /needs a real HUBSPOT_PRIVATE_APP_TOKEN/);
  assert.match(validateAuditConfig(loadAuditConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-hubspot-token', WEBHOOK_SECRET: 'short' })).errors.join('\n'), /WEBHOOK_SECRET must be/);
  const v3 = validateAuditConfig(loadAuditConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-hubspot-token', WEBHOOK_AUTH_MODE: 'hubspot_v3' })).errors.join('\n');
  assert.match(v3, /HUBSPOT_APP_CLIENT_SECRET/);
  assert.match(v3, /WEBHOOK_PUBLIC_URL/);
});

test('invalid choices, numbers, URLs and Airtable settings are rejected', () => {
  const config = loadAuditConfig({ WEBHOOK_AUTH_MODE: 'magic', REGRESSION_MIN_STEPS: '0', SLACK_WEBHOOK_URL: 'https://example.com/hook', AUDIT_TABLE_PROVIDER: 'airtable', REGRESSION_REASON_PROPERTY: 'Bad Name' });
  const errors = validateAuditConfig(config).errors.join('\n');
  assert.match(errors, /WEBHOOK_AUTH_MODE must be one of/);
  assert.match(errors, /REGRESSION_MIN_STEPS must be/);
  assert.match(errors, /SLACK_WEBHOOK_URL must start with/);
  assert.match(errors, /needs AIRTABLE_TOKEN and AIRTABLE_BASE_ID/);
  assert.match(errors, /not a valid HubSpot property name/);
});

test('Slack production is used only in live mode', () => {
  const base = { ...HUBSPOT_ENV, SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/EXAMPLE/PROD/EXAMPLE', SLACK_SANDBOX_WEBHOOK_URL: 'https://hooks.slack.com/services/EXAMPLE/SANDBOX/EXAMPLE' };
  assert.equal(resolveSlackTarget(loadAuditConfig(base)).target, 'sandbox');
  assert.equal(resolveSlackTarget(loadAuditConfig({ ...base, DRY_RUN: 'false' })).target, 'sandbox');
  assert.equal(resolveSlackTarget(loadAuditConfig({ ...base, DRY_RUN: 'false', SANDBOX_MODE: 'false' })).target, 'production');
});

/* ---------- intake ---------- */

test('shared-secret intake: 401 on a wrong secret, 202 on a valid batch, never echoes the secret', () => {
  const config = loadAuditConfig(HUBSPOT_ENV);
  assert.equal(validateIntake({ headers: { 'x-webhook-secret': 'nope' }, body: { objectId: 1 } }, config, [], {}, NOW, hmacBase64).statusCode, 401);
  const ok = validateIntake({ headers: { 'X-Webhook-Secret': SECRET }, body: createDemoEvents() }, config, [], {}, NOW, hmacBase64);
  assert.equal(ok.statusCode, 202);
  assert.equal(ok.events.length, 8);
  assert.ok(!JSON.stringify(ok.response).includes(SECRET));
  assert.equal(validateIntake({ headers: { 'x-webhook-secret': SECRET }, body: { objectId: 1 } }, config, ['broken'], {}, NOW, hmacBase64).statusCode, 503);
  assert.equal(validateIntake({ headers: { 'x-webhook-secret': SECRET }, body: '{nope' }, config, [], {}, NOW, hmacBase64).statusCode, 400);
});

test('HubSpot v3 signatures are verified over method + URL + body + timestamp, within the age window', () => {
  const config = loadAuditConfig({ ...HUBSPOT_ENV, WEBHOOK_AUTH_MODE: 'hubspot_v3', HUBSPOT_APP_CLIENT_SECRET: 'test-client-secret', WEBHOOK_PUBLIC_URL: 'https://n8n.example.com/webhook/deal-stage-regression' });
  const body = JSON.stringify(createDemoEvents().slice(0, 1));
  const timestamp = String(NOW - 1000);
  const signature = hmacBase64('test-client-secret', `POST${config.webhook.publicUrl}${body}${timestamp}`);
  const headers = { 'X-HubSpot-Signature-v3': signature, 'X-HubSpot-Request-Timestamp': timestamp };
  assert.equal(verifyHubSpotSignatureV3({ headers, rawBody: body, config, now: NOW, hmacBase64 }).ok, true);
  assert.equal(verifyHubSpotSignatureV3({ headers, rawBody: `${body} `, config, now: NOW, hmacBase64 }).reason, 'signature_mismatch');
  assert.equal(verifyHubSpotSignatureV3({ headers, rawBody: body, config, now: NOW + 10 * 60000, hmacBase64 }).reason, 'signature_timestamp_outside_window');
  assert.equal(validateIntake({ headers, body: JSON.parse(body) }, config, [], {}, NOW, hmacBase64).statusCode, 202, 'parsed bodies are re-serialised compactly for verification');
});

test('event extraction keeps dealstage changes only, and replayed event IDs are dropped for 24 hours', () => {
  const { events, ignored } = extractEvents([
    { eventId: 1, subscriptionType: 'deal.propertyChange', propertyName: 'dealstage', objectId: 5, propertyValue: 'qualifiedtobuy', occurredAt: NOW },
    { eventId: 2, subscriptionType: 'deal.propertyChange', propertyName: 'amount', objectId: 5 },
    { eventId: 3, subscriptionType: 'deal.creation', objectId: 6 },
    { hs_object_id: '7' },
    { objectId: 'abc' },
  ], 100);
  assert.deepEqual(events.map((event) => [event.dealId, event.source, event.newStageId]), [['5', 'app_webhook', 'qualifiedtobuy'], ['7', 'workflow_webhook', null]]);
  assert.equal(ignored, 3);
  const state = {};
  assert.equal(filterDuplicateEvents(events, state, NOW).fresh.length, 2);
  assert.equal(filterDuplicateEvents(events, state, NOW + 1000).duplicates, 1, 'event 1 is a replay; the workflow event has no ID');
  assert.equal(filterDuplicateEvents(events, state, NOW + 25 * 3600000).duplicates, 0, 'IDs expire after 24 hours');
});

/* ---------- stage logic ---------- */

test('stage order comes from displayOrder, and every transition type is classified', () => {
  const cases = [
    ['contractsent', 'appointmentscheduled', 'regression', true, 4, 'high'],
    ['presentationscheduled', 'qualifiedtobuy', 'regression', true, 1, 'normal'],
    ['qualifiedtobuy', 'presentationscheduled', 'forward', false, 0, null],
    ['closedwon', 'contractsent', 'reopened', true, 0, 'high'],
    ['closedwon', 'closedlost', 'closed_reversal', true, 0, 'high'],
    ['closedlost', 'closedwon', 'closed', false, 0, null],
    ['contractsent', 'closedlost', 'closed', false, 0, null],
    ['1234569', 'qualifiedtobuy', 'pipeline_change', false, 0, null],
    ['nope', 'qualifiedtobuy', 'unknown_stage', false, 0, null],
  ];
  for (const [from, to, type, regression, steps, severity] of cases) {
    const result = classifyTransition(from, to, INDEX, DETECTION);
    assert.deepEqual([result.type, result.regression, result.stepsBack, result.severity], [type, regression, steps, severity], `${from} -> ${to}`);
  }
});

test('detection switches: minimum steps, reopened deals, closed reversals and pipeline changes', () => {
  assert.equal(classifyTransition('presentationscheduled', 'qualifiedtobuy', INDEX, { ...DETECTION, minStepsBack: 2 }).regression, false);
  assert.equal(classifyTransition('closedwon', 'contractsent', INDEX, { ...DETECTION, trackReopened: false }).regression, false);
  assert.equal(classifyTransition('closedwon', 'closedlost', INDEX, { ...DETECTION, trackClosedReversals: false }).regression, false);
  assert.equal(classifyTransition('1234569', 'qualifiedtobuy', INDEX, { ...DETECTION, pipelineChangePolicy: 'probability' }).regression, true, 'win probability 0.8 -> 0.4');
});

test('the stage change is located in history by value and time, with the stage it came from', () => {
  const history = [
    { value: 'qualifiedtobuy', timestamp: new Date(NOW - 60000).toISOString(), updatedByUserId: 7002 },
    { value: 'appointmentscheduled', timestamp: new Date(NOW - 3600000).toISOString(), updatedByUserId: 7001 },
    { value: 'contractsent', timestamp: new Date(NOW - 86400000).toISOString() },
  ];
  const located = locateStageChange(history, { newStageId: 'appointmentscheduled', occurredAt: NOW - 3600000 + 1500 });
  assert.equal(located.previousStageId, 'contractsent');
  assert.equal(located.changedByUserId, '7001', 'a later move does not hide the change the event refers to');
  assert.equal(locateStageChange(history, { newStageId: null }).previousStageId, 'appointmentscheduled', 'workflow webhooks use the latest change');
  assert.equal(locateStageChange(history.slice(2), { newStageId: null }).found, false);
});

test('reason checks: provided, missing, too short, and stale from an earlier regression', () => {
  const config = loadAuditConfig({});
  const entered = NOW - 3600000;
  assert.equal(evaluateReason([{ value: 'Budget frozen', timestamp: new Date(NOW).toISOString() }], null, entered, config).status, 'provided');
  assert.equal(evaluateReason([], '', entered, config).status, 'missing');
  assert.equal(evaluateReason([{ value: 'no', timestamp: new Date(NOW).toISOString() }], null, entered, config).status, 'missing');
  assert.equal(evaluateReason([{ value: 'Old reason', timestamp: new Date(entered - 1000).toISOString() }], null, entered, config).status, 'stale');
});

/* ---------- HubSpot, audit table, Slack ---------- */

test('sandbox enforcement, owner index and owner task payloads', () => {
  const config = loadAuditConfig({ ...HUBSPOT_ENV, HUBSPOT_SANDBOX_PORTAL_ID: '42' });
  assert.equal(enforceSandbox({ portalId: 1, accountType: 'SANDBOX' }, config).ok, true);
  assert.equal(enforceSandbox({ portalId: 42, accountType: 'STANDARD' }, config).ok, true);
  assert.equal(enforceSandbox({ portalId: 1, accountType: 'STANDARD' }, config).ok, false);
  const owners = buildOwnerIndex({ results: [{ id: '1', userId: 9, firstName: 'Avery', lastName: 'Example', email: 'avery.example@example.com' }] });
  assert.equal(owners.byUserId['9'].name, 'Avery Example');
  assert.equal(owners.byOwnerId['1'].email, null, 'owner emails are dropped unless INCLUDE_OWNER_EMAIL=true');
  const task = buildOwnerTaskRequest(config, { dealId: '9', dealName: 'Acme Corp - Pilot', previousStage: 'Contract Sent', newStage: 'Discovery', regressedAt: DEMO_NOW, severity: 'high', ownerId: '1' }, NOW);
  assert.equal(task.body.associations[0].types[0].associationTypeId, 216);
  assert.equal(task.body.properties.hs_timestamp, new Date(NOW + 24 * 3600000).toISOString());
  assert.equal(parseDealResponse('5', { error: { message: 'not found' } }).found, false);
});

test('Airtable rows are upserted on Audit Key in batches of 10 and omit owner email by default', () => {
  const config = loadAuditConfig({ AUDIT_TABLE_PROVIDER: 'airtable', AIRTABLE_TOKEN: 'test-airtable-token', AIRTABLE_BASE_ID: 'appEXAMPLE000001' });
  const records = Array.from({ length: 12 }, (_, index) => ({ auditKey: `k${index}`, dealId: String(index), dealName: 'Acme Corp', ownerEmail: 'avery.example@example.com', amount: null }));
  const requests = buildAirtableUpsertRequests(records, config);
  assert.deepEqual(requests.map((plan) => plan.request.body.records.length), [10, 2]);
  assert.equal(requests[0].request.method, 'PATCH');
  assert.deepEqual(requests[0].request.body.performUpsert, { fieldsToMergeOn: ['Audit Key'] });
  assert.equal(requests[0].request.url, 'https://api.airtable.com/v0/appEXAMPLE000001/Deal%20Stage%20Regressions');
  assert.equal(toAirtableFields(records[0], config)['Owner Email'], undefined);
  assert.ok(!JSON.stringify(requests).includes('test-airtable-token'));
});

test('the static table upserts by key and keeps the newest rows within the limit', () => {
  const config = loadAuditConfig({ STATIC_AUDIT_ROW_LIMIT: '10' });
  const state = {};
  for (let index = 0; index < 12; index += 1) appendStaticRows(state, [{ auditKey: `k${index}` }], config);
  appendStaticRows(state, [{ auditKey: 'k11', reasonStatus: 'provided' }], config);
  assert.equal(state.regressionAuditRows.length, 10);
  assert.equal(state.regressionAuditRows[0].reasonStatus, 'provided');
  assert.equal(state.regressionAuditRows.filter((row) => row.auditKey === 'k11').length, 1);
});

test('alert filters: minimum severity, minimum amount, missing reasons only', () => {
  const records = [{ severity: 'high', amount: 100, reasonStatus: 'provided' }, { severity: 'normal', amount: 5000, reasonStatus: 'missing' }, { severity: 'high', amount: null, reasonStatus: 'missing' }];
  assert.equal(recordsToAlert(records, loadAuditConfig({})).length, 3);
  assert.equal(recordsToAlert(records, loadAuditConfig({ ALERT_MIN_SEVERITY: 'high' })).length, 2);
  assert.equal(recordsToAlert(records, loadAuditConfig({ ALERT_MIN_AMOUNT: '1000' })).length, 1);
  assert.equal(recordsToAlert(records, loadAuditConfig({ ALERT_ONLY_MISSING_REASON: 'true' })).length, 2);
});

test('leadership alerts list stages, owner and reason status; failure alerts are redacted', async () => {
  const { records, alerted } = await runDemo({ config: loadAuditConfig({}) });
  const message = buildLeadershipAlert({ records, alerted, config: loadAuditConfig({}), requestId: 'r1' });
  assert.match(message.text, /\[DEMO DATA \| DRY RUN \| SANDBOX\] Deal stage regression audit: 5 deal stage regressions, 2 without a valid reason/);
  const text = JSON.stringify(message);
  for (const fragment of ['Contract Sent → Appointment Scheduled', 'Avery Example', 'reason missing', 'reason stale', 'closed-won reversed']) assert.ok(text.includes(fragment), fragment);
  assert.ok(message.blocks.every((block) => !block.text || block.text.text.length <= 3000));
  const failure = JSON.stringify(buildFailureAlert({ errorMessage: 'Bearer test-hubspot-token failed at https://hooks.slack.com/services/EXAMPLE/X?token=abc', config: loadAuditConfig({}), secrets: ['test-airtable-token'] }));
  for (const fragment of ['test-hubspot-token', 'hooks.slack.com', 'abc']) assert.ok(!failure.includes(fragment), fragment);
  assert.equal(redactSecrets('key test-airtable-token here', ['test-airtable-token']), 'key [redacted] here');
});

/* ---------- end to end ---------- */

test('demo: five regressions detected as designed, with the grace re-check filling one reason', async () => {
  const { evaluations, records, counters, hubspot } = await runDemo({ config: loadAuditConfig({}) });
  const byDeal = Object.fromEntries(evaluations.map((entry) => [entry.dealId, entry.outcome === 'regression' ? `${entry.transition.type}:${entry.reason.status}` : entry.outcome]));
  assert.deepEqual(byDeal, {
    9001: 'regression:provided', 9002: 'regression:missing', 9003: 'not_regression', 9004: 'reopened:stale',
    9005: 'regression:provided', 9006: 'not_regression', 9007: 'not_regression', 9008: 'closed_reversal:provided',
  });
  assert.equal(records.find((record) => record.dealId === '9005').reasonRechecked, true);
  assert.equal(counters.tasksPlanned, 2);
  assert.equal(hubspot.tasks.length, 0, 'DRY_RUN creates no tasks');
});

test('sandbox writes: Airtable upserts, owner tasks for missing reasons, idempotent rows on replay', async () => {
  const env = { ...HUBSPOT_ENV, DRY_RUN: 'false', AUDIT_TABLE_PROVIDER: 'airtable', AIRTABLE_TOKEN: 'test-airtable-token', AIRTABLE_BASE_ID: 'appEXAMPLE000001' };
  const config = loadAuditConfig(env);
  const hubspot = createMockHubSpot({ account: SANDBOX_ACCOUNT });
  const airtable = createMockAirtable();
  const waits = [];
  const result = await processEvents({ config, events: demoEvents(), hubspotHttp: hubspot.request, airtableHttp: airtable.request, now: NOW, wait: async (minutes) => { waits.push(minutes); } });
  assert.deepEqual(waits, [15]);
  assert.equal(Object.keys(airtable.rows).length, 5);
  assert.equal(airtable.rows[result.records[0].auditKey].fields['Deal URL'], 'https://app-eu1.hubspot.com/contacts/12345678/record/0-3/9001');
  assert.deepEqual(hubspot.tasks.map((task) => task.associations[0].to.id).sort(), ['9002', '9004']);
  await processEvents({ config, events: demoEvents(), hubspotHttp: hubspot.request, airtableHttp: airtable.request, now: NOW, wait: async () => {} });
  assert.equal(Object.keys(airtable.rows).length, 5, 'upsert on Audit Key: no duplicate rows');
});

test('production portals are refused in sandbox mode, and unreadable batches stop', async () => {
  const config = loadAuditConfig(HUBSPOT_ENV);
  await assert.rejects(processEvents({ config, events: demoEvents(), hubspotHttp: createMockHubSpot({ account: { portalId: 1, accountType: 'STANDARD' } }).request, now: NOW }), /SANDBOX_MODE=true, but the connected portal/);
  await assert.rejects(processEvents({ config, events: [{ dealId: '1', eventId: null, newStageId: null, occurredAt: null }], hubspotHttp: createMockHubSpot({ account: SANDBOX_ACCOUNT }).request, now: NOW }), /No deal could be read/);
});

test('runAuditLogger delivers Slack to the sandbox webhook and validates configuration first', async () => {
  const posted = [];
  const fetchImpl = async (url) => { posted.push(url); return { ok: true, status: 200 }; };
  const sandboxHook = 'https://hooks.slack.com/services/EXAMPLE/SANDBOX/EXAMPLE';
  const config = loadAuditConfig({ ...HUBSPOT_ENV, SLACK_SANDBOX_WEBHOOK_URL: sandboxHook, REASON_GRACE_MINUTES: '0' });
  const result = await runAuditLogger({ config, events: demoEvents(), fetchImpl, hubspotHttp: createMockHubSpot({ account: SANDBOX_ACCOUNT }).request });
  assert.equal(result.slack.status, 'sent to the sandbox webhook');
  assert.deepEqual(posted, [sandboxHook]);
  assert.equal(result.waitMinutes, 0);
  await assert.rejects(runAuditLogger({ config: loadAuditConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-hubspot-token' }), events: [] }), /WEBHOOK_SECRET/);
});

test('the HTTP client retries 429 and redacts secrets from network errors', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1 ? { status: 429, headers: { get: () => '0.01' }, text: async () => '{}' } : { status: 200, headers: { get: () => null }, text: async () => '{"ok":true}' };
  };
  assert.deepEqual((await createHttpClient({ authorization: 'Bearer x', fetchImpl, baseDelayMs: 1 })({ method: 'GET', url: 'https://api.hubapi.com/x' })).body, { ok: true });
  const failing = createHttpClient({ fetchImpl: async () => { throw new Error('socket closed for test-hubspot-token'); }, maxRetries: 0, secrets: ['test-hubspot-token'] });
  await assert.rejects(failing({ method: 'GET', url: 'https://api.hubapi.com/x' }), (error) => !error.message.includes('test-hubspot-token'));
});

test('.env parsing handles quotes, comments and export', () => {
  assert.deepEqual(parseDotEnv('# c\nA=1\nexport B="two words"\nC=three # note\n'), { A: '1', B: 'two words', C: 'three' });
});
