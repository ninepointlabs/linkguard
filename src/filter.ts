import { isIP } from 'node:net';

export type IgnoreRule = (url: string) => boolean;

/**
 * Parse the `ignore-urls` input. One entry per line or comma-separated.
 * `/pattern/flags` is a regular expression; anything else is a URL prefix.
 */
export function parseIgnoreRules(input: string): IgnoreRule[] {
  const entries = input
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return entries.map((entry) => {
    const re = /^\/(.+)\/([a-z]*)$/.exec(entry);
    if (re) {
      const regex = new RegExp(re[1]!, re[2]!.replace(/g/g, ''));
      return (url: string) => regex.test(url);
    }
    return (url: string) => url.startsWith(entry);
  });
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

/** True for localhost, .local/.localhost/.internal names and private/loopback/link-local IPs. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host)) return true;
  const kind = isIP(host);
  if (kind === 4) return isPrivateIPv4(host);
  if (kind === 6) return isPrivateIPv6(host);
  return false;
}

/** Normalized key used to dedupe links: fragment removed. Returns null if not a checkable external URL. */
export function externalKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || isPrivateHost(parsed.hostname)) return null;
  parsed.hash = '';
  return parsed.toString();
}
