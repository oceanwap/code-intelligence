import treeify from 'treeify';
import type { TreeObject, TreeValue } from 'treeify';

export interface CompactCallGraphNode {
  symbol: string;
  connectionsWithinResults?: {
    calls?: string[];
    usedBy?: string[];
  };
  graphSummary?: {
    calls?: { symbols?: string[] };
    usedBy?: { symbols?: string[] };
  };
}

function symbolSuffix(symbol: string): string {
  if (symbol.includes('::')) return symbol.split('::').pop() ?? symbol;
  if (symbol.includes('.')) return symbol.split('.').pop() ?? symbol;
  if (symbol.includes('\\')) return symbol.split('\\').pop() ?? symbol;
  return symbol;
}

function resolveInPageSymbol(candidate: string, symbols: Set<string>): string | null {
  if (!candidate) return null;
  if (symbols.has(candidate)) return candidate;

  const normalizedCandidate = symbolSuffix(candidate);
  const suffixMatches = [...symbols].filter(symbol => symbolSuffix(symbol) === normalizedCandidate);
  if (suffixMatches.length === 1) return suffixMatches[0] ?? null;

  const endingMatches = [...symbols].filter(symbol => symbol.endsWith(`::${normalizedCandidate}`) || symbol.endsWith(`.${normalizedCandidate}`));
  if (endingMatches.length === 1) return endingMatches[0] ?? null;

  return null;
}

export interface CompactCallGraphRenderOptions {
  maxEdges?: number;
  linePrefix?: string;
  emptyMessage?: string;
}

interface Edge {
  from: string;
  to: string;
}

function buildEdges(results: CompactCallGraphNode[]): Edge[] {
  const symbols = new Set(results.map(result => result.symbol));
  const edgeKeys = new Set<string>();
  const edges: Edge[] = [];

  for (const result of results) {
    const outboundCandidates = [
      ...(result.connectionsWithinResults?.calls ?? []),
      ...(result.graphSummary?.calls?.symbols ?? []),
    ];
    for (const callee of outboundCandidates) {
      const resolvedCallee = resolveInPageSymbol(callee, symbols);
      if (!resolvedCallee || resolvedCallee === result.symbol) continue;
      const key = `${result.symbol} -> ${resolvedCallee}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ from: result.symbol, to: resolvedCallee });
    }

    const inboundCandidates = [
      ...(result.connectionsWithinResults?.usedBy ?? []),
      ...(result.graphSummary?.usedBy?.symbols ?? []),
    ];
    for (const caller of inboundCandidates) {
      const resolvedCaller = resolveInPageSymbol(caller, symbols);
      if (!resolvedCaller || resolvedCaller === result.symbol) continue;
      const key = `${resolvedCaller} -> ${result.symbol}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ from: resolvedCaller, to: result.symbol });
    }
  }

  return edges;
}

function buildForest(edges: Edge[]): TreeObject {
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const nodes = new Set<string>();

  for (const edge of edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
    const list = adjacency.get(edge.from) ?? [];
    if (!list.includes(edge.to)) list.push(edge.to);
    adjacency.set(edge.from, list);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    if (!indegree.has(edge.from)) indegree.set(edge.from, indegree.get(edge.from) ?? 0);
  }

  for (const [node, list] of adjacency) {
    adjacency.set(node, [...list].sort((a, b) => a.localeCompare(b)));
  }

  const roots = [...nodes]
    .filter(node => (adjacency.get(node)?.length ?? 0) > 0 && (indegree.get(node) ?? 0) === 0)
    .sort((a, b) => a.localeCompare(b));
  const startNodes = roots.length > 0
    ? roots
    : [...adjacency.keys()].sort((a, b) => a.localeCompare(b));

  const toBranch = (node: string, path: Set<string>): TreeObject => {
    const children = adjacency.get(node) ?? [];
    const branch: TreeObject = {};

    for (const child of children) {
      if (path.has(child)) {
        branch[`${child} (cycle)`] = {};
        continue;
      }
      const nextPath = new Set(path);
      nextPath.add(child);
      branch[child] = toBranch(child, nextPath);
    }

    return branch;
  };

  const forest: TreeObject = {};
  for (const root of startNodes) {
    forest[root] = toBranch(root, new Set([root])) as TreeValue;
  }
  return forest;
}

export function renderCompactCallGraphLines(
  results: CompactCallGraphNode[],
  options: CompactCallGraphRenderOptions = {}
): string[] {
  const maxEdges = options.maxEdges ?? 12;
  const linePrefix = options.linePrefix ?? '- ';
  const emptyMessage = options.emptyMessage ?? '(no in-page call edges found)';

  const edges = buildEdges(results).slice(0, maxEdges);
  if (edges.length === 0) return ['Small call graph:', `${linePrefix}${emptyMessage}`];
  const forest = buildForest(edges);
  const rendered = treeify.asTree(forest, false, true).trimEnd();
  const graphLines = rendered.length > 0
    ? rendered.split('\n').map(line => `${linePrefix}${line}`)
    : [`${linePrefix}${emptyMessage}`];
  return ['Small call graph:', ...graphLines];
}