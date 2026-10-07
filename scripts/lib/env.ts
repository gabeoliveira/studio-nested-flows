/**
 * Shared plumbing for the lifecycle scripts: .env load + upsert, auth headers,
 * a thin fetch wrapper, and the POC's fixed names — for BOTH scenarios.
 */
import { config as dotenvConfig } from 'dotenv';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ENV_PATH = join(POC_DIR, '.env');
export const SERVERLESS_DIR = join(POC_DIR, 'serverless');
export const STUDIO_DIR = join(POC_DIR, 'infra', 'studio');

if (existsSync(ENV_PATH)) dotenvConfig({ path: ENV_PATH });

// Fixed resource names — teardown finds things by these, never by .env alone.
/** Resource-name root. Override with POC_NAME / FLOW_NAME_PREFIX in .env when
 *  the live resources were created under an older name — renaming live
 *  resources = `teardown --apply` + `provision`, not a code change. */
export const POC_NAME = process.env.POC_NAME || 'studio-nested-flows';
export const FLOW_NAME_PREFIX = process.env.FLOW_NAME_PREFIX || 'nested-flows';
export const SERVERLESS_NAME = POC_NAME;
export const SYNC_FRIENDLY_NAME = `${POC_NAME} call stacks`;
export const ADDRESS_CONFIG_NAME = `${POC_NAME} (scenario B entry)`;

export type Scenario = 'messaging' | 'conversations';
export const SCENARIOS: Scenario[] = ['messaging', 'conversations'];
export type Level = 'L0' | 'L1' | 'L2' | 'L3';

export interface FlowSpec {
  /** Short tag used in logs/trace: L0..L3 (messaging) · C0..C3 (conversations) */
  key: string;
  scenario: Scenario;
  level: Level;
  file: string;
  name: string;
  envKey: string;
}

const msg = (level: Level, slug: string): FlowSpec => ({
  key: level,
  scenario: 'messaging',
  level,
  file: `msg-${level}-${slug}.json`,
  name: `${FLOW_NAME_PREFIX}-msg-${level}-${slug}`,
  envKey: `${level}_FLOW_SID`,
});
const conv = (level: Level, slug: string): FlowSpec => ({
  key: `C${level[1]}`,
  scenario: 'conversations',
  level,
  file: `conv-${level}-${slug}.json`,
  name: `${FLOW_NAME_PREFIX}-conv-${level}-${slug}`,
  envKey: `CONV_${level}_FLOW_SID`,
});

/** Provision order inside each scenario is L3 → L0 (a parent embeds its child's SID). */
export const FLOWS: FlowSpec[] = [
  msg('L3', 'rentabilidade'),
  msg('L2', 'renda-fixa'),
  msg('L1', 'investimentos'),
  msg('L0', 'front-door'),
  conv('L3', 'rentabilidade'),
  conv('L2', 'renda-fixa'),
  conv('L1', 'investimentos'),
  conv('L0', 'front-door'),
];

export const env = (k: string): string => process.env[k] || '';

export function requireEnv(...keys: string[]) {
  const missing = keys.filter((k) => !env(k));
  if (missing.length) {
    console.error(`Missing in .env: ${missing.join(', ')} — cp .env.example .env and fill the shared block first (SETUP §2).`);
    process.exit(1);
  }
}

/** The scenario the sender is currently wired for (written by provision). */
export function activeScenario(): Scenario {
  return env('ACTIVE_SCENARIO') === 'conversations' ? 'conversations' : 'messaging';
}

export const keyAuth = () => 'Basic ' + Buffer.from(`${env('TWILIO_API_KEY')}:${env('TWILIO_API_SECRET')}`).toString('base64');
export const basicAuth = () => 'Basic ' + Buffer.from(`${env('TWILIO_ACCOUNT_SID')}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64');

export function log(stage: string, msg: string) {
  console.log(`[${stage}] ${msg}`);
}

/** Upsert KEY=value in .env (preserving everything else) + process.env. */
export function setEnv(key: string, value: string) {
  let s = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(s)) s = s.replace(re, `${key}=${value}`);
  else s += `${s.endsWith('\n') || s === '' ? '' : '\n'}${key}=${value}\n`;
  writeFileSync(ENV_PATH, s);
  process.env[key] = value;
  log('env', `${key}=${value || '(blank)'}`);
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T;
  text: string;
}

/** fetch wrapper: form-encoded or JSON body, API-key auth by default. */
export async function api<T = unknown>(
  url: string,
  opts: { method?: string; auth?: 'key' | 'basic'; form?: Record<string, string>; json?: unknown } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { Authorization: opts.auth === 'basic' ? basicAuth() : keyAuth() };
  let body: string | undefined;
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(url, { method: opts.method || (body ? 'POST' : 'GET'), headers, body });
  const text = await res.text();
  let data: T = undefined as unknown as T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    /* non-JSON body */
  }
  return { ok: res.ok, status: res.status, data, text };
}

/** A liveness GET — an id in .env is only trusted after this. */
export async function alive(url: string, auth: 'key' | 'basic' = 'key'): Promise<boolean> {
  return (await api(url, { auth })).ok;
}

/** The sender address Studio/Conversations see, always `whatsapp:+…`. */
export function whatsappAddress(): string {
  const n = env('TWILIO_WHATSAPP_NUMBER');
  return n.startsWith('whatsapp:') ? n : `whatsapp:${n}`;
}

/** Optional `--address +55…` / `--address whatsapp:+55…` on reset/trace: narrow
 *  to one customer. Default is everything on this POC's flows + sender — it's
 *  a dedicated sender, so everything there is ours. */
export function addressArg(): string | null {
  const i = process.argv.indexOf('--address');
  if (i === -1 || !process.argv[i + 1]) return null;
  return process.argv[i + 1]!.replace(/^whatsapp:/, '');
}

/** Both forms Studio/Sync may key a customer address on. */
export function addressKeys(bare: string): string[] {
  return [bare, `whatsapp:${bare}`];
}

export const flowWebhook = (sid: string) => `https://webhooks.twilio.com/v1/Accounts/${env('TWILIO_ACCOUNT_SID')}/Flows/${sid}`;
