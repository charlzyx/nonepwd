import { describe, expect, it } from 'vitest';
import { runScheduledImapSync } from '../src/app.js';
import {
  IMAP_ALARM_DO_NAME,
  IMAP_ALARM_INTERVAL_MS,
  alarmNeedsArming,
  armImapAlarmFromEnv,
  ensureImapAlarm,
  nextImapAlarmAt,
} from '../src/imap-alarm.js';
import {
  IMAP_CODE_WINDOW_MS,
  IMAP_MAX_MESSAGES_PER_ACCOUNT,
  buildVerificationUidSearch,
  selectNewestUids,
  shouldBaselineUid,
  syncMinIntervalMs,
} from '../src/imap.js';
import type { CfServerEnv } from '../src/types.js';
import { VaultWsHub } from '../src/ws-hub.js';

function memoryAlarm() {
  let scheduled: number | null = null;
  const sets: number[] = [];
  return {
    sets,
    storage: {
      async getAlarm() {
        return scheduled;
      },
      async setAlarm(time: number) {
        scheduled = time;
        sets.push(time);
      },
      async deleteAlarm() {
        scheduled = null;
      },
    },
    read: () => scheduled,
  };
}

describe('IMAP alarm schedule', () => {
  it('arms about a minute out and does not postpone an alarm that is already pending', async () => {
    expect(IMAP_ALARM_INTERVAL_MS).toBe(60_000);
    const now = 1_700_000_000_000;
    expect(nextImapAlarmAt(now)).toBe(now + 60_000);
    expect(alarmNeedsArming(null, now)).toBe(true);
    expect(alarmNeedsArming(now - 1, now)).toBe(true);
    expect(alarmNeedsArming(now + 30_000, now)).toBe(false);

    const clock = memoryAlarm();
    expect(await ensureImapAlarm(clock.storage, now)).toBe(true);
    expect(clock.read()).toBe(now + 60_000);
    expect(await ensureImapAlarm(clock.storage, now + 1_000)).toBe(false);
    expect(clock.sets).toEqual([now + 60_000]);
  });

  it('schedules the mailbox object without syncing, and the alarm handler still reschedules if the pull throws', async () => {
    const clock = memoryAlarm();
    const calls: string[] = [];
    const env = {
      DB: {
        prepare() {
          calls.push('db');
          throw new Error('db down');
        },
      },
    } as unknown as CfServerEnv;

    const hub = new VaultWsHub(
      {
        storage: clock.storage,
        getWebSockets: () => [],
        acceptWebSocket() {},
      } as unknown as DurableObjectState,
      env
    );

    const armed = await hub.fetch(new Request('https://do.internal/imap-alarm'));
    expect(armed.status).toBe(200);
    expect(await armed.json()).toEqual({ ok: true, armed: true });
    expect(calls).toEqual([]);
    const firstAlarm = clock.read();
    expect(firstAlarm).not.toBeNull();

    const again = await hub.fetch(new Request('https://do.internal/imap-alarm'));
    expect(await again.json()).toEqual({ ok: true, armed: false });
    expect(clock.read()).toBe(firstAlarm);

    const before = Date.now();
    await hub.alarm();
    const after = Date.now();
    const next = clock.read()!;
    expect(next).toBeGreaterThanOrEqual(before + IMAP_ALARM_INTERVAL_MS);
    expect(next).toBeLessThanOrEqual(after + IMAP_ALARM_INTERVAL_MS);
    expect(calls[0]).toBe('db');
  });

  it('asks only the imap object to arm, and keeps the UID window and failure backoff', async () => {
    const fetched: string[] = [];
    const env = {
      WS_HUB: {
        idFromName(name: string) {
          fetched.push(`id:${name}`);
          return { name };
        },
        get() {
          return {
            async fetch(input: RequestInfo) {
              const url = typeof input === 'string' ? input : input.url;
              fetched.push(url);
              return Response.json({ ok: true, armed: true });
            },
          };
        },
      },
    } as unknown as CfServerEnv;

    expect(await armImapAlarmFromEnv(env)).toBe(true);
    expect(fetched).toEqual([`id:${IMAP_ALARM_DO_NAME}`, 'https://do.internal/imap-alarm']);

    const now = Date.parse('2026-11-19T15:00:00.000Z');
    expect(shouldBaselineUid(false, null, now)).toBe(true);
    expect(shouldBaselineUid(true, new Date(now - 60_000).toISOString(), now)).toBe(false);
    expect(buildVerificationUidSearch(40, new Date(now))).toContain('UID 41:*');
    expect(selectNewestUids([41, 42, 48], 40, IMAP_MAX_MESSAGES_PER_ACCOUNT)).toEqual({
      fetch: [42, 48],
      advanceTo: 48,
    });
    expect(syncMinIntervalMs(0)).toBeLessThan(IMAP_CODE_WINDOW_MS);
    expect(syncMinIntervalMs(1)).toBeGreaterThan(syncMinIntervalMs(0));
    expect(typeof runScheduledImapSync).toBe('function');
  });
});
