import { describe, expect, it } from 'vitest';
import { appendLineToFile, formatLine, sanitizeFileName } from './vocab-file';

// Minimal in-memory stand-in for the one FileSystemDirectoryHandle/
// FileSystemFileHandle surface appendLineToFile actually touches
// (getFileHandle -> getFile/createWritable). Real handles are not
// constructible outside a browser + user gesture, so this is the only way
// to exercise the read-then-rewrite logic without a live picker.
class FakeFileHandle {
  content = '';
  getFile(): Promise<{ text(): Promise<string> }> {
    return Promise.resolve({ text: () => Promise.resolve(this.content) });
  }
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }> {
    let buffer = '';
    return Promise.resolve({
      write: (data: string) => {
        buffer = data;
        return Promise.resolve();
      },
      close: () => {
        this.content = buffer;
        return Promise.resolve();
      },
    });
  }
}

class FakeDirHandle {
  files = new Map<string, FakeFileHandle>();
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let handle = this.files.get(name);
    if (!handle) {
      if (!opts?.create) return Promise.reject(new Error('NotFoundError'));
      handle = new FakeFileHandle();
      this.files.set(name, handle);
    }
    return Promise.resolve(handle);
  }
}

function fakeDir(): FakeDirHandle {
  return new FakeDirHandle();
}

describe('sanitizeFileName', () => {
  it('appends .txt to a plain title', () => {
    expect(sanitizeFileName('How to change pointer color')).toBe('How to change pointer color.txt');
  });

  it('strips characters invalid on Windows/macOS/Linux filenames', () => {
    expect(sanitizeFileName('A: B/C\\D*E?F"G<H>I|J')).toBe('A B C D E F G H I J.txt');
  });

  it('collapses repeated whitespace left by stripped characters', () => {
    expect(sanitizeFileName('foo   bar///baz')).toBe('foo bar baz.txt');
  });

  it('falls back to "untitled" for a title with no usable characters', () => {
    expect(sanitizeFileName('///???')).toBe('untitled.txt');
  });

  it('caps the base name well under OS filename limits', () => {
    const long = 'x'.repeat(500);
    const name = sanitizeFileName(long);
    expect(name.length).toBeLessThanOrEqual(154); // 150 chars + ".txt"
  });
});

describe('formatLine', () => {
  it('joins term and translation with a colon and a trailing newline', () => {
    expect(formatLine('hello', 'xin chao')).toBe('hello:xin chao\n');
  });

  it('flattens embedded newlines in either field to spaces', () => {
    expect(formatLine('multi\nline', 'da\r\ndong')).toBe('multi line:da dong\n');
  });

  it('trims surrounding whitespace on both fields', () => {
    expect(formatLine('  hello  ', '  xin chao  ')).toBe('hello:xin chao\n');
  });
});

describe('appendLineToFile', () => {
  it('creates the file and writes the first line', async () => {
    const dir = fakeDir();
    const ok = await appendLineToFile(dir as never, 'Article.txt', 'hello', 'xin chao');
    expect(ok).toBe(true);
    expect(dir.files.get('Article.txt')?.content).toBe('hello:xin chao\n');
  });

  it('appends subsequent entries after existing content instead of overwriting it', async () => {
    const dir = fakeDir();
    await appendLineToFile(dir as never, 'Article.txt', 'one', 'mot');
    await appendLineToFile(dir as never, 'Article.txt', 'two', 'hai');
    expect(dir.files.get('Article.txt')?.content).toBe('one:mot\ntwo:hai\n');
  });

  it('returns false instead of throwing when the underlying handle rejects', async () => {
    const dir = { getFileHandle: () => Promise.reject(new Error('permission revoked')) };
    const ok = await appendLineToFile(dir as never, 'Article.txt', 'hello', 'xin chao');
    expect(ok).toBe(false);
  });
});
