import type { LinkStatus } from './checker.js';
import type { Snapshot } from './snapshot/provider.js';

export interface LinkReport {
  url: string;
  status: LinkStatus;
  httpStatus?: number;
  finalUrl?: string;
  detail: string;
  locations: Array<{ file: string; line: number }>;
  snapshot: Snapshot | null;
  /** How the snapshot was obtained or why there is none. */
  snapshotNote: string;
  action: string;
}

export interface RunReport {
  version: string;
  generatedAt: string;
  siteType: string;
  mode: 'lookup-only' | 'snapshot';
  filesScanned: number;
  checkedCount: number;
  skippedCount: number;
  deadCount: number;
  notes: string[];
  pullRequest: string | null;
  links: LinkReport[];
}

function cell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

const ORDER: Record<LinkStatus, number> = { dead: 0, moved: 1, blocked: 2, ok: 3 };

export function renderMarkdown(r: RunReport): string {
  const counts = (s: LinkStatus) => r.links.filter((l) => l.status === s).length;
  const lines = [
    '## Linkguard report',
    '',
    `Mode: **${r.mode}** · site type: ${r.siteType} · files scanned: ${r.filesScanned}`,
    '',
    `Checked **${r.checkedCount}** unique links: ${counts('ok')} ok, ${counts('moved')} moved, ${counts('dead')} dead, ${counts('blocked')} blocked. Skipped: ${r.skippedCount}.`,
    '',
  ];
  for (const note of r.notes) lines.push(`> ${note}`, '');
  if (r.pullRequest) lines.push(`Pull request with archived replacements: ${r.pullRequest}`, '');
  if (r.links.length) {
    lines.push('| URL | Status | Files:lines | Archived URL | Action |', '| --- | --- | --- | --- | --- |');
    const sorted = [...r.links].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
    for (const l of sorted) {
      const where = l.locations.map((x) => `${x.file}:${x.line}`).join(', ');
      const status = `${l.status} (${l.detail})`;
      lines.push(
        `| ${cell(l.url)} | ${cell(status)} | ${cell(where)} | ${cell(l.snapshot?.url ?? l.snapshotNote)} | ${cell(l.action)} |`,
      );
    }
    lines.push('');
  }
  lines.push('Archived URLs point to copies held by the Internet Archive, not to the original pages.', '');
  return lines.join('\n');
}
