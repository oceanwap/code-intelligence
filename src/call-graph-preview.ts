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

export function renderCompactCallGraphLines(
  results: CompactCallGraphNode[],
  options: CompactCallGraphRenderOptions = {}
): string[] {
  const maxEdges = options.maxEdges ?? 12;
  const linePrefix = options.linePrefix ?? '- ';
  const emptyMessage = options.emptyMessage ?? '(no in-page call edges found)';

  const symbols = new Set(results.map(result => result.symbol));
  const edges = new Set<string>();

  for (const result of results) {
    const outboundCandidates = [
      ...(result.connectionsWithinResults?.calls ?? []),
      ...(result.graphSummary?.calls?.symbols ?? []),
    ];
    for (const callee of outboundCandidates) {
      const resolvedCallee = resolveInPageSymbol(callee, symbols);
      if (!resolvedCallee || resolvedCallee === result.symbol) continue;
      edges.add(`${result.symbol} -> ${resolvedCallee}`);
    }

    const inboundCandidates = [
      ...(result.connectionsWithinResults?.usedBy ?? []),
      ...(result.graphSummary?.usedBy?.symbols ?? []),
    ];
    for (const caller of inboundCandidates) {
      const resolvedCaller = resolveInPageSymbol(caller, symbols);
      if (!resolvedCaller || resolvedCaller === result.symbol) continue;
      edges.add(`${resolvedCaller} -> ${result.symbol}`);
    }
  }

  const topEdges = [...edges].slice(0, maxEdges);
  if (topEdges.length === 0) return ['Small call graph:', `${linePrefix}${emptyMessage}`];
  return ['Small call graph:', ...topEdges.map(edge => `${linePrefix}${edge}`)];
}