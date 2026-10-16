import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractLinks } from '../src/extract.js';
import { externalKey, isPrivateHost, parseIgnoreRules } from '../src/filter.js';

const fixture = (p: string) => readFileSync(new URL(`./fixtures/${p}`, import.meta.url), 'utf8');

describe('extractLinks (markdown)', () => {
  const file = '_posts/2026-01-01-hello.md';
  const links = extractLinks(file, fixture(`jekyll/${file}`));
  const urls = links.map((l) => l.url);

  it('finds inline, reference-style and absolute links with line numbers', () => {
    expect(links.map((l) => [l.url, l.line])).toEqual([
      ['https://ok.example.com/page', 4],
      ['https://dead.example.com/gone', 4],
      ['https://www.linkedin.com/in/someone', 6],
      ['https://blocked.example.com/members', 6],
      ['https://moved.example.com/old', 8],
      ['http://localhost:4000/', 10],
      ['http://192.168.1.10/admin', 10],
      ['https://dead.example.com/gone', 18],
    ]);
  });

  it('skips mailto, relative links and code', () => {
    expect(urls.some((u) => u.includes('code.example.com') || u.includes('inline-code'))).toBe(false);
    expect(urls.some((u) => u.startsWith('mailto:') || u.startsWith('/'))).toBe(false);
  });

  it('records exact source offsets', () => {
    const text = fixture(`jekyll/${file}`);
    for (const l of links) expect(text.slice(l.start, l.end)).toBe(l.raw);
  });

  it('handles autolinks, angle destinations, titles and balanced parentheses', () => {
    const md = [
      'See <https://auto.example.com/x>.',
      '[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) and [t](<https://angle.example.com/a>) ',
      '![img](https://img.example.com/i.png "title")',
      '  [id]: <https://refangle.example.com/>',
    ].join('\n');
    expect(extractLinks('x.md', md).map((l) => l.url)).toEqual([
      'https://auto.example.com/x',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      'https://angle.example.com/a',
      'https://img.example.com/i.png',
      'https://refangle.example.com/',
    ]);
  });

  it('also reads raw HTML anchors inside markdown', () => {
    expect(extractLinks('x.md', 'Hi <a href="https://html.example.com/">x</a>').map((l) => l.url)).toEqual([
      'https://html.example.com/',
    ]);
  });
});

describe('extractLinks (HTML)', () => {
  const text = fixture('jekyll/_pages/links.html');
  const links = extractLinks('_pages/links.html', text);

  it('reads <a href> with either quote style, decodes entities, ignores comments', () => {
    expect(links.map((l) => [l.url, l.raw, l.line])).toEqual([
      ['https://ok.example.com/page?a=1&b=2', 'https://ok.example.com/page?a=1&amp;b=2', 2],
      ['https://dead.example.com/other', 'https://dead.example.com/other', 3],
    ]);
    for (const l of links) expect(text.slice(l.start, l.end)).toBe(l.raw);
  });
});

describe('filters', () => {
  it('rejects private and local hosts', () => {
    for (const h of ['localhost', 'app.localhost', 'printer.local', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.1', '169.254.1.1', '[::1]', 'fd00::1', 'fe80::1']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '2001:4860::8888']) expect(isPrivateHost(h), h).toBe(false);
  });

  it('dedupes on URL without fragment and drops non-http', () => {
    expect(externalKey('https://Example.com/a#b')).toBe('https://example.com/a');
    expect(externalKey('ftp://example.com/')).toBeNull();
    expect(externalKey('http://localhost:4000/')).toBeNull();
    expect(externalKey('not a url')).toBeNull();
  });

  it('supports prefix and /regex/ ignore rules', () => {
    const rules = parseIgnoreRules('https://skip.example.com/\n/twitter\\.com|x\\.com/i, https://other.example.com');
    const ignored = (u: string) => rules.some((r) => r(u));
    expect(ignored('https://skip.example.com/a')).toBe(true);
    expect(ignored('https://TWITTER.com/user')).toBe(true);
    expect(ignored('https://other.example.com/x')).toBe(true);
    expect(ignored('https://keep.example.com/')).toBe(false);
  });
});
