// Per-article plain-text vocab file - a companion to vocab-repo.ts's
// chrome.storage list (kept for the Vocab page + CSV/Anki export), for
// users who want a plain "english:nghia" file they can open directly.
//
// The folder is picked fresh for each article, via a real button click on
// reader.html itself (a "Chon thu muc" banner - see reader.ts). This
// deliberately does NOT happen in popup.ts's toolbar-icon popup: extension
// action popups auto-dismiss the instant a native OS picker steals focus,
// which kills the popup's JS mid-await before the handle can ever be used -
// reader.html is a normal tab, so it doesn't have that problem.

/** Filesystem-safe file name derived from the article title: strips characters invalid on Windows/macOS/Linux, collapses whitespace, and caps length well under every OS's filename limit. */
export function sanitizeFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned.length > 0 ? cleaned.slice(0, 150) : 'untitled';
  return `${base}.txt`;
}

/** One line per saved entry, "<english>:<vietnamese>". Newlines inside either field are flattened to spaces so they can never be mistaken for a new entry. */
export function formatLine(term: string, translation: string): string {
  const flatten = (s: string): string => s.replace(/\r?\n/g, ' ').trim();
  return `${flatten(term)}:${flatten(translation)}\n`;
}

export interface VocabFileWriter {
  /** Appends one "english:nghia" line to this article's file. Returns false (never throws) when no folder was configured or the write failed - callers should treat that as "the chrome.storage save is what counts", not a hard error. */
  append(term: string, translation: string): Promise<boolean>;
}

const NOOP_WRITER: VocabFileWriter = { append: async () => false };

/**
 * Appends one formatted line to `fileName` inside `dir`, creating the file
 * if needed. Read-then-full-rewrite rather than a seek-to-end write: these
 * are small personal text files, and this sidesteps createWritable's
 * truncate-by-default behavior entirely. Exported standalone so it can be
 * unit-tested against a fake directory handle without a real File System
 * Access API.
 */
export async function appendLineToFile(
  dir: FileSystemDirectoryHandle,
  fileName: string,
  term: string,
  translation: string
): Promise<boolean> {
  try {
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const existing = await (await fileHandle.getFile()).text();
    const writable = await fileHandle.createWritable();
    await writable.write(existing + formatLine(term, translation));
    await writable.close();
    return true;
  } catch {
    return false; // permission revoked mid-session, quota, etc. - never block the chrome.storage save
  }
}

/**
 * Must run inside a real user gesture (reader.ts's "Chon thu muc" banner
 * button click). Opens the native folder picker and returns a writer bound
 * to `<articleTitle>.txt` inside whatever the user picked, or a no-op
 * writer if they cancel or the API is unsupported in this Chrome version -
 * callers never have to branch on "was a folder configured".
 */
export async function pickVocabFileWriter(articleTitle: string): Promise<VocabFileWriter> {
  try {
    const picker = window.showDirectoryPicker;
    if (!picker) return NOOP_WRITER;
    const dir = await picker({ id: 'bilingual-reader-vocab', mode: 'readwrite' });
    const fileName = sanitizeFileName(articleTitle);
    return { append: (term, translation) => appendLineToFile(dir, fileName, term, translation) };
  } catch {
    return NOOP_WRITER; // user cancelled the picker
  }
}
