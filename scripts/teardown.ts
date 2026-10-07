/**
 * Teardown — free every LIMITED resource this POC holds so the next one starts
 * with headroom (Serverless services: hard 50-per-account cap — hit live).
 *
 *   0. End ACTIVE executions on all 8 flows + close open conversations on our
 *      sender (hygiene)
 *   1. Sender wiring: delete OUR Address Configuration; restore the sender's
 *      inbound webhook to PREVIOUS_SENDER_WEBHOOK when it still points at /inbound
 *   2. Delete the 8 Studio flows (by .env SID, falling back to friendly name)   [--keep-flows]
 *   3. Delete the Serverless service `studio-nested-flows` + clear .twiliodeployinfo
 *   4. Delete the Sync service (and its map/items)
 *
 * Nothing shared is touched (no CO config, no templates, no other sender).
 *
 * Dry-run by default. `npm run teardown -- --apply` to execute.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { closeConversation, deleteAddressConfig, findAddressConfig, findSender, openConversations, servicesHoldingSender, setMessagingServiceInbound, setSenderWebhook, upsertAddressConfig } from './lib/conversations.js';
import { api, env, FLOWS, log, requireEnv, SERVERLESS_DIR, SERVERLESS_NAME, SYNC_FRIENDLY_NAME } from './lib/env.js';
import { deleteFlow, endExecution, findFlowByName, flowAlive, flowsFromEnv, listExecutions } from './lib/studio.js';

requireEnv('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY', 'TWILIO_API_SECRET', 'TWILIO_WHATSAPP_NUMBER');
const DRY = !process.argv.includes('--apply');
const KEEP_FLOWS = process.argv.includes('--keep-flows');
const tag = DRY ? ' (dry-run)' : '';

// ── 0. Executions + conversations ────────────────────────────────────────
async function hygiene() {
  for (const f of flowsFromEnv()) {
    if (!(await flowAlive(f.sid))) continue;
    for (const e of (await listExecutions(f.sid, 72)).filter((e) => e.status === 'active')) {
      log('0-hygiene', `end ${f.key} ${e.sid} (${e.contact_channel_address})${tag}`);
      if (!DRY) log('0-hygiene', `→ ${await endExecution(f.sid, e.sid)}`);
    }
  }
  for (const c of await openConversations()) {
    log('0-hygiene', `close conversation ${c.sid} (${c.state})${tag}`);
    if (!DRY) log('0-hygiene', `→ ${await closeConversation(c)}`);
  }
}

// ── 1. Sender wiring ─────────────────────────────────────────────────────
async function unwire() {
  const cfg = await findAddressConfig();
  if (cfg) {
    const ours = FLOWS.some((f) => env(f.envKey) && env(f.envKey) === cfg.auto_creation?.studio_flow_sid) || cfg.sid === env('ADDRESS_CONFIG_SID');
    const prevFlow = env('PREVIOUS_ADDRESS_CONFIG_FLOW_SID');
    if (ours && prevFlow) {
      // It existed before us (someone else's — e.g. a Flex pilot): put it back.
      const enabled = env('PREVIOUS_ADDRESS_CONFIG_ENABLED') !== 'false';
      log('1-wiring', `restore address configuration ${cfg.sid} → studio ${prevFlow} (enabled=${enabled})${tag}`);
      if (!DRY) {
        const upd = await upsertAddressConfig(prevFlow, enabled);
        log('1-wiring', `→ restored ${upd.sid}`);
      }
    } else if (ours) {
      log('1-wiring', `delete address configuration ${cfg.sid}${tag}`);
      if (!DRY) log('1-wiring', `→ ${await deleteAddressConfig(cfg.sid)}`);
    } else log('1-wiring', `address configuration ${cfg.sid} is not ours (flow ${cfg.auto_creation?.studio_flow_sid}) — left alone.`);
  } else log('1-wiring', 'no address configuration on the sender.');

  const sender = await findSender();
  if (!sender) return log('1-wiring', 'sender not found — nothing to restore.');
  const current = sender.webhook?.callback_url ?? '';
  const ours = (u: string) => Boolean(env('SERVERLESS_DOMAIN')) && u.includes(env('SERVERLESS_DOMAIN'));
  if (ours(current)) {
    const restore = env('PREVIOUS_SENDER_WEBHOOK');
    log('1-wiring', `sender webhook ${current} → ${restore || '(blank)'}${tag}`);
    if (!DRY) log('1-wiring', `→ ${await setSenderWebhook(sender.sid, restore)}`);
  } else log('1-wiring', `sender webhook is not ours (${current || '(none)'}) — left alone.`);

  for (const ms of await servicesHoldingSender(sender.sid)) {
    const msUrl = ms.inbound_request_url ?? '';
    if (!ours(msUrl)) {
      log('1-wiring', `messaging service ${ms.sid} inbound is not ours (${msUrl || '(none)'}) — left alone.`);
      continue;
    }
    const restoreMs = env('PREVIOUS_MS_INBOUND_URL');
    log('1-wiring', `messaging service ${ms.sid} (${ms.friendly_name}) inbound ${msUrl} → ${restoreMs || '(blank)'}${tag}`);
    if (!DRY) log('1-wiring', `→ ${await setMessagingServiceInbound(ms.sid, restoreMs)}`);
  }
}

// ── 2. Flows ─────────────────────────────────────────────────────────────
async function deleteFlows() {
  if (KEEP_FLOWS) return log('2-flows', 'kept (--keep-flows).');
  for (const f of FLOWS) {
    let sid = env(f.envKey);
    if (!sid || !(await flowAlive(sid))) sid = (await findFlowByName(f.name))?.sid ?? '';
    if (!sid) {
      log('2-flows', `${f.key} not found.`);
      continue;
    }
    log('2-flows', `delete ${f.key} ${sid}${tag}`);
    if (!DRY) log('2-flows', `→ ${await deleteFlow(sid)}`);
  }
}

// ── 3. Serverless ────────────────────────────────────────────────────────
async function deleteServerless() {
  const res = await api<{ services?: { sid: string; unique_name: string }[] }>('https://serverless.twilio.com/v1/Services?PageSize=100');
  const mine = (res.data.services ?? []).find((s) => s.unique_name === SERVERLESS_NAME);
  if (!mine) return log('3-functions', `"${SERVERLESS_NAME}" not found.`);
  log('3-functions', `delete ${mine.sid} (${SERVERLESS_NAME})${tag}`);
  if (DRY) return;
  const del = await api(`https://serverless.twilio.com/v1/Services/${mine.sid}`, { method: 'DELETE' });
  log('3-functions', `→ ${del.status} (frees one of the 50 service slots)`);
  rmSync(join(SERVERLESS_DIR, '.twiliodeployinfo'), { force: true });
  log('3-functions', 'cleared .twiliodeployinfo (next provision deploys fresh instead of 20404ing on the ghost SID)');
}

// ── 4. Sync ──────────────────────────────────────────────────────────────
async function deleteSync() {
  let sid = env('SYNC_SERVICE_SID');
  if (!sid || !(await api(`https://sync.twilio.com/v1/Services/${sid}`)).ok) {
    const list = await api<{ services?: { sid: string; friendly_name: string }[] }>('https://sync.twilio.com/v1/Services?PageSize=100');
    sid = (list.data.services ?? []).find((s) => s.friendly_name === SYNC_FRIENDLY_NAME)?.sid ?? '';
  }
  if (!sid) return log('4-sync', 'service not found.');
  log('4-sync', `delete ${sid}${tag}`);
  if (!DRY) log('4-sync', `→ ${(await api(`https://sync.twilio.com/v1/Services/${sid}`, { method: 'DELETE' })).status}`);
}

(async () => {
  console.log(`\n═══ studio-nested-flows TEARDOWN ${DRY ? '(DRY-RUN — pass --apply to execute)' : '(APPLYING)'} ═══\n`);
  await hygiene();
  await unwire();
  await deleteFlows();
  await deleteServerless();
  await deleteSync();
  console.log('\n─── Manual follow-ups ───');
  console.log('  · .env: blank ACTIVE_SCENARIO, SYNC_SERVICE_SID, SERVERLESS_*, *_FUNCTION_SID, *_FLOW_SID, ADDRESS_CONFIG_SID, PREVIOUS_SENDER_WEBHOOK so scripts fail loudly instead of hitting ghosts');
  console.log(`\n${DRY ? 'Dry-run complete — nothing deleted.' : 'Teardown complete.'} Rebuild: npm run provision (~5 min).`);
})().catch((err) => {
  console.error('[teardown] Failed:', err.message || err);
  process.exit(1);
});
