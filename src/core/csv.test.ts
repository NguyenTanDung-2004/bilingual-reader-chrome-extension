import { describe, expect, it } from 'vitest';
import { buildAnkiCsv, vocabEntryToRow } from './csv';
import type { VocabEntry } from './types';

function makeEntry(overrides: Partial<VocabEntry> = {}): VocabEntry {
  return {
    id: 'v1',
    term: 'ubiquitous',
    translation: 'phổ biến khắp nơi',
    contextText: 'Smartphones are now ubiquitous in modern life.',
    contextStart: 20,
    contextEnd: 30,
    sourceUrl: 'https://example.com/articles/tech',
    sourceTitle: 'The Rise of Smartphones',
    createdAt: Date.parse('2026-01-15T00:00:00Z'),
    tags: [],
    ...overrides,
  };
}

describe('buildAnkiCsv header', () => {
  it('starts with a BOM followed by the Anki directive lines', () => {
    const csv = buildAnkiCsv([]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe(
      '#separator:Semicolon\n#html:true\n#columns:Term;Translation;Context;Source;Date;Tags\n'
    );
  });
});

describe('vocabEntryToRow', () => {
  it('wraps the saved term span in <b> within Context', () => {
    const row = vocabEntryToRow(makeEntry());
    const fields = row.split(';');
    expect(fields[2]).toBe('Smartphones are now <b>ubiquitous</b> in modern life.');
  });

  it('includes Source as title + URL and Tags as bilingual-reader + domain', () => {
    const row = vocabEntryToRow(makeEntry());
    const fields = row.split(';');
    expect(fields[3]).toBe('The Rise of Smartphones (https://example.com/articles/tech)');
    expect(fields[5]).toBe('bilingual-reader example.com');
  });

  it('appends any extra tags after bilingual-reader and the domain', () => {
    const row = vocabEntryToRow(makeEntry({ tags: ['idiom'] }));
    const fields = row.split(';');
    expect(fields[5]).toBe('bilingual-reader example.com idiom');
  });

  it('does NOT quote a field containing a comma, since the delimiter is ";"', () => {
    const row = vocabEntryToRow(makeEntry({ translation: 'phổ biến, khắp nơi' }));
    const fields = row.split(';');
    expect(fields[1]).toBe('phổ biến, khắp nơi');
  });

  it('quotes and doubles internal quotes for a field containing a literal double quote', () => {
    const row = vocabEntryToRow(makeEntry({ term: 'say "hello"' }));
    const fields = row.split(';');
    expect(fields[0]).toBe('"say ""hello"""');
  });

  it('quotes a field containing the ";" delimiter itself', () => {
    const row = vocabEntryToRow(makeEntry({ translation: 'a; b' }));
    // The field itself becomes quoted, so a naive split(';') would (correctly)
    // fragment it - assert on the row as a whole instead.
    expect(row).toContain('"a; b"');
  });

  it('quotes a field containing an embedded newline', () => {
    const row = vocabEntryToRow(makeEntry({ translation: 'line one\nline two' }));
    // Splitting the raw row on ';' is unsafe once a field is quoted+multiline,
    // so assert on the full row string instead.
    expect(row).toContain('"line one\nline two"');
  });

  it('escapes HTML special characters in Term/Translation/Source so they are not parsed as markup by Anki', () => {
    const row = vocabEntryToRow(
      makeEntry({ term: '<b>bold</b> & co', translation: 'a < b & c > d' })
    );
    // The escaped entities (&lt; &gt; &amp;) themselves contain literal ';'
    // characters, so - correctly - the whole field must get CSV-quoted
    // since ';' is our delimiter. Assert on the quoted field as a whole.
    expect(row).toContain('"&lt;b&gt;bold&lt;/b&gt; &amp; co"');
    expect(row).toContain('"a &lt; b &amp; c &gt; d"');
  });

  it('falls back to plain escaped context when the term span is invalid', () => {
    const row = vocabEntryToRow(makeEntry({ contextStart: 100, contextEnd: 200 }));
    const fields = row.split(';');
    expect(fields[2]).toBe('Smartphones are now ubiquitous in modern life.');
    expect(fields[2]).not.toContain('<b>');
  });

  it('formats Date as YYYY-MM-DD', () => {
    const row = vocabEntryToRow(makeEntry());
    const fields = row.split(';');
    expect(fields[4]).toBe('2026-01-15');
  });
});

describe('buildAnkiCsv', () => {
  it('joins multiple rows with CRLF and ends with a trailing CRLF', () => {
    const csv = buildAnkiCsv([makeEntry({ id: 'v1' }), makeEntry({ id: 'v2', term: 'second' })]);
    const row1 = vocabEntryToRow(makeEntry({ id: 'v1' }));
    const row2 = vocabEntryToRow(makeEntry({ id: 'v2', term: 'second' }));
    expect(csv).toBe(`﻿#separator:Semicolon\n#html:true\n#columns:Term;Translation;Context;Source;Date;Tags\n${row1}\r\n${row2}\r\n`);
  });

  it('produces just the header with no trailing row for an empty list', () => {
    const csv = buildAnkiCsv([]);
    expect(csv.endsWith('Tags\n')).toBe(true);
  });
});
