// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Fictional demo portal (Acme Corp, Example Company Inc.), plus in-memory HubSpot and Airtable
 * stand-ins for demo mode, the tests and the workflow simulation. No network access.
 */

export const DEMO_NOW = '2026-11-16T10:00:00.000Z';
const NOW = Date.parse(DEMO_NOW);
const minutesAgo = (minutes) => new Date(NOW - minutes * 60000).toISOString();
const daysAgo = (days) => minutesAgo(days * 1440);

export const DEMO_PIPELINES = Object.freeze({
  results: [
    {
      id: 'default',
      label: 'Sales Pipeline',
      displayOrder: 0,
      stages: [
        { id: 'appointmentscheduled', label: 'Appointment Scheduled', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.2' } },
        { id: 'qualifiedtobuy', label: 'Qualified To Buy', displayOrder: 1, metadata: { isClosed: 'false', probability: '0.4' } },
        { id: 'presentationscheduled', label: 'Presentation Scheduled', displayOrder: 2, metadata: { isClosed: 'false', probability: '0.6' } },
        { id: 'decisionmakerboughtin', label: 'Decision Maker Bought-In', displayOrder: 3, metadata: { isClosed: 'false', probability: '0.8' } },
        { id: 'contractsent', label: 'Contract Sent', displayOrder: 4, metadata: { isClosed: 'false', probability: '0.9' } },
        { id: 'closedwon', label: 'Closed Won', displayOrder: 5, metadata: { isClosed: 'true', probability: '1.0' } },
        { id: 'closedlost', label: 'Closed Lost', displayOrder: 6, metadata: { isClosed: 'true', probability: '0.0' } },
      ],
    },
    {
      id: '1234567',
      label: 'Renewals',
      displayOrder: 1,
      stages: [
        { id: '1234568', label: 'Renewal Review', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.5' } },
        { id: '1234569', label: 'Renewal Negotiation', displayOrder: 1, metadata: { isClosed: 'false', probability: '0.8' } },
        { id: '1234570', label: 'Renewed', displayOrder: 2, metadata: { isClosed: 'true', probability: '1.0' } },
        { id: '1234571', label: 'Churned', displayOrder: 3, metadata: { isClosed: 'true', probability: '0.0' } },
      ],
    },
  ],
});

export const DEMO_OWNERS = Object.freeze({
  results: [
    { id: '501', userId: 7001, firstName: 'Avery', lastName: 'Example', email: 'avery.example@example.com' },
    { id: '502', userId: 7002, firstName: 'Jordan', lastName: 'Sample', email: 'jordan.sample@example.com' },
  ],
});

const stage = (value, timestamp, userId = 7001) => ({ value, timestamp, sourceType: 'CRM_UI', sourceId: `userId:${userId}`, updatedByUserId: userId });
const reason = (value, timestamp, userId = 7001) => ({ value, timestamp, sourceType: 'CRM_UI', sourceId: `userId:${userId}`, updatedByUserId: userId });

/** Histories are newest first, as HubSpot returns them. */
export function createDemoDeals() {
  return {
    9001: {
      properties: { dealname: 'Acme Corp - Platform Rollout', pipeline: 'default', amount: '120000', deal_currency_code: 'USD', hubspot_owner_id: '501', deal_regression_reason: 'Budget frozen until the next fiscal year' },
      history: {
        dealstage: [stage('appointmentscheduled', minutesAgo(10)), stage('contractsent', daysAgo(10)), stage('decisionmakerboughtin', daysAgo(20)), stage('qualifiedtobuy', daysAgo(30)), stage('appointmentscheduled', daysAgo(40))],
        deal_regression_reason: [reason('Budget frozen until the next fiscal year', minutesAgo(9))],
      },
    },
    9002: {
      properties: { dealname: 'Example Company Inc. - Expansion', pipeline: 'default', amount: '45000', deal_currency_code: 'USD', hubspot_owner_id: '502' },
      history: {
        dealstage: [stage('qualifiedtobuy', minutesAgo(8), 7002), stage('decisionmakerboughtin', daysAgo(5), 7002), stage('qualifiedtobuy', daysAgo(14), 7002)],
        deal_regression_reason: [],
      },
    },
    9003: {
      properties: { dealname: 'Acme Corp - Add-on Seats', pipeline: 'default', amount: '8000', deal_currency_code: 'USD', hubspot_owner_id: '501' },
      history: { dealstage: [stage('presentationscheduled', minutesAgo(7)), stage('qualifiedtobuy', daysAgo(3))], deal_regression_reason: [] },
    },
    9004: {
      properties: { dealname: 'Example Company Inc. - Annual Renewal', pipeline: 'default', amount: '60000', deal_currency_code: 'USD', hubspot_owner_id: '502', deal_regression_reason: 'Pricing renegotiation' },
      history: {
        dealstage: [stage('contractsent', minutesAgo(6), 7002), stage('closedwon', daysAgo(30), 7002), stage('contractsent', daysAgo(60), 7002)],
        deal_regression_reason: [reason('Pricing renegotiation', daysAgo(45), 7002)],
      },
    },
    9005: {
      properties: { dealname: 'Acme Corp - Pilot Programme', pipeline: 'default', amount: '15000', deal_currency_code: 'USD', hubspot_owner_id: '501' },
      history: { dealstage: [stage('qualifiedtobuy', minutesAgo(5)), stage('presentationscheduled', daysAgo(4)), stage('qualifiedtobuy', daysAgo(12))], deal_regression_reason: [] },
      lateUpdate: { deal_regression_reason: reason('Champion left the company, re-qualifying', minutesAgo(1)) },
    },
    9006: {
      properties: { dealname: 'Example Company Inc. - Services', pipeline: 'default', amount: '22000', deal_currency_code: 'USD', hubspot_owner_id: '502' },
      history: { dealstage: [stage('closedlost', minutesAgo(4), 7002), stage('contractsent', daysAgo(2), 7002)], deal_regression_reason: [] },
    },
    9007: {
      properties: { dealname: 'Acme Corp - Renewal 2027', pipeline: 'default', amount: '30000', deal_currency_code: 'USD', hubspot_owner_id: '501' },
      history: { dealstage: [stage('qualifiedtobuy', minutesAgo(3)), stage('1234569', daysAgo(9))], deal_regression_reason: [] },
    },
    9008: {
      properties: { dealname: 'Example Company Inc. - Hardware Order', pipeline: 'default', amount: '9500', deal_currency_code: 'USD', hubspot_owner_id: '502', deal_regression_reason: 'Order cancelled by the customer' },
      history: {
        dealstage: [stage('closedlost', minutesAgo(2), 7002), stage('closedwon', daysAgo(15), 7002)],
        deal_regression_reason: [reason('Order cancelled by the customer', minutesAgo(1), 7002)],
      },
    },
  };
}

/** HubSpot app webhook events (deal.propertyChange on dealstage) matching the demo deals. */
export function createDemoEvents() {
  const deals = createDemoDeals();
  return Object.entries(deals).map(([dealId, deal], index) => ({
    eventId: 1001 + index,
    subscriptionId: 4242,
    portalId: 12345678,
    appId: 4343,
    occurredAt: Date.parse(deal.history.dealstage[0].timestamp) + 2000,
    subscriptionType: 'deal.propertyChange',
    attemptNumber: 0,
    objectId: Number(dealId),
    propertyName: 'dealstage',
    propertyValue: deal.history.dealstage[0].value,
    changeSource: 'CRM_UI',
  }));
}

function currentValue(deal, name) {
  if (name === 'dealstage') return deal.history.dealstage[0] ? deal.history.dealstage[0].value : null;
  return deal.properties[name] === undefined ? null : deal.properties[name];
}

export function createMockHubSpot({ deals = createDemoDeals(), account = { portalId: 'DEMO', accountType: 'SANDBOX', uiDomain: 'app.hubspot.com' }, pipelines = DEMO_PIPELINES, owners = DEMO_OWNERS, failTasks = false } = {}) {
  const calls = [];
  const reads = {};
  const tasks = [];
  async function request(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url);
    calls.push({ method, path: url.pathname, search: url.search, body: req.body === undefined ? null : JSON.parse(JSON.stringify(req.body)), headers: req.headers || {} });
    if (method === 'GET' && url.pathname === '/account-info/v3/details') return { status: 200, body: { ...account } };
    if (method === 'GET' && url.pathname === '/crm/v3/pipelines/deals') return { status: 200, body: JSON.parse(JSON.stringify(pipelines)) };
    if (method === 'GET' && url.pathname === '/crm/v3/owners') return { status: 200, body: JSON.parse(JSON.stringify(owners)) };
    const dealMatch = url.pathname.match(/^\/crm\/v3\/objects\/deals\/(\d+)$/);
    if (method === 'GET' && dealMatch) {
      const id = dealMatch[1];
      const deal = deals[id];
      if (!deal) return { status: 404, body: { status: 'error', category: 'OBJECT_NOT_FOUND', message: `resource not found for deal ${id}` } };
      reads[id] = (reads[id] || 0) + 1;
      if (reads[id] >= 2 && deal.lateUpdate) {
        for (const [name, entry] of Object.entries(deal.lateUpdate)) {
          deal.history[name] = [entry, ...(deal.history[name] || [])];
          deal.properties[name] = entry.value;
        }
        delete deal.lateUpdate;
      }
      const names = (url.searchParams.get('properties') || '').split(',').filter(Boolean);
      const historyNames = (url.searchParams.get('propertiesWithHistory') || '').split(',').filter(Boolean);
      const properties = { hs_object_id: id };
      for (const name of names) properties[name] = currentValue(deal, name);
      const propertiesWithHistory = {};
      for (const name of historyNames) propertiesWithHistory[name] = JSON.parse(JSON.stringify(deal.history[name] || []));
      return { status: 200, body: { id, properties, propertiesWithHistory, archived: false } };
    }
    if (method === 'POST' && url.pathname === '/crm/v3/objects/tasks') {
      if (failTasks) return { status: 500, body: { status: 'error', message: 'Internal error' } };
      const id = String(80000 + tasks.length + 1);
      tasks.push({ id, ...JSON.parse(JSON.stringify(req.body)) });
      return { status: 201, body: { id, properties: req.body.properties } };
    }
    return { status: 404, body: { status: 'error', message: `Mock HubSpot has no route for ${method} ${url.pathname}` } };
  }
  return { request, calls, tasks, deals, reads };
}

export function createMockAirtable({ fail = false } = {}) {
  const rows = {};
  const calls = [];
  async function request(req) {
    calls.push({ method: req.method, url: req.url, headers: req.headers || {}, body: JSON.parse(JSON.stringify(req.body || null)) });
    if (fail) return { status: 422, body: { error: { type: 'INVALID_REQUEST', message: 'Unknown field name' } } };
    const merge = req.body.performUpsert.fieldsToMergeOn[0];
    const records = [];
    const createdRecords = [];
    const updatedRecords = [];
    for (const record of req.body.records) {
      const key = record.fields[merge];
      const existing = rows[key];
      const id = existing ? existing.id : `rec${String(Object.keys(rows).length + 1).padStart(14, '0')}`;
      rows[key] = { id, fields: { ...(existing ? existing.fields : {}), ...record.fields } };
      (existing ? updatedRecords : createdRecords).push(id);
      records.push(rows[key]);
    }
    return { status: 200, body: { records, createdRecords, updatedRecords } };
  }
  return { request, rows, calls };
}
