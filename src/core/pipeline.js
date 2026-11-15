// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Node.js mirror of workflow.json: the same functions in the same order as the n8n nodes.
 */
import { resolveNow, resolveSlackTarget, validateAuditConfig, airtableEnabled } from './config.js';
import { buildStageIndex } from './stages.js';
import {
  buildAccountDetailsRequest, buildDealReadRequest, buildOwnerIndex, buildOwnerTaskRequest, buildOwnersRequest,
  buildPipelinesRequest, buildReasonReadRequest, enforceSandbox, parseCreateResponse, parseDealResponse,
} from './hubspot.js';
import { applyReasonRechecks, buildAuditRecords, dealsNeedingRecheck, evaluateEvents, recordsNeedingTasks, recordsToAlert, summarizeEvaluations } from './regression.js';
import { appendStaticRows, buildAirtableUpsertRequests, buildRunTotals, parseAirtableResponse, recordDailyCounters } from './auditTable.js';
import { buildLeadershipAlert, redactSecrets } from './slack.js';
import { createDemoEvents, createMockHubSpot, DEMO_NOW } from './mocks.js';
import { extractEvents } from './intake.js';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** fetch wrapper: retries 429/5xx (Retry-After honoured) and returns { status, body } for every response. */
export function createHttpClient({ authorization, fetchImpl = globalThis.fetch, maxRetries = 3, baseDelayMs = 1000, secrets = [] }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available. Use Node.js 20 or newer.');
  return async function send(req) {
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(req.url, {
          method: req.method,
          headers: { ...(authorization ? { Authorization: authorization } : {}), Accept: 'application/json', ...(req.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
        });
      } catch (error) {
        if (attempt < maxRetries) { await sleep(baseDelayMs * 2 ** attempt); continue; }
        throw new Error(redactSecrets(`Request to ${new URL(req.url).host} failed: ${error.message}`, secrets));
      }
      const raw = await response.text();
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = { message: raw.slice(0, 200) }; }
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : NaN);
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt);
        continue;
      }
      return { status: response.status, body };
    }
  };
}

function unwrap(response) {
  if (response.status >= 200 && response.status < 300) return response.body;
  const body = response.body && typeof response.body === 'object' ? response.body : {};
  return { error: { status: response.status, message: body.message || (body.error && body.error.message) || `HTTP ${response.status}` } };
}

async function required(http, request, label) {
  const response = await http(request);
  if (response.status < 200 || response.status >= 300) throw new Error(`HubSpot ${label} failed with ${response.status}`);
  return response.body;
}

/**
 * Processes a batch of stage-change events end to end (without Slack delivery).
 * `wait(minutes)` implements the reason grace period; `state` holds the static-data table and counters.
 */
export async function processEvents({ config, events, hubspotHttp, airtableHttp, now, state = {}, wait = async () => {}, requestId = 'local' }) {
  const gate = enforceSandbox(await required(hubspotHttp, buildAccountDetailsRequest(config), 'account check'), config);
  if (!gate.ok) throw new Error(gate.reason);
  const portal = { portalId: gate.portalId, uiDomain: gate.uiDomain };
  const index = buildStageIndex(await required(hubspotHttp, buildPipelinesRequest(config), 'pipeline read'));
  const owners = buildOwnerIndex(await required(hubspotHttp, buildOwnersRequest(config), 'owner read'), { includeEmail: config.audit.includeOwnerEmail });

  const dealIds = [...new Set(events.map((event) => event.dealId))];
  const deals = [];
  for (const dealId of dealIds) deals.push(parseDealResponse(dealId, unwrap(await hubspotHttp(buildDealReadRequest(config, dealId)))));
  if (deals.length && deals.every((deal) => !deal.found)) throw new Error(`No deal could be read (first error: ${deals[0].error}). Check the token scopes and the deal IDs.`);

  let evaluations = evaluateEvents(events, deals, index, config);
  const recheckIds = dealsNeedingRecheck(evaluations);
  const waitMinutes = recheckIds.length && config.reason.graceMinutes > 0 ? config.reason.graceMinutes : 0;
  if (waitMinutes) {
    await wait(waitMinutes);
    const rechecks = [];
    for (const dealId of recheckIds) rechecks.push(parseDealResponse(dealId, unwrap(await hubspotHttp(buildReasonReadRequest(config, dealId)))));
    evaluations = applyReasonRechecks(evaluations, rechecks, config);
  }

  const records = buildAuditRecords(evaluations, owners, portal, config, now);
  const counters = summarizeEvaluations(evaluations);
  appendStaticRows(state, records, config);

  const auditResults = [];
  if (records.length && airtableEnabled(config) && !config.dryRun) {
    for (const plan of buildAirtableUpsertRequests(records, config)) auditResults.push(parseAirtableResponse(plan, unwrap(await airtableHttp(plan.request))));
  }
  const taskResults = [];
  const taskCandidates = recordsNeedingTasks(records, config);
  if (!config.dryRun) {
    for (const record of taskCandidates) taskResults.push(parseCreateResponse(record.auditKey, unwrap(await hubspotHttp(buildOwnerTaskRequest(config, record, now)))));
  }
  const alerted = recordsToAlert(records, config);
  const message = alerted.length ? buildLeadershipAlert({ records, alerted, auditResults, taskResults, config, requestId }) : null;
  const totals = buildRunTotals({ counters, auditResults, taskCandidates, taskResults, alerted });
  recordDailyCounters(state, totals, now);
  return { portal, evaluations, records, waitMinutes, auditResults, taskResults, alerted, message, counters: { ...totals, skipReasons: counters.skipReasons } };
}

/** Demo mode: bundled fictional deals and events behind the HubSpot mock, fixed clock, no waiting. */
export async function runDemo({ config, events = null, state = {}, requestId = 'demo' }) {
  const hubspot = createMockHubSpot();
  const normalized = events && events.length ? events : extractEvents(createDemoEvents(), 500).events;
  const result = await processEvents({ config, events: normalized, hubspotHttp: hubspot.request, airtableHttp: async () => { throw new Error('demo mode never calls Airtable'); }, now: Date.parse(DEMO_NOW), state, requestId });
  return { ...result, hubspot };
}

export async function postSlack(url, payload, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Slack webhook returned ${response.status}`);
}

/** Full run with real HTTP clients (or injected ones), including Slack delivery. */
export async function runAuditLogger({ config, events, fetchImpl = globalThis.fetch, hubspotHttp, airtableHttp, state = {}, wait, requestId = 'cli' }) {
  const { errors } = validateAuditConfig(config);
  if (errors.length) throw new Error(`Configuration invalid:\n- ${errors.join('\n- ')}`);
  const secrets = [config.hubspot.token, config.audit.airtableToken, config.webhook.secret, config.webhook.appClientSecret];
  const result = config.mode === 'demo'
    ? await runDemo({ config, events, state, requestId })
    : await processEvents({
      config,
      events,
      hubspotHttp: hubspotHttp || createHttpClient({ authorization: `Bearer ${config.hubspot.token}`, fetchImpl, secrets }),
      airtableHttp: airtableHttp || createHttpClient({ authorization: `Bearer ${config.audit.airtableToken}`, fetchImpl, secrets }),
      now: resolveNow(config),
      state,
      wait: wait || ((minutes) => sleep(minutes * 60000)),
      requestId,
    });
  const slack = resolveSlackTarget(config);
  let slackStatus = result.message ? `not sent: ${slack.reason}` : 'not sent: no regressions matched the alert rules';
  if (result.message && slack.target !== 'preview') {
    await postSlack(slack.target === 'production' ? config.alerts.webhookUrl : config.alerts.sandboxWebhookUrl, result.message, fetchImpl);
    slackStatus = `sent to the ${slack.target} webhook`;
  }
  return { ...result, slack: { ...slack, status: slackStatus } };
}
