import { beforeEach, vi } from 'vitest';

// CI must make no real network calls: any test that forgets to inject a mock fetch fails loudly.
beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('real network access is disabled in tests');
  });
});
