// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * HubSpot request builders and parsers. No network access, and no request object carries the token:
 * the n8n HTTP Request nodes add `Authorization: Bearer {{ $env.HUBSPOT_PRIVATE_APP_TOKEN }}`.
 */
import { isPlaceholder, SANDBOX_ACCOUNT_TYPES } from './config.js';

export const TASK_TO_DEAL_ASSOCIATION_TYPE_ID = 216;
export const DEAL_PROPERTIES = Object.freeze(['dealname', 'dealstage', 'pipeline', 'amount', 'deal_currency_code', 'hubspot_owner_id']);

export function hubspotUrl(config, path) {
  return `${config.hubspot.baseUrl}${path}`;
}

export function buildAccountDetailsRequest(config) {
  return { method: 'GET', url: hubspotUrl(config, '/account-info/v3/details') };
}

export function buildPipelinesRequest(config) {
  return { method: 'GET', url: hubspotUrl(config, '/crm/v3/pipelines/deals') };
}

export function buildOwnersRequest(config) {
  return { method: 'GET', url: hubspotUrl(config, '/crm/v3/owners?limit=500&archived=false') };
}

export function buildDealReadRequest(config, dealId) {
  const properties = [...DEAL_PROPERTIES, config.reason.property].join(',');
  return { method: 'GET', url: hubspotUrl(config, `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${encodeURIComponent(properties)}&propertiesWithHistory=${encodeURIComponent(`dealstage,${config.reason.property}`)}`) };
}

export function buildReasonReadRequest(config, dealId) {
  return { method: 'GET', url: hubspotUrl(config, `/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${encodeURIComponent(config.reason.property)}&propertiesWithHistory=${encodeURIComponent(config.reason.property)}`) };
}

/** Refuses to continue when SANDBOX_MODE=true and the token belongs to a production portal. */
export function enforceSandbox(account, config) {
  const portalId = account && account.portalId !== undefined && account.portalId !== null ? String(account.portalId) : null;
  const accountType = account && account.accountType ? String(account.accountType).toUpperCase() : null;
  const uiDomain = account && /^app(?:-[a-z0-9]+)?\.hubspot\.com$/.test(String(account.uiDomain || '')) ? account.uiDomain : 'app.hubspot.com';
  const base = { portalId, accountType, uiDomain };
  if (!config.sandboxMode) return { ok: true, ...base, reason: 'SANDBOX_MODE=false, so production portals are allowed' };
  if (accountType && SANDBOX_ACCOUNT_TYPES.includes(accountType)) return { ok: true, ...base, reason: `account type ${accountType} is a sandbox or test account` };
  if (portalId && !isPlaceholder(config.hubspot.sandboxPortalId) && portalId === config.hubspot.sandboxPortalId) return { ok: true, ...base, reason: 'portal ID matches HUBSPOT_SANDBOX_PORTAL_ID' };
  return { ok: false, ...base, reason: `SANDBOX_MODE=true, but the connected portal (account type ${accountType || 'unknown'}) is not a sandbox or developer test account and does not match HUBSPOT_SANDBOX_PORTAL_ID. I refuse to continue.` };
}

export function dealUrl(portal, dealId) {
  if (!portal || !/^\d+$/.test(String(portal.portalId || ''))) return null;
  return `https://${portal.uiDomain || 'app.hubspot.com'}/contacts/${portal.portalId}/record/0-3/${dealId}`;
}

/** Indexes GET /crm/v3/owners by owner ID and by user ID (history entries record the user ID). */
export function buildOwnerIndex(ownersBody, { includeEmail = false } = {}) {
  const byOwnerId = {};
  const byUserId = {};
  const results = ownersBody && Array.isArray(ownersBody.results) ? ownersBody.results : [];
  for (const owner of results) {
    const name = [owner.firstName, owner.lastName].filter(Boolean).join(' ').trim() || `Owner ${owner.id}`;
    const entry = { ownerId: String(owner.id), userId: owner.userId !== undefined && owner.userId !== null ? String(owner.userId) : null, name, email: includeEmail ? owner.email || null : null };
    byOwnerId[entry.ownerId] = entry;
    if (entry.userId) byUserId[entry.userId] = entry;
  }
  return { byOwnerId, byUserId, truncated: Boolean(ownersBody && ownersBody.paging && ownersBody.paging.next) };
}

export function parseDealResponse(dealId, body) {
  if (body && typeof body === 'object' && body.id !== undefined && body.properties) {
    return { dealId: String(body.id), found: true, properties: body.properties, history: body.propertiesWithHistory || {}, error: null };
  }
  const message = body && typeof body === 'object' ? (typeof body.error === 'object' && body.error ? body.error.message : body.message || body.error) : null;
  return { dealId: String(dealId), found: false, properties: {}, history: {}, error: String(message || 'deal_not_readable').slice(0, 200) };
}

export function buildOwnerTaskRequest(config, record, now) {
  const due = new Date(now + config.tasks.dueHours * 3600000).toISOString();
  return {
    method: 'POST',
    url: hubspotUrl(config, '/crm/v3/objects/tasks'),
    body: {
      properties: {
        hs_task_subject: `Add a regression reason: ${record.dealName}`.slice(0, 250),
        hs_task_body: `This deal moved back from "${record.previousStage}" to "${record.newStage}" on ${record.regressedAt}. Please fill in "${config.reason.property}" so the regression is documented for the pipeline review.`,
        hs_timestamp: due,
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: record.severity === 'high' ? 'HIGH' : 'MEDIUM',
        hs_task_type: 'TODO',
        hubspot_owner_id: record.ownerId,
      },
      associations: [{ to: { id: record.dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TASK_TO_DEAL_ASSOCIATION_TYPE_ID }] }],
    },
  };
}

export function parseCreateResponse(key, body) {
  const ok = Boolean(body && typeof body === 'object' && body.id !== undefined && !body.error);
  return { key, ok, id: ok ? String(body.id) : null, error: ok ? null : String((body && (body.message || (body.error && body.error.message) || body.error)) || 'create_failed').slice(0, 200) };
}
