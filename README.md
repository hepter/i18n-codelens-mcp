# i18n-codelens-mcp

Model Context Protocol (MCP) server for i18n translation files. It lets AI agents (Claude Code, Cursor, Antigravity, GitHub Copilot, Codex, Gemini CLI and any other MCP client) inspect, audit and **safely** edit locale JSON files without ever loading a 600 KB `en.json` into the model context.

- **Compact by design.** Ten tools, single-line JSON results, no echoed input, `limit`/`includeValues` everywhere. A typical read costs 50-200 tokens.
- **Safe by construction.** No write path can reduce a locale file's key set; mixed flat/nested files are edited in place, never converted; upserts report conflicts instead of overwriting.
- **Current MCP.** Built on the TypeScript SDK v2: protocol revision 2026-07-28 and the 2025 revisions, server instructions, prompts (slash commands), cache hints and elicitation-based confirmation for destructive tools.
- **Any layout.** `locales/en.json`, `locales/en-US.json`, `messages.en.json` and i18next-style `locales/en/common.json` (namespace files, keys as `common:nav.home`).

This package is also the MCP backend of the [i18n CodeLens VS Code extension](https://github.com/hepter/i18n-codelens).

## Requirements

- Node.js 20 or newer
- Locale resources as JSON files
- An MCP client that supports stdio servers

## Install

```bash
npx -y i18n-codelens-mcp
# or
npm install -g i18n-codelens-mcp
```

## Client setup

Every client uses the same stdio command. When the client starts the server from the project directory (or sets `CLAUDE_PROJECT_DIR`, as Claude Code does) no other configuration is needed; otherwise pass the project with `WORKSPACE_ROOT`.

### Claude Code

```bash
# project scope, committed as .mcp.json so every teammate and agent gets it
claude mcp add --scope project --transport stdio i18n-codelens -- npx -y i18n-codelens-mcp
# user scope
claude mcp add --transport stdio i18n-codelens -- npx -y i18n-codelens-mcp
```

Claude Code sets `CLAUDE_PROJECT_DIR` for stdio servers, so the server always finds the right project. Its tool-search feature defers MCP tools; `i18n_upsert_translations` and `i18n_get_translations` are marked `anthropic/alwaysLoad` so the two everyday tools are available without a lookup. The server's prompts appear as `/i18n-codelens:audit`, `/i18n-codelens:add-key` and `/i18n-codelens:translate-missing`.

### Google Antigravity (IDE, CLI and 2.0)

Global `~/.gemini/config/mcp_config.json` (Windows: `%USERPROFILE%\.gemini\config\mcp_config.json`) or per project `.agents/mcp_config.json`. In the IDE: **…** → **MCP Servers** → **Manage MCP Servers** → **View raw config**; in the CLI type `/mcp`.

```json
{
  "mcpServers": {
    "i18n-codelens": {
      "command": "npx",
      "args": ["-y", "i18n-codelens-mcp"],
      "cwd": "/absolute/path/to/project",
      "env": { "WORKSPACE_ROOT": "/absolute/path/to/project" }
    }
  }
}
```

### Cursor, Windsurf, Claude Desktop, Kiro, Cline, Roo Code

Same `mcpServers` shape in the client's config file (`.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, Claude Desktop config, `.kiro/settings/mcp.json`, `cline_mcp_settings.json`, `.roo/mcp.json`):

```json
{
  "mcpServers": {
    "i18n-codelens": {
      "command": "npx",
      "args": ["-y", "i18n-codelens-mcp"],
      "env": { "WORKSPACE_ROOT": "/absolute/path/to/project" }
    }
  }
}
```

### VS Code / GitHub Copilot Chat (`.vscode/mcp.json`)

```json
{
  "servers": {
    "i18n-codelens": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "i18n-codelens-mcp"],
      "env": { "WORKSPACE_ROOT": "${workspaceFolder}" }
    }
  }
}
```

### GitHub Copilot CLI (`~/.copilot/mcp-config.json`, or `.github/mcp.json` in the repo)

```json
{
  "mcpServers": {
    "i18n-codelens": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "i18n-codelens-mcp"],
      "env": { "WORKSPACE_ROOT": "/absolute/path/to/project" },
      "tools": ["*"]
    }
  }
}
```

### Codex CLI, Gemini CLI, OpenCode, Zed

```bash
codex mcp add i18n-codelens -- npx -y i18n-codelens-mcp
gemini mcp add -s user i18n-codelens npx -y i18n-codelens-mcp
```

```json
// opencode.json
{ "mcp": { "i18n-codelens": { "type": "local", "command": ["npx", "-y", "i18n-codelens-mcp"], "environment": { "WORKSPACE_ROOT": "/absolute/path/to/project" } } } }
```

```json
// Zed settings.json / .zed/settings.json
{ "context_servers": { "i18n-codelens": { "source": "custom", "command": "npx", "args": ["-y", "i18n-codelens-mcp"], "env": { "WORKSPACE_ROOT": "/absolute/path/to/project" } } } }
```

### Sharing with a team

| Client | Project-level file |
|---|---|
| Claude Code | `.mcp.json` |
| GitHub Copilot CLI | `.github/mcp.json` or `.mcp.json` |
| Antigravity | `.agents/mcp_config.json` |
| Kiro | `.kiro/settings/mcp.json` |
| Zed | `.zed/settings.json` |
| OpenCode | `opencode.json` |
| Cursor | `.cursor/mcp.json` |
| VS Code / Copilot Chat | `.vscode/mcp.json` |
| Roo Code | `.roo/mcp.json` |

## Workspace root

Resolution order:

1. Per-tool `workspaceDir` argument (must be inside the configured root, see below)
2. CLI `--workspaceRoot <path>` / `--workspace-root <path>`
3. `WORKSPACE_ROOT`
4. `CLAUDE_PROJECT_DIR` (set by Claude Code)
5. Current working directory
6. Server package directory

The `workspaceDir` tool argument can only select a sub-directory of the configured root. A model cannot point the server at another directory on disk unless the server is started with `I18N_ALLOW_ANY_WORKSPACE=1`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `WORKSPACE_ROOT` | cwd | Project root to scan and edit |
| `I18N_GLOB` | `**/locales/**/*.json` | Locale JSON glob |
| `I18N_CODE_GLOB` | `**/*.{ts,tsx,js,jsx}` | Source glob for key scans |
| `I18N_CODE_REGEX` | built-in | Regex with a named group `key`; the default matches `t("key")`, `T('key')`, `i18n.t("key")` and `/** @i18n */ "key"` |
| `I18N_IGNORE` | `node_modules, .git, dist, build, out, coverage, .next, .turbo, .cache` | JSON array or comma/semicolon list of globs; `.gitignore` is honoured as well |
| `I18N_STRUCTURE` | `auto` | Write shape: `auto` (keep), `flat`, `nested` |
| `I18N_INSERT_ORDER` | `nearby` | Where new keys go: `nearby`, `append`, `sort` |
| `I18N_NS_SEPARATOR` | `:` | Separator between namespace and key for `{locale}/{namespace}.json` layouts |
| `I18N_DEFAULT_NS` | unset | Namespace used for keys written without one in a namespaced project |
| `I18N_ALLOW_ANY_WORKSPACE` | unset | Let `workspaceDir` escape the configured root |
| `I18N_MCP_LOG_PORT` | unset | Log relay used by the VS Code extension |

## Tools

| Tool | Writes | Purpose |
|---|---:|---|
| `i18n_project_info` | No | Locales, key format, counts, config, warnings. Call once per session. |
| `i18n_get_translations` | No | Values of keys per locale; `nav.` returns a namespace; `includeValues:false` for presence only |
| `i18n_search_keys` | No | Substring search in keys or values, optional `keyPrefix`; marks keys missing in some locales |
| `i18n_file_keys` | No | Keys one source file uses and the locales lacking each |
| `i18n_key_references` | No | Where keys are used in code (`path:line:col`) |
| `i18n_audit` | No | `missing`, `placeholders`, `code` (used but untranslated), `unused`; pick `checks` |
| `i18n_upsert_translations` | Yes | Create/update keys with a value per locale; writes immediately, never deletes, conflicts unless `overwrite:true` |
| `i18n_delete_keys` | Yes | Remove keys; previews unless `dryRun:false` |
| `i18n_rename_key` | Yes | Rename a key, or move a namespace when `from` ends with `.`; previews unless `dryRun:false` |
| `i18n_format_resources` | Yes | Sort keys and normalize formatting; previews unless `dryRun:false` |

All results are compact single-line JSON. Empty sections are omitted, paths are workspace-relative with forward slashes, and every list honours `limit` (default 50). Errors come back as `isError` text with the fix in the message (for example the list of available locales).

### Confirmation for destructive tools

`i18n_delete_keys`, `i18n_rename_key` and `i18n_format_resources` preview by default. When the model omits `dryRun` and the client supports MCP elicitation (Claude Code does), the server shows the user a one-question dialog describing the change and applies it on accept. Pass `dryRun:false` to apply without a dialog, `dryRun:true` to only preview. `i18n_upsert_translations` needs no confirmation: it cannot remove keys and refuses to overwrite a differing value unless `overwrite:true`.

### Prompts

The server publishes three prompts that clients expose as commands: `audit` (full audit and fix proposals), `add-key <key> [text]` (add one key with copy for every locale) and `translate-missing [locale]` (fill missing translations in batches).

### Instructions

On connect the server sends usage instructions (under 2 KB) that clients such as Claude Code add to the system prompt: never edit locale files directly, call `i18n_project_info` once, upsert with every locale in one call, and so on. Project-specific rules (key naming, tone, placeholder style) still belong in your own `CLAUDE.md` / `AGENTS.md`.

## Namespaced layouts

If locale files live in per-locale directories (`locales/en/common.json`, `locales/tr/auth.json`), the directory is the locale and the file is the namespace. Keys are addressed as `namespace:key` (`common:nav.home`); `i18n_project_info` reports `keyFormat: "namespace:key"` and the namespaces. Set `I18N_NS_SEPARATOR` if your i18n library uses another separator and `I18N_DEFAULT_NS` for keys written without one.

Files whose name is not a locale tag (`config.json`) are skipped with a warning, and when a glob matches the same locale twice (`src/locales/en.json` and `public/locales/en.json`) the first is used and `i18n_project_info` warns you to narrow `I18N_GLOB`.

## Structure and key safety

A locale file is classified by how its leaves are stored: **flat** (`"nav.home": "Home"`), **nested** (objects) or **mixed**. Under `I18N_STRUCTURE=auto` a flat file is written flat, a nested file nested, and a **mixed file is never converted**: every key stays where it is and a new key is written in the file's dominant style. Writes preserve the file's indentation, line endings and trailing newline, so a single-key change is a single-line diff.

Two guards make key loss structurally impossible:

- `unflattenObject` throws on a value/namespace collision (`dashboard.announcement` both a string and a parent) instead of overwriting one side.
- Every write compares the new document against the file on disk and refuses when a key would disappear. Deletes and renames declare their removals; anything else that goes missing aborts the write and names the keys.

The regression suite in `src/__tests__/tools-write.test.ts` and `resource-manager.test.ts` reproduces the incident that motivated this (a 3,000-key mixed file, a leaf that is also a namespace) and asserts zero loss and one-line diffs on every write path.

## Migrating from 1.x

2.0 consolidates 18 tools into 10 and changes two defaults.

| 1.x | 2.0 |
|---|---|
| `i18n_list_locales` | `i18n_project_info` |
| `i18n_check_keys` | `i18n_get_translations` with `includeValues:false` |
| `i18n_get_namespace` | `i18n_get_translations` with `keys:["prefix."]`, or `i18n_search_keys` with `keyPrefix` |
| `i18n_diff_locales` | `i18n_audit` with `checks:["missing"]` |
| `i18n_validate_placeholders` | `i18n_audit` with `checks:["placeholders"]`; upsert also reports mismatches inline |
| `i18n_scan_workspace_missing` | `i18n_audit` with `checks:["code"]` (`includeReferences:true` for locations) |
| `i18n_unused_keys` | `i18n_audit` with `checks:["unused"]` |
| `i18n_untranslated_keys_on_page` | `i18n_file_keys` |
| `i18n_delete_key` (one key) | `i18n_delete_keys` (`keys` array) |
| `i18n_move_namespace` | `i18n_rename_key` with `from` ending in `.` |
| upsert `dryRun` default true | default **false**; existing values are protected by `overwrite` (default false) |
| pretty-printed JSON + `structuredContent` | compact single-line JSON text only |

Other changes: Node 20+; `@modelcontextprotocol/sdk` replaced by `@modelcontextprotocol/server` 2.0 (protocol 2026-07-28 and 2025 revisions, both served); default ignore globs now skip common build output; `workspaceDir` is confined to the configured root; paths are posix; the code regex accepts `ns:key` and matches a call at the start of a file.

Suggested agent instruction block for projects that used the 1.x names:

```
i18n: never edit src/locales/*.json by hand. Call i18n_project_info once, then
i18n_upsert_translations with values for every locale (en and tr) in one call; it
reports conflicts and placeholder mismatches. Use i18n_get_translations to read,
i18n_audit for QA, i18n_rename_key / i18n_delete_keys with dryRun:false to apply.
```

## MCP Registry

`package.json` carries `mcpName: io.github.hepter/i18n-codelens-mcp` and `server.json` describes the package. Publish with:

```bash
npm publish --access public
mcp-publisher login github
mcp-publisher publish
```

## Programmatic API

```ts
import { createI18nMcpServer, loadProject, createResourceManager, toolUpsertTranslations, createToolContext } from 'i18n-codelens-mcp';

const ctx = createToolContext({ workspaceRoot: '/path/to/project' });
const result = await toolUpsertTranslations({ entries: [{ key: 'nav.home', values: { en: 'Home', tr: 'Ana Sayfa' } }] }, ctx);
```

Every tool is exported as a plain async function taking `(args, ctx)`, alongside the building blocks: `loadProject` (cached, namespace-aware), `getCodeIndex` (cached code scan), `createResourceManager` (write states with the key-loss guard), `writeFilePretty`, `flattenObject`, `unflattenObject`, `classifyResourceStructure`.

## Changelog

### 2.0.0

- **SDK v2 / protocol 2026-07-28.** `@modelcontextprotocol/server` with `serveStdio`, zod 4, Node 20+. Both the 2026-07-28 and 2025 revisions are served on stdio. `tools/list` and `prompts/list` carry cache hints.
- **Ten tools instead of eighteen**, compact single-line results, no `structuredContent`, no echoed arguments. Tool definitions shrank from 13.5 K to 9.5 K characters; a 50-hit search dropped from ~12 K to ~1.8 K characters.
- **Upsert semantics.** Writes immediately, validates the whole batch before touching a file (an unknown locale rejects everything), reports conflicts instead of overwriting unless `overwrite:true`, warns about locales without a value and about placeholder mismatches against the values other locales hold.
- **Confirmation dialogs.** Delete, rename and format use MCP elicitation when the client supports it and fall back to a preview with a hint otherwise.
- **Server instructions and prompts** (`audit`, `add-key`, `translate-missing`), server metadata (`websiteUrl`, `description`), version read from `package.json`.
- **Namespaced layouts** (`{locale}/{namespace}.json`, keys as `ns:key`), locale detection from file or directory names, duplicate and non-locale file warnings.
- **Caches.** Parsed locale files and code scans are reused while mtime/size are unchanged; the audit scans code once. `.gitignore` and common build directories are excluded before files are read.
- **Fixes.** Code regex character range (`.-_` accidentally spanned `:`…`^`) and start-of-file matches; posix paths on Windows; `CLAUDE_PROJECT_DIR` respected; `workspaceDir` confined to the root; writes preserve indentation and CRLF; `getWorkspaceRoot` no longer logs on every call.

### 1.1.0

Fixed a data-loss defect: a single upsert could convert a mixed file and drop keys whose name was both a value and a namespace. Mixed files are no longer converted, `unflattenObject`/`setNestedValue` throw on collisions, and every write is guarded against key loss.

## License

MIT © Mustafa Kuru
