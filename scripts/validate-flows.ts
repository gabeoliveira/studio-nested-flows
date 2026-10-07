/**
 * Validate — render all 8 templates and run them through POST /Flows/Validate
 * without creating or publishing anything. Placeholders missing from .env get
 * well-formed dummies so the JSON shape can be checked before provisioning.
 *
 * This is also the "teams own layers" CI story: a layer owner edits only their
 * infra/studio/<scenario>-<level>.json and validates it in isolation.
 */
import { env, FLOWS, log, requireEnv } from './lib/env.js';
import { renderFlow, validateFlow } from './lib/studio.js';

requireEnv('TWILIO_API_KEY', 'TWILIO_API_SECRET');

const dummy = (prefix: string) => `${prefix}${'0'.repeat(32)}`;
const vars: Record<string, string> = {
  FN_DOMAIN: env('SERVERLESS_DOMAIN') || 'studio-nested-flows-0000-dev.twil.io',
  SERVERLESS_SERVICE_SID: env('SERVERLESS_SERVICE_SID') || dummy('ZS'),
  SERVERLESS_ENV_SID: env('SERVERLESS_ENV_SID') || dummy('ZE'),
  FRAME_FUNCTION_SID: env('FRAME_FUNCTION_SID') || dummy('ZH'),
  CALL_FUNCTION_SID: env('CALL_FUNCTION_SID') || dummy('ZH'),
  RETURN_FUNCTION_SID: env('RETURN_FUNCTION_SID') || dummy('ZH'),
};
for (const f of FLOWS) vars[f.envKey] = env(f.envKey) || dummy('FW');

(async () => {
  let ok = true;
  for (const spec of FLOWS) {
    const def = renderFlow(spec, vars);
    log('render', `${spec.key} ${spec.file}: ${def.states.length} widgets`);
    ok = (await validateFlow(spec, def)) && ok;
  }
  console.log(ok ? '\n✅ all 8 flows valid' : '\n✗ fix the errors above');
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error('[validate] Failed:', err.message || err);
  process.exit(1);
});
