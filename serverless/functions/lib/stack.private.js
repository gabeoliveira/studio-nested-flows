/**
 * The call stack behind the nested-Flow POC — shared by BOTH scenarios.
 *
 * One Sync Map (`SYNC_MAP_NAME`, default "stacks") in service `SYNC_SERVICE_SID`;
 * one item per *session key*:
 *   · scenario A (Programmable Messaging): the raw inbound `From` ("whatsapp:+55…")
 *   · scenario B (Conversations Classic):  the Conversation SID ("CH…")
 *
 * Item data: { frames: [...], ret: {...}|null }
 *   frame = { parent: "FW<caller>", child: "FW<callee>", args: {...}, at: "<ISO>" }
 *   ret   = the "return register" (scenario B only): what the last child sent
 *           up, consumed by the parent's first /frame call after re-entry.
 *
 * /call pushes, /return pops, /inbound (A) reads the top to route the next
 * message, /frame exposes the top (and the return register) to the Flow.
 */
const twilio = require('twilio');

// ── Sync ────────────────────────────────────────────────────────────────
function mapRef(context) {
  return context
    .getTwilioClient()
    .sync.v1.services(context.SYNC_SERVICE_SID)
    .syncMaps(context.SYNC_MAP_NAME || 'stacks');
}

async function readDoc(context, key) {
  try {
    const item = await mapRef(context).syncMapItems(key).fetch();
    return { frames: Array.isArray(item.data.frames) ? item.data.frames : [], ret: item.data.ret || null };
  } catch (e) {
    if (e.status === 404) return { frames: [], ret: null };
    throw e;
  }
}

async function writeDoc(context, key, doc) {
  const map = mapRef(context);
  if (doc.frames.length === 0 && !doc.ret) {
    try {
      await map.syncMapItems(key).remove();
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    return;
  }
  const data = { frames: doc.frames, ret: doc.ret || null };
  try {
    await map.syncMapItems(key).update({ data });
  } catch (e) {
    if (e.status !== 404) throw e;
    await map.syncMapItems.create({ key, data });
  }
}

/** Frames older than STACK_TTL_SECONDS can't be returned to (scenario A: the
 *  parent's TwiML Redirect timed out) — treat the whole stack as abandoned. */
function isStale(context, frames) {
  if (frames.length === 0) return false;
  const ttlMs = Number(context.STACK_TTL_SECONDS || 14400) * 1000;
  const top = frames[frames.length - 1];
  return Date.now() - new Date(top.at).getTime() > ttlMs;
}

/** Collect `arg_*` params into an object (`…&arg_canal=whatsapp&arg_produto=…`). */
function collectArgs(event) {
  const args = {};
  for (const [k, v] of Object.entries(event)) {
    if (k.startsWith('arg_')) args[k.slice(4)] = String(v);
  }
  return args;
}

/** Guards shared by both /call branches. Returns an error message or null. */
function callGuard(context, frames, child, caller) {
  if (!/^FW[0-9a-f]{32}$/i.test(child || '')) return `child must be a Flow SID, got "${child}"`;
  if (!/^FW[0-9a-f]{32}$/i.test(caller || '')) return `caller must be {{flow.flow_sid}}, got "${caller}"`;
  const maxDepth = Number(context.MAX_DEPTH || 8);
  if (frames.length >= maxDepth) return `stack depth ${frames.length} >= MAX_DEPTH ${maxDepth} — refusing to push (runaway loop?)`;
  // Studio keeps ONE active execution per contact (A) / per conversation (B)
  // per Flow, so a Flow already on the stack cannot be entered again.
  if (frames.some((f) => f.child === child)) return `Flow ${child} is already on this session's stack — no recursion`;
  if (child === context.L0_FLOW_SID || child === context.CONV_L0_FLOW_SID) return 'L0 cannot be called as a child';
  return null;
}

// ── Scenario A: Programmable Messaging (TwiML) ──────────────────────────
function flowWebhook(context, flowSid) {
  return `https://webhooks.twilio.com/v1/Accounts/${context.ACCOUNT_SID}/Flows/${flowSid}`;
}

/** Messaging TwiML that hands the current inbound message to `url`. Twilio
 *  re-POSTs the original message params (From/To/Body/...) to it. */
function redirectTo(url) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.redirect(url);
  return twiml;
}

function emptyResponse() {
  return new twilio.twiml.MessagingResponse();
}

// ── Scenario B: Conversations Classic (scoped studio webhook) ───────────
// Plain REST (global fetch, Node 22) so we don't depend on the helper lib's
// parameter spelling for nested `Configuration.*` fields.
function convBase(context, ch) {
  const svc = context.CONVERSATIONS_SERVICE_SID;
  return svc ? `https://conversations.twilio.com/v1/Services/${svc}/Conversations/${ch}` : `https://conversations.twilio.com/v1/Conversations/${ch}`;
}

async function rest(context, method, url, form) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${context.ACCOUNT_SID}:${context.AUTH_TOKEN}`).toString('base64'),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? form.toString() : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** Index of the newest message — the one the Flow is handling right now. */
async function latestMessageIndex(context, ch) {
  const data = await rest(context, 'GET', `${convBase(context, ch)}/Messages?Order=desc&PageSize=1`);
  return data.messages && data.messages.length ? data.messages[0].index : null;
}

/**
 * The scoped `studio` webhook IS the program counter. Re-point it to `flowSid`
 * and, when `replayAfter` is given, ask Conversations to replay the current
 * message into the new Flow — that's what makes the child (or the returning
 * parent) start on the SAME customer message instead of waiting for the next.
 * Delete-then-create rather than update: replay is a creation-time option.
 */
async function pointStudioWebhook(context, ch, flowSid, replayAfter) {
  const base = convBase(context, ch);
  const list = await rest(context, 'GET', `${base}/Webhooks?PageSize=20`);
  for (const h of list.webhooks || []) {
    if (h.target === 'studio') await rest(context, 'DELETE', `${base}/Webhooks/${h.sid}`);
  }
  const form = new URLSearchParams({ Target: 'studio', 'Configuration.FlowSid': flowSid, 'Configuration.Filters': 'onMessageAdded' });
  if (replayAfter !== null && replayAfter !== undefined) form.set('Configuration.ReplayAfter', String(replayAfter));
  const hook = await rest(context, 'POST', `${base}/Webhooks`, form);
  return hook.sid;
}

// ── Studio execution hygiene ────────────────────────────────────────────
/** End ACTIVE executions for this session key on every POC flow (FLOW_SIDS).
 *  Used by the reset keyword — a parked execution left behind would swallow
 *  the next message routed to that flow. */
async function endActiveExecutions(context, key, sinceHours = 48) {
  const client = context.getTwilioClient();
  const flows = (context.FLOW_SIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const since = new Date(Date.now() - sinceHours * 3600 * 1000);
  const ended = [];
  for (const fw of flows) {
    const executions = await client.studio.v2.flows(fw).executions.list({ dateCreatedFrom: since, limit: 100 });
    for (const ex of executions) {
      if (ex.status === 'active' && ex.contactChannelAddress === key) {
        await client.studio.v2.flows(fw).executions(ex.sid).update({ status: 'ended' });
        ended.push(`${fw.slice(-6)}/${ex.sid.slice(-6)}`);
      }
    }
  }
  return ended;
}

function jsonResponse(body) {
  const res = new Twilio.Response();
  res.appendHeader('Content-Type', 'application/json');
  res.setBody(body);
  return res;
}

function logEvent(fn, fields) {
  console.log(JSON.stringify({ fn, t: new Date().toISOString(), ...fields }));
}

module.exports = {
  readDoc,
  writeDoc,
  isStale,
  collectArgs,
  callGuard,
  flowWebhook,
  redirectTo,
  emptyResponse,
  latestMessageIndex,
  pointStudioWebhook,
  endActiveExecutions,
  jsonResponse,
  logEvent,
};
