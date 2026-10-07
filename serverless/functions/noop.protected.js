/**
 * /noop — where the sender webhook and the Messaging Service inbound URL point
 * while SCENARIO B is active. Returns empty TwiML so the Programmable
 * Messaging path does nothing.
 *
 * Why it exists: Conversations autocreation does NOT suppress the messaging
 * webhook — verified live 2026-10-02: with the Address Configuration enabled
 * AND the service inbound URL still on /inbound, one "oi" was delivered to
 * BOTH the conv L0 flow (via Conversations) and the msg L0 flow (via /inbound).
 */
exports.handler = (context, event, callback) => {
  const lib = require(Runtime.getFunctions()['lib/stack'].path);
  lib.logEvent('noop', { key: event.From, body: String(event.Body || '').slice(0, 40), note: 'scenario B active — messaging path ignored' });
  return callback(null, lib.emptyResponse());
};
