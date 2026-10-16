import { describe, expect, it } from 'vitest';
import { LinkChecker, parseRetryAfter } from '../src/checker.js';
import { USER_AGENT } from '../src/config.js';
import { KeyedLimiter } from '../src/limit.js';
import { fakeClock, mockFetch, netError, res, type Handler } from './helpers.js';

function checker(handler: Handler) {
  const clock = fakeClock();
  const fetch = mockFetch(handler);
  return { c: new LinkChecker({ fetch, sleep: clock.sleep, userAgent: USER_AGENT }), fetch, clock };
}

describe('LinkChecker', () => {
  it('ok on 200 HEAD, with an honest User-Agent', async () => {
    const { c, fetch } = checker(() => res(200));
    expect(await c.check('https://a.example/')).toMatchObject({ status: 'ok', httpStatus: 200 });
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.method).toBe('HEAD');
    expect(fetch.calls[0]!.headers['user-agent']).toBe('Linkguard/0.1 (+https://linkguard.persistwise.com)');
  });

  it.each([404, 410])('dead on %i (confirmed with GET, no retries)', async (code) => {
    const { c, fetch } = checker(() => res(code));
    expect(await c.check('https://a.example/x')).toMatchObject({ status: 'dead', httpStatus: code });
    expect(fetch.calls.map((x) => x.method)).toEqual(['HEAD', 'GET']);
  });

  it('a HEAD 404 that GET answers with 200 is ok', async () => {
    const { c } = checker(({ method }) => res(method === 'HEAD' ? 404 : 200));
    expect((await c.check('https://a.example/x')).status).toBe('ok');
  });

  it.each([405, 403, 501])('falls back to GET when HEAD returns %i', async (code) => {
    const { c, fetch } = checker(({ method }) => res(method === 'HEAD' ? code : 200));
    expect((await c.check('https://a.example/')).status).toBe('ok');
    expect(fetch.calls.map((x) => x.method)).toEqual(['HEAD', 'GET']);
  });

  it.each([401, 403, 999])('treats %i as blocked, not dead', async (code) => {
    const { c } = checker(() => res(code));
    expect(await c.check('https://www.linkedin.com/in/x')).toMatchObject({ status: 'blocked', httpStatus: code });
  });

  it('reports redirects to a different path as moved', async () => {
    const { c } = checker(({ url }) => (url.endsWith('/old') ? res(301, { location: '/new' }) : res(200)));
    expect(await c.check('https://m.example/old')).toMatchObject({ status: 'moved', finalUrl: 'https://m.example/new' });
  });

  it('does not call http->https or trailing-slash redirects moved', async () => {
    const { c } = checker(({ url }) => (url.startsWith('http:') ? res(301, { location: 'https://m.example/a/' }) : res(200)));
    expect((await c.check('http://m.example/a')).status).toBe('ok');
  });

  it('a redirect that ends in 404 is dead', async () => {
    const { c } = checker(({ url }) => (url.endsWith('/old') ? res(302, { location: '/missing' }) : res(404)));
    expect((await c.check('https://m.example/old')).status).toBe('dead');
  });

  it('stops after 5 redirects', async () => {
    let n = 0;
    const { c, fetch } = checker(() => res(302, { location: `/r${++n}` }));
    expect(await c.check('https://loop.example/')).toMatchObject({ status: 'blocked', detail: 'more than 5 redirects' });
    expect(fetch.calls).toHaveLength(6);
  });

  it('retries 5xx twice with backoff, then dead', async () => {
    const { c, fetch, clock } = checker(() => res(503));
    const r = await c.check('https://down.example/');
    expect(r.status).toBe('dead');
    expect(r.detail).toBe('HTTP 503 after 3 attempts');
    expect(fetch.calls.filter((x) => x.method === 'HEAD')).toHaveLength(3);
    expect(clock.sleeps).toEqual([1000, 2000]);
  });

  it('recovers when a retry succeeds', async () => {
    let n = 0;
    const { c } = checker(() => res(++n === 1 ? 502 : 200));
    expect((await c.check('https://flaky.example/')).status).toBe('ok');
  });

  it('timeouts and DNS failures are dead after retries', async () => {
    const t = checker(() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    expect(await t.c.check('https://slow.example/')).toMatchObject({ status: 'dead', detail: 'timeout after 3 attempts' });
    expect(t.fetch.calls).toHaveLength(3);
    const d = checker(() => {
      throw netError('ENOTFOUND');
    });
    expect(await d.c.check('https://nxdomain.example/')).toMatchObject({
      status: 'dead',
      detail: 'DNS failure (ENOTFOUND) after 3 attempts',
    });
  });

  it('honours Retry-After on 429', async () => {
    let n = 0;
    const { c, clock } = checker(() => (++n === 1 ? res(429, { 'retry-after': '7' }) : res(200)));
    expect((await c.check('https://busy.example/')).status).toBe('ok');
    expect(clock.sleeps).toEqual([7000]);
  });

  it('persistent 429 is blocked, not dead; long Retry-After gives up immediately', async () => {
    expect((await checker(() => res(429)).c.check('https://busy.example/')).status).toBe('blocked');
    const long = checker(() => res(429, { 'retry-after': '3600' }));
    expect((await long.c.check('https://busy.example/')).status).toBe('blocked');
    expect(long.clock.sleeps).toEqual([]);
  });

  it('parses Retry-After dates', () => {
    expect(parseRetryAfter('Fri, 16 Oct 2026 00:00:10 GMT', Date.UTC(2026, 9, 16))).toBe(10_000);
    expect(parseRetryAfter('garbage')).toBeNull();
  });
});

describe('KeyedLimiter', () => {
  it('runs at most 4 tasks overall and 1 per host', async () => {
    const limiter = new KeyedLimiter(4);
    let active = 0;
    let maxActive = 0;
    const perHost = new Map<string, number>();
    let maxPerHost = 0;
    const hosts = ['a', 'a', 'a', 'b', 'b', 'c', 'd', 'e', 'f', 'g'];
    await Promise.all(
      hosts.map((h) =>
        limiter.run(h, async () => {
          active++;
          perHost.set(h, (perHost.get(h) ?? 0) + 1);
          maxActive = Math.max(maxActive, active);
          maxPerHost = Math.max(maxPerHost, perHost.get(h)!);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          perHost.set(h, perHost.get(h)! - 1);
        }),
      ),
    );
    expect(maxActive).toBe(4);
    expect(maxPerHost).toBe(1);
  });
});
