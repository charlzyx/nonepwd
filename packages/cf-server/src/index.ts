import { setNonePwdWasmModule } from '@nonepwd/core/worker';
import { createCfApp, runScheduledImapSync, runScheduledMaintenance } from './app.js';
import { handleIncomingCfEmail } from './email.js';
import wasmModule from './nonepwd_core.wasm';
import type { CfServerEnv, EmailMessageLike } from './types.js';
import { VaultWsHub } from './ws-hub.js';

setNonePwdWasmModule(wasmModule);

const app = createCfApp();

export { VaultWsHub, createCfApp, handleIncomingCfEmail, runScheduledMaintenance };

export default {
  async fetch(
    request: Request,
    env: CfServerEnv,
    ctx: ExecutionContext
  ): Promise<Response> {
    return app.fetch(request, env, ctx);
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
    controller: ScheduledController,
    env: CfServerEnv,
    _ctx: ExecutionContext
  ): Promise<void> {
    // The every-minute trigger only pulls fresh verification codes.
    // Any other schedule keeps the session purge and R2 snapshot.
    if (controller.cron === '* * * * *') {
      await runScheduledImapSync(env);
      return;
    }
    await runScheduledMaintenance(env);
  },
};
