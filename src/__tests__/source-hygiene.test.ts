import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..');

/**
 * A stray control character inside a string literal compiles and runs, so
 * nothing fails: it just sits there invisibly, breaks diffs and greps, and
 * reads like a corrupted file to anyone who opens it. Two NUL bytes reached
 * 2.0 that way, used as map-key separators. Ask for them explicitly instead.
 *
 * Both patterns are built from escape sequences on purpose, so this file
 * itself contains only printable ASCII and does not trip its own check.
 */
const CONTROL_CHARS = new RegExp('[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]');
/** BOM, zero-width marks, bidi overrides, non-breaking space, line/paragraph separators. */
const INVISIBLE_CHARS = new RegExp('[\\uFEFF\\u200B-\\u200F\\u2028\\u2029\\u00A0\\u202A-\\u202E\\u2060]');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function findChars(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const relative = path.relative(SRC, file).replace(/\\/g, '/');
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      const match = line.match(pattern);
      if (match) {
        const code = `U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
        hits.push(`src/${relative}:${index + 1} contains ${code}`);
      }
    });
  }
  return hits;
}

describe('source hygiene', () => {
  it('finds source files to check', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(15);
  });

  it('has no literal control characters in any source file', () => {
    expect(findChars(CONTROL_CHARS)).toEqual([]);
  });

  it('has no invisible or bidirectional Unicode in any source file', () => {
    expect(findChars(INVISIBLE_CHARS)).toEqual([]);
  });
});
