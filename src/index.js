#!/usr/bin/env node
// DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
/**
 * Command-line runner (the Node.js mirror of workflow.json).
 *
 *   node src/index.js demo [--json]                       bundled fictional deals, no network
 *   node src/index.js replay <events.json> [--json]       replay a saved HubSpot webhook payload
 *        [--no-wait]                                      skip the reason grace period
 *   node src/index.js deals 123,456 [--json]              audit the latest stage change of each deal
 *
 * Variables come from the shell, then .env. Static-table rows, de-duplication state and daily
 * counters persist in data/state.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAuditConfig, validateAuditConfig } from './core/config.js';
import { extractEvents, filterDuplicateEvents } from './core/intake.js';
import { runAuditLogger } from './core/pipeline.js';

export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

export function loadContext({ cwd = process.cwd(), baseEnv = process.env } = {}) {
  const dotEnvPath = resolve(cwd, '.env');
  const env = { ...(existsSync(dotEnvPath) ? parseDotEnv(readFileSync(dotEnvPath, 'utf8')) : {}), ...baseEnv };
  return { env, config: loadAuditConfig(env), statePath: resolve(cwd, 'data', 'state.json') };
}

function loadState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function print(result, log) {
  for (const entry of result.evaluations) {
    if (entry.outcome === 'regression') {
      const record = result.records.find((row) => row.dealId === entry.dealId && row.auditKey.endsWith(String(entry.change.changedAt)));
      log(`REGRESSION ${entry.dealId.padEnd(6)} ${record.dealName}: ${record.previousStage} -> ${record.newStage} (${record.transitionType}, ${record.severity}) reason ${record.reasonStatus}${record.reasonRechecked ? ' after re-check' : ''}`);
    } else if (entry.outcome === 'not_regression') {
      log(`ok         ${entry.dealId.padEnd(6)} ${entry.transitionType}`);
    } else {
      log(`skipped    ${entry.dealId.padEnd(6)} ${entry.skipReason}`);
    }
  }
  const c = result.counters;
  log(`\n${c.regressions} regression(s): ${c.reasonProvided} with a reason, ${c.reasonMissing} missing, ${c.reasonStale} stale. Tasks: ${c.tasksCreated}/${c.tasksPlanned} created. Audit rows written: ${c.auditRowsWritten}.`);
  log(`Slack: ${result.slack.status}`);
}

export async function main(argv = process.argv.slice(2), { log = console.log, errorLog = console.error } = {}) {
  const [command = 'demo', target] = argv;
  const json = argv.includes('--json');
  try {
    const context = loadContext();
    const state = loadState(context.statePath);
    let config = context.config;
    let events = null;
    if (command === 'demo') {
      config = loadAuditConfig({ ...context.env, HUBSPOT_PRIVATE_APP_TOKEN: '' }, { forceMode: 'demo' });
    } else if (command === 'replay') {
      if (!target) throw new Error('Usage: node src/index.js replay <events.json>');
      const extracted = extractEvents(JSON.parse(readFileSync(resolve(target), 'utf8')), config.webhook.maxEventsPerRequest);
      const { fresh, duplicates } = filterDuplicateEvents(extracted.events, state, Date.now());
      if (duplicates) errorLog(`${duplicates} event(s) already processed and skipped`);
      events = fresh;
    } else if (command === 'deals') {
      const ids = String(target || '').split(',').map((id) => id.trim()).filter((id) => /^\d+$/.test(id));
      if (!ids.length) throw new Error('Usage: node src/index.js deals 123,456');
      events = ids.map((dealId) => ({ eventId: null, dealId, newStageId: null, occurredAt: null, source: 'manual' }));
    } else {
      throw new Error(`Unknown command "${command}". Use demo, replay or deals.`);
    }
    for (const warning of validateAuditConfig(config).warnings) errorLog(`warning: ${warning}`);
    if (events && !events.length) { log('Nothing to process.'); return 0; }
    const result = await runAuditLogger({
      config,
      events,
      state,
      wait: argv.includes('--no-wait') ? async () => {} : undefined,
      requestId: `cli-${Date.now().toString(36)}`,
    });
    if (config.mode !== 'demo') saveState(context.statePath, state);
    if (json) log(JSON.stringify({ counters: result.counters, records: result.records, slack: result.slack, message: result.message }, null, 2));
    else print(result, log);
    return 0;
  } catch (error) {
    errorLog(error.message);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; });
}
