/**
 * Studio v2 helpers: render a flow template, validate, create-or-update by
 * friendly name, publish, and the execution hygiene calls (list/end/steps).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { api, env, FLOWS, log, STUDIO_DIR, type ApiResult, type FlowSpec } from './env.js';

const STUDIO = 'https://studio.twilio.com/v2';

export interface FlowDefinition {
  description: string;
  initial_state: string;
  flags: { allow_concurrent_calls: boolean };
  states: unknown[];
}

type Page<K extends string, T> = { [k in K]?: T[] } & { meta?: { next_page_url?: string | null } };

/** Replace every ${KEY} in the template with vars[KEY]; refuse to leave any
 *  placeholder behind — a half-rendered flow validates fine and fails live. */
export function renderFlow(spec: FlowSpec, vars: Record<string, string>): FlowDefinition {
  const raw = readFileSync(join(STUDIO_DIR, spec.file), 'utf-8');
  const rendered = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k: string) => {
    if (!vars[k]) throw new Error(`${spec.file}: placeholder \${${k}} has no value`);
    return vars[k];
  });
  const def = JSON.parse(rendered) as FlowDefinition;
  mkdirSync(join(STUDIO_DIR, 'rendered'), { recursive: true });
  writeFileSync(join(STUDIO_DIR, 'rendered', spec.file), JSON.stringify(def, null, 2));
  return def;
}

interface ValidateResponse {
  valid?: boolean;
  message?: string;
  details?: unknown;
}

export async function validateFlow(spec: FlowSpec, def: FlowDefinition): Promise<boolean> {
  const res = await api<ValidateResponse>(`${STUDIO}/Flows/Validate`, {
    form: { FriendlyName: spec.name, Status: 'published', Definition: JSON.stringify(def) },
  });
  if (res.ok && res.data?.valid) {
    log('validate', `${spec.key} ✓ valid`);
    return true;
  }
  log('validate', `${spec.key} ✗ ${res.status} ${res.text.slice(0, 600)}`);
  return false;
}

interface FlowRow {
  sid: string;
  friendly_name: string;
  status: string;
  revision: number;
}

export async function findFlowByName(name: string): Promise<FlowRow | undefined> {
  let url: string | null = `${STUDIO}/Flows?PageSize=100`;
  while (url) {
    const res: ApiResult<Page<'flows', FlowRow>> = await api(url);
    if (!res.ok) throw new Error(`list flows ${res.status}: ${res.text.slice(0, 200)}`);
    const hit = (res.data.flows ?? []).find((f) => f.friendly_name === name);
    if (hit) return hit;
    url = res.data.meta?.next_page_url ?? null;
  }
  return undefined;
}

export async function flowAlive(sid: string): Promise<boolean> {
  return (await api(`${STUDIO}/Flows/${sid}`)).ok;
}

/** Create or update (new published revision) — idempotent on friendly name. */
export async function upsertFlow(spec: FlowSpec, def: FlowDefinition, knownSid?: string): Promise<string> {
  let sid = knownSid && (await flowAlive(knownSid)) ? knownSid : (await findFlowByName(spec.name))?.sid;
  const form = {
    FriendlyName: spec.name,
    Status: 'published',
    Definition: JSON.stringify(def),
    CommitMessage: `provision ${new Date().toISOString()}`,
  };
  const res = await api<FlowRow & { message?: string }>(sid ? `${STUDIO}/Flows/${sid}` : `${STUDIO}/Flows`, { form });
  if (!res.ok) throw new Error(`${sid ? 'update' : 'create'} ${spec.name} → ${res.status}: ${res.text.slice(0, 400)}`);
  sid = res.data.sid;
  log('flows', `${spec.key} ${spec.name} → ${sid} (revision ${res.data.revision}, ${res.data.status})`);
  return sid;
}

export async function deleteFlow(sid: string): Promise<number> {
  return (await api(`${STUDIO}/Flows/${sid}`, { method: 'DELETE' })).status;
}

export interface ExecutionRow {
  sid: string;
  status: 'active' | 'ended';
  contact_channel_address: string;
  date_created: string;
  date_updated: string;
}

export async function listExecutions(flowSid: string, sinceHours = 48): Promise<ExecutionRow[]> {
  const from = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const out: ExecutionRow[] = [];
  let url: string | null = `${STUDIO}/Flows/${flowSid}/Executions?PageSize=100&DateCreatedFrom=${encodeURIComponent(from)}`;
  while (url) {
    const res: ApiResult<Page<'executions', ExecutionRow>> = await api(url);
    if (!res.ok) throw new Error(`list executions ${flowSid} ${res.status}: ${res.text.slice(0, 200)}`);
    out.push(...(res.data.executions ?? []));
    url = res.data.meta?.next_page_url ?? null;
  }
  return out;
}

export async function endExecution(flowSid: string, execSid: string): Promise<number> {
  return (await api(`${STUDIO}/Flows/${flowSid}/Executions/${execSid}`, { form: { Status: 'ended' } })).status;
}

export interface StepRow {
  sid: string;
  name: string;
  transitioned_from: string;
  transitioned_to: string;
  date_created: string;
}

export async function listSteps(flowSid: string, execSid: string): Promise<StepRow[]> {
  const out: StepRow[] = [];
  let url: string | null = `${STUDIO}/Flows/${flowSid}/Executions/${execSid}/Steps?PageSize=100`;
  while (url) {
    const res: ApiResult<Page<'steps', StepRow>> = await api(url);
    if (!res.ok) throw new Error(`list steps ${res.status}: ${res.text.slice(0, 200)}`);
    out.push(...(res.data.steps ?? []));
    url = res.data.meta?.next_page_url ?? null;
  }
  return out;
}

/** Every flow spec whose SID is in .env (blank ones skipped). */
export function flowsFromEnv(): (FlowSpec & { sid: string })[] {
  return FLOWS.map((f) => ({ ...f, sid: env(f.envKey) })).filter((f) => f.sid);
}
