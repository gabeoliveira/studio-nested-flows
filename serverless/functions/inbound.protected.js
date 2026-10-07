/**
 * /inbound — SCENARIO A ONLY (Programmable Messaging). The sender's inbound
 * webhook. A sender can point at exactly one URL, so this Function decides
 * which Flow owns the customer's next message: the top of their call stack,
 * or L0 when idle. Studio then matches the message to that Flow's active
 * execution for the To/From pair (or starts a fresh one on L0).
 *
 * Scenario B never comes through here — Conversations delivers straight to
 * whichever Flow the conversation's scoped studio webhook points at.
 *
 * Also handles RESET_KEYWORD: clears the stack AND ends the parked executions
 * on every POC flow, then starts L0 fresh — the rehearsal escape hatch.
 */
exports.handler = async (context, event, callback) => {
  const lib = require(Runtime.getFunctions()['lib/stack'].path);
  const key = event.From;
  const body = String(event.Body || '').trim().toLowerCase();

  if (!context.L0_FLOW_SID) return callback(new Error('L0_FLOW_SID is not set on the Functions environment — run `npm run provision`.'));
  if (!key) return callback(new Error('No From on the request — /inbound must be hit by a Twilio messaging webhook.'));

  try {
    const doc = await lib.readDoc(context, key);
    let note = '';

    if (lib.isStale(context, doc.frames)) {
      note = `stale stack (depth ${doc.frames.length}) dropped`;
      doc.frames = [];
      await lib.writeDoc(context, key, doc);
    }

    if (body && body === String(context.RESET_KEYWORD || 'reset').toLowerCase()) {
      const ended = await lib.endActiveExecutions(context, key);
      doc.frames = [];
      doc.ret = null;
      await lib.writeDoc(context, key, doc);
      note = `reset: ended ${ended.length} execution(s) [${ended.join(' ')}]`;
    }

    const target = doc.frames.length ? doc.frames[doc.frames.length - 1].child : context.L0_FLOW_SID;
    lib.logEvent('inbound', { key, body, depth: doc.frames.length, target, note });
    return callback(null, lib.redirectTo(lib.flowWebhook(context, target)));
  } catch (e) {
    lib.logEvent('inbound', { key, error: e.message });
    return callback(e);
  }
};
