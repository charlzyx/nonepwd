import { setNonePwdWasmModule } from '@nonepwd/core/worker';
import { createCfApp, runScheduledMaintenance } from './app.js';
import { handleIncomingCfEmail } from './email.js';
import { armImapAlarmFromEnv } from './imap-alarm.js';
import wasmModule from './nonepwd_core.wasm';
import type { CfServerEnv, EmailMessageLike } from './types.js';
import { AgentRelayHub } from './agent-relay-do.js';
import { VaultWsHub } from './ws-hub.js';

setNonePwdWasmModule(wasmModule);

const app = createCfApp();

/** One arm attempt per isolate. The call only schedules the alarm; it does not sync. */
const imapAlarmArm = new WeakMap<object, Promise<void>>();

function armImapAlarmOnce(env: CfServerEnv): Promise<void> {
  if (!env.WS_HUB) return Promise.resolve();
  const existing = imapAlarmArm.get(env.WS_HUB);
  if (existing) return existing;
  const pending = armImapAlarmFromEnv(env).then(
    () => undefined,
    () => {
      imapAlarmArm.delete(env.WS_HUB!);
    }
  );
  imapAlarmArm.set(env.WS_HUB, pending);
  return pending;
}

export { AgentRelayHub, VaultWsHub, createCfApp, handleIncomingCfEmail, runScheduledMaintenance };

export default {
  async fetch(
    request: Request,
    env: CfServerEnv,
    _ctx: ExecutionContext
  ): Promise<Response> {
    // Schedule the mailbox alarm alongside the response. This is not IMAP work
    // and is not waitUntil: a cold isolate does one Durable Object storage read.
    const arm = armImapAlarmOnce(env);
    const response = await app.fetch(request, env, _ctx);
    await arm;
    return response;
  },

  async email(
    message: EmailMessageLike,
    env: CfServerEnv,
    _ctx: ExecutionContext
  ): Promise<void> {
    const result = await handleIncomingCfEmail(message, env);
    if (!result.accepted && result.reason === 'account_not_initialized') {
      throw new Error('nonepwd account is not initialized yet');
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: CfServerEnv,
    _ctx: ExecutionContext
  ): Promise<void> {
    // No Cron Trigger is configured: this account is already at the Workers Free
    // limit of 5. IMAP sync runs from the VaultWsHub "imap" alarm instead.
    await runScheduledMaintenance(env);
  },
};
