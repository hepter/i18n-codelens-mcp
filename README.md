# i18n-codelens-mcp

Standalone Model Context Protocol (MCP) server for i18n translation files.

It lets MCP clients inspect and safely edit locale JSON files from local projects: list locales, read translations, detect missing keys, upsert translations, rename keys, move namespaces, and validate placeholders.

This package is also the MCP backend used by the [i18n CodeLens VS Code extension](https://github.com/hepter/i18n-codelens).

The tool surface is designed for large locale files: agents can search, audit, and edit by key or namespace without loading entire (~10 MB>) translation files into the model context.

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
| `I18N_STRUCTURE` | `auto` | Write strategy: `auto`, `flat`, or `nested` |
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
  unflattenObject,
  getEffectiveConfigFromEnv,
  createI18nMcpServer,
  startServer,
} from 'i18n-codelens-mcp';
```

## License

MIT © Mustafa Kuru
