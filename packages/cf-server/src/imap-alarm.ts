import type { CfServerEnv } from './types.js';

/** About once a minute. Longer than the 15s success throttle, shorter than a code's life. */
export const IMAP_ALARM_INTERVAL_MS = 60_000;

/** Separate object from the WebSocket hub so a mailbox pull cannot block live clients. */
export const IMAP_ALARM_DO_NAME = 'imap';

export function nextImapAlarmAt(nowMs: number = Date.now()): number {
  return nowMs + IMAP_ALARM_INTERVAL_MS;
}

/**
 * `setAlarm` replaces any pending alarm. Only arm when nothing is scheduled,
 * otherwise steady traffic would keep pushing the run forward and it would never fire.
 */
export function alarmNeedsArming(existingAlarmMs: number | null, nowMs: number = Date.now()): boolean {
  return existingAlarmMs === null || existingAlarmMs <= nowMs;
}

export async function ensureImapAlarm(
  storage: {
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number): Promise<void>;
  },
  nowMs: number = Date.now()
): Promise<boolean> {
  const existing = await storage.getAlarm();
  if (!alarmNeedsArming(existing, nowMs)) return false;
  await storage.setAlarm(nextImapAlarmAt(nowMs));
  return true;
}

/** Asks the mailbox Durable Object to schedule its alarm. Does not sync IMAP. */
export async function armImapAlarmFromEnv(env: CfServerEnv): Promise<boolean> {
  if (!env.WS_HUB) return false;
  const id = env.WS_HUB.idFromName(IMAP_ALARM_DO_NAME);
  const stub = env.WS_HUB.get(id);
  const res = await stub.fetch('https://do.internal/imap-alarm');
  if (!res.ok) return false;
  const body = (await res.json().catch(() => ({}))) as { armed?: boolean };
  return Boolean(body.armed);
}
