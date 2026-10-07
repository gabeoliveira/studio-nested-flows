/**
 * /return — a child Flow hands control back to whoever called it.
 *
 * A · Programmable Messaging — the child's LAST widget is a TwiML Redirect
 *     with timeout 0: https://<domain>/return?result=…&produto=…
 *     Pops the frame and <Redirect>s the message into the PARENT's webhook
 *     with `FlowEvent=return` + every extra param — Studio resumes the parked
 *     parent on the redirect widget's Return transition and exposes them as
 *     {{widgets.<redirect_widget>.<param>}} (+ `returned_from`, `depth`).
 *     Empty stack → empty TwiML (nothing to return to; execution just ends).
 *
 * B · Conversations Classic — the child's last widget is a Run Function with
 *     parameters conversationSid + the return values; the child ENDS after.
 *     Pops the frame, parks the values in the session's return register,
 *     re-points the scoped studio webhook at the PARENT with ReplayAfter =
 *     this message's index → the parent starts a NEW execution on the same
 *     message, and its first /frame call reads `mode=return` + the values.
 *     Empty stack → point the webhook back at L0 (no replay).
 */

// Params Twilio puts on every messaging webhook — everything else on the
// request is a return value the child chose to send up.
const TWILIO_PARAMS = /^(From|To|Body|MessageSid|SmsSid|SmsMessageSid|SmsStatus|MessageStatus|AccountSid|MessagingServiceSid|NumMedia|NumSegments|ApiVersion|ProfileName|WaId|Forwarded|FrequentlyForwarded|ButtonText|ButtonPayload|ReferralNumMedia|OriginalRepliedMessageSid|OriginalRepliedMessageSender|ChannelMetadata|ChannelPrefix|ChannelInstallSid|ChannelToAddress|ChannelAttributes|ChannelInstanceSid|EventType|Source|request|FlowEvent|conversationSid)$|^(From|To)[A-Z]|^Media(Url|ContentType)\d+$/;

function returnedValues(event) {
  const out = {};
  for (const [k, v] of Object.entries(event)) {
    if (!TWILIO_PARAMS.test(k)) out[k] = String(v);
  }
  return out;
}

/** Belt and braces for the "timeout 0 leaves the child ACTIVE" case (scenario
 *  A, SETUP symptom table): end the child's execution so a second call to the
 *  same child starts fresh instead of landing in a parked execution. */
async function endChildExecution(context, flowSid, key) {
  const client = context.getTwilioClient();
  const since = new Date(Date.now() - 6 * 3600 * 1000);
  const executions = await client.studio.v2.flows(flowSid).executions.list({ dateCreatedFrom: since, limit: 50 });
  const ended = [];
  for (const ex of executions) {
    if (ex.status === 'active' && ex.contactChannelAddress === key) {
      await client.studio.v2.flows(flowSid).executions(ex.sid).update({ status: 'ended' });
      ended.push(ex.sid);
    }
  }
  return ended;
}

exports.handler = async (context, event, callback) => {
  const lib = require(Runtime.getFunctions()['lib/stack'].path);
  const { conversationSid } = event;
  const key = conversationSid || event.From;
  const mode = conversationSid ? 'conversations' : 'messaging';
  if (!key) return callback(new Error('Neither conversationSid (B) nor From (A) on the request.'));

  try {
    const doc = await lib.readDoc(context, key);
    const frame = doc.frames.pop();
    const values = returnedValues(event);

    if (!frame) {
      lib.logEvent('return', { mode, key, note: 'empty stack — nothing to return to', values });
      if (mode === 'messaging') return callback(null, lib.emptyResponse());
      if (context.CONV_L0_FLOW_SID) await lib.pointStudioWebhook(context, conversationSid, context.CONV_L0_FLOW_SID, null);
      await lib.writeDoc(context, key, { frames: [], ret: null });
      return callback(null, lib.jsonResponse({ ok: true, depth: 0, note: 'empty stack; webhook → L0' }));
    }

    if (mode === 'messaging') {
      await lib.writeDoc(context, key, doc);
      const params = new URLSearchParams({ FlowEvent: 'return', ...values, returned_from: frame.child, depth: String(doc.frames.length) });
      if (String(context.END_CHILD_ON_RETURN).toLowerCase() === 'true') {
        const ended = await endChildExecution(context, frame.child, key);
        if (ended.length) lib.logEvent('return', { mode, key, note: `ended child execution(s) ${ended.join(' ')}` });
      }
      lib.logEvent('return', { mode, key, from: frame.child, to: frame.parent, depth: doc.frames.length, values });
      return callback(null, lib.redirectTo(`${lib.flowWebhook(context, frame.parent)}?${params.toString()}`));
    }

    // B: park the values, re-point the webhook at the parent with replay.
    doc.ret = { from: frame.child, to: frame.parent, depth: doc.frames.length, at: new Date().toISOString(), ...values };
    await lib.writeDoc(context, key, doc);
    const replayAfter = await lib.latestMessageIndex(context, conversationSid);
    const hook = await lib.pointStudioWebhook(context, conversationSid, frame.parent, replayAfter);
    lib.logEvent('return', { mode, key, from: frame.child, to: frame.parent, depth: doc.frames.length, replayAfter, hook, values });
    return callback(null, lib.jsonResponse({ ok: true, depth: doc.frames.length, parent: frame.parent, replayAfter }));
  } catch (e) {
    lib.logEvent('return', { mode, key, error: e.message });
    return callback(e);
  }
};
