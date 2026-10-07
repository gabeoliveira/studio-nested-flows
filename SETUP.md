# SETUP — studio-nested-flows

From an empty checkout to a rehearsable POC, for both scenarios. Written for a
teammate who can run `npm` and read a `.env` but doesn't need to touch
TypeScript. Follow the checkboxes top to bottom; every id in `.env` says where
it comes from.

Time budget: **~10 minutes** the first time (the Functions deploy is the slow
bit); **~1 minute** to flip scenarios afterwards.

---

## §1 · Prerequisites

- [ ] **Node 22** (`node -v`) — the Twilio Functions runtime version.
- [ ] A Twilio account with **Studio**, **Functions**, **Sync**, **Conversations** enabled (all on by default).
- [ ] A **WhatsApp sender this POC owns** (registered, ACTIVATED). Its inbound wiring is flipped between scenarios — do **not** use a sender another demo relies on (the TAC demos' shared sender, a CO-captured sender).
- [ ] Any WhatsApp handset to message that sender from — no fixed test number; the scripts operate on everything that touches this POC's flows and sender.
- [ ] *(Scenario B, optional)* a dedicated **Conversations service** if the account's default service carries other demos' webhooks → `CONVERSATIONS_SERVICE_SID`.

No Fly, no Docker, no LLM. Everything runs inside Twilio.

---

## §2 · `.env`

```bash
cd pocs/studio-nested-flows
npm install
cp .env.example .env
```

Fill the **shared** block only (the rest is written by provision):

| Key | Where it comes from |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Console → Account Info. The Auth Token is what `twilio-run` deploys with. |
| `TWILIO_API_KEY`, `TWILIO_API_SECRET` | Console → Account → API keys & tokens → Create (Standard). Every REST call uses these. |
| `TWILIO_WHATSAPP_NUMBER` | `whatsapp:+…` — the sender from §1. |
| `WHATSAPP_SENDER_SID` | optional `XE…`; blank = provision looks it up by address. |
| `CONVERSATIONS_SERVICE_SID` | optional (scenario B); blank = default service. |

Leave the router knobs (`RESET_KEYWORD`, `STACK_TTL_SECONDS`, `MAX_DEPTH`, `END_CHILD_ON_RETURN`) at their defaults for the first run.

- [ ] `.env` filled.

---

## §3 · Validate the flows (optional, 15 s)

```bash
npm run validate-flows
```

Renders all 8 templates with dummy ids and runs them through Studio's
`/Flows/Validate` — proves the JSON shape before anything is created.

- [ ] `✅ all 8 flows valid`

---

## §4 · Provision

Pick the scenario the sender should be wired for first (both scenarios' flows
are created regardless):

```bash
npm run provision -- --scenario messaging        # scenario A
npm run provision -- --scenario conversations    # scenario B
```

What it does, in order (each stage skips itself when the resource is already live):

| Stage | Creates | Writes to `.env` |
|---|---|---|
| 1 | Sync service **"studio-nested-flows call stacks"** + Map `stacks` | `SYNC_SERVICE_SID`, `SYNC_MAP_NAME` |
| 2 | Functions service **`studio-nested-flows`** (`/inbound /call /return /frame`) via `twilio-run deploy` | `SERVERLESS_SERVICE_SID`, `SERVERLESS_ENV_SID`, `SERVERLESS_DOMAIN`, `FRAME|CALL|RETURN_FUNCTION_SID` |
| 3 | 8 Studio flows, per scenario **L3 → L0** (children first — a parent embeds its child's SID), each validated then published | `L0..L3_FLOW_SID`, `CONV_L0..L3_FLOW_SID` |
| 4 | Functions env vars (`L0_FLOW_SID`, `CONV_L0_FLOW_SID`, `FLOW_SIDS`, service sid, router knobs) via the Variables API — live, no redeploy | — |
| 5 | **Sender wiring** (sender webhook **and** the Messaging Service inbound URL — the service URL is what actually fires) — A: Address Configuration *disabled* (if any) + both URLs → `/inbound` · B: Address Configuration *enabled* (autocreation → `CONV_L0`) + both URLs → `/noop` | `WHATSAPP_SENDER_SID`, `MESSAGING_SERVICE_SID`, `ADDRESS_CONFIG_SID`, `PREVIOUS_SENDER_WEBHOOK`, `PREVIOUS_MS_INBOUND_URL`, `ACTIVE_SCENARIO` |

- [ ] `✅ Provision complete.` and the summary lists 8 flow SIDs + the active scenario.
- [ ] Console → Studio → Flows shows `nested-flows-msg-…` ×4 and `nested-flows-conv-…` ×4, all **Published**.

Re-running is safe. Flags: `--skip-serverless` (no redeploy — after editing only flow JSON or `.env` knobs), `--skip-wiring`.

### Flipping scenarios

```bash
npm run reset
npm run provision -- --scenario conversations --skip-serverless   # or messaging
```

Only stage 5 changes. Autocreation does **not** take precedence over the messaging
webhook — with both live, one `oi` was answered by **both** L0 flows (2026-10-02). So
A disables the Address Configuration, and B parks the sender webhook + service inbound
URL on `/noop`. Always `reset` before a flip
so no execution or conversation from the other scenario is left holding the
address.

---

## §5 · Smoke test — scenario A (Programmable Messaging)

`ACTIVE_SCENARIO=messaging`. Always start clean:

```bash
npm run reset      # ends parked executions, closes open conversations on the sender, clears stacks
```

Message the sender from any WhatsApp handset. `→` you, `←` bot. Keep `npm run stack` in a second terminal.

> ⏱ **Pace yourself: ≥ 10 s between messages.** Twilio's anti-loop guard (error **14107**) fails every message in the pair for 30 s once it sees > 30 "replies" between the two numbers in 30 s — and in scenario A every `<Redirect>` hop counts as a reply (one `10000` unwinding L3→L2→L1 is ~7 hops). A-2 at 5-second pace tripped it live on 2026-10-02: the final `não` was accepted by Twilio, Studio reached `return_done`, and the `/return` redirect was silently dropped. See §9-A.

### A-1 · Full round trip (Q1 · Q3 · Q5 · Q7)

| | Message | Check |
|---|---|---|
| → | `oi` | |
| ← | `[L0 · Canais] Olá! Sou o assistente virtual do banco… 1 - Investimentos …` | **Q7**: `/inbound` → L0. `npm run stack` → no stacks |
| → | `1` | |
| ← | `[L1 · Investimentos] Chamado por FW… · profundidade 1 · canal=whatsapp` | depth 1, parent = `L0_FLOW_SID` ⇒ `/call` + `/frame` work |
| → | `1` | |
| ← | `[L2 · Renda fixa] Chamado por FW… · profundidade 2 · produto=renda_fixa` | args passed L1 → L2 |
| → | `1` | |
| ← | `[L3 · Jornada rentabilidade] … profundidade 3 · produto=renda_fixa · 112% do CDI` | **three levels**; `stack` shows `L0→L1, L1→L2, L2→L3` |
| → | `10000` | |
| ← | `[L3 · Jornada] R$ 10000 … ≈ R$ 11288.0 em 12 meses. Devolvendo…` | |
| ← | `[L2 · Renda fixa] Jornada concluída: 11288.0 (profundidade agora 2)…` | **Q3**: L3→L2 return with the value |
| ← | `[L1 · Investimentos] Renda fixa retornou: 11288.0 (profundidade agora 1). Quer consultar outro produto?` | **Q3**: L2→L1 chained on the same message |
| → | `não` | |
| ← | `[L0 · Canais] De volta ao atendimento principal (profundidade 0). Resultado da jornada: 11288.0 · produto=renda_fixa · voltou de FW…` | **Q1 pass**. `voltou de` = `L1_FLOW_SID`. `stack` empty |

- [ ] A-1 passes.
- [ ] `npm run trace` → timeline L0 → L1 → L2 → L3 → L2 → L1 → L0, `active executions: none` (**Q5**). `npm run latency` for the per-hop ms (**Q6**).

### A-2 · Second call to the same child

Fresh `oi` → `1` → `1` → `1` → `10000`, then at *"outro produto?"*:

| | Message | Check |
|---|---|---|
| → | `sim` | |
| ← | `[L1 · Investimentos] … Qual produto?` | |
| → | `1` | |
| ← | `[L2 · Renda fixa] Chamado por … profundidade 2` | a **second L2 execution** started cleanly ⇒ the first ended after `/return` |

- [ ] A-2 passes (if L2 is silent / out of order → §9-A row 3).

### A-3 · Abandon + recover (Q4)

| | Message | Check |
|---|---|---|
| → | `oi` → `1` → `1` | parked at L2's menu |
| → | `reset` | the router keyword |
| ← | `[L0 · Canais] Olá!…` | fresh L0; `stack` empty; `trace` shows L1/L2 **ended** |

- [ ] A-3 passes.

### A-4 · Independent publish (Q2)

- [ ] Edit `infra/studio/msg-L2-renda-fixa.json` → change the `menu_l2` body (add `v2`).
- [ ] `npm run provision -- --scenario messaging --skip-serverless --skip-wiring` → only L2's revision increments.
- [ ] `npm run reset`, run A-1 → the new L2 text shows; nothing else changed.

---

## §6 · Smoke test — scenario B (Conversations classic)

`ACTIVE_SCENARIO=conversations`. Start clean (closes your open conversation — **required**, autocreation only fires for a new one):

```bash
npm run reset
```

### B-1 · Entry via autocreation (Q7)

| | Message | Check |
|---|---|---|
| → | `oi` | |
| ← | `[L0 · Canais · conv] Olá! …` — **once**, with the `· conv` tag | A **new conversation** exists (Console → Conversations) with one `studio` webhook → `CONV_L0_FLOW_SID`. Functions log shows `noop`, not `inbound`. Two greetings (one without `· conv`) = the messaging path is still live → §9-B row 3 |

- [ ] B-1 passes. If nothing comes back → §9-B row 1.

### B-2 · Full round trip (Q1 · Q3 · Q5) — the replay test

| | Message | Check |
|---|---|---|
| → | `1` | |
| ← | `[L1 · Investimentos · conv] Chamado por FW… · profundidade 1 · canal=whatsapp` | **replay worked**: L1 started on the same `"1"`. Functions log: `call … replayAfter: <index>`. Conversation webhook now → `CONV_L1` |
| → | `1` | |
| ← | `[L2 · Renda fixa · conv] … profundidade 2 · produto=renda_fixa` | |
| → | `1` | |
| ← | `[L3 · Jornada rentabilidade · conv] … profundidade 3 …` | `stack` shows the `CH…` key with 3 frames |
| → | `10000` | |
| ← | `[L3 · Jornada · conv] R$ 10000 … ≈ R$ 11288.0 …` | |
| ← | `[L2 · Renda fixa · conv] Jornada concluída: 11288.0 (profundidade agora 2)…` | **Q3**: L2 re-entered in `mode=return` by replay |
| ← | `[L1 · Investimentos · conv] Renda fixa retornou: 11288.0 … outro produto?` | **Q3**: second replay in a row |
| → | `não` | |
| ← | `[L0 · Canais · conv] De volta … Resultado da jornada: 11288.0 · produto=renda_fixa · voltou de FW…` | **Q1 pass**. Webhook back on `CONV_L0`; `stack` empty |

- [ ] B-2 passes.
- [ ] `npm run trace` → every execution **ended**, including L0's (**Q5** — B leaves nothing parked). `npm run latency` for the replay-hop ms (**Q6**).

### B-3 · Abandon + recover (Q4)

| | Step | Check |
|---|---|---|
| → | `oi` → `1` → `1` | parked at L2 (webhook → `CONV_L2`) |
| | `npm run reset` | closes the conversation, ends L2's execution, clears the `CH…` stack |
| → | `oi` | |
| ← | `[L0 · Canais · conv] Olá! …` | a **new** conversation, fresh L0 |

- [ ] B-3 passes. (Skipping `reset` here is the failure mode in §9-B row 4.)

### B-4 · Independent publish (Q2)

- [ ] Edit `infra/studio/conv-L2-renda-fixa.json` → change the `menu_l2` body.
- [ ] `npm run provision -- --scenario conversations --skip-serverless --skip-wiring` → only C2's revision increments.
- [ ] `npm run reset`, run B-1 + B-2 → the new text shows.

### Results

| Q | A result | B result | Notes (hop latency, surprises) |
|---|---|---|---|
| Q1 round trip | 🟢 | 🟢 | A 2026-10-02 18:08 UTC · B 18:35 UTC: full L0→L1→L2→L3→L2→L1→L0 on both; final L0 message carried `11288.00 · renda_fixa · voltou de <L1>` |
| Q2 independent publish | ⚪ | ⚪ | |
| Q3 multi-hop unwind on one message | 🟢 | 🟢 | A: `[L2]` and `[L1] outro produto?` both arrived after one `10000` (3 redirects + 2 sends, ~1 s). A-2 re-entry and the `0`-back from L2 (`voltou_de_L2`) also 🟢. **B: `ReplayAfter` works** — the same unwind replayed twice in a row (L3→L2, L2→L1) on one `10000` |
| Q4 abandon/recover | ⚪ | ⚪ | |
| Q5 nothing lingers | 🟡 | 🟢 | A: a `timeout 0` TwiML Redirect does **not** end the child's execution (L1 stayed `active`); `END_CHILD_ON_RETURN=true` is now the default — `/return` ends it via REST. B: `trace` after the run → `active executions: none` with no help needed |
| Q6 hop latency p50 | 🟢 | 🟢 | `npm run latency` (Functions-log ms, 2026-10-02): **A** redirect hop `call→frame` p50 **381 ms**, `inbound→call` 448 ms, unwind `return→return` 0–793 ms · **B** replay hop `call→frame` p50 **452 ms** (p90 459), return replay `return→frame=return` 405 ms · customer-perceived inbound→first reply p50 **2 s** / p90 3 s on both (1 s granularity). A's p90 outliers (8.5 s/14 s) are pairing artefacts from the first broken runs, not hops |
| Q7 entry | 🟢 | 🟢 | A: via the Messaging Service inbound URL (not the Senders-API webhook — §9-A row 1). B: autocreation → `CONV_L0` — but it does **not** silence the messaging path (both L0s answered until the sender/service URLs were parked on `/noop`) |
| — anti-loop guard | 🟡 | ⚪ | A: error **14107** at ~24 msgs/75 s during A-2 (5 s pace); redirect hops count as replies. B: none observed, but B was run at ≥ 10 s pace — not a controlled comparison. Production design constraint for A (README) |

🟢 passes · 🟡 passes with a workaround · 🔴 fails · ⚪ not run

---

## §7 · Reset between rehearsals

```bash
npm run reset                               # this POC's executions, stacks, and ONLY conversations carrying our studio webhook
npm run reset -- --address +5511…           # the same, narrowed to one customer
npm run reset -- --address +5511… --force   # also close that customer's open conversations on our sender that are NOT ours (e.g. a stale Flex thread holding the address)
```

Ends parked executions on all 8 flows (address keys **and** conversation keys), deletes the Sync stack items, and closes open conversations **only when their scoped `studio` webhook points at one of our flows** (what scenario B leaves behind).

> ⚠ Never widen that to "every open conversation on the sender". The sender is shared with other demos and pilots, **closed is a final state** in Conversations, and the first version of this script did exactly that on 2026-10-02 — 63 foreign (stale, June-2026-and-older) conversations on the Flex Chat Service got closed. `--force` exists for one named customer only. In scenario A you can also text `reset`.

---

## §8 · Teardown

```bash
npm run teardown                 # dry-run: prints what would go
npm run teardown -- --apply      # do it
npm run teardown -- --apply --keep-flows   # keep the 8 Studio flows for inspection
```

Unwires the sender (deletes our Address Configuration; restores the inbound webhook to `PREVIOUS_SENDER_WEBHOOK`), deletes the flows, the Functions service (**frees one of the 50 Serverless slots**) and the Sync service. Then blank the provisioned ids in `.env`. Rebuild = §4 (~5 min).

---

## §9 · Symptom → fix

### §9-A · Scenario A

| Symptom | Likely cause | Fix |
|---|---|---|
| `oi` gets nothing; Debugger **11200** on `/inbound` | `L0_FLOW_SID` not on the Functions environment (stage 4) | `npm run provision -- --scenario messaging --skip-serverless --skip-wiring`; Console → Functions → Logs |
| `oi` gets nothing, **no** `/inbound` log, **no** Studio execution; Debugger shows **11210 / 11200 against some *other* URL** (and the inbound Message resource carries that `error_code`) | The sender sits in a **Messaging Service** whose `inbound_request_url` is what Twilio actually calls — for a WhatsApp channel sender, even with "defer to sender's webhook" ON. **Verified live 2026-10-02:** the shared sender sat in a Messaging Service whose inbound URL was another demo's torn-down host. | `npm run provision -- --scenario messaging --skip-serverless` — stage 5 now sets the service's inbound URL too (and records `PREVIOUS_MS_INBOUND_URL`). Diagnose in one call: `GET /2010-04-01/…/Messages.json?To=<sender>` → `error_code` on the inbound message |
| `oi` gets nothing, **no** `/inbound` log, no other-URL alert | An Address Configuration is still **enabled** (autocreation wins) | Same command — stage 5 disables it |
| `oi` gets nothing, **no** `/inbound` log, and the message in Console → Monitor → Messaging shows a **Messaging Service SID** (often with error **11210** / 11200) | The sender is enrolled in a **Messaging Service** whose inbound URL wins over the sender webhook (another demo's service, possibly pointing at a torn-down host). Stage 5 reported success on a value Twilio ignored. | `npm run provision -- --scenario messaging --skip-serverless` — stage 5 now finds every service holding the sender and flips it to *use inbound webhook on number*. Manual: Console → Messaging → Services → *Integration* → "Defer to sender's webhook" |
| `1` at L0 → no L1 menu; 11200 on `/call` | `caller`/`child` rejected (placeholder left in the flow) or Sync write failed | `infra/studio/rendered/msg-L0-front-door.json` → the `/call` URL must carry a real `FW…`; `npm run stack` |
| Second visit to the same level (A-2) is **silent** or replies with stale state | The child's execution stayed **active** after `/return` (timeout 0 didn't end it) | `END_CHILD_ON_RETURN=true` in `.env` → `npm run provision -- --scenario messaging --skip-serverless --skip-wiring` (vars go live) → `npm run reset`. Record Q5 = 🟡 |
| `[L1 … Chamado por · profundidade ·]` — **empty** values | `/frame` found no frame: Sync key ≠ `contact.channel.address` (prefix), or the Run Function failed (fail branch still shows the menu) | `npm run stack` — key must equal the Studio address; Functions logs for `/frame` |
| After `10000`, `[L2]` arrives but **L1 never asks "outro produto?"** | Messaging followed the first `<Redirect>` but not the second | **Q3 = 🔴 for chained unwind.** Make L2 end with a Send & Wait before returning so each hop is its own inbound message; record it |
| `{{widgets.call_l2.result}}` **blank** in the parent | Param name on `/return?…` ≠ what the parent reads, or redirect widget renamed | Compare the child's `return_done` URL with the parent's body |
| A level's `call_*` redirect takes the **Fail** branch instantly — the parent gets `result=fail_Lx` back and `/call` never logs | The rendered `/call` URL is **unparseable**: a Liquid value with a space / `+` / `&` landed raw in the query string. **Seen live 2026-10-02:** L0 passed `arg_canal={{flow.channel.address}}` (`whatsapp:+55…`), the `+` decoded to a space, L1 re-emitted it → Fail. | Pass only URL-safe literals/tokens as `arg_*` and `/return` values (`whatsapp`, `renda_fixa`, numbers). Studio exposes the rendered widget context at `…/Executions/{FN}/Steps/{FNstep}/Context` — `get_frame.parsed.args` shows the mangled value |
| **403** on `/call` / `/return` | Signature validation — request didn't come from Twilio (e.g. curl) | Expected: all four Functions are `protected`. Test through a real message |
| Messages ignored on a flow that "worked yesterday" | A parked execution from an abandoned rehearsal | `npm run reset` — chain it first |
| A reply mid-run simply **vanishes**: the inbound Message resource is `failed` with **14107**, Debugger shows 14107 against a flow webhook, Studio logged the step but the next `/call`/`/return` never ran; parents stay parked | Twilio's **anti-loop guard**: > 30 replies between the pair in 30 s. Redirect hops count, so a fast tester (or a chatty customer) hits it on the unwind | Wait 30 s, `npm run reset -- --address <phone>`, retry at ≥ 10 s pace. Design note: this caps how many TwiML hops a single customer message may fan out into — see README trade-offs. Twilio Support can lift the guard per account once loop protections exist |

### §9-B · Scenario B

| Symptom | Likely cause | Fix |
|---|---|---|
| `oi` gets nothing; no conversation created | Address Configuration not enabled / wrong address form, or the sender is captured elsewhere (CO bridge) | Console → Conversations → Addresses: `whatsapp:+…` must be enabled → `CONV_L0`. `npm run provision -- --scenario conversations --skip-serverless` |
| `oi` creates a conversation but **L0 never answers** | The scoped studio webhook isn't on the conversation (service-level config overriding?) or the flow errored on `/frame` | Conversation → Webhooks tab: one `studio` → `CONV_L0`. Studio → flow → Logs; Functions logs for `/frame` |
| `oi` is answered **twice** (one greeting without `· conv`), or only by scenario A's L0 | The messaging path is still live: sender webhook / Messaging Service inbound URL not parked on `/noop` (autocreation does **not** suppress them) | `npm run provision -- --scenario conversations --skip-serverless` (stage 5 parks both); then `npm run reset -- --address <phone>` to end the stray msg-L0 execution |
| `1` at L0 → **silence** (L0 ended, L1 never started) | **Replay did not fire** into the newly pointed Flow — the open question. Functions log shows `call … replayAfter` but no L1 execution | Send one more message: if L1 answers *now*, the webhook flip works but replay doesn't. **Q3 = 🔴 for B** → build the REST + `resume-conversation` fallback (README) |
| `1` → L1 answers, but L0's old execution **also** reacts (duplicate messages) | L0's execution hadn't ended when the replay landed, or two studio webhooks on the conversation | Conversation → Webhooks: exactly one `studio`. `npm run trace` for the overlap. If persistent, add a Set Variables "noop" before `/call` is not enough — report |
| `[L2 … conv] Jornada concluída: ` **blank** result | The return register was consumed by a *different* `/frame` call (double replay) or `/return` ran before `writeDoc` | Functions logs: one `return` then one `frame mode=return` per hop. `npm run stack` shows an unconsumed register if the order broke |
| After a run, `oi` lands in **L2's menu** instead of L0 | The conversation is still **open** and its webhook points at a mid-tree layer (abandoned run) | `npm run reset` (closes it). This is the sticky-address behaviour — design note in README |
| Run Function widget → **fail** branch every time | Function 5xx (Conversations REST error — wrong service sid / closed conversation) | Functions logs show `GET/POST … → 4xx` with the body; check `CONVERSATIONS_SERVICE_SID` |
| `send-message` / `send-and-wait` → `failed` on conversation flows | Widget `service`/`channel` Liquid didn't resolve | Edit the template's `service`/`channel` to `{{trigger.conversation.ChatServiceSid}}` / `{{trigger.conversation.ConversationSid}}` and re-provision flows |

### Both

| Symptom | Likely cause | Fix |
|---|---|---|
| `20404` on `twilio-run deploy` | `.twiliodeployinfo` points at a deleted service | `rm serverless/.twiliodeployinfo` (teardown and provision do this) |
| `20001 … limited to 50` on deploy | The account's **50 Serverless services** cap | `npm run teardown -- --apply` on a finished demo/POC |
| Studio canvas is a tangle | Offsets in the JSON are approximate | Cosmetic — drag widgets; the definition is unaffected |
| Another demo's bot answers the sender | Someone re-pointed the sender / enabled an address config | This POC must own the sender (§1) |
