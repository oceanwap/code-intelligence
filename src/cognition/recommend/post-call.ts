/**
 * recommend/post-call — PRD US-006 P4 post-call hook.
 *
 * The hook wraps `server.registerTool` so that, when CODE_INTEL_RECOMMEND=1
 * is set, the handler result — IF it is a `ToolResult<T>` envelope — has
 * `data.recommended_next` populated with the next-tool list derived from
 * the scratchpad co-occurrence history.
 *
 * Hard contract (FR-11 byte-equality):
 *   - The hook is OPT-IN via env flag `CODE_INTEL_RECOMMEND=1`. Default off.
 *   - When the flag is unset, the hook is a no-op (the wrapped registerTool
 *     returns the handler's result unchanged).
 *   - When the flag is set but the result is NOT a ToolResult envelope
 *     (e.g. legacy leaf returns its native shape), the hook is a no-op.
 *   - When the flag is set and the result IS a ToolResult envelope, the
 *     hook appends `recommended_next: string[]` to `data`. The order of
 *     the array is the recommender's deterministic order.
 *
 * Why a separate module:
 *   - The hook is small and pure. Putting it in its own file makes the
 *     test surface obvious.
 *   - It is the only env-flagged behaviour in the MCP server, so it
 *     deserves a single owner.
 */

import { isToolResult } from '../signalization/builder.js';
import type { ToolResult } from '../signalization/types.js';
import { recommendNextAsync, coldStartDefault } from './cooccur.js';

/** Environment variable that activates the hook. Default off. */
export const RECOMMEND_ENV_KEY = 'CODE_INTEL_RECOMMEND';

/** Read the env flag at call-time. */
export function isRecommendEnabled(): boolean {
  const raw = process.env[RECOMMEND_ENV_KEY];
  if (raw == null) return false;
  const norm = raw.trim().toLowerCase();
  return norm === '1' || norm === 'true' || norm === 'yes' || norm === 'on';
}

/**
 * Append `recommended_next` to a `ToolResult.data` when the hook is on.
 *
 * Returns the result unchanged when:
 *   - the env flag is off, OR
 *   - the result is not a ToolResult envelope, OR
 *   - the tool name is empty / unknown.
 *
 * Otherwise the returned object is a shallow copy of `result` with
 * `data.recommended_next` populated.
 */
export async function withRecommendedNext(
  result: unknown,
  opts: { toolName: string; projectRoot: string; topN?: number },
): Promise<unknown> {
  if (!isRecommendEnabled()) return result;
  if (!isToolResult(result)) return result;
  if (!opts.toolName || !opts.toolName.trim()) return result;

  let recs;
  try {
    recs = await recommendNextAsync(opts.toolName, {
      projectRoot: opts.projectRoot,
      topN: opts.topN ?? 4,
    });
  } catch {
    // Path validation / I/O failure → return the result unchanged. The
    // hook must NEVER break the host tool's response shape.
    return result;
  }
  // Use the tool names. If the cold-start path produced nothing, fall back
  // to the curated default so the agent always has at least one option.
  const names = recs.length > 0
    ? recs.map((r) => r.tool)
    : coldStartDefault();

  const envelope = result as ToolResult<Record<string, unknown>>;
  const newData: Record<string, unknown> = { ...(envelope.data as Record<string, unknown>), recommended_next: names };
  return { ...envelope, data: newData };
}

// ---------------------------------------------------------------------------
// Wrap a tool registration helper. Mirrors the pattern in mcp-server.ts's
// `attachToolLogging` so the integration is small.
//
// The wrapper intercepts the handler's return value, applies the
// `withRecommendedNext` transform, then returns the transformed value.
// The hook is a no-op when the env flag is unset.
// ---------------------------------------------------------------------------

/**
 * `McpServerLike` — the minimal shape we need from the underlying MCP
 * server. We type it as a structural subset so the helper is testable
 * without spinning up a real server.
 */
export interface McpServerLike {
  registerTool: (...args: unknown[]) => unknown;
}

/**
 * `ToolHandler` — the handler signature MCP gives us. We type it loosely
 * because MCP's `registerTool` overloads are complex.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolHandler = (input: any) => Promise<unknown> | unknown;

/**
 * Wrap a tool registration so the handler's result is post-processed
 * with `withRecommendedNext`. When `isRecommendEnabled()` returns false,
 * the wrapper is a transparent passthrough.
 *
 * Designed to be called from `mcp-server.ts`:
 *
 *   server.registerTool = attachRecommendedNext(server.registerTool, (name) => root);
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function attachRecommendedNext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  originalRegister: (...args: any[]) => any,
  resolveProjectRoot: (toolName: string) => string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (...args: any[]) => any {
  return ((...args: unknown[]) => {
    const [name, config, handler] = args as [string, unknown, ToolHandler];
    if (typeof handler !== 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalRegister as (...a: any[]) => any)(name, config, handler);
    }
    const wrapped: ToolHandler = async (input) => {
      const out = await handler(input);
      if (!isRecommendEnabled()) return out;
      const root = resolveProjectRoot(name);
      if (!root) return out;
      return withRecommendedNext(out, { toolName: name, projectRoot: root });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalRegister as (...a: any[]) => any)(name, config, wrapped);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as (...args: any[]) => any;
}
