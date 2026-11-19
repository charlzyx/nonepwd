import type { CfServerEnv } from './types.js';

/** About once a minute. Longer than the 15s success throttle, shorter than a code's life. */
export const IMAP_ALARM_INTERVAL_MS = 60_000;
/** When another mailbox is already due, run it on the next alarm instead of waiting a minute. */
export const IMAP_ALARM_FOLLOWUP_MS = 2_000;
/** Manual sync asks the alarm to run on the next tick instead of inside the HTTP request. */
export const IMAP_ALARM_SOON_MS = 1_000;

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
export async function armImapAlarmFromEnv(
  env: CfServerEnv,
  options?: { soon?: boolean }
): Promise<boolean> {
  if (!env.WS_HUB) return false;
  const id = env.WS_HUB.idFromName(IMAP_ALARM_DO_NAME);
  const stub = env.WS_HUB.get(id);
  const url = options?.soon ? 'https://do.internal/imap-alarm?soon=1' : 'https://do.internal/imap-alarm';
  const res = await stub.fetch(url);
  if (!res.ok) return false;
  const body = (await res.json().catch(() => ({}))) as { armed?: boolean };
  return body.armed !== false;
}
