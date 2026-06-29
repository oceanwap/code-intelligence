/**
 * One-shot smoke — actually launches the MCP server over stdio and calls
 * `session_scratchpad` through the JSON-RPC protocol. Proves the tool is
 * callable by an MCP client (not just our smoke script that uses the
 * underlying scratchpad API directly).
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = path.resolve('.');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cog-mcp-smoke-'));

// Bootstrap a tiny git repo so getCurrentBranchAsync resolves.
fs.writeFileSync(path.join(TMP, '.keep'), 'x');
spawn('git', ['init', '-q'], { cwd: TMP }).on('exit', () => {
  spawn('git', ['config', 'user.name', 'X'], { cwd: TMP });
  spawn('git', ['config', 'user.email', 'x@x'], { cwd: TMP });
  spawn('git', ['add', '.keep'], { cwd: TMP }).on('exit', () => {
    spawn('git', ['commit', '-m', 'init', '-q'], { cwd: TMP }).on('exit', () => run());
  });
});

function run() {
  const child = spawn('bun', ['src/mcp-server.ts'], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let buf = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        onMsg(msg);
      } catch { /* ignore non-JSON */ }
    }
  });

  function onMsg(msg: any) {
    if (msg.id === 1) {
      // initialized → call session_scratchpad
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'session_scratchpad',
          arguments: { projectRoot: TMP, sessionId: 'mcp-smoke' },
        },
      });
    } else if (msg.id === 2) {
      const text = msg.result?.content?.[0]?.text ?? '';
      if (typeof text === 'string' && text.includes('Scratchpad for session "mcp-smoke" is empty')) {
        console.log('MCP SMOKE OK: session_scratchpad returned: ' + text);
      } else {
        console.log('MCP SMOKE unexpected content: ' + JSON.stringify(msg).slice(0, 200));
      }
      send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    } else if (msg.id === 3) {
      const tools = msg.result?.tools ?? [];
      const ss = tools.find((t: any) => t.name === 'session_scratchpad');
      if (ss) {
        console.log(`MCP SMOKE OK: tools/list reports ${tools.length} tools, session_scratchpad present, inputSchema keys=${Object.keys(ss.inputSchema?.properties ?? {}).join(',')}`);
      } else {
        console.log('MCP SMOKE FAIL: session_scratchpad not in tools/list');
      }
      child.kill();
      cleanup();
    }
  }

  function send(msg: any) {
    child.stdin.write(JSON.stringify(msg) + '\n');
  }

  // init
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // safety timeout
  setTimeout(() => {
    console.log('MCP SMOKE TIMEOUT');
    child.kill();
    cleanup();
  }, 8000);
}

function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(0), 50);
}