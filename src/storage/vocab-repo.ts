// Vocabulary CRUD, backed by chrome.storage.local (persists to disk,
// survives restarts - see core/types.ts Settings/VocabEntry). Reader/vocab
// pages go through this module rather than touching chrome.storage
// directly.
import type { VocabEntry } from '../core/types';

const KEY = 'vocab';

export async function listVocab(): Promise<VocabEntry[]> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as VocabEntry[] | undefined) ?? [];
}

export interface NewVocabEntryInput {
  term: string;
  translation: string;
  contextText: string;
  contextStart: number;
  contextEnd: number;
  sourceUrl: string;
  sourceTitle: string;
  tags?: string[];
}

export function buildVocabEntry(input: NewVocabEntryInput): VocabEntry {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    tags: input.tags ?? [],
    ...input,
  };
}

export async function addVocabEntry(entry: VocabEntry): Promise<void> {
  const all = await listVocab();
  all.push(entry);
  await chrome.storage.local.set({ [KEY]: all });
}

export async function deleteVocabEntry(id: string): Promise<void> {
  const all = await listVocab();
  await chrome.storage.local.set({ [KEY]: all.filter((e) => e.id !== id) });
}

export async function deleteVocabEntries(ids: string[]): Promise<void> {
  const idSet = new Set(ids);
  const all = await listVocab();
  await chrome.storage.local.set({ [KEY]: all.filter((e) => !idSet.has(e.id)) });
}

export async function clearVocab(): Promise<void> {
  await chrome.storage.local.set({ [KEY]: [] });
}
