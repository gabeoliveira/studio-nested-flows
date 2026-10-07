/**
 * Stack — print every live call stack in the Sync map (who is parked where).
 * Keys are addresses (scenario A) or Conversation SIDs (scenario B); flow SIDs
 * are resolved to their L0..L3 / C0..C3 tags from .env.
 */
import { api, env, requireEnv } from './lib/env.js';
import { flowsFromEnv } from './lib/studio.js';

requireEnv('TWILIO_API_KEY', 'TWILIO_API_SECRET', 'SYNC_SERVICE_SID');

interface Frame {
  parent: string;
  child: string;
  args?: Record<string, string>;
  at: string;
}

(async () => {
  const byLevel = new Map(flowsFromEnv().map((f) => [f.sid, f.key]));
  const name = (sid: string) => byLevel.get(sid) ?? sid;
  const map = env('SYNC_MAP_NAME') || 'stacks';
  const res = await api<{ items?: { key: string; data: { frames?: Frame[]; ret?: Record<string, string> | null }; date_updated: string }[] }>(
    `https://sync.twilio.com/v1/Services/${env('SYNC_SERVICE_SID')}/Maps/${map}/Items?PageSize=100`,
  );
  if (!res.ok) throw new Error(`list items ${res.status}: ${res.text.slice(0, 200)}`);
  const items = res.data.items ?? [];
  if (items.length === 0) return console.log('(no stacks — every session is idle / at L0)');
  for (const it of items) {
    const frames = it.data.frames ?? [];
    const scenario = it.key.startsWith('CH') ? 'B conversations' : 'A messaging';
    console.log(`\n${it.key}  [${scenario}]  depth=${frames.length}  updated ${it.date_updated}`);
    frames.forEach((f, i) => {
      const age = Math.round((Date.now() - new Date(f.at).getTime()) / 1000);
      console.log(`  ${i + 1}. ${name(f.parent)} → ${name(f.child)}  args=${JSON.stringify(f.args ?? {})}  (${age}s ago)`);
    });
    if (it.data.ret) console.log(`  return register (unconsumed): ${JSON.stringify({ ...it.data.ret, from: name(it.data.ret.from ?? ''), to: name(it.data.ret.to ?? '') })}`);
    console.log(`  next message routes to: ${frames.length ? name(frames[frames.length - 1]!.child) : 'L0'}`);
  }
})().catch((err) => {
  console.error('[stack] Failed:', err.message || err);
  process.exit(1);
});
