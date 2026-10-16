import type { SnapshotProvider } from './provider.js';
import { WaybackProvider, type WaybackOptions } from './wayback.js';

export const PERSISTWISE_UNAVAILABLE = "snapshot-provider 'persistwise' is not available yet. Use 'wayback'.";

/** Build the configured provider. Throws (before any network call) for unknown or unavailable providers. */
export function createProvider(name: string, options: WaybackOptions): SnapshotProvider {
  switch (name) {
    case 'wayback':
      return new WaybackProvider(options);
    case 'persistwise':
      throw new Error(PERSISTWISE_UNAVAILABLE);
    default:
      throw new Error(`unknown snapshot-provider '${name}'. Supported: wayback.`);
  }
}

export * from './provider.js';
export { WaybackProvider, waybackUrl } from './wayback.js';
