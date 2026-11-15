// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Pipeline stage ordering and transition classification.
 *
 * Stage order comes from the pipelines API (displayOrder), never from hard-coded stage names,
 * so custom pipelines work. Closed stages use metadata.isClosed and metadata.probability.
 */

/** Builds { stagesById, pipelinesById } from GET /crm/v3/pipelines/deals. */
export function buildStageIndex(pipelinesBody) {
  const stagesById = {};
  const pipelinesById = {};
  const pipelines = pipelinesBody && Array.isArray(pipelinesBody.results) ? pipelinesBody.results : [];
  for (const pipeline of pipelines) {
    const stages = (pipeline.stages || []).filter((stage) => !stage.archived).slice().sort((a, b) => Number(a.displayOrder) - Number(b.displayOrder));
    const openStages = stages.filter((stage) => !isClosedStage(stage));
    pipelinesById[pipeline.id] = { id: String(pipeline.id), label: pipeline.label || String(pipeline.id), stageIds: stages.map((stage) => String(stage.id)) };
    for (const stage of stages) {
      const closed = isClosedStage(stage);
      const probability = Number(stage.metadata && stage.metadata.probability);
      stagesById[String(stage.id)] = {
        id: String(stage.id),
        label: stage.label || String(stage.id),
        pipelineId: String(pipeline.id),
        pipelineLabel: pipeline.label || String(pipeline.id),
        closed,
        won: closed && probability === 1,
        probability: Number.isFinite(probability) ? probability : null,
        openRank: closed ? null : openStages.findIndex((entry) => String(entry.id) === String(stage.id)),
      };
    }
  }
  return { stagesById, pipelinesById };
}

function isClosedStage(stage) {
  const flag = stage.metadata && stage.metadata.isClosed;
  return flag === true || String(flag).toLowerCase() === 'true';
}

/**
 * Classifies a stage change. Returns { type, regression, stepsBack, severity, previous, next }.
 * Types: regression, reopened, closed_reversal, forward, closed, pipeline_change, no_change, unknown_stage.
 */
export function classifyTransition(previousStageId, newStageId, index, detection) {
  const previous = index.stagesById[String(previousStageId)] || null;
  const next = index.stagesById[String(newStageId)] || null;
  const base = { previous, next, stepsBack: 0, regression: false, severity: null };
  if (!previous || !next) return { ...base, type: 'unknown_stage' };
  if (previous.id === next.id) return { ...base, type: 'no_change' };

  if (previous.pipelineId !== next.pipelineId) {
    const dropped = previous.probability !== null && next.probability !== null && next.probability < previous.probability;
    const regression = detection.pipelineChangePolicy === 'probability' && dropped;
    return { ...base, type: 'pipeline_change', regression, severity: regression ? 'normal' : null };
  }
  if (previous.closed && next.closed) {
    const reversal = previous.won && !next.won;
    return { ...base, type: reversal ? 'closed_reversal' : 'closed', regression: reversal && detection.trackClosedReversals, severity: reversal ? 'high' : null };
  }
  if (previous.closed && !next.closed) {
    return { ...base, type: 'reopened', regression: detection.trackReopened, severity: 'high' };
  }
  if (next.closed) return { ...base, type: 'closed' };

  const stepsBack = previous.openRank - next.openRank;
  if (stepsBack >= detection.minStepsBack) {
    return { ...base, type: 'regression', regression: true, stepsBack, severity: stepsBack >= detection.highSeveritySteps ? 'high' : 'normal' };
  }
  return { ...base, type: stepsBack > 0 ? 'minor_regression' : 'forward', stepsBack: Math.max(0, stepsBack) };
}

function sortedHistory(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({ value: entry.value === undefined || entry.value === null ? '' : String(entry.value), timestamp: Date.parse(entry.timestamp), sourceType: entry.sourceType || null, updatedByUserId: entry.updatedByUserId !== undefined && entry.updatedByUserId !== null ? String(entry.updatedByUserId) : null }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Finds the stage change an event refers to inside dealstage history (newest first) and returns
 * { found, previousStageId, newStageId, changedAt, enteredPreviousAt, changedByUserId, sourceType }.
 * App webhooks carry the new stage and occurredAt; workflow webhooks use the latest change.
 */
export function locateStageChange(history, event) {
  const entries = sortedHistory(history);
  let index = -1;
  if (event.newStageId) {
    const tolerance = 120000;
    if (event.occurredAt) index = entries.findIndex((entry) => entry.value === event.newStageId && Math.abs(entry.timestamp - event.occurredAt) <= tolerance);
    if (index < 0) index = entries.findIndex((entry) => entry.value === event.newStageId && (!event.occurredAt || entry.timestamp <= event.occurredAt + tolerance));
  } else if (entries.length) {
    index = 0;
  }
  if (index < 0 || !entries[index + 1]) return { found: false, reason: index < 0 ? 'stage_change_not_in_history' : 'no_previous_stage' };
  const change = entries[index];
  const previous = entries[index + 1];
  return {
    found: true,
    newStageId: change.value,
    previousStageId: previous.value,
    changedAt: change.timestamp,
    enteredPreviousAt: previous.timestamp,
    changedByUserId: change.updatedByUserId,
    sourceType: change.sourceType,
  };
}

/** Latest value and timestamp of a property from its history (falls back to the current value). */
export function latestPropertyValue(history, currentValue) {
  const entries = sortedHistory(history);
  if (entries.length) return { value: entries[0].value.trim(), timestamp: entries[0].timestamp };
  const value = currentValue === undefined || currentValue === null ? '' : String(currentValue).trim();
  return { value, timestamp: null };
}
