# i18n-codelens-mcp

Standalone Model Context Protocol (MCP) server for i18n translation files.

It lets MCP clients inspect and safely edit locale JSON files from local projects: list locales, read translations, detect missing keys, upsert translations, rename keys, move namespaces, and validate placeholders.

This package is also the MCP backend used by the [i18n CodeLens VS Code extension](https://github.com/hepter/i18n-codelens).

The tool surface is designed for large locale files: agents can search, audit, and edit by key or namespace without loading entire (~10 MB>) translation files into the model context.

"Safely" is a guarantee, not a hope: no write path can reduce a locale file's key set. See [Structure and key safety](#structure-and-key-safety).

## Requirements

- Node.js 18 or newer
- Locale resources as JSON files
- An MCP client that supports stdio servers

## Install

Run directly with npx:

```bash
npx -y i18n-codelens-mcp
```

Or install globally:

```bash
npm install -g i18n-codelens-mcp
i18n-codelens-mcp
```

## Client Setup

### Claude Code CLI

```bash
claude mcp add --transport stdio i18n-codelens -- npx -y i18n-codelens-mcp
```

With an explicit workspace root:

```bash
claude mcp add --transport stdio i18n-codelens -- npx -y i18n-codelens-mcp --workspaceRoot /absolute/path/to/project
```

### Gemini CLI

```bash
gemini mcp add -s user i18n-codelens npx -y i18n-codelens-mcp
```

With an explicit workspace root:

```bash
gemini mcp add -s user i18n-codelens npx -y i18n-codelens-mcp --workspaceRoot /absolute/path/to/project
```

### OpenAI Codex CLI

```bash
codex mcp add i18n-codelens -- npx -y i18n-codelens-mcp
```

Or manually in `~/.codex/config.toml`:

```toml
[mcp_servers.i18n-codelens]
command = "npx"
args = ["-y", "i18n-codelens-mcp", "--workspaceRoot", "/absolute/path/to/project"]
```

### VS Code MCP

For the i18n CodeLens extension, no manual setup is needed. The extension registers this server automatically for VS Code MCP-aware clients such as GitHub Copilot Chat.

Manual `.vscode/mcp.json` example:

```json
{
  "servers": {
    "i18n-codelens": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "i18n-codelens-mcp"],
      "env": {
        "WORKSPACE_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

### Claude Desktop

Add this server to your Claude Desktop config:

```json
{
  "mcpServers": {
    "i18n-codelens": {
      "command": "npx",
      "args": ["-y", "i18n-codelens-mcp"],
      "env": {
        "WORKSPACE_ROOT": "/absolute/path/to/project"
      }
    }
  }
}
```

### Cursor and Windsurf

Use the same stdio server shape in the client's MCP config:

```json
{
  "mcpServers": {
    "i18n-codelens": {
      "command": "npx",
      "args": ["-y", "i18n-codelens-mcp", "--workspaceRoot", "/absolute/path/to/project"]
    }
  }
}
```

## Workspace Root

The server must know which project to scan and edit. Resolution order:

1. Per-tool `workspaceDir` argument
2. CLI arg `--workspaceRoot <path>` or `--workspace-root <path>`
3. `WORKSPACE_ROOT` environment variable
4. Current working directory
5. Server package directory fallback

Examples:

```bash
WORKSPACE_ROOT=/absolute/path/to/project npx -y i18n-codelens-mcp
npx -y i18n-codelens-mcp --workspaceRoot /absolute/path/to/project
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `WORKSPACE_ROOT` | `process.cwd()` | Project root to scan and edit |
| `I18N_GLOB` | `**/locales/**/*.json` | Locale JSON file glob |
| `I18N_CODE_GLOB` | `**/*.{ts,tsx,js,jsx}` | Source file glob for key scans |
| `I18N_CODE_REGEX` | Built-in `t("key")` / `T("key")` / `/** @i18n */ "key"` regex | Regex with optional named group `key` |
| `I18N_IGNORE` | `**/node_modules/**` | JSON array, comma-separated, or semicolon-separated glob ignores |
| `I18N_STRUCTURE` | `auto` | Write strategy: `auto`, `flat`, or `nested`. See [Structure and key safety](#structure-and-key-safety) |
| `I18N_INSERT_ORDER` | `nearby` | New key order: `nearby`, `append`, or `sort` |
| `I18N_MCP_LOG_PORT` | unset | Internal log relay used by the VS Code extension |

## Tools

| Tool | Writes files | Description |
|---|---:|---|
| `i18n_project_info` | No | Return resolved workspace/configuration metadata and compact locale/key counts |
| `i18n_list_locales` | No | List detected locale files with normalized locale tags |
| `i18n_check_keys` | No | Check key presence across locales; keys ending in `.` are namespace prefix checks |
| `i18n_get_translations` | No | Read translations for keys and optional locale filters |
| `i18n_search_keys` | No | Search by key prefix/text or value text with limited preview output |
| `i18n_get_namespace` | No | Return a compact, limited view of keys under a namespace prefix |
| `i18n_diff_locales` | No | Compare base locale against other locales for missing, extra, and placeholder differences; supports `limit` |
| `i18n_scan_workspace_missing` | No | Scan code for keys missing from at least one locale; supports `limit` and optional references |
| `i18n_key_references` | No | Return source references for given keys |
| `i18n_validate_placeholders` | No | Check `{{name}}` and `{name}` placeholder parity; reports missing translations separately |
| `i18n_unused_keys` | No | Find locale keys that are not referenced in source code |
| `i18n_audit` | No | Compact audit summary for missing translations, placeholder mismatches, code-missing keys, and unused keys |
| `i18n_upsert_translations` | Yes | Create or update translations; defaults to dry-run |
| `i18n_delete_key` | Yes | Delete a key from all or selected locales; defaults to dry-run |
| `i18n_rename_key` | Yes | Rename a key with collision checks; defaults to dry-run |
| `i18n_move_namespace` | Yes | Move a namespace prefix with collision checks; defaults to dry-run |
| `i18n_format_resources` | Yes | Preview or apply normalized JSON formatting and optional sorted keys; defaults to dry-run |
| `i18n_untranslated_keys_on_page` | No | Check one source file for keys missing from any locale |

Write tools are workspace-bound: paths outside the resolved workspace root and symlink traversal are rejected. Write tools preview by default; pass `dryRun: false` only when the returned plan is acceptable.

All tools return structured MCP output plus a JSON text copy for clients that only display text content.

## Structure and key safety

A locale file is classified by how its leaves are actually stored:

- **flat** - dotted keys only, for example `"nav.home": "Home"`.
- **nested** - objects only.
- **mixed** - both in the same file, which is common in files that were migrated halfway.

`I18N_STRUCTURE=auto` writes a flat file flat and a nested file nested. A **mixed file is
never converted**: every key stays where it already is, and a new key is written in the style
that holds most of the file's leaves. Forcing `flat` or `nested` still converts the whole
document, and `nested` is refused outright when a key is used both as a value and as a
namespace, because JSON cannot hold `dashboard.announcement` as a string and as the parent of
`dashboard.announcement.campaignStatus` at the same time.

Two guards make key loss structurally impossible rather than merely unlikely:

- `unflattenObject` throws on a value/namespace collision instead of overwriting one side.
- Every write compares the new document against the file on disk and refuses to write when a
  key would disappear. Deletes, renames and namespace moves declare their removals; anything
  else that goes missing aborts the write and reports the keys by name.

### Why the write guard stays

The guard looks redundant once mixed files are no longer converted, so here is the measurement
that says otherwise. With the guard in place and the old `auto` rule restored on purpose, the
regression suite in `src/__tests__/mixedStructureKeyLoss.test.ts` failed nine tests and lost
**zero** keys: every tool refused to write and named the 82 value/namespace pairs it had found.
Without the guard, the same rule silently deleted 25 of 3,084 keys and rewrote the whole file.

The guard is what turns a bug anywhere in the write path into an error message instead of a
data loss. Removing it because the current structure logic looks correct would remove the only
part of this that does not depend on the structure logic being correct.

## MCP Implementation Notes

- Uses stdio transport for local CLI and editor clients.
- Uses the official TypeScript MCP SDK v1 production API: `McpServer`, `StdioServerTransport`, and `registerTool`.
- Registers a deterministic static tool list.
- Adds MCP tool annotations for read-only, destructive, idempotent, and local-world behavior.
- Logs to stderr so stdout remains reserved for MCP protocol messages.

## Programmatic API

```ts
import {
  readResourceFiles,
  getWorkspaceRoot,
  flattenObject,
  flattenObjectPaths,
  unflattenObject,
  classifyResourceStructure,
  findKeyCollisions,
  reorderTopLevel,
  writeFilePretty,
  getEffectiveConfigFromEnv,
  createI18nMcpServer,
  startServer,
} from 'i18n-codelens-mcp';
```

`unflattenObject` throws on a value/namespace collision, and `writeFilePretty` refuses a write
that would drop an existing key unless the caller passes `allowRemovedKeys` or `allowKeyLoss`.
Both were silent before 1.1.0, which is how the data loss happened.

## Changelog

### 1.1.0

Fixes a data-loss defect. Asked to add one key to a locale file, the server could rewrite the
whole document, convert it from flat dotted keys to nested objects, and drop keys without a
word. Measured on a real file, one upsert rewrote it by +7,314 / -6,141 and lost 397 keys.

- A **mixed** file, meaning flat dotted keys plus at least one nested island, is no longer
  converted. Every key stays where it is and a new key is written in the file's dominant style.
  Previously a single island made the whole document "nested" and everything was converted to
  match.
- `unflattenObject` and `setNestedValue` **throw** on a value/namespace collision instead of
  overwriting one side of it. A name that is both a value and a parent cannot exist in nested
  JSON, so one of the two used to be destroyed, whichever was written last.
- Every write now compares the new document against the file on disk and **aborts** when a key
  would disappear. Deletes, renames and namespace moves declare their removals.
- New exports: `classifyResourceStructure`, `flattenObjectPaths`, `findKeyCollisions`,
  `reorderTopLevel`, and the `WriteGuardOptions` type. `ResourceFile` gained a `structure`
  field, and `i18n_project_info` and `i18n_list_locales` report it.

Behaviour that previously destroyed data now raises an error, so a caller that relied on
`unflattenObject` or `writeFilePretty` accepting a lossy input has to declare its intent. The
MCP tool surface itself is unchanged.

**Why this is a minor release and not 1.0.1 or 2.0.0.** A patch is too narrow: there are new
exports and `ResourceFile` gained a field. A strict semver reading argues for major, because
`unflattenObject`, `setNestedValue` and `writeFilePretty` now throw on inputs they used to
accept. It is filed as minor anyway, because the only calls that break are the ones that
destroy translations, and the MCP tool surface, which is what this package actually is, did not
change at all. A consumer of the programmatic API who treats it as a supported contract should
read this entry as breaking.

## License

MIT © Mustafa Kuru
