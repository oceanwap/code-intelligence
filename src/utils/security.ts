/**
 * Security helpers for untrusted input handling.
 *
 * - `safeFetch(url, opts?)` — only allows http(s) URLs that resolve to a public IP.
 *   Blocks file://, localhost, and private IP ranges (10/8, 172.16/12, 192.168/16,
 *   127/8, ::1, fe80::/10, fc00::/7) unless ALLOW_LOCAL_NETWORK=1 or
 *   the caller passes `allowLocal: true`.
 * - `sanitizeLabel(s)` — strips control chars, collapses whitespace, caps length 256.
 * - `validateGraphPath(p, root)` — rejects `..`, absolute paths outside `root`, and
 *   symlinks pointing outside `root`.
 *
 * US-002 / FR-10.
 */

import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

const LABEL_MAX_LENGTH = 256;

export function sanitizeLabel(input: unknown): string {
  if (input === null || input === undefined) return '';
  const raw = typeof input === 'string' ? input : String(input);
  let cleaned = raw.replace(/\x1B\][^\x07]*\x07/g, '');
  cleaned = cleaned.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (cleaned.length > LABEL_MAX_LENGTH) {
    cleaned = cleaned.slice(0, LABEL_MAX_LENGTH);
  }
  return cleaned;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('ff')) return true;
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}

function ipIsBlocked(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

function isLocalHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  if (lower === 'ip6-localhost' || lower === 'ip6-loopback') return true;
  return false;
}

export function isLocalNetworkAllowed(): boolean {
  return process.env['ALLOW_LOCAL_NETWORK'] === '1';
}

export interface SafeFetchOptions extends RequestInit {
  allowLocal?: boolean;
}

export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { allowLocal, ...init } = opts;
  const localAllowed = allowLocal ?? isLocalNetworkAllowed();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SecurityError(`Refused fetch: invalid URL "${url}"`);
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new SecurityError(`Refused fetch: protocol "${protocol}" not allowed (file:// and others blocked)`);
  }
  if (!parsed.hostname) {
    throw new SecurityError(`Refused fetch: URL missing hostname`);
  }
  const host = parsed.hostname;
  if (isLocalHost(host) || ipIsBlocked(host)) {
    if (!localAllowed) {
      throw new SecurityError(`Refused fetch: target "${host}" is in a blocked range (loopback/private). Set ALLOW_LOCAL_NETWORK=1 to override.`);
    }
  }
  if (net.isIP(host) === 0) {
    let addresses: { address: string; family: number }[];
    try {
      addresses = await dns.lookup(host, { all: true });
    } catch (err) {
      throw new SecurityError(`Refused fetch: failed to resolve "${host}": ${(err as Error).message}`);
    }
    if (addresses.length === 0) {
      throw new SecurityError(`Refused fetch: no addresses for "${host}"`);
    }
    if (!localAllowed) {
      for (const a of addresses) {
        if (ipIsBlocked(a.address)) {
          throw new SecurityError(`Refused fetch: "${host}" resolves to blocked address ${a.address}. Set ALLOW_LOCAL_NETWORK=1 to override.`);
        }
      }
    }
  }
  return fetch(parsed.toString(), init);
}

function walkUpToExisting(absPath: string): string {
  let cursor = absPath;
  while (cursor !== path.dirname(cursor)) {
    try {
      return fs.realpathSync(cursor);
    } catch {
      cursor = path.dirname(cursor);
    }
  }
  return cursor;
}

export function validateGraphPath(p: string, root: string): string {
  if (typeof p !== 'string') throw new SecurityError('Refused path: not a string');
  if (p.length === 0) throw new SecurityError('Refused path: empty');
  const absRoot = path.resolve(root);
  if (p.split(/[\\/]+/).includes('..')) {
    throw new SecurityError(`Refused path: contains ".." segment: "${p}"`);
  }
  let resolved: string;
  if (path.isAbsolute(p)) {
    resolved = path.resolve(p);
  } else {
    resolved = path.resolve(absRoot, p);
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(absRoot);
  } catch {
    realRoot = walkUpToExisting(absRoot);
  }
  let tail = '';
  let cursor = resolved;
  while (cursor !== path.dirname(cursor)) {
    try {
      const realCursor = fs.realpathSync(cursor);
      const realFinal = path.join(realCursor, tail);
      const rel = path.relative(realRoot, realFinal);
      if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
        throw new SecurityError(`Refused path: "${p}" escapes root "${realRoot}"`);
      }
      return resolved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        tail = path.join(path.basename(cursor), tail);
        cursor = path.dirname(cursor);
        continue;
      }
      if (err instanceof SecurityError) throw err;
      throw new SecurityError(`Refused path: cannot resolve "${p}": ${(err as Error).message}`);
    }
  }
  throw new SecurityError(`Refused path: "${p}" has no existing ancestor`);
}