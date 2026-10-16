import * as core from '@actions/core';
import { context } from '@actions/github';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from './config.js';
import { octokitPrClient } from './pr.js';
import { run } from './run.js';

async function main(): Promise<void> {
  // Mask keys before anything else can log them.
  for (const name of ['wayback-access-key', 'wayback-secret-key', 'github-token']) {
    const value = core.getInput(name).trim();
    if (value) core.setSecret(value);
  }
  const { config, warnings } = readConfig((name) => core.getInput(name));
  for (const w of warnings) core.warning(w);

  const pr =
    config.openPr && config.githubToken
      ? {
          client: octokitPrClient(config.githubToken),
          ...context.repo,
          ref: context.ref,
          sha: context.sha,
          runId: `${context.runId}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`,
        }
      : null;

  const result = await run(config, {
    root: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    reportDir: join(process.env.RUNNER_TEMP ?? tmpdir(), 'linkguard'),
    fetch: (input, init) => fetch(input, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    log: {
      info: (m) => core.info(m),
      warning: (m, where) => (where ? core.warning(m, { file: where.file, startLine: where.startLine }) : core.warning(m)),
    },
    pr,
  });

  for (const { occurrence: occ, detail } of result.deadOccurrences) {
    const message = `Dead link: ${occ.url} (${detail})`;
    const props = { file: occ.file, startLine: occ.line, title: 'Linkguard' };
    if (config.failOnDead) core.error(message, props);
    else core.warning(message, props);
  }

  await core.summary.addRaw(result.markdown).write();
  core.setOutput('dead-count', result.report.deadCount);
  core.setOutput('checked-count', result.report.checkedCount);
  core.setOutput('skipped-count', result.report.skippedCount);
  core.setOutput('report-path', result.reportPath);
  core.info(`Report: ${result.reportPath} (markdown: ${result.markdownPath})`);

  if (config.failOnDead && result.report.deadCount > 0) {
    core.setFailed(`${result.report.deadCount} dead link(s) found.`);
  }
}

main().catch((err: unknown) => core.setFailed(err instanceof Error ? err.message : String(err)));
