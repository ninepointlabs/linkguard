import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LinkChecker, type CheckResult, type FetchFn } from './checker.js';
import { FREE_TIER_CAP, USER_AGENT, type Config } from './config.js';
import { extractLinks, type LinkOccurrence } from './extract.js';
import { DEFAULT_GLOBS, detectSiteType, findFiles } from './files.js';
import { externalKey, parseIgnoreRules } from './filter.js';
import { KeyedLimiter, Semaphore } from './limit.js';
import type { PrClient } from './pr.js';
import { renderMarkdown, type LinkReport, type RunReport } from './report.js';
import { applyReplacements, type Replacement } from './rewrite.js';
import { createProvider, SnapshotError, timestampToMs, type Snapshot } from './snapshot/index.js';

export const VERSION = '0.1.1';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const CHECK_CONCURRENCY = 4;
const CAPTURE_CONCURRENCY = 4;
const RATE_LIMIT_STOP_AFTER = 3;

export interface Logger {
  info(message: string): void;
  warning(message: string, where?: { file: string; startLine: number }): void;
}

export interface RunDeps {
  root: string;
  reportDir: string;
  fetch: FetchFn;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: Logger;
  /** Needed only for open-pr. */
  pr?: { client: PrClient; owner: string; repo: string; ref: string; sha: string; runId: string } | null;
}

export interface RunResult {
  report: RunReport;
  markdown: string;
  reportPath: string;
  markdownPath: string;
  /** Dead-link occurrences with the reason, for annotations. */
  deadOccurrences: Array<{ occurrence: LinkOccurrence; detail: string }>;
}

interface Entry {
  key: string;
  url: string;
  occurrences: LinkOccurrence[];
  check?: CheckResult;
  snapshot: Snapshot | null;
  snapshotNote: string;
  action: string;
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

export async function run(config: Config, deps: RunDeps): Promise<RunResult> {
  const { log } = deps;
  // Fails fast for unavailable providers, before any network call.
  const provider = createProvider(config.snapshotProvider, {
    fetch: deps.fetch,
    sleep: deps.sleep,
    now: deps.now,
    userAgent: USER_AGENT,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });
  const notes: string[] = [];
  const mode = provider.canCreate ? 'snapshot' : 'lookup-only';
  if (mode === 'lookup-only') {
    notes.push(
      'Lookup-only mode: no Internet Archive keys were provided, so existing Wayback snapshots are looked up but no new ones are created.',
    );
  }
  for (const n of notes) log.info(n);

  // 1. Find files and links.
  const siteType = config.siteType === 'auto' ? detectSiteType(deps.root) : config.siteType;
  const patterns = config.paths.length ? config.paths : DEFAULT_GLOBS[siteType];
  const files = await findFiles(deps.root, patterns);
  log.info(`Site type: ${siteType}. Scanning ${files.length} files (${patterns.join(', ')}).`);

  const ignore = parseIgnoreRules(config.ignoreUrls);
  const entries = new Map<string, Entry>();
  for (const file of files) {
    const abs = join(deps.root, file);
    if ((await stat(abs)).size > MAX_FILE_BYTES) {
      log.warning(`Skipping ${file}: larger than 5 MB.`);
      continue;
    }
    const text = await readFile(abs, 'utf8');
    for (const occ of extractLinks(file, text)) {
      const key = externalKey(occ.url);
      if (!key || ignore.some((rule) => rule(occ.url))) continue;
      let entry = entries.get(key);
      if (!entry) {
        entry = { key, url: occ.url.split('#')[0]!, occurrences: [], snapshot: null, snapshotNote: '', action: 'none' };
        entries.set(key, entry);
      }
      entry.occurrences.push(occ);
    }
  }

  // 2. Free-tier cap, in file order.
  const all = [...entries.values()];
  const checked = all.slice(0, config.maxLinks);
  const skippedCount = all.length - checked.length;
  if (skippedCount > 0) {
    const why = config.maxLinks === FREE_TIER_CAP ? `free tier cap ${FREE_TIER_CAP}` : `max-links ${config.maxLinks}; free tier cap ${FREE_TIER_CAP}`;
    const msg = `${skippedCount} links skipped (${why})`;
    log.warning(msg);
    notes.push(msg);
  }
  log.info(`Checking ${checked.length} unique external links.`);

  // 3. Liveness checks: max 4 in flight, 1 per host.
  const checker = new LinkChecker({ fetch: deps.fetch, sleep: deps.sleep, userAgent: USER_AGENT });
  const limiter = new KeyedLimiter(CHECK_CONCURRENCY);
  await Promise.all(
    checked.map((e) =>
      limiter.run(hostOf(e.key), async () => {
        e.check = await checker.check(e.key);
        log.info(`${e.check.status.padEnd(7)} ${e.url} (${e.check.detail})`);
      }),
    ),
  );

  // 4. Snapshot lookups (paced inside the provider).
  let lookupFailures = 0;
  for (const e of checked) {
    try {
      e.snapshot = await provider.lookup(e.key);
      e.snapshotNote = e.snapshot ? `existing snapshot ${e.snapshot.timestamp}` : 'no snapshot';
    } catch (err) {
      lookupFailures++;
      e.snapshotNote = 'no snapshot info (lookup failed)';
      log.info(`Snapshot lookup failed for ${e.url}: ${(err as Error).message}`);
    }
  }
  if (lookupFailures) notes.push(`${lookupFailures} snapshot lookups failed; those links show "no snapshot info".`);

  // 5. Snapshot creation for live links with no (or an old) snapshot.
  if (provider.canCreate) {
    const maxAgeMs = config.maxSnapshotAgeDays * 86_400_000;
    const candidates = checked.filter((e) => {
      if (e.check?.status !== 'ok' && e.check?.status !== 'moved') return false;
      if (e.snapshotNote.startsWith('no snapshot info')) return false;
      if (!e.snapshot) return true;
      const at = timestampToMs(e.snapshot.timestamp);
      return at === null || deps.now() - at > maxAgeMs;
    });
    const deadline = deps.now() + config.snapshotTimeBudgetMinutes * 60_000;
    let consecutiveRateLimits = 0;
    let stopped = false;
    let budgetHit = false;
    let created = 0;
    const sem = new Semaphore(CAPTURE_CONCURRENCY);
    log.info(`Creating snapshots for ${candidates.length} links (time budget ${config.snapshotTimeBudgetMinutes} min).`);
    await Promise.all(
      candidates.map((e) =>
        sem.run(async () => {
          if (stopped) {
            e.action = 'snapshot skipped (rate limited)';
            return;
          }
          if (deps.now() >= deadline) {
            budgetHit = true;
            e.action = 'snapshot skipped (time budget reached)';
            return;
          }
          try {
            e.snapshot = await provider.create(e.key, { deadline });
            e.snapshotNote = 'new snapshot';
            e.action = 'snapshot created';
            consecutiveRateLimits = 0;
            created++;
          } catch (err) {
            const se = err instanceof SnapshotError ? err : new SnapshotError('failed', (err as Error).message);
            if (se.kind === 'rate-limited') {
              consecutiveRateLimits++;
              if (consecutiveRateLimits >= RATE_LIMIT_STOP_AFTER) stopped = true;
            } else {
              consecutiveRateLimits = 0;
            }
            if (se.kind === 'pending') budgetHit = true;
            e.action = se.kind === 'pending' ? 'snapshot pending' : `snapshot failed: ${se.message}`;
            log.info(`Snapshot for ${e.url}: ${se.message}`);
          }
        }),
      ),
    );
    log.info(`Created ${created} new snapshots.`);
    if (stopped) notes.push('Stopped creating snapshots: the Internet Archive kept answering HTTP 429 (rate limited).');
    if (budgetHit) notes.push(`Snapshot time budget (${config.snapshotTimeBudgetMinutes} min) reached; some captures were not finished.`);
  }

  // 6. Dead links: report (and optionally replace) with a 2xx archived copy.
  const dead = checked.filter((e) => e.check?.status === 'dead');
  const replaceable = dead.filter((e) => e.snapshot);
  for (const e of dead) {
    e.action = e.snapshot ? 'archived copy available (report only)' : 'no usable snapshot; fix manually';
  }

  let pullRequest: string | null = null;
  if (config.openPr && replaceable.length) {
    pullRequest = await openPr(replaceable, deps, notes);
    if (pullRequest) for (const e of replaceable) e.action = 'replaced with archived copy (PR)';
  } else if (config.openPr) {
    log.info('open-pr: no dead links with a usable snapshot; no pull request needed.');
  }

  // 7. Report.
  const links: LinkReport[] = checked.map((e) => ({
    url: e.url,
    status: e.check!.status,
    ...(e.check!.httpStatus !== undefined ? { httpStatus: e.check!.httpStatus } : {}),
    ...(e.check!.finalUrl ? { finalUrl: e.check!.finalUrl } : {}),
    detail: e.check!.detail,
    locations: e.occurrences.map((o) => ({ file: o.file, line: o.line })),
    snapshot: e.snapshot,
    snapshotNote: e.snapshotNote,
    action: e.action,
  }));
  const report: RunReport = {
    version: VERSION,
    generatedAt: new Date(deps.now()).toISOString(),
    siteType,
    mode,
    filesScanned: files.length,
    checkedCount: checked.length,
    skippedCount,
    deadCount: dead.length,
    notes,
    pullRequest,
    links,
  };
  const markdown = renderMarkdown(report);
  await mkdir(deps.reportDir, { recursive: true });
  const reportPath = join(deps.reportDir, 'linkguard-report.json');
  const markdownPath = join(deps.reportDir, 'linkguard-report.md');
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await writeFile(markdownPath, markdown);
  return { report, markdown, reportPath, markdownPath, deadOccurrences: dead.flatMap((e) => e.occurrences.map((occurrence) => ({ occurrence, detail: e.check!.detail }))),
  };
}

async function openPr(replaceable: Entry[], deps: RunDeps, notes: string[]): Promise<string | null> {
  const skip = (why: string) => {
    deps.log.warning(`open-pr skipped: ${why}`);
    notes.push(`open-pr skipped: ${why}`);
    return null;
  };
  if (!deps.pr) return skip('no GitHub token or repository context available.');
  const { client, owner, repo, ref, sha, runId } = deps.pr;
  const base = await client.defaultBranch(owner, repo);
  if (ref !== `refs/heads/${base}`) {
    return skip(`this run is on ${ref || 'an unknown ref'}, not the default branch ${base}; replacements are only proposed from ${base}.`);
  }

  const byFile = new Map<string, Replacement[]>();
  for (const e of replaceable) {
    for (const occ of e.occurrences) {
      const list = byFile.get(occ.file) ?? [];
      list.push({ occurrence: occ, timestamp: e.snapshot!.timestamp });
      byFile.set(occ.file, list);
    }
  }
  const files: Array<{ path: string; content: string }> = [];
  for (const [file, reps] of byFile) {
    const original = await readFile(join(deps.root, file), 'utf8');
    files.push({ path: file, content: applyReplacements(original, reps) });
  }

  const rows = replaceable.flatMap((e) =>
    e.occurrences.map((o) => `| \`${o.file}:${o.line}\` | ${o.url} | ${e.check!.detail} | ${e.snapshot!.url} |`),
  );
  const body = [
    'Linkguard found dead outbound links and replaced them with Internet Archive (Wayback Machine) snapshots.',
    '',
    '**Each replacement is an archived copy, not the original.** Please review before merging.',
    '',
    '| Location | Dead URL | Why | Archived copy |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `Generated by Linkguard ${VERSION}.`,
  ].join('\n');
  const url = await client.openPullRequest({
    owner,
    repo,
    base,
    baseSha: sha,
    branch: `linkguard/archived-links-${runId}`,
    files,
    title: `Replace ${replaceable.length} dead link${replaceable.length === 1 ? '' : 's'} with archived copies`,
    body,
  });
  deps.log.info(`Opened pull request: ${url}`);
  return url;
}
