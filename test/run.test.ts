import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readConfig, type Config } from '../src/config.js';
import { DEFAULT_GLOBS, detectSiteType } from '../src/files.js';
import type { PrClient, PrRequest } from '../src/pr.js';
import { run, type RunDeps } from '../src/run.js';
import { PERSISTWISE_UNAVAILABLE } from '../src/snapshot/index.js';
import { fakeClock, json, mockFetch, res, type Call, type Handler } from './helpers.js';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;
const JEKYLL = join(FIXTURES, 'jekyll');
const SNAP_TS = '20250101000000';

function config(overrides: Partial<Config> = {}): Config {
  return { ...readConfig(() => '').config, ...overrides };
}

function availability(call: Call, snapshots: Record<string, string>): Response {
  const url = decodeURIComponent(new URL(call.url).searchParams.get('url')!);
  const ts = snapshots[url];
  if (!ts) return json({ url, archived_snapshots: {} });
  return json({
    url,
    archived_snapshots: { closest: { status: '200', available: true, url: `http://web.archive.org/web/${ts}/${url}`, timestamp: ts } },
  });
}

/** Simulated internet for the jekyll fixture. */
function site(spn2?: Handler, snapshots: Record<string, string> = { 'https://dead.example.com/gone': SNAP_TS }): Handler {
  return (call) => {
    const u = new URL(call.url);
    if (u.hostname === 'archive.org') return availability(call, snapshots);
    if (u.hostname === 'web.archive.org') {
      if (!spn2) throw new Error('unexpected SPN2 call');
      return spn2(call);
    }
    switch (u.hostname) {
      case 'ok.example.com':
        return res(200);
      case 'dead.example.com':
        return res(404);
      case 'www.linkedin.com':
        return res(999);
      case 'blocked.example.com':
        return res(403);
      case 'moved.example.com':
        return u.pathname === '/old' ? res(301, { location: '/new' }) : res(200);
      default:
        throw new Error(`unexpected request ${call.url}`);
    }
  };
}

function deps(handler: Handler, root = JEKYLL, extra: Partial<RunDeps> = {}) {
  const clock = fakeClock();
  const logs: string[] = [];
  const fetch = mockFetch(handler);
  const d: RunDeps = {
    root,
    reportDir: mkdtempSync(join(tmpdir(), 'linkguard-test-')),
    fetch,
    sleep: clock.sleep,
    now: clock.now,
    log: {
      info: (m) => logs.push(`info: ${m}`),
      warning: (m) => logs.push(`warning: ${m}`),
    },
    ...extra,
  };
  return { d, logs, fetch };
}

describe('site detection', () => {
  it('detects jekyll, hugo and folderblog fixtures', () => {
    expect(detectSiteType(JEKYLL)).toBe('jekyll');
    expect(detectSiteType(join(FIXTURES, 'hugo'))).toBe('hugo');
    expect(detectSiteType(join(FIXTURES, 'folderblog'))).toBe('folderblog');
  });

  it('folderblog defaults scan dated post pages only', async () => {
    const { d } = deps(site());
    const { report } = await run(config(), { ...d, root: join(FIXTURES, 'folderblog') });
    expect(report.siteType).toBe('folderblog');
    expect(report.links.map((l) => [l.url, l.status, l.locations])).toEqual([
      ['https://dead.example.com/gone', 'dead', [{ file: '2026/09/first-post/index.html', line: 4 }]],
    ]);
    expect(DEFAULT_GLOBS.folderblog).toEqual(['[0-9][0-9][0-9][0-9]/**/*.{html,md,markdown}']);
  });
});

describe('run: lookup-only mode (no secrets)', () => {
  it('finds the dead link, does not flag bot-blocked links, and suggests the archived copy', async () => {
    const { d, logs, fetch } = deps(site());
    const { report, markdown, reportPath, deadOccurrences } = await run(config(), d);

    expect(report.mode).toBe('lookup-only');
    expect(logs[0]).toContain('Lookup-only mode');
    const by = Object.fromEntries(report.links.map((l) => [l.url, l]));
    expect(Object.keys(by)).toEqual([
      'https://ok.example.com/page?a=1&b=2',
      'https://dead.example.com/other',
      'https://ok.example.com/page',
      'https://dead.example.com/gone',
      'https://www.linkedin.com/in/someone',
      'https://blocked.example.com/members',
      'https://moved.example.com/old',
    ]);
    expect(by['https://dead.example.com/gone']).toMatchObject({
      status: 'dead',
      locations: [
        { file: '_posts/2026-01-01-hello.md', line: 4 },
        { file: '_posts/2026-01-01-hello.md', line: 18 },
        { file: 'about.md', line: 3 },
      ],
      snapshot: { url: `https://web.archive.org/web/${SNAP_TS}/https://dead.example.com/gone`, timestamp: SNAP_TS },
      action: 'archived copy available (report only)',
    });
    expect(by['https://dead.example.com/other']).toMatchObject({ status: 'dead', snapshot: null, action: 'no usable snapshot; fix manually' });
    expect(by['https://www.linkedin.com/in/someone']!.status).toBe('blocked');
    expect(by['https://blocked.example.com/members']!.status).toBe('blocked');
    expect(by['https://moved.example.com/old']).toMatchObject({ status: 'moved', finalUrl: 'https://moved.example.com/new' });
    expect(report).toMatchObject({ checkedCount: 7, skippedCount: 0, deadCount: 2, pullRequest: null });
    expect(deadOccurrences).toHaveLength(4);

    // No capture attempts and nothing sent to SPN2 without keys.
    expect(fetch.calls.some((c) => c.url.startsWith('https://web.archive.org/'))).toBe(false);
    // Only link URLs leave the runner: availability lookups carry the URL, never file contents.
    expect(fetch.calls.every((c) => c.body === undefined)).toBe(true);

    expect(markdown).toContain('| URL | Status | Files:lines | Archived URL | Action |');
    expect(markdown).toContain('_posts/2026-01-01-hello.md:4, _posts/2026-01-01-hello.md:18, about.md:3');
    const saved = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(saved.deadCount).toBe(2);
    expect(readFileSync(reportPath.replace(/\.json$/, '.md'), 'utf8')).toBe(markdown);
  });

  it('honours ignore-urls', async () => {
    const { d } = deps(site());
    const { report } = await run(config({ ignoreUrls: 'https://dead.example.com/\n/linkedin/' }), d);
    expect(report.links.map((l) => l.url).some((u) => u.includes('dead.example') || u.includes('linkedin'))).toBe(false);
  });
});

describe('run: free tier cap', () => {
  const root = mkdtempSync(join(tmpdir(), 'linkguard-cap-'));
  const body = Array.from({ length: 105 }, (_, i) => `- [l${i}](https://ok.example.com/p${i})`).join('\n');
  writeFileSync(join(root, 'post.md'), body + '\n');

  it('checks 100 links in file order and logs the rest as skipped', async () => {
    const { d, logs } = deps(site());
    const { report } = await run(config({ siteType: 'generic' as Config['siteType'] }), { ...d, root });
    expect(report.checkedCount).toBe(100);
    expect(report.skippedCount).toBe(5);
    expect(report.links.at(-1)!.url).toBe('https://ok.example.com/p99');
    expect(logs).toContain('warning: 5 links skipped (free tier cap 100)');
  });

  it('max-links can lower but never raise the cap', async () => {
    expect(readConfig((n) => (n === 'max-links' ? '500' : '')).config.maxLinks).toBe(100);
    const { d, logs } = deps(site());
    const { report } = await run(config({ maxLinks: 10, paths: ['*.md'] }), { ...d, root });
    expect(report.checkedCount).toBe(10);
    expect(logs).toContain('warning: 95 links skipped (max-links 10; free tier cap 100)');
  });
});

describe('run: snapshot mode (mocked SPN2)', () => {
  const keys = { accessKey: 'AKEY-test-123', secretKey: 'SKEY-test-456' };

  it('creates snapshots for live links without one, handling pending -> success and errors; never logs keys', async () => {
    const polls = new Map<string, number>();
    const spn2: Handler = (call) => {
      if (call.method === 'POST') {
        const url = new URLSearchParams(call.body).get('url')!;
        if (url.includes('moved.example.com')) return json({ job_id: 'job-moved' });
        if (url.includes('page?a=1')) return json({ status: 'error', message: 'Cannot resolve host' });
        return json({ job_id: `job-${url}` });
      }
      const job = decodeURIComponent(call.url.split('/status/')[1]!);
      if (job === 'job-moved') return json({ status: 'error', status_ext: 'error:bad-gateway', message: 'Bad gateway' });
      const n = (polls.get(job) ?? 0) + 1;
      polls.set(job, n);
      return n < 2 ? json({ status: 'pending' }) : json({ status: 'success', timestamp: '20261016101010', original_url: job.slice(4) });
    };
    const { d, logs, fetch } = deps(site(spn2));
    const { report, markdown, reportPath } = await run(config(keys), d);
    const by = Object.fromEntries(report.links.map((l) => [l.url, l]));

    expect(report.mode).toBe('snapshot');
    expect(by['https://ok.example.com/page']).toMatchObject({
      action: 'snapshot created',
      snapshot: { url: 'https://web.archive.org/web/20261016101010/https://ok.example.com/page' },
    });
    expect(by['https://moved.example.com/old']!.action).toBe('snapshot failed: capture failed: error:bad-gateway: Bad gateway');
    expect(by['https://ok.example.com/page?a=1&b=2']!.action).toBe('snapshot failed: capture refused: Cannot resolve host');
    // Dead and blocked links are never submitted for capture.
    const submitted = fetch.calls.filter((c) => c.method === 'POST').map((c) => new URLSearchParams(c.body).get('url'));
    expect(submitted.sort()).toEqual(['https://moved.example.com/old', 'https://ok.example.com/page', 'https://ok.example.com/page?a=1&b=2']);

    const everything = [...logs, markdown, readFileSync(reportPath, 'utf8')].join('\n');
    for (const secret of [keys.accessKey, keys.secretKey]) expect(everything).not.toContain(secret);
  });

  it('refreshes snapshots older than max-snapshot-age-days', async () => {
    const spn2: Handler = (call) =>
      call.method === 'POST' ? json({ job_id: 'j' }) : json({ status: 'success', timestamp: '20261016000000', original_url: 'https://ok.example.com/page' });
    const { d, fetch } = deps(site(spn2, { 'https://ok.example.com/page': '20200101000000', 'https://moved.example.com/old': '20261001000000' }));
    await run(config({ ...keys, maxSnapshotAgeDays: 365 }), d);
    const submitted = fetch.calls.filter((c) => c.method === 'POST').map((c) => new URLSearchParams(c.body).get('url'));
    expect(submitted).toContain('https://ok.example.com/page');
    expect(submitted).not.toContain('https://moved.example.com/old');
  });

  it('stops capturing after repeated 429 and says so', async () => {
    const root = mkdtempSync(join(tmpdir(), 'linkguard-429-'));
    writeFileSync(join(root, 'post.md'), Array.from({ length: 10 }, (_, i) => `[x](https://ok.example.com/r${i})`).join('\n'));
    const { d, fetch } = deps(site(() => res(429)), root);
    const { report } = await run(config({ ...keys, paths: ['*.md'] }), d);
    const posts = fetch.calls.filter((c) => c.method === 'POST').length;
    expect(posts).toBeGreaterThanOrEqual(3);
    expect(posts).toBeLessThan(10);
    expect(report.notes).toContain('Stopped creating snapshots: the Internet Archive kept answering HTTP 429 (rate limited).');
    expect(report.links.filter((l) => l.action === 'snapshot skipped (rate limited)').length).toBe(10 - posts);
  });
});

describe('run: open-pr', () => {
  function fakePr(defaultBranch = 'main') {
    const requests: PrRequest[] = [];
    const client: PrClient = {
      defaultBranch: async () => defaultBranch,
      openPullRequest: async (req) => {
        requests.push(req);
        return 'https://github.com/o/r/pull/1';
      },
    };
    return { client, requests };
  }
  const ctx = { owner: 'o', repo: 'r', ref: 'refs/heads/main', sha: 'abc123', runId: '42-1' };

  it('edits only the dead URLs that have a 2xx snapshot', async () => {
    const { client, requests } = fakePr();
    const { d } = deps(site(), JEKYLL, { pr: { client, ...ctx } });
    const { report } = await run(config({ openPr: true }), d);

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req).toMatchObject({ base: 'main', baseSha: 'abc123', branch: 'linkguard/archived-links-42-1' });
    expect(req.files.map((f) => f.path).sort()).toEqual(['_posts/2026-01-01-hello.md', 'about.md']);
    const archived = `https://web.archive.org/web/${SNAP_TS}/https://dead.example.com/gone`;
    for (const f of req.files) {
      const original = readFileSync(join(JEKYLL, f.path), 'utf8');
      expect(f.content).toBe(original.replaceAll('https://dead.example.com/gone', archived));
    }
    expect(req.files.find((f) => f.path === 'about.md')!.content).toContain(`${archived}#section`);
    expect(req.body).toContain('archived copy, not the original');
    expect(req.body).toContain('`about.md:3`');
    expect(report.pullRequest).toBe('https://github.com/o/r/pull/1');
    expect(report.links.find((l) => l.url === 'https://dead.example.com/gone')!.action).toBe('replaced with archived copy (PR)');
    expect(report.links.find((l) => l.url === 'https://dead.example.com/other')!.action).toBe('no usable snapshot; fix manually');
  });

  it('does not open a PR from a non-default branch', async () => {
    const { client, requests } = fakePr();
    const { d } = deps(site(), JEKYLL, { pr: { client, ...ctx, ref: 'refs/heads/feature' } });
    const { report } = await run(config({ openPr: true }), d);
    expect(requests).toHaveLength(0);
    expect(report.notes.some((n) => n.startsWith('open-pr skipped'))).toBe(true);
  });
});

describe('run: providers', () => {
  it("snapshot-provider 'persistwise' fails fast with no network calls", async () => {
    const { d, fetch } = deps(site());
    await expect(run(config({ snapshotProvider: 'persistwise' }), d)).rejects.toThrow(PERSISTWISE_UNAVAILABLE);
    expect(fetch.calls).toHaveLength(0);
  });
});
