import type { SiteType } from './files.js';
import { parseList } from './files.js';

export const FREE_TIER_CAP = 100;
export const USER_AGENT = 'Linkguard/0.1 (+https://linkguard.persistwise.com)';

export interface Config {
  paths: string[];
  siteType: SiteType | 'auto';
  maxLinks: number;
  failOnDead: boolean;
  openPr: boolean;
  ignoreUrls: string;
  snapshotProvider: string;
  accessKey: string;
  secretKey: string;
  maxSnapshotAgeDays: number;
  snapshotTimeBudgetMinutes: number;
  githubToken: string;
}

export type GetInput = (name: string) => string;

function bool(name: string, value: string, fallback: boolean): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return fallback;
  if (['true', 'yes', '1'].includes(v)) return true;
  if (['false', 'no', '0'].includes(v)) return false;
  throw new Error(`input '${name}' must be true or false, got '${value}'`);
}

function int(name: string, value: string, fallback: number, min: number): number {
  const v = value.trim();
  if (!v) return fallback;
  if (!/^\d+$/.test(v) || Number(v) < min) throw new Error(`input '${name}' must be an integer >= ${min}, got '${value}'`);
  return Number(v);
}

export interface ParsedConfig {
  config: Config;
  warnings: string[];
}

export function readConfig(get: GetInput): ParsedConfig {
  const warnings: string[] = [];
  const siteType = (get('site-type').trim().toLowerCase() || 'auto') as Config['siteType'];
  if (!['auto', 'jekyll', 'hugo', 'folderblog'].includes(siteType)) {
    throw new Error(`input 'site-type' must be one of auto, jekyll, hugo, folderblog; got '${siteType}'`);
  }
  let maxLinks = int('max-links', get('max-links'), FREE_TIER_CAP, 1);
  if (maxLinks > FREE_TIER_CAP) {
    warnings.push(`max-links ${maxLinks} is above the free tier cap; using ${FREE_TIER_CAP}.`);
    maxLinks = FREE_TIER_CAP;
  }
  const accessKey = get('wayback-access-key').trim();
  const secretKey = get('wayback-secret-key').trim();
  if (Boolean(accessKey) !== Boolean(secretKey)) {
    warnings.push('Only one of wayback-access-key / wayback-secret-key is set; both are needed. Running in lookup-only mode.');
  }
  const config: Config = {
    paths: parseList(get('paths')),
    siteType,
    maxLinks,
    failOnDead: bool('fail-on-dead', get('fail-on-dead'), false),
    openPr: bool('open-pr', get('open-pr'), false),
    ignoreUrls: get('ignore-urls'),
    snapshotProvider: get('snapshot-provider').trim().toLowerCase() || 'wayback',
    accessKey: accessKey && secretKey ? accessKey : '',
    secretKey: accessKey && secretKey ? secretKey : '',
    maxSnapshotAgeDays: int('max-snapshot-age-days', get('max-snapshot-age-days'), 365, 1),
    snapshotTimeBudgetMinutes: int('snapshot-time-budget-minutes', get('snapshot-time-budget-minutes'), 20, 1),
    githubToken: get('github-token').trim(),
  };
  return { config, warnings };
}
