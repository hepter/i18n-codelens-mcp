import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadJson, writeFilePretty } from '../core/fs-write';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-fs-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('loadJson', () => {
  it('parses a JSON file inside the root', () => {
    const file = path.join(root, 'en.json');
    fs.writeFileSync(file, '{"a":"1"}');
    expect(loadJson(file, root)).toEqual({ a: '1' });
  });

  it('throws on invalid JSON and names the file', () => {
    const file = path.join(root, 'en.json');
    fs.writeFileSync(file, '{oops');
    expect(() => loadJson(file, root)).toThrow(/en\.json/);
  });

  it('refuses a path outside the root', () => {
    expect(() => loadJson(path.join(os.tmpdir(), 'elsewhere.json'), root)).toThrow(/outside workspace root/);
  });
});

describe('writeFilePretty', () => {
  it('writes 2-space JSON with a trailing newline and creates parent directories', () => {
    const file = path.join(root, 'deep', 'locales', 'en.json');
    writeFilePretty(file, { a: '1' }, root);
    expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "a": "1"\n}\n');
  });

  it('leaves no temp file behind', () => {
    const file = path.join(root, 'en.json');
    writeFilePretty(file, { a: '1' }, root);
    expect(fs.readdirSync(root)).toEqual(['en.json']);
  });

  it('refuses a write that would drop an existing key and leaves the file untouched', () => {
    const file = path.join(root, 'en.json');
    fs.writeFileSync(file, JSON.stringify({ a: '1', b: '2' }));
    expect(() => writeFilePretty(file, { a: '1' }, root)).toThrow(/missing 1 existing key/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: '1', b: '2' });
  });

  it('allows a removal the caller declared', () => {
    const file = path.join(root, 'en.json');
    fs.writeFileSync(file, JSON.stringify({ a: '1', b: '2' }));
    writeFilePretty(file, { a: '1' }, root, { allowRemovedKeys: ['b'] });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: '1' });
  });

  it('allows anything when the guard is switched off', () => {
    const file = path.join(root, 'en.json');
    fs.writeFileSync(file, JSON.stringify({ a: '1', b: '2' }));
    writeFilePretty(file, {}, root, { allowKeyLoss: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
  });

  it('compares nested and flat documents by their flattened keys', () => {
    const file = path.join(root, 'en.json');
    fs.writeFileSync(file, JSON.stringify({ nav: { home: 'Home' } }));
    writeFilePretty(file, { 'nav.home': 'Home', extra: 'x' }, root);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ 'nav.home': 'Home', extra: 'x' });
  });

  it('refuses a path outside the root', () => {
    expect(() => writeFilePretty(path.join(os.tmpdir(), 'elsewhere.json'), {}, root)).toThrow(/outside workspace root/);
  });

  it('keeps CRLF line endings when the file already uses them', () => {
    const file = path.join(root, 'en.json');
    fs.writeFileSync(file, '{\r\n  "a": "1"\r\n}\r\n');
    writeFilePretty(file, { a: '1', b: '2' }, root);
    expect(fs.readFileSync(file, 'utf8')).toBe('{\r\n  "a": "1",\r\n  "b": "2"\r\n}\r\n');
  });

  it('keeps the existing indentation width and tabs', () => {
    const spaces = path.join(root, 'four.json');
    fs.writeFileSync(spaces, '{\n    "a": "1"\n}\n');
    writeFilePretty(spaces, { a: '1', b: '2' }, root);
    expect(fs.readFileSync(spaces, 'utf8')).toBe('{\n    "a": "1",\n    "b": "2"\n}\n');

    const tabs = path.join(root, 'tabs.json');
    fs.writeFileSync(tabs, '{\n\t"a": "1"\n}\n');
    writeFilePretty(tabs, { a: '1', b: '2' }, root);
    expect(fs.readFileSync(tabs, 'utf8')).toBe('{\n\t"a": "1",\n\t"b": "2"\n}\n');
  });

  it('keeps a file without a trailing newline that way', () => {
    const file = path.join(root, 'nonl.json');
    fs.writeFileSync(file, '{\n  "a": "1"\n}');
    writeFilePretty(file, { a: '1', b: '2' }, root);
    expect(fs.readFileSync(file, 'utf8')).toBe('{\n  "a": "1",\n  "b": "2"\n}');
  });
});
