/**
 * Latency (Q6) — hop timings from the Functions log, which has millisecond
 * timestamps (`t` in our JSON lines); Studio's step API only has seconds.
 *
 * Hops measured (per session key, events in time order):
 *   A · inbound→call      parent receives the reply, decides, redirects to /call
 *   A · call→frame        redirect lands in the child, Studio starts it, child reads /frame
 *   A · return→return     one unwind hop (parent resumes on Return, sends, redirects to /return)
 *   B · call→frame        webhook flip + Conversations REPLAY + child start (the B bet)
 *   B · return→frame      replay back into the parent (mode=return)
 * Plus, from the Messages API (second granularity): inbound → first outbound
 * reply, the number the customer actually feels.
 *
 * Flags: --hours N (default 8)   --address +55… (one customer)
 */
import { addressArg, api, env, log, requireEnv, whatsappAddress } from './lib/env.js';

requireEnv('TWILIO_API_KEY', 'TWILIO_API_SECRET', 'SERVERLESS_SERVICE_SID', 'SERVERLESS_ENV_SID');
const hoursArg = process.argv.indexOf('--hours');
const HOURS = hoursArg > -1 ? Number(process.argv[hoursArg + 1]) : 8;
const ADDRESS = addressArg();
const GAP_MAX_MS = 15000; // beyond this the two events aren't the same hop

interface Ev {
  t: number;
  fn: string;
  mode?: string;
  key: string;
  body?: string;
  frameMode?: string;
}

async function fetchEvents(): Promise<Ev[]> {
  const since = new Date(Date.now() - HOURS * 3600e3).toISOString();
  const out: Ev[] = [];
  let url: string | null = `https://serverless.twilio.com/v1/Services/${env('SERVERLESS_SERVICE_SID')}/Environments/${env('SERVERLESS_ENV_SID')}/Logs?StartDate=${encodeURIComponent(since)}&PageSize=100`;
  let pages = 0;
  while (url && pages++ < 20) {
    const res: { ok: boolean; status: number; data: { logs?: { message: string }[]; meta?: { next_page_url?: string | null } }; text: string } = await api(url);
    if (!res.ok) throw new Error(`logs ${res.status}: ${res.text.slice(0, 200)}`);
    for (const l of res.data.logs ?? []) {
      try {
        const j = JSON.parse(l.message);
        if (!j.fn || !j.t || !j.key) continue;
        out.push({ t: new Date(j.t).getTime(), fn: j.fn, mode: j.mode, key: j.key, body: j.body, frameMode: j.fn === 'frame' ? j.mode : undefined });
      } catch {
        /* not one of ours */
      }
    }
    url = res.data.meta?.next_page_url ?? null;
  }
  return out.sort((a, b) => a.t - b.t);
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

function row(label: string, xs: number[]): string {
  return `${label.padEnd(34)} n=${String(xs.length).padStart(3)}  p50=${String(Math.round(pct(xs, 50))).padStart(5)} ms  p90=${String(Math.round(pct(xs, 90))).padStart(5)} ms  max=${String(Math.round(Math.max(...xs))).padStart(5)} ms`;
}

(async () => {
  const events = (await fetchEvents()).filter((e) => !ADDRESS || e.key.includes(ADDRESS) || e.key.startsWith('CH'));
  if (!events.length) return log('latency', `no Function events in the last ${HOURS}h.`);
  const hops: Record<string, number[]> = {};
  const add = (k: string, ms: number) => (hops[k] ??= []).push(ms);
  const byKey = new Map<string, Ev[]>();
  for (const e of events) (byKey.get(e.key) ?? byKey.set(e.key, []).get(e.key)!).push(e);

  for (const evs of byKey.values()) {
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]!;
      const next = (pred: (x: Ev) => boolean) => evs.slice(i + 1).find((x) => x.t - e.t <= GAP_MAX_MS && pred(x));
      const scenario = e.key.startsWith('CH') ? 'B' : 'A';
      if (e.fn === 'call') {
        const f = next((x) => x.fn === 'frame');
        if (f) add(`${scenario} · call → frame (child starts${scenario === 'B' ? ', via replay' : ''})`, f.t - e.t);
        if (scenario === 'A') {
          const prev = [...evs.slice(0, i)].reverse().find((x) => x.fn === 'inbound' && e.t - x.t <= GAP_MAX_MS);
          if (prev) add('A · inbound → call (parent decides)', e.t - prev.t);
        }
      }
      if (e.fn === 'return') {
        if (scenario === 'B') {
          const f = next((x) => x.fn === 'frame' && x.frameMode === 'return');
          if (f) add('B · return → frame=return (parent re-enters via replay)', f.t - e.t);
        } else {
          const r = next((x) => x.fn === 'return');
          if (r) add('A · return → return (one unwind hop)', r.t - e.t);
        }
      }
    }
  }

  console.log(`\nFunction-log hops, last ${HOURS}h${ADDRESS ? ` for ${ADDRESS}` : ''}:`);
  for (const k of Object.keys(hops).sort()) console.log('  ' + row(k, hops[k]!));

  // Customer-perceived: inbound → first outbound reply (Messages API, seconds)
  const AC = env('TWILIO_ACCOUNT_SID');
  const since = Date.now() - HOURS * 3600e3;
  const grab = async (dir: 'To' | 'From') => {
    const r = await api<{ messages?: { date_created: string; direction: string; from: string; to: string; status: string }[] }>(
      `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages.json?${dir}=${encodeURIComponent(whatsappAddress())}&PageSize=200`,
    );
    return (r.data.messages ?? []).map((m) => ({ t: new Date(m.date_created).getTime(), other: dir === 'To' ? m.from : m.to, out: dir === 'From', status: m.status })).filter((m) => m.t > since && (!ADDRESS || m.other.includes(ADDRESS)));
  };
  const msgs = [...(await grab('To')), ...(await grab('From'))].sort((a, b) => a.t - b.t);
  const e2e: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.out || m.status === 'failed') continue;
    const reply = msgs.slice(i + 1).find((x) => x.out && x.other === m.other && x.t - m.t <= GAP_MAX_MS);
    if (reply) e2e.push(reply.t - m.t);
  }
  console.log('\nCustomer-perceived (Messages API, 1 s granularity):');
  console.log('  ' + row('inbound → first reply', e2e));
  console.log('\nRead: A call→frame ≈ redirect + Studio start; B call→frame includes the replay round trip. Studio step logs are 1 s granular — these are the real numbers for Q6.');
})().catch((err) => {
  console.error('[latency] Failed:', err.message || err);
  process.exit(1);
});
