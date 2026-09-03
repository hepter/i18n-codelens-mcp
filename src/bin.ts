#!/usr/bin/env node
import net from 'net';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { getEffectiveConfigFromEnv } from './config';
import { getWorkspaceRoot, toPosixPath } from './core/workspace';
import { createI18nMcpServer, SERVER_VERSION, type Logger } from './server';

const PREFIX = '[i18n-codelens MCP]';

function safeStderr(message: string): void {
  try { process.stderr.write(`${message}\n`); } catch { /* ignore */ }
}

/**
 * stderr always; optionally mirrored to a local TCP port so the i18n CodeLens
 * VS Code extension can show server logs in its output channel.
 */
function createLogger(): Logger {
  const portRaw = process.env.I18N_MCP_LOG_PORT;
  const port = portRaw ? parseInt(portRaw, 10) : NaN;
  if (!portRaw || Number.isNaN(port)) return safeStderr;

  const queue: string[] = [];
  let socket: net.Socket | undefined;
  let tries = 0;
  const connect = () => {
    try {
      const candidate = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket = candidate;
        while (queue.length) {
          const line = queue.shift();
          if (line) try { candidate.write(`${line}\n`); } catch { /* ignore */ }
        }
      });
      candidate.on('error', () => { socket = undefined; if (tries < 5) { tries++; setTimeout(connect, 300 * tries); } });
      candidate.on('close', () => { socket = undefined; });
    } catch {
      if (tries < 5) { tries++; setTimeout(connect, 300 * tries); }
    }
  };
  connect();
  return message => {
    safeStderr(message);
    if (socket && socket.writable) try { socket.write(`${message}\n`); } catch { /* ignore */ }
    else queue.push(message);
  };
}

export function main(): void {
  const log = createLogger();
  try {
    const root = getWorkspaceRoot();
    const config = getEffectiveConfigFromEnv(process.env);
    log(`${PREFIX} v${SERVER_VERSION} node=${process.version} pid=${process.pid}`);
    log(`${PREFIX} workspace root: ${toPosixPath(root)}`);
    log(`${PREFIX} resourceGlob='${config.resourceGlob}' codeGlob='${config.codeGlob}' structure=${config.structurePreference}`);
  } catch { /* logging only */ }

  serveStdio(() => createI18nMcpServer({ logger: log }), {
    onerror: error => log(`${PREFIX} transport error: ${error.message}`),
  });
  log(`${PREFIX} serving on stdio`);
}

main();
