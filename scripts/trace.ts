/**
 * Trace — one merged timeline across all flows for recent runs: every Studio
 * step, tagged with its flow (L0..L3 = scenario A, C0..C3 = scenario B),
 * sorted by time, with the gap from the previous step. This is how you read
 * hop latency (/call, /return) and confirm the unwind order.
 *
 * Flags: --hours N (default 6)   --address +55… (one customer; default = all)
 */
import { openConversations } from './lib/conversations.js';
import { addressArg, addressKeys, log, requireEnv } from './lib/env.js';
import { flowsFromEnv, listExecutions, listSteps } from './lib/studio.js';

requireEnv('TWILIO_API_KEY', 'TWILIO_API_SECRET', 'TWILIO_WHATSAPP_NUMBER');
const hoursArg = process.argv.indexOf('--hours');
const HOURS = hoursArg > -1 ? Number(process.argv[hoursArg + 1]) : 6;
const ADDRESS = addressArg();

interface Row {
  t: number;
  flow: string;
  exec: string;
  contact: string;
  status: string;
  from: string;
  to: string;
  event: string;
}

(async () => {
  const keys = ADDRESS ? new Set([...addressKeys(ADDRESS), ...(await openConversations(ADDRESS)).map((c) => c.sid)]) : null;
  const rows: Row[] = [];
  for (const f of flowsFromEnv()) {
    const execs = (await listExecutions(f.sid, HOURS)).filter((e) => !keys || keys.has(e.contact_channel_address));
    for (const e of execs) {
      const steps = await listSteps(f.sid, e.sid);
      const contact = e.contact_channel_address.slice(-6);
      for (const s of steps) {
        rows.push({ t: new Date(s.date_created).getTime(), flow: f.key, exec: e.sid.slice(-6), contact, status: e.status, from: s.transitioned_from, to: s.transitioned_to, event: s.name });
      }
      if (steps.length === 0) rows.push({ t: new Date(e.date_created).getTime(), flow: f.key, exec: e.sid.slice(-6), contact, status: e.status, from: '-', to: '(no steps yet)', event: '' });
    }
  }
  if (rows.length === 0) return log('trace', `no executions${ADDRESS ? ` for ${ADDRESS}` : ''} in the last ${HOURS}h.`);
  rows.sort((a, b) => a.t - b.t);
  console.log(`\n${'time'.padEnd(12)} ${'+ms'.padStart(7)}  ${'flow'.padEnd(4)} ${'exec'.padEnd(7)} ${'contact'.padEnd(7)} ${'status'.padEnd(6)}  transition`);
  let prev = rows[0]!.t;
  for (const r of rows) {
    const time = new Date(r.t).toISOString().slice(11, 23);
    console.log(`${time.padEnd(12)} ${String(r.t - prev).padStart(7)}  ${r.flow.padEnd(4)} ${r.exec.padEnd(7)} …${r.contact.padEnd(6)} ${r.status.padEnd(6)}  ${r.from} → ${r.to}${r.event ? `  (${r.event})` : ''}`);
    prev = r.t;
  }
  const active = [...new Set(rows.filter((r) => r.status === 'active').map((r) => `${r.flow}/${r.exec}`))];
  console.log(`\nactive executions: ${active.length ? active.join(', ') : 'none'}`);
  console.log('  A: children should be ENDED after /return (else END_CHILD_ON_RETURN — SETUP §9)');
  console.log('  B: NOTHING should be active between messages — every level ends on call/return');
})().catch((err) => {
  console.error('[trace] Failed:', err.message || err);
  process.exit(1);
});
