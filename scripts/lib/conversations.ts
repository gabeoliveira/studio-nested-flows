/**
 * Sender wiring (both scenarios) + Conversations Classic hygiene.
 *
 *  · Senders API v2 — the WhatsApp sender's inbound webhook (scenario A entry)
 *  · Address Configuration — autocreation → Studio flow (scenario B entry)
 *  · open conversations on our sender — find/close (service listing, or
 *    ParticipantConversations when narrowed to one address)
 */
import { ADDRESS_CONFIG_NAME, api, env, FLOWS, log, whatsappAddress } from './env.js';

const SENDERS = 'https://messaging.twilio.com/v2/Channels/Senders';
const CONV = 'https://conversations.twilio.com/v1';

// ── Sender (scenario A) ──────────────────────────────────────────────────
export interface Sender {
  sid: string;
  sender_id: string;
  status: string;
  webhook?: { callback_url?: string | null; callback_method?: string | null } | null;
}

export async function findSender(): Promise<Sender | undefined> {
  const known = env('WHATSAPP_SENDER_SID');
  if (known) {
    const res = await api<Sender>(`${SENDERS}/${known}`);
    if (res.ok) return res.data;
    log('sender', `${known} is DEAD — looking the sender up by address.`);
  }
  let url: string | null = `${SENDERS}?Channel=whatsapp&PageSize=100`;
  while (url) {
    const res: { ok: boolean; status: number; data: { senders?: Sender[]; meta?: { next_page_url?: string | null } }; text: string } = await api(url);
    if (!res.ok) throw new Error(`list senders ${res.status}: ${res.text.slice(0, 200)}`);
    const hit = (res.data.senders ?? []).find((s) => s.sender_id === whatsappAddress());
    if (hit) return hit;
    url = res.data.meta?.next_page_url ?? null;
  }
  return undefined;
}

export async function setSenderWebhook(sid: string, callbackUrl: string): Promise<number> {
  const res = await api(`${SENDERS}/${sid}`, { json: { webhook: { callback_url: callbackUrl, callback_method: 'POST' } } });
  if (!res.ok) log('sender', `webhook update failed ${res.status}: ${res.text.slice(0, 200)}`);
  return res.status;
}

// ── Messaging Service membership (the silent override) ───────────────────
// A sender enrolled in a Messaging Service is routed by the SERVICE's inbound
// URL unless the service defers to the sender ("use inbound webhook on
// number"). Stage 5 sets the sender webhook and reports success either way —
// bit live 2026-10-02: the shared sender sat in another demo's service whose
// inbound URL was a torn-down Fly host → every `oi` died with 11210 and
// /inbound never logged a line.
const MSG = 'https://messaging.twilio.com/v1';

export interface MessagingService {
  sid: string;
  friendly_name?: string;
  inbound_request_url?: string | null;
  use_inbound_webhook_on_number?: boolean;
}

/** Every Messaging Service that holds OUR sender (by XE sid or address). */
export async function servicesHoldingSender(senderSid: string): Promise<MessagingService[]> {
  const out: MessagingService[] = [];
  let url: string | null = `${MSG}/Services?PageSize=100`;
  while (url) {
    const res: Paged<'services', MessagingService> = await api(url);
    if (!res.ok) throw new Error(`list messaging services ${res.status}: ${res.text.slice(0, 200)}`);
    for (const svc of res.data.services ?? []) {
      const members: Paged<'senders', { sid?: string; sender?: string }> = await api(`${MSG}/Services/${svc.sid}/ChannelSenders?PageSize=100`);
      if (!members.ok) continue; // services without channel senders 404 here
      if ((members.data.senders ?? []).some((s) => s.sid === senderSid || s.sender === whatsappAddress())) out.push(svc);
    }
    url = res.data.meta?.next_page_url ?? null;
  }
  return out;
}

/** Make the service defer inbound routing to the sender's own webhook. */
export async function deferServiceToSender(serviceSid: string): Promise<number> {
  const res = await api(`${MSG}/Services/${serviceSid}`, { form: { UseInboundWebhookOnNumber: 'true' } });
  if (!res.ok) log('sender', `messaging service ${serviceSid} update failed ${res.status}: ${res.text.slice(0, 200)}`);
  return res.status;
}

/**
 * Point the service's OWN inbound URL at us. Deferring (above) is not enough
 * for a WhatsApp channel sender — verified live 2026-10-02: the "LLM" service
 * already had use_inbound_webhook_on_number=true and Twilio still POSTed to
 * its inbound_request_url (Debugger 11210 against another demo's dead host, and
 * the message resource itself carried error_code 11210). So for channel
 * senders the service URL is the effective webhook; set both.
 */
export async function setMessagingServiceInbound(serviceSid: string, inboundUrl: string): Promise<number> {
  const res = await api(`${MSG}/Services/${serviceSid}`, { form: { InboundRequestUrl: inboundUrl, InboundMethod: 'POST' } });
  if (!res.ok) log('sender', `messaging service ${serviceSid} inbound URL update failed ${res.status}: ${res.text.slice(0, 200)}`);
  return res.status;
}

// ── Address Configuration (scenario B) ───────────────────────────────────
export interface AddressConfig {
  sid: string;
  address: string;
  friendly_name?: string;
  auto_creation?: { enabled?: boolean; type?: string; studio_flow_sid?: string; conversation_service_sid?: string };
}

export async function findAddressConfig(): Promise<AddressConfig | undefined> {
  const known = env('ADDRESS_CONFIG_SID');
  if (known) {
    const res = await api<AddressConfig>(`${CONV}/Configuration/Addresses/${known}`);
    if (res.ok) return res.data;
  }
  let url: string | null = `${CONV}/Configuration/Addresses?Type=whatsapp&PageSize=100`;
  while (url) {
    const res: { ok: boolean; status: number; data: { address_configurations?: AddressConfig[]; meta?: { next_page_url?: string | null } }; text: string } = await api(url);
    if (!res.ok) throw new Error(`list address configurations ${res.status}: ${res.text.slice(0, 200)}`);
    const hit = (res.data.address_configurations ?? []).find((a) => a.address === whatsappAddress());
    if (hit) return hit;
    url = res.data.meta?.next_page_url ?? null;
  }
  return undefined;
}

/** Create or update the address configuration: autocreation → `flowSid`, on/off. */
export async function upsertAddressConfig(flowSid: string, enabled: boolean): Promise<AddressConfig> {
  const form: Record<string, string> = {
    FriendlyName: ADDRESS_CONFIG_NAME,
    'AutoCreation.Enabled': String(enabled),
    'AutoCreation.Type': 'studio',
    'AutoCreation.StudioFlowSid': flowSid,
    'AutoCreation.StudioRetryCount': '3',
  };
  if (env('CONVERSATIONS_SERVICE_SID')) form['AutoCreation.ConversationServiceSid'] = env('CONVERSATIONS_SERVICE_SID');
  const existing = await findAddressConfig();
  const res = existing
    ? await api<AddressConfig>(`${CONV}/Configuration/Addresses/${existing.sid}`, { form })
    : await api<AddressConfig>(`${CONV}/Configuration/Addresses`, { form: { Type: 'whatsapp', Address: whatsappAddress(), ...form } });
  if (!res.ok) throw new Error(`address configuration ${existing ? 'update' : 'create'} ${res.status}: ${res.text.slice(0, 300)}`);
  return res.data;
}

export async function deleteAddressConfig(sid: string): Promise<number> {
  return (await api(`${CONV}/Configuration/Addresses/${sid}`, { method: 'DELETE' })).status;
}

// ── Conversations hygiene ────────────────────────────────────────────────
type Paged<K extends string, T> = { ok: boolean; status: number; data: { [k in K]?: T[] } & { meta?: { next_page_url?: string | null } }; text: string };

export interface SessionConversation {
  sid: string;
  serviceSid: string;
  state: string;
  address: string;
}

async function serviceSid(): Promise<string> {
  if (env('CONVERSATIONS_SERVICE_SID')) return env('CONVERSATIONS_SERVICE_SID');
  const res = await api<{ default_chat_service_sid?: string }>(`${CONV}/Configuration`);
  if (!res.ok || !res.data.default_chat_service_sid) throw new Error(`could not read the default Conversations service (${res.status})`);
  return res.data.default_chat_service_sid;
}

/** A conversation is OURS only if its scoped `studio` webhook points at one of
 *  this POC's flows. Proxy address is NOT enough — a shared sender carries
 *  other demos'/pilots' conversations too (bit live 2026-10-02: the first
 *  reset closed 63 foreign conversations on the Flex Chat Service, and closed
 *  is a FINAL state). */
async function isOurs(serviceSid: string, conversationSid: string): Promise<boolean> {
  const mine = new Set(FLOWS.map((f) => env(f.envKey)).filter(Boolean));
  const hooks = await api<{ webhooks?: { target?: string; configuration?: { flow_sid?: string } }[] }>(`${CONV}/Services/${serviceSid}/Conversations/${conversationSid}/Webhooks`);
  return (hooks.data.webhooks ?? []).some((h) => h.target === 'studio' && mine.has(h.configuration?.flow_sid ?? ''));
}

/**
 * OPEN (active/inactive) conversations that belong to THIS POC: proxy = our
 * sender AND a scoped studio webhook → one of our flows (scenario B leaves
 * exactly that shape behind).
 *
 *  · with `bareAddress`: that customer's open conversations on our sender,
 *    via ParticipantConversations (paginate to the end — gotcha 10.12). Still
 *    requires our webhook unless `force` (the explicit --address --force path).
 *  · without: every open conversation in the service, filtered by proxy AND
 *    our webhook (capped at 500 conversations).
 */
export async function openConversations(bareAddress?: string | null, force = false): Promise<SessionConversation[]> {
  const ours = whatsappAddress();
  const out: SessionConversation[] = [];

  if (bareAddress) {
    const address = `whatsapp:${bareAddress}`;
    let url: string | null = `${CONV}/ParticipantConversations?Address=${encodeURIComponent(address)}&PageSize=50`;
    while (url) {
      const res: Paged<'conversations', { conversation_sid: string; chat_service_sid: string; conversation_state: string; participant_messaging_binding?: { proxy_address?: string } }> = await api(url);
      if (!res.ok) throw new Error(`ParticipantConversations ${res.status}: ${res.text.slice(0, 200)}`);
      for (const c of res.data.conversations ?? []) {
        if (c.conversation_state === 'closed' || (c.participant_messaging_binding?.proxy_address ?? '') !== ours) continue;
        if (force || (await isOurs(c.chat_service_sid, c.conversation_sid))) {
          out.push({ sid: c.conversation_sid, serviceSid: c.chat_service_sid, state: c.conversation_state, address });
        }
      }
      url = res.data.meta?.next_page_url ?? null;
    }
    return out;
  }

  const svc = await serviceSid();
  for (const state of ['active', 'inactive']) {
    let url: string | null = `${CONV}/Services/${svc}/Conversations?State=${state}&PageSize=100`;
    let pages = 0;
    while (url && pages++ < 5) {
      const res: Paged<'conversations', { sid: string; state: string }> = await api(url);
      if (!res.ok) throw new Error(`list conversations ${res.status}: ${res.text.slice(0, 200)}`);
      for (const c of res.data.conversations ?? []) {
        const parts = await api<{ participants?: { messaging_binding?: { proxy_address?: string; address?: string } }[] }>(`${CONV}/Services/${svc}/Conversations/${c.sid}/Participants?PageSize=20`);
        const customer = (parts.data.participants ?? []).find((p) => (p.messaging_binding?.proxy_address ?? '') === ours);
        if (customer && (await isOurs(svc, c.sid))) out.push({ sid: c.sid, serviceSid: svc, state: c.state, address: customer.messaging_binding?.address ?? '' });
      }
      url = res.data.meta?.next_page_url ?? null;
    }
  }
  return out;
}

export async function closeConversation(c: SessionConversation): Promise<number> {
  return (await api(`${CONV}/Services/${c.serviceSid}/Conversations/${c.sid}`, { form: { State: 'closed' } })).status;
}
