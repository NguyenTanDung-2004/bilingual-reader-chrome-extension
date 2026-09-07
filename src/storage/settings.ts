// Settings repo - the only module besides article-repo/vocab-repo/fs-cache
// allowed to touch chrome.storage. Everything else (reader/popup/vocab)
// goes through these functions.
import { DEFAULT_SETTINGS, SCHEMA_VERSION, type Settings } from '../core/types';

const KEY = 'settings';

/** Reconciles a stored Settings blob (possibly from an older schemaVersion) onto the current defaults (R11). */
function migrate(stored: Partial<Settings> & { schemaVersion?: number }): Settings {
  // No migrations needed yet (schemaVersion 1 is the first shipped shape).
  // Future versions add a switch on stored.schemaVersion here, transforming
  // old field shapes before merging onto DEFAULT_SETTINGS.
  return { ...DEFAULT_SETTINGS, ...stored, schemaVersion: SCHEMA_VERSION };
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  const existing = stored[KEY] as Settings | undefined;
  return existing ? migrate(existing) : { ...DEFAULT_SETTINGS };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next: Settings = { ...current, ...patch, schemaVersion: SCHEMA_VERSION };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** Subscribes to settings changes (e.g. options page open in another tab). Returns an unsubscribe function. */
export function onSettingsChanged(callback: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName !== 'local') return;
    const change = changes[KEY];
    if (change?.newValue) callback(change.newValue as Settings);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** R10: refuse translation/reader on privacy-sensitive domains (mail, internal trackers, localhost) by default. */
export function isDomainBlocked(url: string, settings: Pick<Settings, 'blockedDomains'>): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return settings.blockedDomains.some((pattern) => matchesDomainPattern(hostname, pattern));
}

function matchesDomainPattern(hostname: string, pattern: string): boolean {
  if (pattern === hostname) return true;
  if (pattern.startsWith('*.')) return hostname.endsWith(pattern.slice(1));
  return false;
}
