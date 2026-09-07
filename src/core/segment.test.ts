import { describe, expect, it } from 'vitest';
import { splitSentences, splitSentencesWithOffsets } from './segment';

describe('splitSentences', () => {
  it('splits plain sentences on terminal punctuation', () => {
    expect(splitSentences('Hello world. How are you? Fine!')).toEqual([
      'Hello world.',
      'How are you?',
      'Fine!',
    ]);
  });

  it('does not split on a title abbreviation (Mr.)', () => {
    expect(splitSentences('Mr. Smith went to Washington. He arrived on Monday.')).toEqual([
      'Mr. Smith went to Washington.',
      'He arrived on Monday.',
    ]);
  });

  it('does not split on a multi-dot abbreviation (U.S.)', () => {
    expect(splitSentences('The U.S. economy grew last quarter. Analysts were surprised.')).toEqual([
      'The U.S. economy grew last quarter.',
      'Analysts were surprised.',
    ]);
  });

  it('does not split on e.g. mid-sentence', () => {
    expect(
      splitSentences('Bring some fruit, e.g. apples or pears. Do not forget the bread.')
    ).toEqual(['Bring some fruit, e.g. apples or pears.', 'Do not forget the bread.']);
  });

  it('does not split a decimal number', () => {
    expect(splitSentences('The price is 3.50 dollars today. It went up.')).toEqual([
      'The price is 3.50 dollars today.',
      'It went up.',
    ]);
  });

  it('does not split on ellipsis followed by a lowercase continuation', () => {
    expect(splitSentences('She paused... and then continued speaking. That was odd.')).toEqual([
      'She paused... and then continued speaking.',
      'That was odd.',
    ]);
  });

  it('keeps a quoted sentence with internal punctuation together', () => {
    const input = 'He said, "Wait for me." Then he left.';
    expect(splitSentences(input)).toEqual(['He said, "Wait for me."', 'Then he left.']);
  });

  it('merges a spurious split before a lowercase continuation', () => {
    // Simulates a segmenter false-positive: whatever the raw split, a
    // lowercase-starting fragment must not become its own sentence.
    expect(splitSentences('This costs $5 vs. $10 for the other one. Choose wisely.')).toEqual([
      'This costs $5 vs. $10 for the other one.',
      'Choose wisely.',
    ]);
  });

  it('returns an empty array for empty/whitespace input', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   ')).toEqual([]);
  });

  it('handles a single sentence with no terminal punctuation', () => {
    expect(splitSentences('Just a fragment')).toEqual(['Just a fragment']);
  });
});

describe('splitSentencesWithOffsets', () => {
  it('returns offsets that slice back to the exact sentence text', () => {
    const text = 'Hello world. How are you?';
    const sentences = splitSentencesWithOffsets(text);
    for (const s of sentences) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
    }
    expect(sentences.map((s) => s.text)).toEqual(['Hello world.', 'How are you?']);
  });

  it('keeps offsets correct through an abbreviation merge', () => {
    const text = 'Mr. Smith left. He came back.';
    const sentences = splitSentencesWithOffsets(text);
    expect(sentences.map((s) => s.text)).toEqual(['Mr. Smith left.', 'He came back.']);
    for (const s of sentences) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
    }
  });

  it('returns an empty array for empty/whitespace input', () => {
    expect(splitSentencesWithOffsets('')).toEqual([]);
    expect(splitSentencesWithOffsets('   ')).toEqual([]);
  });
});
