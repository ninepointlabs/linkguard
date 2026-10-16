import type { FetchFn } from '../src/checker.js';

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type Handler = (call: Call) => Response | Promise<Response>;

/** Mock fetch that records every call. Throw from the handler to simulate network errors. */
export function mockFetch(handler: Handler): FetchFn & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: string, init: RequestInit = {}) => {
    const call: Call = {
      url: input,
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
    };
    calls.push(call);
    return handler(call);
  }) as FetchFn & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

export function res(status: number, headers: Record<string, string> = {}, body: string | null = null): Response {
  // The Response constructor only accepts 200-599, but real servers send e.g. LinkedIn's 999.
  const ctorStatus = status > 599 ? 200 : status;
  const nullBody = status === 204 || status === 304 || (status >= 300 && status < 400 && !body);
  const r = new Response(nullBody ? null : (body ?? ''), { status: ctorStatus, headers });
  if (ctorStatus !== status) Object.defineProperty(r, 'status', { value: status });
  return r;
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

export function netError(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
}

/** Fake clock: sleep advances time instantly. */
export function fakeClock(start = Date.UTC(2026, 9, 16)) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}
