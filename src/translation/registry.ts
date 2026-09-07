// A registry of exactly one provider today, structured so a second one can
// be added later without touching batching/cache/service-worker code -
// they only ever depend on the TranslationProvider interface.
import { googleGtxProvider } from './google-gtx';
import type { TranslationProvider } from './provider';

const PROVIDERS: Record<string, TranslationProvider> = {
  [googleGtxProvider.id]: googleGtxProvider,
};

export function getProvider(id: string): TranslationProvider {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`Unknown translation provider: ${id}`);
  return provider;
}

/** The provider currently in use. Only one exists in v1 (decision #2). */
export function getActiveProvider(): TranslationProvider {
  return googleGtxProvider;
}
