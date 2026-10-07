/**
 * Reset — clean slate before a rehearsal. Chain FIRST.
 *
 *   1. End ACTIVE executions on all 8 flows. Scenario A keys executions on the
 *      customer address; scenario B on the Conversation SID — both covered.
 *      (A parked execution left behind swallows the next message routed to
 *      that flow — the messaging cousin of TAC guide gotcha 10.14.)
 *   2. Close OPEN conversations on our sender (scenario B: an open conversation
 *      holds the address and keeps its stale studio webhook — gotcha 10.17).
 *   3. Delete the Sync stack items (address keys AND conversation keys).
 *
 * Scope: executions on OUR 8 flows (always ours), Sync items in OUR map (ours),
 * and conversations ONLY if their scoped studio webhook points at one of our
 * flows — never "every open conversation on the sender": the sender is shared
 * and closed is a final state. `--address +55…` narrows everything to one
 * customer; add `--force` to close that customer's open conversations on our
 * sender even without our webhook (e.g. a stale Flex thread blocking a test).
 */
import { closeConversation, openConversations } from './lib/conversations.js';
import { addressArg, addressKeys, api, env, log, requireEnv } from './lib/env.js';
import { endExecution, flowAlive, flowsFromEnv, listExecutions } from './lib/studio.js';

requireEnv('TWILIO_API_KEY', 'TWILIO_API_SECRET', 'TWILIO_WHATSAPP_NUMBER');
const ADDRESS = addressArg();
const FORCE = process.argv.includes('--force');
if (FORCE && !ADDRESS) {
  console.error('--force requires --address <phone> (it closes that customer\'s conversations regardless of webhook).');
  process.exit(1);
}

(async () => {
  const convs = await openConversations(ADDRESS, FORCE);
  const keys = ADDRESS ? new Set([...addressKeys(ADDRESS), ...convs.map((c) => c.sid)]) : null;

  let ended = 0;
  for (const f of flowsFromEnv()) {
    if (!(await flowAlive(f.sid))) {
      log('reset', `${f.key} ${f.sid} is DEAD — skipped (re-run provision).`);
      continue;
    }
    for (const e of (await listExecutions(f.sid, 72)).filter((e) => e.status === 'active' && (!keys || keys.has(e.contact_channel_address)))) {
      log('reset', `${f.key} ended ${e.sid} (${e.contact_channel_address}) → ${await endExecution(f.sid, e.sid)}`);
      ended++;
    }
  }
  log('reset', `${ended} execution(s) ended.`);

  for (const c of convs) log('reset', `closed conversation ${c.sid} (${c.state}, ${c.address}) → ${await closeConversation(c)}`);

  const svc = env('SYNC_SERVICE_SID');
  const map = env('SYNC_MAP_NAME') || 'stacks';
  if (!svc) return log('reset', 'SYNC_SERVICE_SID unset — stacks not cleared.');
  const toDelete = new Set<string>(keys ?? []);
  if (!keys) {
    const items = await api<{ items?: { key: string }[] }>(`https://sync.twilio.com/v1/Services/${svc}/Maps/${map}/Items?PageSize=100`);
    for (const it of items.data.items ?? []) toDelete.add(it.key);
  }
  for (const key of toDelete) {
    const res = await api(`https://sync.twilio.com/v1/Services/${svc}/Maps/${map}/Items/${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (res.status !== 404) log('reset', `stack "${key}" → ${res.status}`);
  }
  console.log(`\n✅ Reset complete${ADDRESS ? ` for ${ADDRESS}` : ''} — message the sender to start at L0.`);
})().catch((err) => {
  console.error('[reset] Failed:', err.message || err);
  process.exit(1);
});
