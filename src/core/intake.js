// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Webhook intake: authentication, replay protection and event extraction.
 *
 * Two authentication modes:
 * - shared_secret: a HubSpot workflow "Send a webhook" action sends WEBHOOK_SECRET in a header.
 * - hubspot_v3: a HubSpot app webhook subscription signs requests with X-HubSpot-Signature-v3,
 *   base64(HMAC-SHA256(client secret, method + uri + body + timestamp)).
 *
 * Accepted payloads: app webhook event arrays (deal.propertyChange on dealstage) and workflow
 * webhook objects ({ objectId } / { hs_object_id } / { dealId }).
 */
import { isPlaceholder } from './config.js';

export function constantTimeEqual(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  let mismatch = left.length === right.length ? 0 : 1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return mismatch === 0;
}

export function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  }
  return '';
}

/**
 * Verifies a HubSpot v3 signature. `hmacBase64(secret, text)` is injected (Node crypto in both
 * the CLI and the n8n Code node), so this module stays dependency-free.
 */
export function verifyHubSpotSignatureV3({ headers, rawBody, method = 'POST', config, now, hmacBase64 }) {
  const signature = headerValue(headers, 'x-hubspot-signature-v3');
  const timestamp = headerValue(headers, 'x-hubspot-request-timestamp');
  if (!signature || !timestamp) return { ok: false, reason: 'signature_headers_missing' };
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > config.webhook.maxSignatureAgeMinutes * 60000) return { ok: false, reason: 'signature_timestamp_outside_window' };
  const expected = hmacBase64(config.webhook.appClientSecret, `${method.toUpperCase()}${config.webhook.publicUrl}${rawBody}${timestamp}`);
  return constantTimeEqual(signature, expected) ? { ok: true, reason: null } : { ok: false, reason: 'signature_mismatch' };
}

function pickId(entry) {
  const nested = entry.properties && entry.properties.hs_object_id;
  const candidates = [entry.objectId, entry.dealId, entry.hs_object_id, entry.id, nested && typeof nested === 'object' ? nested.value : nested];
  const found = candidates.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  return found === undefined ? null : String(found).trim();
}

/**
 * Normalises a payload into stage-change events:
 * { eventId, dealId, newStageId (null when unknown), occurredAt (ms or null), source }.
 */
export function extractEvents(body, maxEvents) {
  const entries = Array.isArray(body) ? body : body && typeof body === 'object' ? (Array.isArray(body.events) ? body.events : [body]) : [];
  const events = [];
  let ignored = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') { ignored += 1; continue; }
    const isAppEvent = typeof entry.subscriptionType === 'string';
    if (isAppEvent && !(/^deal\.propertyChange$/i.test(entry.subscriptionType) && entry.propertyName === 'dealstage')) { ignored += 1; continue; }
    const dealId = pickId(entry);
    if (!dealId || !/^\d{1,20}$/.test(dealId)) { ignored += 1; continue; }
    const occurredAt = Number(entry.occurredAt);
    events.push({
      eventId: entry.eventId !== undefined && entry.eventId !== null ? String(entry.eventId) : null,
      dealId,
      newStageId: isAppEvent && entry.propertyValue ? String(entry.propertyValue) : (entry.dealstage ? String(entry.dealstage) : null),
      occurredAt: Number.isFinite(occurredAt) && occurredAt > 0 ? occurredAt : null,
      source: isAppEvent ? 'app_webhook' : 'workflow_webhook',
    });
  }
  const overflow = Math.max(0, events.length - maxEvents);
  return { events: events.slice(0, maxEvents), ignored, overflow };
}

/** Replay protection: remembers event IDs for 24 hours (n8n workflow static data or a CLI state file). */
export function filterDuplicateEvents(events, state, now) {
  const seen = state.processedEventIds || (state.processedEventIds = {});
  for (const [id, at] of Object.entries(seen)) if (now - at > 86400000) delete seen[id];
  const fresh = [];
  let duplicates = 0;
  for (const event of events) {
    if (event.eventId && seen[event.eventId]) { duplicates += 1; continue; }
    if (event.eventId) seen[event.eventId] = now;
    fresh.push(event);
  }
  const ids = Object.keys(seen);
  if (ids.length > 5000) for (const id of ids.sort((a, b) => seen[a] - seen[b]).slice(0, ids.length - 5000)) delete seen[id];
  return { fresh, duplicates };
}

export function newRequestId(now) {
  return `dsr-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Returns { accepted, statusCode, response, events, requestId, configError }.
 * Responses never echo secrets or payload contents.
 */
export function validateIntake({ headers, body, rawBody, method }, config, configErrors, state, now, hmacBase64) {
  const requestId = newRequestId(now);
  const reply = (statusCode, response, extra = {}) => ({ accepted: false, statusCode, response: { requestId, ...response }, events: [], requestId, configError: false, ...extra });
  if (configErrors.length) return reply(503, { error: 'audit_logger_not_configured' }, { configError: true });

  const demoWithoutSecret = config.mode === 'demo' && isPlaceholder(config.webhook.secret) && isPlaceholder(config.webhook.appClientSecret);
  if (!demoWithoutSecret) {
    if (config.webhook.authMode === 'hubspot_v3') {
      const raw = typeof rawBody === 'string' ? rawBody : JSON.stringify(body ?? '');
      const check = verifyHubSpotSignatureV3({ headers, rawBody: raw, method, config, now, hmacBase64 });
      if (!check.ok) return reply(401, { error: 'unauthorized' });
    } else if (!constantTimeEqual(headerValue(headers, config.webhook.headerName), config.webhook.secret)) {
      return reply(401, { error: 'unauthorized' });
    }
  }

  let payload = body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return reply(400, { error: 'invalid_json' }); }
  }
  const { events, ignored, overflow } = extractEvents(payload, config.webhook.maxEventsPerRequest);
  const { fresh, duplicates } = filterDuplicateEvents(events, state, now);
  if (!events.length) return reply(200, { accepted: 0, ignored, note: 'no deal stage changes in payload' });
  if (!fresh.length) return reply(200, { accepted: 0, duplicates, note: 'all events already processed' });
  return {
    accepted: true,
    statusCode: 202,
    response: { requestId, accepted: fresh.length, ignored, duplicates, overflow, mode: config.mode, dryRun: config.dryRun },
    events: fresh,
    requestId,
    configError: false,
  };
}
