// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Regression detection, regression-reason checks and audit records. Pure functions.
 */
import { classifyTransition, latestPropertyValue, locateStageChange } from './stages.js';
import { dealUrl } from './hubspot.js';

/**
 * A reason counts only when it is long enough and was written after the deal entered the later
 * stage it fell back from. A reason left over from an earlier regression is "stale".
 */
export function evaluateReason(history, currentValue, enteredPreviousAt, config) {
  const latest = latestPropertyValue(history, currentValue);
  if (latest.value.length < config.reason.minLength) return { status: 'missing', value: latest.value || null, updatedAt: latest.timestamp };
  if (latest.timestamp !== null && latest.timestamp < enteredPreviousAt) return { status: 'stale', value: latest.value, updatedAt: latest.timestamp };
  return { status: 'provided', value: latest.value, updatedAt: latest.timestamp };
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * Evaluates every event against its deal. Returns one evaluation per event:
 * { eventId, dealId, outcome, transition, change, reason, deal } where outcome is
 * regression | not_regression | skipped.
 */
export function evaluateEvents(events, deals, index, config) {
  const dealsById = Object.fromEntries(deals.map((deal) => [deal.dealId, deal]));
  const seenChanges = new Set();
  return events.map((event) => {
    const base = { eventId: event.eventId, dealId: event.dealId, source: event.source };
    const deal = dealsById[event.dealId];
    if (!deal || !deal.found) return { ...base, outcome: 'skipped', skipReason: deal ? `deal_not_readable: ${deal.error}` : 'deal_not_read' };
    const change = locateStageChange(deal.history.dealstage, event);
    if (!change.found) return { ...base, outcome: 'skipped', skipReason: change.reason };
    const key = `${event.dealId}:${change.changedAt}`;
    if (seenChanges.has(key)) return { ...base, outcome: 'skipped', skipReason: 'duplicate_change_in_batch' };
    seenChanges.add(key);
    const transition = classifyTransition(change.previousStageId, change.newStageId, index, config.detection);
    const pipelineId = transition.next ? transition.next.pipelineId : null;
    if (config.detection.pipelineIds.length && pipelineId && !config.detection.pipelineIds.includes(pipelineId)) {
      return { ...base, outcome: 'skipped', skipReason: 'pipeline_not_monitored' };
    }
    if (!transition.regression) return { ...base, outcome: 'not_regression', transitionType: transition.type, change };
    const reason = evaluateReason(deal.history[config.reason.property], deal.properties[config.reason.property], change.enteredPreviousAt, config);
    return { ...base, outcome: 'regression', transition, change, reason, deal: { properties: deal.properties } };
  });
}

/** Regressions whose reason is still missing or stale get a second look after the grace period. */
export function dealsNeedingRecheck(evaluations) {
  return [...new Set(evaluations.filter((entry) => entry.outcome === 'regression' && entry.reason.status !== 'provided').map((entry) => entry.dealId))];
}

/** Applies re-read reason data ({ dealId, found, properties, history }) gathered after the grace period. */
export function applyReasonRechecks(evaluations, rechecks, config) {
  const byId = Object.fromEntries(rechecks.filter((entry) => entry.found).map((entry) => [entry.dealId, entry]));
  return evaluations.map((entry) => {
    if (entry.outcome !== 'regression' || entry.reason.status === 'provided' || !byId[entry.dealId]) return entry;
    const recheck = byId[entry.dealId];
    const reason = evaluateReason(recheck.history[config.reason.property], recheck.properties[config.reason.property], entry.change.enteredPreviousAt, config);
    return { ...entry, reason: { ...reason, rechecked: true } };
  });
}

function numberOrNull(value) {
  const number = Number(value);
  return value === undefined || value === null || value === '' || !Number.isFinite(number) ? null : number;
}

/** Turns regression evaluations into audit table records. */
export function buildAuditRecords(evaluations, owners, portal, config, now) {
  return evaluations.filter((entry) => entry.outcome === 'regression').map((entry) => {
    const properties = entry.deal.properties;
    const owner = owners.byOwnerId[text(properties.hubspot_owner_id)] || null;
    const changedBy = entry.change.changedByUserId ? owners.byUserId[entry.change.changedByUserId] || null : null;
    const regressedAt = new Date(entry.change.changedAt).toISOString();
    return {
      auditKey: `${entry.dealId}:${entry.change.changedAt}`,
      eventId: entry.eventId,
      dealId: entry.dealId,
      dealName: text(properties.dealname) || `Deal ${entry.dealId}`,
      dealUrl: dealUrl(portal, entry.dealId),
      pipeline: entry.transition.next.pipelineLabel,
      previousStage: entry.transition.previous.label,
      previousStageId: entry.transition.previous.id,
      newStage: entry.transition.next.label,
      newStageId: entry.transition.next.id,
      transitionType: entry.transition.type,
      stepsBack: entry.transition.stepsBack,
      severity: entry.transition.severity,
      amount: numberOrNull(properties.amount),
      currency: text(properties.deal_currency_code) || null,
      ownerId: owner ? owner.ownerId : (text(properties.hubspot_owner_id) || null),
      ownerName: owner ? owner.name : (text(properties.hubspot_owner_id) ? `Owner ${text(properties.hubspot_owner_id)}` : 'Unassigned'),
      ownerEmail: owner ? owner.email : null,
      changedBy: changedBy ? changedBy.name : (entry.change.changedByUserId ? `User ${entry.change.changedByUserId}` : (entry.change.sourceType || 'unknown')),
      changeSource: entry.change.sourceType,
      regressedAt,
      detectedAt: new Date(now).toISOString(),
      reason: entry.reason.value,
      reasonStatus: entry.reason.status,
      reasonRechecked: Boolean(entry.reason.rechecked),
      runMode: config.dryRun ? 'dry_run' : config.sandboxMode ? 'sandbox' : 'live',
    };
  });
}

export function summarizeEvaluations(evaluations) {
  const counters = { events: evaluations.length, regressions: 0, reasonProvided: 0, reasonMissing: 0, reasonStale: 0, notRegression: 0, skipped: 0 };
  const skipReasons = {};
  for (const entry of evaluations) {
    if (entry.outcome === 'regression') {
      counters.regressions += 1;
      if (entry.reason.status === 'provided') counters.reasonProvided += 1;
      else if (entry.reason.status === 'stale') counters.reasonStale += 1;
      else counters.reasonMissing += 1;
    } else if (entry.outcome === 'not_regression') counters.notRegression += 1;
    else {
      counters.skipped += 1;
      skipReasons[entry.skipReason] = (skipReasons[entry.skipReason] || 0) + 1;
    }
  }
  return { ...counters, skipReasons };
}

/** Records that leadership should hear about, after ALERT_MIN_SEVERITY, ALERT_MIN_AMOUNT and ALERT_ONLY_MISSING_REASON. */
export function recordsToAlert(records, config) {
  return records.filter((record) => {
    if (config.alerts.minSeverity === 'high' && record.severity !== 'high') return false;
    if (config.alerts.minAmount > 0 && (record.amount === null || record.amount < config.alerts.minAmount)) return false;
    if (config.alerts.onlyMissingReason && record.reasonStatus === 'provided') return false;
    return true;
  });
}

/** Owner tasks for regressions without a valid reason (only when CREATE_OWNER_TASKS=true and an owner exists). */
export function recordsNeedingTasks(records, config) {
  if (!config.tasks.enabled) return [];
  return records.filter((record) => record.reasonStatus !== 'provided' && Boolean(record.ownerId));
}
