import type { LinkOccurrence } from './extract.js';
import { waybackUrl } from './snapshot/wayback.js';

export interface Replacement {
  occurrence: LinkOccurrence;
  /** 14-digit snapshot timestamp to point at. */
  timestamp: string;
}

/**
 * Replace exactly the given occurrences in `text` with archived URLs. The original source text of
 * each URL is kept after the Wayback prefix, so HTML entities and markdown escapes survive.
 * Throws if an occurrence no longer matches the file (it must not silently edit anything else).
 */
export function applyReplacements(text: string, replacements: Replacement[]): string {
  const ordered = [...replacements].sort((a, b) => b.occurrence.start - a.occurrence.start);
  let out = text;
  for (const { occurrence: o, timestamp } of ordered) {
    if (out.slice(o.start, o.end) !== o.raw) {
      throw new Error(`${o.file}:${o.line}: source text changed; refusing to rewrite`);
    }
    out = out.slice(0, o.start) + waybackUrl(timestamp, o.raw) + out.slice(o.end);
  }
  return out;
}
