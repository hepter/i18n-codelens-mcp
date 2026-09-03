import fs from 'fs';
import path from 'path';
import { McpServer, inputRequired, acceptedContent, type ServerContext, type CallToolResult, type InputRequiredResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createToolContext, type ToolContext } from './tools/shared';
import { toolProjectInfo } from './tools/project-info';
import { toolGetTranslations } from './tools/get-translations';
import { toolSearchKeys } from './tools/search-keys';
import { toolFileKeys } from './tools/file-keys';
import { toolKeyReferences } from './tools/key-references';
import { toolAudit, AUDIT_CHECKS } from './tools/audit';
import { toolUpsertTranslations } from './tools/upsert-translations';
import { toolDeleteKeys, type DeleteKeysResult } from './tools/delete-keys';
import { toolRenameKey, type RenameKeyResult } from './tools/rename-key';
import { toolFormatResources, type FormatResourcesResult } from './tools/format-resources';

// ─── Package metadata ────────────────────────────────────────────────────────

type PackageJson = { version: string; homepage?: string; description?: string };
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as PackageJson;

export const SERVER_NAME = 'i18n-codelens-mcp';
export const SERVER_VERSION = pkg.version;

export const TOOL_NAMES = [
  'i18n_project_info',
  'i18n_get_translations',
  'i18n_search_keys',
  'i18n_file_keys',
  'i18n_key_references',
  'i18n_audit',
  'i18n_upsert_translations',
  'i18n_delete_keys',
  'i18n_rename_key',
  'i18n_format_resources',
] as const;

/** Sent to the client on connect; Claude Code adds it to the system prompt (2 KB cap). */
export const SERVER_INSTRUCTIONS = [
  'i18n-codelens manages the locale JSON files of this workspace (en.json, tr.json or en/common.json). Never read or edit those files directly: every read and write goes through these tools.',
  'Call i18n_project_info once per session to learn the locales, the key format (plain key or namespace:key) and any warnings.',
  'To add or change copy call i18n_upsert_translations once with a value for EVERY locale. It writes immediately, can never delete a key, and reports a conflict instead of overwriting an existing value unless overwrite:true. Missing locales and placeholder mismatches ({0}, {{name}}) come back as warnings; fix them in a follow-up call.',
  "Read with i18n_get_translations (exact keys, or a namespace ending in '.'), i18n_search_keys (substring in keys or values), i18n_file_keys (keys one source file uses and which locales lack them) and i18n_key_references (where a key is used in code).",
  'i18n_audit checks missing keys, placeholder parity, keys used in code but untranslated, and unused keys. Pass checks to run only what you need.',
  "i18n_delete_keys, i18n_rename_key (a prefix ending in '.' moves a whole namespace) and i18n_format_resources preview by default. Pass dryRun:false to apply, or confirm the dialog when the client shows one.",
  'Use dotted, feature-scoped keys such as component.userCard.title. Responses are compact JSON; use limit, includeValues and maxValueChars to control their size.',
].join('\n');

// ─── Logging ─────────────────────────────────────────────────────────────────

export type Logger = (message: string) => void;

const stderrLogger: Logger = message => {
  try { process.stderr.write(`${message}\n`); } catch { /* ignore */ }
};

// ─── Server factory ──────────────────────────────────────────────────────────

export type I18nServerOptions = {
  /** Explicit workspace root; otherwise CLI arg, WORKSPACE_ROOT, CLAUDE_PROJECT_DIR, cwd. */
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
};

type TextResult = CallToolResult;

const workspaceDirSchema = z.string().optional().describe('Sub-directory of the workspace root to operate on. Usually omitted.');
const localesSchema = z.array(z.string()).optional().describe("Locale tags to include, e.g. ['en','tr']. Default: all.");
const limitSchema = z.number().min(1).max(500).optional().describe('Max items to return (default 50).');
const dryRunSchema = z.boolean().optional();

function textResult(value: unknown): TextResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(error: unknown): TextResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

type ConfirmablePlan = DeleteKeysResult | RenameKeyResult | FormatResourcesResult;

export function createI18nMcpServer(options: I18nServerOptions = {}): McpServer {
  const env = options.env ?? process.env;
  const log = options.logger ?? stderrLogger;

  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: 'i18n CodeLens',
      description: pkg.description,
      websiteUrl: pkg.homepage ?? 'https://github.com/hepter/i18n-codelens-mcp',
    },
    {
      capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
      instructions: SERVER_INSTRUCTIONS,
      cacheHints: {
        'tools/list': { ttlMs: 24 * 60 * 60 * 1000, cacheScope: 'private' },
        'prompts/list': { ttlMs: 24 * 60 * 60 * 1000, cacheScope: 'private' },
      },
    }
  );

  const contextFor = (args: { workspaceDir?: string }): ToolContext =>
    createToolContext({ workspaceRoot: options.workspaceRoot, workspaceDir: args.workspaceDir, env });

  const run = async (name: string, args: { workspaceDir?: string }, fn: (ctx: ToolContext) => Promise<unknown>): Promise<TextResult> => {
    const started = Date.now();
    try {
      const result = await fn(contextFor(args));
      log(`[i18n-codelens MCP] ${name} ok ${Date.now() - started}ms`);
      return textResult(result);
    } catch (error) {
      log(`[i18n-codelens MCP] ${name} error: ${error instanceof Error ? error.message : String(error)}`);
      return errorResult(error);
    }
  };

  const clientSupportsElicitation = (ctx: ServerContext): boolean => {
    if (server.server.getClientCapabilities()?.elicitation) return true;
    const req = ctx.mcpReq as unknown as { envelope?: { clientCapabilities?: { elicitation?: unknown } }; _meta?: Record<string, unknown> };
    if (req.envelope?.clientCapabilities?.elicitation) return true;
    const meta = req._meta?.['io.modelcontextprotocol/clientCapabilities'] as { elicitation?: unknown } | undefined;
    return Boolean(meta?.elicitation);
  };

  /**
   * Destructive tools: explicit dryRun wins; otherwise preview, and when the
   * client can show a dialog ask the user once and apply on accept.
   */
  const runConfirmable = async (
    name: string,
    args: { workspaceDir?: string; dryRun?: boolean },
    ctx: ServerContext,
    plan: (toolCtx: ToolContext, dryRun: boolean) => Promise<ConfirmablePlan>,
    describe: (preview: ConfirmablePlan) => string
  ): Promise<TextResult | InputRequiredResult> => {
    if (typeof args.dryRun === 'boolean') return run(name, args, toolCtx => plan(toolCtx, args.dryRun as boolean));
    const started = Date.now();
    try {
      const toolCtx = contextFor(args);
      const responses = (ctx.mcpReq as unknown as { inputResponses?: unknown }).inputResponses;
      if (responses !== undefined) {
        const answer = acceptedContent<{ apply?: boolean }>(responses as Record<string, unknown>, 'confirm');
        if (answer?.apply) {
          const applied = await plan(toolCtx, false);
          log(`[i18n-codelens MCP] ${name} confirmed+applied ${Date.now() - started}ms`);
          return textResult({ ...applied, confirmed: true });
        }
        const preview = await plan(toolCtx, true);
        log(`[i18n-codelens MCP] ${name} declined`);
        return textResult({ ...preview, declined: true });
      }
      const preview = await plan(toolCtx, true);
      if (!preview.files.length || !clientSupportsElicitation(ctx)) {
        log(`[i18n-codelens MCP] ${name} preview ${Date.now() - started}ms`);
        return textResult(preview.files.length ? { ...preview, hint: 'Pass dryRun:false to apply these changes.' } : preview);
      }
      return inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: describe(preview),
            requestedSchema: {
              type: 'object',
              properties: { apply: { type: 'boolean', title: 'Apply changes', description: 'Write the changes to the locale files now.' } },
              required: ['apply'],
            },
          }),
        },
      });
    } catch (error) {
      log(`[i18n-codelens MCP] ${name} error: ${error instanceof Error ? error.message : String(error)}`);
      return errorResult(error);
    }
  };

  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

  // ─── Read tools ────────────────────────────────────────────────────────────

  server.registerTool(
    'i18n_project_info',
    {
      title: 'Inspect i18n project',
      description: 'Locales, key format (plain or namespace:key), key counts, resolved config and warnings. Call once per session before other tools.',
      inputSchema: z.object({ workspaceDir: workspaceDirSchema }),
      annotations: readOnly,
    },
    async args => run('i18n_project_info', args, ctx => toolProjectInfo({}, ctx))
  );

  server.registerTool(
    'i18n_get_translations',
    {
      title: 'Get translations',
      description: "Values of specific keys in every (or selected) locale; null marks a missing translation. A key ending with '.' returns the whole namespace. Use includeValues:false for presence only.",
      inputSchema: z.object({
        keys: z.array(z.string()).min(1).describe("Exact keys, or namespaces ending with '.' (e.g. 'nav.')."),
        locales: localesSchema,
        includeValues: z.boolean().optional().describe('Default true. False returns the locales holding each key.'),
        maxValueChars: z.number().min(1).max(1000).optional().describe('Truncate values (default 160).'),
        limit: limitSchema,
        workspaceDir: workspaceDirSchema,
      }),
      annotations: readOnly,
      _meta: { 'anthropic/alwaysLoad': true },
    },
    async args => run('i18n_get_translations', args, ctx => toolGetTranslations(args, ctx))
  );

  server.registerTool(
    'i18n_search_keys',
    {
      title: 'Search keys',
      description: 'Find keys by substring of the key or the translated text, optionally under a key prefix. Keys missing from some locales are marked with "in". Add includeValues to see the text.',
      inputSchema: z.object({
        query: z.string().optional().describe('Substring to look for (case-insensitive by default).'),
        keyPrefix: z.string().optional().describe("Only keys starting with this prefix, e.g. 'component.chat.'."),
        searchIn: z.enum(['keys', 'values', 'both']).optional().describe('Default both.'),
        locales: localesSchema,
        caseSensitive: z.boolean().optional(),
        includeValues: z.boolean().optional().describe('Default false.'),
        maxValueChars: z.number().min(1).max(1000).optional(),
        limit: limitSchema,
        workspaceDir: workspaceDirSchema,
      }),
      annotations: readOnly,
    },
    async args => run('i18n_search_keys', args, ctx => toolSearchKeys(args, ctx))
  );

  server.registerTool(
    'i18n_file_keys',
    {
      title: 'Keys used by a file',
      description: 'Translation keys referenced in one source file and the locales that lack each of them. Run after editing a component to verify its copy is complete.',
      inputSchema: z.object({
        filePath: z.string().describe('Workspace-relative or absolute path of a source file.'),
        includeComplete: z.boolean().optional().describe('Default false: only count fully translated keys.'),
        workspaceDir: workspaceDirSchema,
      }),
      annotations: readOnly,
    },
    async args => run('i18n_file_keys', args, ctx => toolFileKeys(args, ctx))
  );

  server.registerTool(
    'i18n_key_references',
    {
      title: 'Find key references',
      description: 'Where keys are used in code, as path:line:column, with exact totals. Useful before renaming or deleting a key.',
      inputSchema: z.object({
        keys: z.array(z.string()).min(1),
        limit: z.number().min(1).max(100).optional().describe('Max locations per key (default 25).'),
        workspaceDir: workspaceDirSchema,
      }),
      annotations: readOnly,
    },
    async args => run('i18n_key_references', args, ctx => toolKeyReferences(args, ctx))
  );

  server.registerTool(
    'i18n_audit',
    {
      title: 'Audit translations',
      description: 'Project-wide health check: keys missing in some locale (vs the base locale), placeholder mismatches, keys used in code but untranslated, and keys never referenced in code. Choose checks to keep the response small.',
      inputSchema: z.object({
        baseLocale: z.string().optional().describe('Reference locale (default: first locale).'),
        locales: localesSchema,
        checks: z.array(z.enum(AUDIT_CHECKS as [string, ...string[]])).optional().describe('Subset of missing, placeholders, code, unused. Default all.'),
        limit: limitSchema,
        includeReferences: z.boolean().optional().describe('Attach code locations to untranslated keys.'),
        workspaceDir: workspaceDirSchema,
      }),
      annotations: readOnly,
    },
    async args => run('i18n_audit', args, ctx => toolAudit(args as Parameters<typeof toolAudit>[0], ctx))
  );

  // ─── Write tools ───────────────────────────────────────────────────────────

  server.registerTool(
    'i18n_upsert_translations',
    {
      title: 'Add or update translations',
      description: 'Create or update keys in one call, with a value per locale. Writes immediately and never deletes keys. An existing value that differs is reported as a conflict unless overwrite:true. Reports missing locales and placeholder mismatches.',
      inputSchema: z.object({
        entries: z.array(z.object({
          key: z.string().describe("Dotted key, e.g. 'component.userCard.title' (or 'ns:key' in namespaced projects)."),
          values: z.record(z.string(), z.string()).describe("Locale -> text, e.g. {\"en\":\"Save\",\"tr\":\"Kaydet\"}. Provide every locale."),
        })).min(1),
        overwrite: z.boolean().optional().describe('Replace values that already differ (default false).'),
        dryRun: dryRunSchema.describe('Preview only (default false).'),
        workspaceDir: workspaceDirSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { 'anthropic/alwaysLoad': true },
    },
    async args => run('i18n_upsert_translations', args, ctx => toolUpsertTranslations(args, ctx))
  );

  server.registerTool(
    'i18n_delete_keys',
    {
      title: 'Delete keys',
      description: 'Remove keys from all or selected locales. Previews by default; pass dryRun:false to delete (or confirm the dialog).',
      inputSchema: z.object({
        keys: z.array(z.string()).min(1),
        locales: localesSchema,
        dryRun: dryRunSchema.describe('Default true (preview). false deletes.'),
        workspaceDir: workspaceDirSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args, ctx) =>
      runConfirmable(
        'i18n_delete_keys',
        args,
        ctx,
        (toolCtx, dryRun) => toolDeleteKeys({ ...args, dryRun }, toolCtx),
        preview => {
          const deleted = (preview as DeleteKeysResult).deleted ?? {};
          const keys = Object.keys(deleted);
          return `Delete ${keys.length} key(s) from ${preview.files.length} file(s): ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', …' : ''}?`;
        }
      )
  );

  server.registerTool(
    'i18n_rename_key',
    {
      title: 'Rename key or move namespace',
      description: "Rename a key across locales, or move a whole namespace when from ends with '.' (e.g. 'nav.' -> 'menu.'). Refuses when a target exists. Previews by default; pass dryRun:false to apply.",
      inputSchema: z.object({
        from: z.string().describe("Key, or namespace prefix ending with '.'."),
        to: z.string(),
        locales: localesSchema,
        dryRun: dryRunSchema.describe('Default true (preview). false applies.'),
        workspaceDir: workspaceDirSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args, ctx) =>
      runConfirmable(
        'i18n_rename_key',
        args,
        ctx,
        (toolCtx, dryRun) => toolRenameKey({ ...args, dryRun }, toolCtx),
        preview => {
          const result = preview as RenameKeyResult;
          const what = result.moved ? `Move ${result.moved} key(s) from '${args.from}' to '${args.to}'` : `Rename '${args.from}' to '${args.to}'`;
          return `${what} in ${result.locales.join(', ')}?`;
        }
      )
  );

  server.registerTool(
    'i18n_format_resources',
    {
      title: 'Format locale files',
      description: 'Normalize JSON formatting and sort keys (top level only for mixed files). Previews by default; pass dryRun:false to rewrite.',
      inputSchema: z.object({
        locales: localesSchema,
        sortKeys: z.boolean().optional().describe('Default true.'),
        dryRun: dryRunSchema.describe('Default true (preview). false rewrites.'),
        workspaceDir: workspaceDirSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args, ctx) =>
      runConfirmable(
        'i18n_format_resources',
        args,
        ctx,
        (toolCtx, dryRun) => toolFormatResources({ ...args, dryRun }, toolCtx),
        preview => `Rewrite ${preview.files.length} locale file(s) (${preview.files.slice(0, 3).join(', ')}${preview.files.length > 3 ? ', …' : ''})?`
      )
  );

  // ─── Prompts (slash commands in Claude Code) ───────────────────────────────

  const promptMessage = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

  server.registerPrompt(
    'audit',
    {
      title: 'Audit translations',
      description: 'Run a full i18n audit and propose fixes.',
      argsSchema: z.object({ baseLocale: z.string().optional().describe('Reference locale, default first.') }),
    },
    async args =>
      promptMessage(
        `Run i18n_audit${args.baseLocale ? ` with baseLocale "${args.baseLocale}"` : ''} using all checks. ` +
        'Summarise the counts, list up to 20 concrete problems grouped by type, then propose the exact i18n_upsert_translations calls that would fix the missing translations. Do not edit locale files directly.'
      )
  );

  server.registerPrompt(
    'add-key',
    {
      title: 'Add a translation key',
      description: 'Add one key with copy for every locale through the MCP tools.',
      argsSchema: z.object({
        key: z.string().describe("Dotted key, e.g. component.userCard.title"),
        text: z.string().optional().describe('Source text in the base language.'),
      }),
    },
    async args =>
      promptMessage(
        `Add the translation key "${args.key}"${args.text ? ` with the source text "${args.text}"` : ''}. ` +
        'If you have not called i18n_project_info in this session, call it first to learn the locales and key format. ' +
        'Write natural copy for every locale, keep placeholders identical across locales, then call i18n_upsert_translations once with all locales. ' +
        'Report the result and fix any warning it returns. Never edit the locale JSON files directly.'
      )
  );

  server.registerPrompt(
    'translate-missing',
    {
      title: 'Translate missing keys',
      description: 'Find keys missing in a locale and fill them in batches.',
      argsSchema: z.object({ locale: z.string().optional().describe('Target locale, default all.') }),
    },
    async args =>
      promptMessage(
        `Call i18n_audit with checks ["missing"]${args.locale ? ` and locales ["${args.locale}"]` : ''}. ` +
        'For each missing key read the existing translations with i18n_get_translations, write the missing copy, and call i18n_upsert_translations in batches of at most 20 keys with a value for every locale that lacks it. ' +
        'Keep placeholders identical, then run the audit again and report what remains.'
      )
  );

  return server;
}
