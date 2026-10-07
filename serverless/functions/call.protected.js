/**
 * /call — a parent Flow "calls" a child Flow. Two entry shapes:
 *
 * A · Programmable Messaging — reached through the parent's TwiML Redirect
 *     widget (timeout 14400, so the parent's execution PARKS):
 *       https://<domain>/call?child=FW…&caller={{flow.flow_sid}}&arg_x=…
 *     Twilio re-POSTs the message params, so `From` is the session key.
 *     Pushes a frame, then <Redirect>s the same message into the child's
 *     webhook — Studio starts a fresh execution of the child.
 *
 * B · Conversations Classic — reached through a Run Function widget with
 *     parameters conversationSid, child, caller, arg_*. The parent ENDS right
 *     after (no transition). Pushes a frame keyed by the Conversation SID,
 *     re-points the conversation's scoped studio webhook at the child with
 *     ReplayAfter = this message's index, so the child starts on the same
 *     customer message. Returns JSON.
 */
exports.handler = async (context, event, callback) => {
  const lib = require(Runtime.getFunctions()['lib/stack'].path);
  const { child, caller, conversationSid } = event;
  const key = conversationSid || event.From;
  const mode = conversationSid ? 'conversations' : 'messaging';
  if (!key) return callback(new Error('Neither conversationSid (B) nor From (A) on the request.'));

  try {
    const doc = await lib.readDoc(context, key);
    const problem = lib.callGuard(context, doc.frames, child, caller);
    if (problem) {
      lib.logEvent('call', { mode, key, error: problem, child, caller, depth: doc.frames.length });
      return callback(new Error(problem));
    }

    doc.frames.push({ parent: caller, child, args: lib.collectArgs(event), at: new Date().toISOString() });
    await lib.writeDoc(context, key, doc);
    const depth = doc.frames.length;

    if (mode === 'messaging') {
      lib.logEvent('call', { mode, key, caller, child, depth, args: doc.frames[depth - 1].args });
      return callback(null, lib.redirectTo(lib.flowWebhook(context, child)));
    }

    const replayAfter = await lib.latestMessageIndex(context, conversationSid);
    const hook = await lib.pointStudioWebhook(context, conversationSid, child, replayAfter);
    lib.logEvent('call', { mode, key, caller, child, depth, replayAfter, hook, args: doc.frames[depth - 1].args });
    return callback(null, lib.jsonResponse({ ok: true, depth, child, replayAfter }));
  } catch (e) {
    lib.logEvent('call', { mode, key, error: e.message });
    return callback(e);
  }
};
