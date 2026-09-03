import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createI18nMcpServer, SERVER_VERSION, TOOL_NAMES } from '../server';
import { clearResourceCache } from '../core/resources';

const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures');
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };

let root: string;

beforeEach(() => {
  clearResourceCache();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-srv-'));
  fs.cpSync(path.join(FIXTURES, 'flat-project'), root, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

type ElicitMode = 'none' | 'accept' | 'decline';

async function connect(mode: ElicitMode = 'none') {
  const server = createI18nMcpServer({ workspaceRoot: root, env: {} });
  const client = new Client({ name: 'test-client', version: '0.0.0' }, mode === 'none' ? {} : { capabilities: { elicitation: { form: {} } } });
  const seen: unknown[] = [];
  if (mode !== 'none') {
    client.setRequestHandler('elicitation/create', async (request: { params: unknown }) => {
      seen.push(request.params);
      return mode === 'accept' ? { action: 'accept', content: { apply: true } } : { action: 'decline' };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean; structuredContent?: unknown };
    const text = result.content[0]?.text ?? '';
    return { result, text, json: result.isError ? undefined : (JSON.parse(text) as Record<string, unknown>) };
  };
  const close = async () => {
    await client.close();
    await server.close();
  };
  return { server, client, call, close, seen };
}

const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) as Record<string, unknown>;

describe('server metadata', () => {
  it('reports the package version, a website and instructions under 2 KB', async () => {
    const { client, close } = await connect();
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(client.getServerVersion()).toMatchObject({ name: 'i18n-codelens-mcp', version: pkg.version, websiteUrl: expect.stringContaining('github.com') });
    const instructions = client.getInstructions() ?? '';
    expect(instructions.length).toBeGreaterThan(200);
    expect(instructions.length).toBeLessThan(2000);
    expect(instructions).toContain('i18n_upsert_translations');
    await close();
  });
});

describe('tools/list', () => {
  it('exposes exactly the 2.0 tool surface with compact definitions', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual(TOOL_NAMES);
    expect(tools).toHaveLength(10);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(20);
      expect(tool.description?.length ?? 0).toBeLessThan(2000);
      expect(tool).not.toHaveProperty('outputSchema');
      expect(tool.annotations).toBeDefined();
    }
    const byName = Object.fromEntries(tools.map(t => [t.name, t]));
    expect(byName.i18n_project_info.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(byName.i18n_delete_keys.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.i18n_upsert_translations.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.i18n_upsert_translations._meta).toMatchObject({ 'anthropic/alwaysLoad': true });
    expect(byName.i18n_get_translations._meta).toMatchObject({ 'anthropic/alwaysLoad': true });
    expect(byName.i18n_audit._meta).toBeUndefined();
    // 1.x shipped 18 tools in 13.5K characters; 2.0 must stay well below that.
    expect(JSON.stringify(tools).length).toBeLessThan(10000);
    await close();
  });
});

describe('prompts', () => {
  it('lists three prompts and renders arguments into them', async () => {
    const { client, close } = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map(p => p.name).sort()).toEqual(['add-key', 'audit', 'translate-missing']);
    const prompt = await client.getPrompt({ name: 'add-key', arguments: { key: 'component.userCard.title', text: 'User card' } });
    const text = (prompt.messages[0].content as { text: string }).text;
    expect(text).toContain('component.userCard.title');
    expect(text).toContain('i18n_upsert_translations');
    await close();
  });
});

describe('tool results', () => {
  it('returns compact single-line JSON and no structuredContent', async () => {
    const { call, close } = await connect();
    const { result, text, json } = await call('i18n_project_info');
    expect(text).not.toContain('\n');
    expect(result.structuredContent).toBeUndefined();
    expect(json).toMatchObject({ keyFormat: 'key', totals: { locales: 2, keys: 11 } });
    await close();
  });

  it('turns thrown errors into isError results with the message', async () => {
    const { call, close } = await connect();
    const { result, text } = await call('i18n_get_translations', { keys: ['greeting'], locales: ['de'] });
    expect(result.isError).toBe(true);
    expect(text).toMatch(/^Error: .*Available locales: en, tr/);
    await close();
  });

  it('rejects invalid arguments before running the tool', async () => {
    const { call, close } = await connect();
    const { result } = await call('i18n_get_translations', { keys: 'greeting' });
    expect(result.isError).toBe(true);
    await close();
  });

  it('refuses a workspaceDir outside the configured root', async () => {
    const { call, close } = await connect();
    const { result, text } = await call('i18n_project_info', { workspaceDir: os.tmpdir() });
    expect(result.isError).toBe(true);
    expect(text).toContain('outside');
    await close();
  });

  it('writes through upsert without any confirmation round trip', async () => {
    const { call, close } = await connect();
    const { json } = await call('i18n_upsert_translations', { entries: [{ key: 'srv.key', values: { en: 'A', tr: 'B' } }] });
    expect(json).toMatchObject({ applied: true, files: ['locales/en.json', 'locales/tr.json'] });
    expect(read('locales/en.json')['srv.key']).toBe('A');
    await close();
  });
});

describe('destructive tools and confirmation', () => {
  it('falls back to a preview with a hint when the client cannot show a dialog', async () => {
    const { call, close } = await connect('none');
    const { json } = await call('i18n_delete_keys', { keys: ['greeting'] });
    expect(json).toMatchObject({ applied: false, dryRun: true, deleted: { greeting: ['en', 'tr'] } });
    expect(String(json!.hint)).toContain('dryRun');
    expect(read('locales/en.json')).toHaveProperty('greeting');
    await close();
  });

  it('asks the user through elicitation and applies on accept', async () => {
    const { call, close, seen } = await connect('accept');
    const { json } = await call('i18n_delete_keys', { keys: ['greeting'] });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).toContain('greeting');
    expect(json).toMatchObject({ applied: true, confirmed: true, files: ['locales/en.json', 'locales/tr.json'] });
    expect(read('locales/en.json')).not.toHaveProperty('greeting');
    await close();
  });

  it('keeps the files when the user declines', async () => {
    const { call, close } = await connect('decline');
    const { json } = await call('i18n_rename_key', { from: 'greeting', to: 'hello' });
    expect(json).toMatchObject({ applied: false, declined: true });
    expect(read('locales/en.json')).toHaveProperty('greeting');
    await close();
  });

  it('never asks when dryRun is given explicitly', async () => {
    const { call, close, seen } = await connect('accept');
    const preview = await call('i18n_format_resources', { dryRun: true });
    expect(preview.json).toMatchObject({ applied: false, dryRun: true });
    const applied = await call('i18n_format_resources', { dryRun: false });
    expect(applied.json).toMatchObject({ applied: true });
    expect(seen).toHaveLength(0);
    await close();
  });
});
