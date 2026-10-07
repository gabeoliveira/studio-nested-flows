/**
 * /frame — what a Flow calls FIRST (Run Function widget) to learn why it is
 * running. Parameters: `address={{contact.channel.address}}` (scenario A) or
 * `conversationSid={{trigger.conversation.ConversationSid}}` (scenario B).
 *
 *   { mode: "entry",  depth, parent, child, args: {...} }   // called by a parent (top frame)
 *   { mode: "entry",  depth: 0, args: {} }                  // idle / entered directly (L0)
 *   { mode: "return", depth, parent, child, args, from, to, <returned values…> }
 *                                                           // scenario B only: a child just
 *                                                           // returned; register consumed here
 *
 * Studio parses the JSON → {{widgets.get_frame.parsed.mode}}, `.args.produto`,
 * `.result`, … In scenario B every Flow branches on `mode` right after this
 * widget: "entry" → its menu, "return" → its post-call point.
 */
exports.handler = async (context, event, callback) => {
  const lib = require(Runtime.getFunctions()['lib/stack'].path);
  const key = event.conversationSid || event.address || event.From;
  if (!key) return callback(new Error('conversationSid or address parameter required'));
  try {
    const doc = await lib.readDoc(context, key);
    const top = doc.frames[doc.frames.length - 1];
    const base = top ? { depth: doc.frames.length, parent: top.parent, child: top.child, args: top.args || {} } : { depth: 0, args: {} };
    let out;
    if (doc.ret) {
      out = { mode: 'return', ...base, ...doc.ret };
      doc.ret = null; // consumed — the next /frame on this session is a plain entry again
      await lib.writeDoc(context, key, doc);
    } else {
      out = { mode: 'entry', ...base };
    }
    lib.logEvent('frame', { key, mode: out.mode, depth: out.depth });
    return callback(null, lib.jsonResponse(out));
  } catch (e) {
    lib.logEvent('frame', { key, error: e.message });
    return callback(e);
  }
};
