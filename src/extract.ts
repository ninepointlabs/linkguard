export interface LinkOccurrence {
  /** Decoded absolute URL as it will be requested. */
  url: string;
  /** Exact source text of the URL, so a replacement can preserve encoding. */
  raw: string;
  /** Repo-relative path, forward slashes. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Offset of `raw` in the file (UTF-16 code units). */
  start: number;
  end: number;
}

const HTTP_RE = /^https?:\/\//i;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Replace a range with spaces (newlines kept) so offsets and line numbers stay valid. */
function blank(text: string, start: number, end: number): string {
  return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, ' ') + text.slice(end);
}

function maskHtmlComments(text: string): string {
  let out = text;
  for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) out = blank(out, m.index, m.index + m[0].length);
  return out;
}

/** Blank fenced code blocks, indented code is left alone (too ambiguous in practice). */
function maskMarkdownCode(text: string): string {
  let out = text;
  const lines = text.split('\n');
  let offset = 0;
  let fence: { char: string; len: number; start: number } | null = null;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1]![0] === fence.char && m[1]!.length >= fence.len && line.trim() === m[1]) {
        out = blank(out, fence.start, offset + line.length);
        fence = null;
      }
    } else if (m) {
      fence = { char: m[1]![0]!, len: m[1]!.length, start: offset };
    }
    offset += line.length + 1;
  }
  if (fence) out = blank(out, fence.start, text.length);
  // Inline code spans (same-length backtick runs).
  for (const m of out.matchAll(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g)) out = blank(out, m.index, m.index + m[0].length);
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

type Hit = { raw: string; start: number; url: string };

/** Read a link destination after `](`, allowing balanced parentheses (e.g. Wikipedia URLs). */
function readInlineDestination(text: string, i: number): Hit | null {
  while (text[i] === ' ' || text[i] === '\t') i++;
  if (text[i] === '<') {
    const close = text.indexOf('>', i + 1);
    if (close < 0) return null;
    const raw = text.slice(i + 1, close);
    if (/[\s<]/.test(raw)) return null;
    return { raw, start: i + 1, url: raw };
  }
  const start = i;
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\' && i + 1 < text.length) {
      i++;
      continue;
    }
    if (/\s/.test(c)) break;
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
  }
  if (i === start) return null;
  const raw = text.slice(start, i);
  return { raw, start, url: raw.replace(/\\([()])/g, '$1') };
}

function markdownHits(text: string): Hit[] {
  const hits: Hit[] = [];
  // Inline links and images: [text](dest "title")
  for (const m of text.matchAll(/\]\(/g)) {
    const hit = readInlineDestination(text, m.index + 2);
    if (hit) hits.push(hit);
  }
  // Reference definitions: [id]: dest "title"
  for (const m of text.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<?)(\S+?)(>?)(?=\s|$)/gm)) {
    const lead = m[0].length - (m[1]!.length + m[2]!.length + m[3]!.length);
    hits.push({ raw: m[2]!, start: m.index + lead + m[1]!.length, url: m[2]! });
  }
  // Autolinks: <https://example.com>
  for (const m of text.matchAll(/<(https?:\/\/[^\s<>]+)>/gi)) {
    hits.push({ raw: m[1]!, start: m.index + 1, url: m[1]! });
  }
  return hits;
}

function htmlHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(/<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!raw) continue;
    const valueGroup = m[1] ?? m[2] ?? m[3]!;
    const valueStart = m.index + m[0].length - valueGroup.length - (m[3] === undefined ? 1 : 0);
    const start = valueStart + valueGroup.indexOf(raw);
    hits.push({ raw, start, url: decodeEntities(raw) });
  }
  return hits;
}

export function isMarkdown(file: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(file);
}

/** Extract absolute http(s) link occurrences from a markdown or HTML file, in source order. */
export function extractLinks(file: string, text: string): LinkOccurrence[] {
  const masked = isMarkdown(file) ? maskMarkdownCode(maskHtmlComments(text)) : maskHtmlComments(text);
  const hits = isMarkdown(file) ? [...markdownHits(masked), ...htmlHits(masked)] : htmlHits(masked);
  const starts = lineStarts(text);
  const seen = new Set<number>();
  const out: LinkOccurrence[] = [];
  for (const h of hits.sort((a, b) => a.start - b.start)) {
    if (seen.has(h.start) || !HTTP_RE.test(h.url)) continue;
    seen.add(h.start);
    out.push({
      url: h.url,
      raw: text.slice(h.start, h.start + h.raw.length),
      file,
      line: lineOf(starts, h.start),
      start: h.start,
      end: h.start + h.raw.length,
    });
  }
  return out;
}
