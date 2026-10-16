import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { glob } from 'tinyglobby';

export type SiteType = 'jekyll' | 'hugo' | 'folderblog' | 'generic';

export const DEFAULT_GLOBS: Record<SiteType, string[]> = {
  jekyll: ['_posts/**/*.{md,markdown,html}', '_pages/**/*.{md,markdown,html}', '*.{md,markdown}'],
  hugo: ['content/**/*.{md,markdown,html}'],
  // folderblog publishes posts as YYYY/MM/<slug>/index.html (checked against ninepointlabs/Tim-Apples-Desk).
  folderblog: ['[0-9][0-9][0-9][0-9]/**/*.{html,md,markdown}'],
  generic: ['**/*.{md,markdown,html,htm}'],
};

const ALWAYS_IGNORE = ['**/node_modules/**', '**/.git/**', '**/vendor/**', '_site/**', 'public/**', 'resources/**'];

const HUGO_CONFIGS = ['hugo.toml', 'hugo.yaml', 'hugo.yml', 'hugo.json'];
const LEGACY_HUGO_CONFIGS = ['config.toml', 'config.yaml', 'config.yml', 'config.json'];

/** Best-effort detection of the site generator from files at the repo root. */
export function detectSiteType(root: string): SiteType {
  const has = (f: string) => existsSync(join(root, f));
  if (HUGO_CONFIGS.some(has) || (has('content') && LEGACY_HUGO_CONFIGS.some(has))) return 'hugo';
  if (has('_config.yml') || has('_config.yaml')) return 'jekyll';
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    // unreadable root: fall through to generic
  }
  if (entries.some((e) => /^\d{4}$/.test(e)) && (has('.nojekyll') || has('feed.xml'))) return 'folderblog';
  return 'generic';
}

export function parseList(input: string): string[] {
  return input
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

/** Resolve content files, sorted, as forward-slash paths relative to `root`. */
export async function findFiles(root: string, patterns: string[]): Promise<string[]> {
  const files = await glob(patterns, { cwd: root, ignore: ALWAYS_IGNORE, onlyFiles: true, dot: false });
  return [...new Set(files)].sort();
}
