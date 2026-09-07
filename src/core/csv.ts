// Anki-importable CSV export (R9). Format is fixed by the spec: UTF-8 with
// BOM, ';'-delimited, a 3-line Anki directive header, and RFC4180-style
// quoting (adapted to ';' as the delimiter instead of ',') so commas in
// free text need no escaping but ';', '"', and newlines do.
import type { VocabEntry } from './types';

const BOM = '﻿';
const HEADER = '#separator:Semicolon\n#html:true\n#columns:Term;Translation;Context;Source;Date;Tags\n';
const CRLF = '\r\n';

/** RFC4180 field quoting, with ';' (our delimiter) added to the trigger set alongside '"' and newlines. */
function csvEscape(field: string): string {
  if (/[";\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/** Anki fields are interpreted as HTML (#html:true) - escape so literal '<'/'&' in user text isn't parsed as markup. */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Rebuilds the Context field, wrapping the saved term's span in a real (unescaped) <b> for Anki to render. */
function buildContextHtml(entry: VocabEntry): string {
  const { contextText, contextStart, contextEnd } = entry;
  const validSpan =
    Number.isInteger(contextStart) &&
    Number.isInteger(contextEnd) &&
    contextStart >= 0 &&
    contextEnd <= contextText.length &&
    contextStart < contextEnd;
  if (!validSpan) return escapeHtml(contextText);
  const before = escapeHtml(contextText.slice(0, contextStart));
  const term = escapeHtml(contextText.slice(contextStart, contextEnd));
  const after = escapeHtml(contextText.slice(contextEnd));
  return `${before}<b>${term}</b>${after}`;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Builds one ';'-delimited, escaped CSV row (no trailing newline) for a single vocab entry. */
export function vocabEntryToRow(entry: VocabEntry): string {
  const context = buildContextHtml(entry);
  const source = escapeHtml(`${entry.sourceTitle} (${entry.sourceUrl})`);
  const domain = domainOf(entry.sourceUrl);
  const tags = Array.from(new Set(['bilingual-reader', domain, ...entry.tags].filter(Boolean)))
    .map(escapeHtml)
    .join(' ');
  const fields = [
    escapeHtml(entry.term),
    escapeHtml(entry.translation),
    context,
    source,
    formatDate(entry.createdAt),
    tags,
  ];
  return fields.map(csvEscape).join(';');
}

/** Builds the full CSV file content (BOM + Anki directive header + rows), ready to hand to a file download. */
export function buildAnkiCsv(entries: VocabEntry[]): string {
  const rows = entries.map(vocabEntryToRow);
  const body = rows.length > 0 ? rows.join(CRLF) + CRLF : '';
  return BOM + HEADER + body;
}
