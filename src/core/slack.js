// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Leadership alerts and redacted failure alerts (Slack Block Kit).
 */

const REASON_LABEL = { provided: ':white_check_mark: reason provided', missing: ':warning: *reason missing*', stale: ':warning: *reason stale* (left over from an earlier regression)' };
const TYPE_LABEL = { regression: 'moved back', reopened: 'reopened', closed_reversal: 'closed-won reversed', pipeline_change: 'moved pipeline' };

export function escapeSlack(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatAmount(record) {
  if (record.amount === null || record.amount === undefined) return null;
  const formatted = Number(record.amount).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return record.currency ? `${formatted} ${record.currency}` : formatted;
}

function badges(config) {
  const list = [];
  if (config.mode === 'demo') list.push('DEMO DATA');
  if (config.dryRun) list.push('DRY RUN');
  if (config.sandboxMode) list.push('SANDBOX');
  return list;
}

export function describeOutcome({ auditResults, taskResults, config }) {
  const parts = [];
  if (config.audit.provider === 'airtable') {
    if (config.dryRun) parts.push('audit rows kept in n8n only (DRY_RUN)');
    else parts.push(`${auditResults.filter((result) => result.ok).reduce((sum, result) => sum + result.auditKeys.length, 0)} audit row(s) upserted to Airtable${auditResults.some((result) => !result.ok) ? ', some failed' : ''}`);
  } else {
    parts.push('audit rows stored in n8n static data');
  }
  if (config.tasks.enabled) {
    if (config.dryRun) parts.push('owner tasks planned, not created (DRY_RUN)');
    else parts.push(`${taskResults.filter((result) => result.ok).length} owner task(s) created${taskResults.some((result) => !result.ok) ? `, ${taskResults.filter((result) => !result.ok).length} failed` : ''}`);
  }
  return parts.join(' · ');
}

export function buildLeadershipAlert({ records, alerted, auditResults = [], taskResults = [], config, requestId }) {
  const missing = alerted.filter((record) => record.reasonStatus !== 'provided').length;
  const tag = badges(config);
  const headline = `${alerted.length} deal stage regression${alerted.length === 1 ? '' : 's'}${missing ? `, ${missing} without a valid reason` : ''}`;
  const text = `${tag.length ? `[${tag.join(' | ')}] ` : ''}Deal stage regression audit: ${headline}.`;
  const lines = alerted.slice(0, config.alerts.maxListed).map((record) => {
    const name = record.dealUrl ? `<${record.dealUrl}|${escapeSlack(record.dealName)}>` : `*${escapeSlack(record.dealName)}*`;
    const amount = formatAmount(record);
    const steps = record.transitionType === 'regression' ? ` (${record.stepsBack} stage${record.stepsBack === 1 ? '' : 's'} back)` : '';
    const reason = record.reasonStatus === 'provided' ? `${REASON_LABEL.provided}: _${escapeSlack(record.reason).slice(0, 200)}_` : REASON_LABEL[record.reasonStatus];
    return [
      `${record.severity === 'high' ? ':red_circle:' : ':large_orange_circle:'} ${name}${amount ? ` · ${escapeSlack(amount)}` : ''}`,
      `   ${escapeSlack(record.previousStage)} → ${escapeSlack(record.newStage)} · ${TYPE_LABEL[record.transitionType] || record.transitionType}${steps} · ${escapeSlack(record.pipeline)}`,
      `   Owner: ${escapeSlack(record.ownerName)} · changed by ${escapeSlack(record.changedBy)} · ${escapeSlack(record.regressedAt)}`,
      `   ${reason}`,
    ].join('\n');
  });
  const more = alerted.length > config.alerts.maxListed ? `\n_${alerted.length - config.alerts.maxListed} more in the audit table._` : '';
  const body = `${lines.join('\n\n')}${more}`;
  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Deal stage regression audit', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `${tag.length ? `*${tag.join('  ·  ')}*\n` : ''}*${escapeSlack(headline)}*` } },
      { type: 'section', text: { type: 'mrkdwn', text: body.length > 2900 ? `${body.slice(0, 2880)}\n_...shortened_` : body } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${escapeSlack(describeOutcome({ auditResults, taskResults, config }))} · ${records.length} regression(s) logged · request ${escapeSlack(requestId)}` }] },
    ],
  };
}

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /pat-[a-z0-9]+-[A-Za-z0-9-]+/gi,
  /\bpat[A-Za-z0-9]{10,}\.[A-Za-z0-9]{20,}\b/g,
  /https:\/\/hooks\.slack\.com\/[^\s"']+/gi,
  /([?&](?:hapikey|api_key|token|access_token)=)[^&\s"']+/gi,
];

export function redactSecrets(value, extraSecrets = []) {
  let output = String(value ?? '');
  for (const secret of extraSecrets) if (secret && String(secret).length >= 6) output = output.split(String(secret)).join('[redacted]');
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, (match, prefix) => (typeof prefix === 'string' && /^[?&]/.test(prefix) ? `${prefix}[redacted]` : '[redacted]'));
  return output;
}

export function buildFailureAlert({ errorMessage, lastNode, executionId, workflowName, config, secrets }) {
  const message = redactSecrets(errorMessage || 'Unknown error', secrets).slice(0, 1500);
  const label = config.dryRun || config.sandboxMode ? ' [DRY RUN / SANDBOX]' : '';
  return {
    text: `Deal stage regression audit failed${label}${lastNode ? ` in "${lastNode}"` : ''}.`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Deal stage regression audit failed', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `:x: Node: *${escapeSlack(lastNode || 'unknown')}*${label}\n\`\`\`${escapeSlack(message)}\`\`\`` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Workflow ${escapeSlack(workflowName || 'n8n-hubspot-deal-stage-regression-audit-logger')} · execution ${escapeSlack(executionId || 'unknown')}` }] },
    ],
  };
}
