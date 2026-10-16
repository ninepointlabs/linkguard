import { describe, expect, it } from 'vitest';
import { USER_AGENT } from '../src/config.js';
import { createProvider, PERSISTWISE_UNAVAILABLE, SnapshotError, WaybackProvider } from '../src/snapshot/index.js';
import { fakeClock, json, mockFetch, res, type Handler } from './helpers.js';

const KEYS = { accessKey: 'AKEY123', secretKey: 'SKEY456' };

function provider(handler: Handler, keys = true) {
  const clock = fakeClock();
  const fetch = mockFetch(handler);
  const p = new WaybackProvider({ fetch, sleep: clock.sleep, now: clock.now, userAgent: USER_AGENT, ...(keys ? KEYS : {}) });
  return { p, fetch, clock };
}

const hit = (status = '200') =>
  json({
    url: 'example.com',
    archived_snapshots: {
      closest: { status, available: true, url: 'http://web.archive.org/web/20261015212308/https://example.com/', timestamp: '20261015212308' },
    },
  });

describe('Wayback lookup', () => {
  it('returns the closest 2xx snapshot normalized to https', async () => {
    const { p, fetch } = provider(() => hit(), false);
    expect(await p.lookup('https://example.com/')).toEqual({
      url: 'https://web.archive.org/web/20261015212308/https://example.com/',
      timestamp: '20261015212308',
      source: 'wayback',
    });
    expect(fetch.calls[0]!.url).toBe('https://archive.org/wayback/available?url=https%3A%2F%2Fexample.com%2F');
    expect(fetch.calls[0]!.headers.authorization).toBeUndefined();
  });

  it('returns null on a miss and rejects non-2xx snapshots', async () => {
    expect(await provider(() => json({ archived_snapshots: {} }), false).p.lookup('https://x.example/')).toBeNull();
    expect(await provider(() => hit('404'), false).p.lookup('https://x.example/')).toBeNull();
    expect(await provider(() => hit('302'), false).p.lookup('https://x.example/')).toBeNull();
  });

  it('paces lookups to at most one per second', async () => {
    const { p, clock } = provider(() => json({ archived_snapshots: {} }), false);
    for (let i = 0; i < 3; i++) await p.lookup(`https://x.example/${i}`);
    expect(clock.sleeps).toEqual([1000, 1000]);
  });

  it('retries 429 then succeeds; persistent 429 throws rate-limited', async () => {
    let n = 0;
    expect(await provider(() => (++n === 1 ? res(429) : hit()), false).p.lookup('https://example.com/')).not.toBeNull();
    await expect(provider(() => res(429), false).p.lookup('https://example.com/')).rejects.toMatchObject({ kind: 'rate-limited' });
  });
});

describe('Wayback create (mocked SPN2)', () => {
  it('submits with LOW auth and polls pending -> success', async () => {
    let polls = 0;
    const { p, fetch, clock } = provider(({ url }) => {
      if (url === 'https://web.archive.org/save') return json({ url: 'https://example.com/', job_id: 'spn2-abc' });
      polls++;
      return polls < 3
        ? json({ status: 'pending', job_id: 'spn2-abc' })
        : json({ status: 'success', timestamp: '20261016120000', original_url: 'https://example.com/' });
    });
    expect(await p.create('https://example.com/')).toEqual({
      url: 'https://web.archive.org/web/20261016120000/https://example.com/',
      timestamp: '20261016120000',
      source: 'wayback',
    });
    const [submit, ...statusCalls] = fetch.calls;
    expect(submit).toMatchObject({ method: 'POST', body: 'url=https%3A%2F%2Fexample.com%2F&skip_first_archive=1' });
    expect(submit!.headers).toMatchObject({ authorization: 'LOW AKEY123:SKEY456', accept: 'application/json' });
    expect(statusCalls.map((c) => c.url)).toEqual(Array(3).fill('https://web.archive.org/save/status/spn2-abc'));
    expect(statusCalls[0]!.headers.authorization).toBe('LOW AKEY123:SKEY456');
    expect(clock.sleeps).toEqual([15000, 15000, 15000]);
  });

  it('reports SPN2 job errors', async () => {
    const { p } = provider(({ url }) =>
      url.endsWith('/save')
        ? json({ job_id: 'j1' })
        : json({ status: 'error', status_ext: 'error:not-found', message: 'Page not found' }),
    );
    await expect(p.create('https://example.com/')).rejects.toMatchObject({
      kind: 'failed',
      message: 'capture failed: error:not-found: Page not found',
    });
  });

  it('treats HTTP 200 without job_id as failure', async () => {
    const { p } = provider(() => json({ status: 'error', message: 'You have already reached the limit of active sessions' }));
    await expect(p.create('https://example.com/')).rejects.toMatchObject({
      kind: 'failed',
      message: 'capture refused: You have already reached the limit of active sessions',
    });
  });

  it('maps HTTP 429 to rate-limited', async () => {
    const { p } = provider(() => res(429));
    const err = await p.create('https://example.com/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotError);
    expect(err).toMatchObject({ kind: 'rate-limited' });
  });

  it('gives up as pending after 20 polls or at the deadline', async () => {
    const pending = provider(({ url }) => (url.endsWith('/save') ? json({ job_id: 'j2' }) : json({ status: 'pending' })));
    await expect(pending.p.create('https://example.com/')).rejects.toMatchObject({ kind: 'pending' });
    expect(pending.fetch.calls).toHaveLength(21);

    const timed = provider(({ url }) => (url.endsWith('/save') ? json({ job_id: 'j3' }) : json({ status: 'pending' })));
    await expect(timed.p.create('https://example.com/', { deadline: timed.clock.now() + 40_000 })).rejects.toMatchObject({
      kind: 'pending',
    });
    expect(timed.fetch.calls).toHaveLength(3);
  });

  it('paces submissions to at most 6 per minute', async () => {
    const clock = fakeClock();
    const submits: number[] = [];
    const fetch = mockFetch(({ url }) => {
      if (!url.endsWith('/save')) return json({ status: 'success', timestamp: '20261016120000', original_url: 'https://e.example/' });
      submits.push(clock.now());
      return json({ job_id: 'j' });
    });
    const p = new WaybackProvider({ fetch, sleep: clock.sleep, now: clock.now, userAgent: USER_AGENT, pollIntervalMs: 1000, ...KEYS });
    for (let i = 0; i < 3; i++) await p.create(`https://e.example/${i}`);
    expect(submits.map((t) => t - submits[0]!)).toEqual([0, 10000, 20000]);
  });

  it('cannot create without keys', async () => {
    const { p, fetch } = provider(() => res(200), false);
    expect(p.canCreate).toBe(false);
    await expect(p.create('https://example.com/')).rejects.toMatchObject({ kind: 'failed' });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('createProvider', () => {
  it('persistwise fails fast without network calls', () => {
    const clock = fakeClock();
    const fetch = mockFetch(() => res(200));
    expect(() => createProvider('persistwise', { fetch, sleep: clock.sleep, userAgent: USER_AGENT })).toThrow(PERSISTWISE_UNAVAILABLE);
    expect(fetch.calls).toHaveLength(0);
  });
});
