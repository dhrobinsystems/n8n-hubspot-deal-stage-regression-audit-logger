// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * The audit tracking table.
 * - static (default): the last STATIC_AUDIT_ROW_LIMIT rows in n8n workflow static data (no setup).
 * - airtable: upserts into an Airtable table keyed on "Audit Key", so retried webhooks never duplicate rows.
 * Request objects never carry the Airtable token; the HTTP node adds it from $env.
 */

export const AIRTABLE_FIELDS = Object.freeze({
  auditKey: 'Audit Key',
  dealId: 'Deal ID',
  dealName: 'Deal Name',
  dealUrl: 'Deal URL',
  pipeline: 'Pipeline',
  previousStage: 'Previous Stage',
  newStage: 'New Stage',
  transitionType: 'Transition',
  stepsBack: 'Steps Back',
  severity: 'Severity',
  amount: 'Amount',
  currency: 'Currency',
  ownerName: 'Owner',
  ownerEmail: 'Owner Email',
  changedBy: 'Changed By',
  changeSource: 'Change Source',
  regressedAt: 'Regressed At',
  detectedAt: 'Detected At',
  reason: 'Regression Reason',
  reasonStatus: 'Reason Status',
  runMode: 'Run Mode',
});

const AIRTABLE_BATCH_SIZE = 10;

export function toAirtableFields(record, config) {
  const fields = {};
  for (const [key, column] of Object.entries(AIRTABLE_FIELDS)) {
    if (key === 'ownerEmail' && !config.audit.includeOwnerEmail) continue;
    const value = record[key];
    if (value === null || value === undefined || value === '') continue;
    fields[column] = value;
  }
  return fields;
}

export function buildAirtableUpsertRequests(records, config) {
  const url = `${config.audit.airtableBaseUrl}/v0/${encodeURIComponent(config.audit.airtableBaseId)}/${encodeURIComponent(config.audit.airtableTable)}`;
  const requests = [];
  for (let index = 0; index < records.length; index += AIRTABLE_BATCH_SIZE) {
    const batch = records.slice(index, index + AIRTABLE_BATCH_SIZE);
    requests.push({
      auditKeys: batch.map((record) => record.auditKey),
      request: {
        method: 'PATCH',
        url,
        body: { performUpsert: { fieldsToMergeOn: [AIRTABLE_FIELDS.auditKey] }, typecast: true, records: batch.map((record) => ({ fields: toAirtableFields(record, config) })) },
      },
    });
  }
  return requests;
}

export function parseAirtableResponse(plan, body) {
  const ok = Boolean(body && Array.isArray(body.records) && !body.error);
  return {
    auditKeys: plan.auditKeys,
    ok,
    created: ok && Array.isArray(body.createdRecords) ? body.createdRecords.length : 0,
    updated: ok && Array.isArray(body.updatedRecords) ? body.updatedRecords.length : 0,
    error: ok ? null : String((body && body.error && (body.error.message || body.error.type || body.error)) || 'airtable_write_failed').slice(0, 200),
  };
}

/** Upserts rows into the static-data table, newest first, capped at STATIC_AUDIT_ROW_LIMIT. */
export function appendStaticRows(state, records, config) {
  const table = state.regressionAuditRows || (state.regressionAuditRows = []);
  for (const record of records) {
    const index = table.findIndex((row) => row.auditKey === record.auditKey);
    const row = { ...record };
    if (!config.audit.includeOwnerEmail) delete row.ownerEmail;
    if (index >= 0) table.splice(index, 1);
    table.unshift(row);
  }
  table.splice(config.audit.staticRowLimit);
  return table.length;
}

/** Daily counters (30 days) for dashboards and the run summary. */
export function recordDailyCounters(state, counters, now) {
  const store = state.regressionDailyCounters || (state.regressionDailyCounters = {});
  const day = new Date(now).toISOString().slice(0, 10);
  const bucket = store[day] || (store[day] = { runs: 0 });
  bucket.runs += 1;
  for (const [key, value] of Object.entries(counters)) if (typeof value === 'number') bucket[key] = (bucket[key] || 0) + value;
  const cutoff = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  for (const key of Object.keys(store)) if (key < cutoff) delete store[key];
  return bucket;
}

/** Run totals shared by the n8n workflow and the Node.js mirror. */
export function buildRunTotals({ counters, auditResults = [], taskCandidates = [], taskResults = [], alerted = [] }) {
  const { skipReasons, ...numeric } = counters;
  return {
    ...numeric,
    auditRowsWritten: auditResults.filter((result) => result.ok).reduce((sum, result) => sum + result.auditKeys.length, 0),
    auditWriteFailures: auditResults.filter((result) => !result.ok).length,
    tasksPlanned: taskCandidates.length,
    tasksCreated: taskResults.filter((result) => result.ok).length,
    taskFailures: taskResults.filter((result) => !result.ok).length,
    alerted: alerted.length,
  };
}
