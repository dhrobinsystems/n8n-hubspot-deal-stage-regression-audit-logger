// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Configuration for the deal stage regression audit logger. Every switch fails safe:
 * - DRY_RUN and SANDBOX_MODE stay on unless explicitly set to false/0/no/off.
 * - A placeholder HubSpot token puts the logger in demo mode (bundled fictional deals, no network).
 * - DRY_RUN blocks every external write (HubSpot tasks, Airtable rows). Slack goes to the sandbox
 *   webhook until DRY_RUN=false and SANDBOX_MODE=false.
 */

export const DEFAULT_HUBSPOT_BASE_URL = 'https://api.hubapi.com';
export const DEFAULT_AIRTABLE_BASE_URL = 'https://api.airtable.com';
export const SANDBOX_ACCOUNT_TYPES = Object.freeze(['SANDBOX', 'DEVELOPER_TEST']);
export const AUTH_MODES = Object.freeze(['shared_secret', 'hubspot_v3']);
export const AUDIT_PROVIDERS = Object.freeze(['static', 'airtable']);
export const PIPELINE_CHANGE_POLICIES = Object.freeze(['ignore', 'probability']);
export const SEVERITIES = Object.freeze(['normal', 'high']);
export const SLACK_WEBHOOK_PREFIX = 'https://hooks.slack.com/';
export const MIN_SECRET_LENGTH = 24;

const PLACEHOLDER_PATTERN = /^(?:|your_[a-z0-9_]+|changeme|change_me|placeholder|x{3,})$/i;
const EMBEDDED_PLACEHOLDER_PATTERN = /YOUR_[A-Z0-9_]{3,}/;
const PROPERTY_NAME_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

/** True for empty values and template placeholders such as YOUR_HUBSPOT_PRIVATE_APP_TOKEN. */
export function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  const text = String(value).trim();
  return PLACEHOLDER_PATTERN.test(text) || EMBEDDED_PLACEHOLDER_PATTERN.test(text);
}

/** Only recognised true/false words change a switch; anything else keeps the safe fallback. */
export function readBooleanEnv(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (text === '') return fallback;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  return fallback;
}

function readList(value) {
  if (value === undefined || value === null || isPlaceholder(value)) return [];
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function readNumber(raw, fallback, { min, max, integer = true }, name, problems) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const number = Number(String(raw).trim());
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < min || number > max) {
    problems.push(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max} (received "${raw}")`);
    return fallback;
  }
  return number;
}

function readChoice(raw, fallback, choices, name, problems) {
  const value = String(raw === undefined || raw === null || String(raw).trim() === '' ? fallback : raw).trim().toLowerCase();
  if (!choices.includes(value)) {
    problems.push(`${name} must be one of ${choices.join(', ')} (received "${raw}")`);
    return fallback;
  }
  return value;
}

/** Builds runtime configuration from n8n `$env` or `process.env`. options.forceMode pins "demo" or "hubspot". */
export function loadAuditConfig(env = {}, options = {}) {
  const source = env || {};
  const problems = [];
  const read = (name) => {
    const value = source[name];
    return value === undefined || value === null ? undefined : String(value).trim();
  };
  const token = read('HUBSPOT_PRIVATE_APP_TOKEN') || '';
  const config = {
    mode: options.forceMode || (isPlaceholder(token) ? 'demo' : 'hubspot'),
    dryRun: readBooleanEnv(read('DRY_RUN'), true),
    sandboxMode: readBooleanEnv(read('SANDBOX_MODE'), true),
    hubspot: {
      token,
      baseUrl: (read('HUBSPOT_BASE_URL') || DEFAULT_HUBSPOT_BASE_URL).replace(/\/+$/, ''),
      sandboxPortalId: read('HUBSPOT_SANDBOX_PORTAL_ID') || '',
    },
    webhook: {
      authMode: readChoice(read('WEBHOOK_AUTH_MODE'), 'shared_secret', AUTH_MODES, 'WEBHOOK_AUTH_MODE', problems),
      secret: read('WEBHOOK_SECRET') || '',
      headerName: (read('WEBHOOK_SECRET_HEADER') || 'x-webhook-secret').toLowerCase(),
      appClientSecret: read('HUBSPOT_APP_CLIENT_SECRET') || '',
      publicUrl: read('WEBHOOK_PUBLIC_URL') || '',
      maxSignatureAgeMinutes: readNumber(read('WEBHOOK_MAX_AGE_MINUTES'), 5, { min: 1, max: 60 }, 'WEBHOOK_MAX_AGE_MINUTES', problems),
      maxEventsPerRequest: readNumber(read('MAX_EVENTS_PER_REQUEST'), 100, { min: 1, max: 500 }, 'MAX_EVENTS_PER_REQUEST', problems),
    },
    detection: {
      pipelineIds: readList(read('PIPELINE_IDS')),
      minStepsBack: readNumber(read('REGRESSION_MIN_STEPS'), 1, { min: 1, max: 50 }, 'REGRESSION_MIN_STEPS', problems),
      highSeveritySteps: readNumber(read('HIGH_SEVERITY_STEPS'), 2, { min: 1, max: 50 }, 'HIGH_SEVERITY_STEPS', problems),
      trackReopened: readBooleanEnv(read('TRACK_REOPENED_DEALS'), true),
      trackClosedReversals: readBooleanEnv(read('TRACK_CLOSED_REVERSALS'), true),
      pipelineChangePolicy: readChoice(read('PIPELINE_CHANGE_POLICY'), 'ignore', PIPELINE_CHANGE_POLICIES, 'PIPELINE_CHANGE_POLICY', problems),
    },
    reason: {
      property: read('REGRESSION_REASON_PROPERTY') || 'deal_regression_reason',
      minLength: readNumber(read('REASON_MIN_LENGTH'), 3, { min: 1, max: 500 }, 'REASON_MIN_LENGTH', problems),
      graceMinutes: readNumber(read('REASON_GRACE_MINUTES'), 15, { min: 0, max: 1440 }, 'REASON_GRACE_MINUTES', problems),
    },
    tasks: {
      enabled: readBooleanEnv(read('CREATE_OWNER_TASKS'), true),
      dueHours: readNumber(read('TASK_DUE_HOURS'), 24, { min: 1, max: 720 }, 'TASK_DUE_HOURS', problems),
    },
    audit: {
      provider: readChoice(read('AUDIT_TABLE_PROVIDER'), 'static', AUDIT_PROVIDERS, 'AUDIT_TABLE_PROVIDER', problems),
      airtableToken: read('AIRTABLE_TOKEN') || '',
      airtableBaseId: read('AIRTABLE_BASE_ID') || '',
      airtableTable: read('AIRTABLE_TABLE_NAME') || 'Deal Stage Regressions',
      airtableBaseUrl: (read('AIRTABLE_BASE_URL') || DEFAULT_AIRTABLE_BASE_URL).replace(/\/+$/, ''),
      staticRowLimit: readNumber(read('STATIC_AUDIT_ROW_LIMIT'), 200, { min: 10, max: 5000 }, 'STATIC_AUDIT_ROW_LIMIT', problems),
      includeOwnerEmail: readBooleanEnv(read('INCLUDE_OWNER_EMAIL'), false),
    },
    alerts: {
      webhookUrl: read('SLACK_WEBHOOK_URL') || '',
      sandboxWebhookUrl: read('SLACK_SANDBOX_WEBHOOK_URL') || '',
      minSeverity: readChoice(read('ALERT_MIN_SEVERITY'), 'normal', SEVERITIES, 'ALERT_MIN_SEVERITY', problems),
      onlyMissingReason: readBooleanEnv(read('ALERT_ONLY_MISSING_REASON'), false),
      minAmount: readNumber(read('ALERT_MIN_AMOUNT'), 0, { min: 0, max: 1e12, integer: false }, 'ALERT_MIN_AMOUNT', problems),
      maxListed: readNumber(read('ALERT_MAX_LISTED'), 10, { min: 1, max: 25 }, 'ALERT_MAX_LISTED', problems),
    },
    manualTestDealIds: readList(read('MANUAL_TEST_DEAL_IDS')),
    nowOverride: read('AUDIT_NOW') || null,
    problems,
  };
  if (config.nowOverride && !Number.isFinite(Date.parse(config.nowOverride))) problems.push(`AUDIT_NOW must be an ISO 8601 timestamp (received "${config.nowOverride}")`);
  return config;
}

export function isLiveMode(config) {
  return !config.dryRun && !config.sandboxMode;
}

export function resolveNow(config) {
  const parsed = config.nowOverride ? Date.parse(config.nowOverride) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function usableSlack(url) {
  return !isPlaceholder(url) && String(url).startsWith(SLACK_WEBHOOK_PREFIX);
}

/** Where alerts may go. Never returns the URL, so it stays out of n8n item data. */
export function resolveSlackTarget(config) {
  if (isLiveMode(config)) {
    return usableSlack(config.alerts.webhookUrl)
      ? { target: 'production', reason: 'live mode' }
      : { target: 'preview', reason: 'SLACK_WEBHOOK_URL is not configured, so the alert is only logged' };
  }
  return usableSlack(config.alerts.sandboxWebhookUrl)
    ? { target: 'sandbox', reason: 'DRY_RUN or SANDBOX_MODE is on, so alerts go to SLACK_SANDBOX_WEBHOOK_URL' }
    : { target: 'preview', reason: 'DRY_RUN or SANDBOX_MODE is on and SLACK_SANDBOX_WEBHOOK_URL is not configured, so the alert is only logged' };
}

export function airtableEnabled(config) {
  return config.audit.provider === 'airtable';
}

export function describeSafety(config) {
  return {
    mode: config.mode,
    dryRun: config.dryRun,
    sandboxMode: config.sandboxMode,
    auditProvider: config.audit.provider,
    externalWritesPossible: config.mode === 'hubspot' && !config.dryRun,
    slackTarget: resolveSlackTarget(config).target,
  };
}

/** Returns { errors, warnings }. Any error stops the workflow before it touches HubSpot. */
export function validateAuditConfig(config) {
  const errors = [...config.problems];
  const warnings = [];
  const live = isLiveMode(config);

  for (const [name, url] of [['SLACK_WEBHOOK_URL', config.alerts.webhookUrl], ['SLACK_SANDBOX_WEBHOOK_URL', config.alerts.sandboxWebhookUrl]]) {
    if (!isPlaceholder(url) && !String(url).startsWith(SLACK_WEBHOOK_PREFIX)) errors.push(`${name} must start with ${SLACK_WEBHOOK_PREFIX}`);
  }
  if (!PROPERTY_NAME_PATTERN.test(config.reason.property)) errors.push(`REGRESSION_REASON_PROPERTY "${config.reason.property}" is not a valid HubSpot property name`);
  if (config.detection.highSeveritySteps < config.detection.minStepsBack) warnings.push('HIGH_SEVERITY_STEPS is lower than REGRESSION_MIN_STEPS, so every regression is high severity.');
  if (airtableEnabled(config)) {
    if (isPlaceholder(config.audit.airtableToken) || isPlaceholder(config.audit.airtableBaseId)) errors.push('AUDIT_TABLE_PROVIDER=airtable needs AIRTABLE_TOKEN and AIRTABLE_BASE_ID (or set AUDIT_TABLE_PROVIDER=static)');
    else if (!/^app[A-Za-z0-9]{6,}$/.test(config.audit.airtableBaseId)) errors.push('AIRTABLE_BASE_ID must look like appXXXXXXXXXXXXXX');
    if (!/^https:\/\//.test(config.audit.airtableBaseUrl)) errors.push('AIRTABLE_BASE_URL must use https://');
  }

  if (config.mode === 'demo') {
    if (live) errors.push('Live mode (DRY_RUN=false and SANDBOX_MODE=false) needs a real HUBSPOT_PRIVATE_APP_TOKEN. Replace the placeholder or turn DRY_RUN back on.');
    warnings.push('HUBSPOT_PRIVATE_APP_TOKEN is a placeholder, so the logger runs against bundled fictional deals and makes no HubSpot calls.');
    return { errors, warnings };
  }

  if (!/^https:\/\//.test(config.hubspot.baseUrl)) errors.push('HUBSPOT_BASE_URL must use https://');
  if (config.webhook.authMode === 'shared_secret' && (isPlaceholder(config.webhook.secret) || config.webhook.secret.length < MIN_SECRET_LENGTH)) {
    errors.push(`WEBHOOK_SECRET must be a random value of at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (config.webhook.authMode === 'hubspot_v3') {
    if (isPlaceholder(config.webhook.appClientSecret)) errors.push('WEBHOOK_AUTH_MODE=hubspot_v3 needs HUBSPOT_APP_CLIENT_SECRET');
    if (isPlaceholder(config.webhook.publicUrl) || !/^https:\/\//.test(config.webhook.publicUrl)) errors.push('WEBHOOK_AUTH_MODE=hubspot_v3 needs WEBHOOK_PUBLIC_URL (the exact https:// URL HubSpot calls)');
  }
  if (!isPlaceholder(config.hubspot.sandboxPortalId) && !/^\d+$/.test(config.hubspot.sandboxPortalId)) errors.push('HUBSPOT_SANDBOX_PORTAL_ID must be numeric when set');
  if (live && isPlaceholder(config.alerts.webhookUrl)) warnings.push('Live mode without SLACK_WEBHOOK_URL: leadership alerts are only logged.');
  if (config.audit.provider === 'static') warnings.push('AUDIT_TABLE_PROVIDER=static keeps the audit table in n8n workflow static data (last rows only). Use airtable for a durable table.');
  return { errors, warnings };
}
