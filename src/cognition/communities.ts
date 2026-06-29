/**
 * Louvain community detection over the entity+symbol graph (US-002 / P1-7).
 *
 * Hand-iterated Louvain implementation — no graph-louvain dependency.
 *
 * Algorithm (https://en.wikipedia.org/wiki/Louvain_method):
 *   1. Start: every node is its own community.
 *   2. For each node, compute ΔQ when moving it to each neighbor's community.
 *      Move to the community with the largest positive ΔQ. Repeat the scan
 *      until no node moves.
 *   3. Build a coarse graph: each community → one node; edge weight = sum of
 *      cross-community edge weights. Repeat step 2 on the coarse graph.
 *   4. Map the coarse partition back onto original nodes; repeat 2–3 until
 *      no ΔQ > 0 is possible.
 *
 * Modularity Q uses the standard Newman formulation. The output is persisted
 * to `.code-intelligence/<branch>/communities.json` per branch and surfaced
 * via the MCP leaf tool `list_communities`.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { getDataDir } from '../git.js';
import type { GraphData } from '../graph.js';

export interface Community {
  id: number;
  members: string[];
  size: number;
}

export interface CommunitiesSnapshot {
  generatedAt: string;
  totalCommunities: number;
  totalNodes: number;
  modularity: number;
  communities: Community[];
}

interface WeightedEdge {
  to: string;
  weight: number;
}

function readGraph(graph: GraphData): { nodes: Set<string>; neighbors: Map<string, WeightedEdge[]>; totalWeight: number } {
  const nodes = new Set<string>();
  const neighbors = new Map<string, WeightedEdge[]>();
  // Build an undirected edge map: `undirectedEdges.get(min(u,v))` → Map(max(u,v), weight).
  const undirected = new Map<string, Map<string, number>>();
  const ensure = (u: string, v: string): Map<string, number> => {
    const a = u < v ? u : v;
    const b = u < v ? v : u;
    let bucket = undirected.get(a);
    if (!bucket) {
      bucket = new Map<string, number>();
      undirected.set(a, bucket);
    }
    return bucket;
  };
  const addDirected = (from: string, to: string, weight: number): void => {
    if (!from || !to || from === to) return;
    const bucket = ensure(from, to);
    bucket.set(to, (bucket.get(to) ?? 0) + weight);
  };

  for (const [sym, callees] of Object.entries(graph.symbols)) {
    for (const callee of callees) addDirected(sym, callee, 1);
  }
  if (graph.callers) {
    // Add reverse direction so directed call edges become undirected (sum of weights).
    for (const [sym, callerList] of Object.entries(graph.callers)) {
      for (const caller of callerList) addDirected(sym, caller, 1);
    }
  }
  if (graph.entityRelations) {
    for (const [entity, related] of Object.entries(graph.entityRelations)) {
      for (const r of related) {
        // Entity relations are bidirectional — mirror the edge so the
        // undirected weight reflects the symmetric relationship.
        addDirected(entity, r, 2);
        addDirected(r, entity, 2);
      }
    }
  }
  let totalWeight = 0;
  for (const [u, bucket] of undirected) {
    nodes.add(u);
    const list: WeightedEdge[] = [];
    for (const [v, w] of bucket) {
      nodes.add(v);
      list.push({ to: v, weight: w });
      totalWeight += w;
    }
    neighbors.set(u, list);
  }
  // Include isolated nodes (symbols with no edges) so they show up in their
  // own community instead of being silently dropped.
  for (const sym of Object.keys(graph.symbols)) {
    if (!nodes.has(sym)) {
      nodes.add(sym);
      neighbors.set(sym, []);
    }
  }
  for (const entity of Object.keys(graph.entityRelations ?? {})) {
    if (!nodes.has(entity)) {
      nodes.add(entity);
      neighbors.set(entity, []);
    }
  }
  return { nodes, neighbors, totalWeight };
}

function computeK(nodes: Set<string>, neighbors: Map<string, WeightedEdge[]>): Map<string, number> {
  // `neighbors` is undirected (each undirected edge appears once). k(n) is the
  // sum of weights of edges incident on n. For undirected graphs, k(n) is the
  // sum of weights of neighbors' edge lists pointing AT n OR FROM n. Since we
  // stored undirected edges, every edge contributes to k at both endpoints.
  // We need to enumerate every (u, v) pair once and add to both endpoints.
  const k = new Map<string, number>();
  for (const n of nodes) k.set(n, 0);
  const seen = new Set<string>();
  for (const [u, list] of neighbors) {
    for (const e of list) {
      // Process each undirected edge once by canonicalizing (min, max).
      const key = u < e.to ? `${u}|${e.to}` : `${e.to}|${u}`;
      if (seen.has(key)) continue;
      seen.add(key);
      k.set(u, (k.get(u) ?? 0) + e.weight);
      k.set(e.to, (k.get(e.to) ?? 0) + e.weight);
    }
  }
  return k;
}

function weightToCommunity(
  node: string,
  community: string,
  nodeCommunity: Map<string, string>,
  neighbors: Map<string, WeightedEdge[]>,
): number {
  let sum = 0;
  const list = neighbors.get(node) ?? [];
  for (const e of list) {
    if (nodeCommunity.get(e.to) === community) sum += e.weight;
  }
  return sum;
}

function sumTotals(
  community: string,
  nodeCommunity: Map<string, string>,
  k: Map<string, number>,
): number {
  let sum = 0;
  for (const [n, c] of nodeCommunity) {
    if (c === community) sum += k.get(n) ?? 0;
  }
  return sum;
}

/** Greedy Louvain pass on a graph. Returns true if any node moved. */
function louvainGreedy(
  nodes: Set<string>,
  neighbors: Map<string, WeightedEdge[]>,
  k: Map<string, number>,
  m2: number,
  nodeCommunity: Map<string, string>,
): boolean {
  let moved = false;
  const order = [...nodes].sort();
  for (const n of order) {
    const kN = k.get(n) ?? 0;
    const currentC = nodeCommunity.get(n)!;
    // Sum weights to each neighbor community (excluding current).
    const communityWeights = new Map<string, number>();
    for (const e of neighbors.get(n) ?? []) {
      const c = nodeCommunity.get(e.to);
      if (!c || c === currentC) continue;
      communityWeights.set(c, (communityWeights.get(c) ?? 0) + e.weight);
    }
    // Best target community: stay, or move to whichever neighbor has max gain.
    let bestCommunity = currentC;
    let bestGain = 0;
    for (const [c, w] of communityWeights) {
      const sumTotC = sumTotals(c, nodeCommunity, k);
      // ΔQ = (w/m2) − (sumTot_C * kN) / (2 m²). m2 = total undirected edge weight.
      const gain = (w / m2) - (sumTotC * kN) / (2 * m2 * m2);
      if (gain > bestGain) {
        bestGain = gain;
        bestCommunity = c;
      }
    }
    if (bestCommunity !== currentC) {
      nodeCommunity.set(n, bestCommunity);
      moved = true;
    }
  }
  return moved;
}

function coarsen(
  nodes: Set<string>,
  neighbors: Map<string, WeightedEdge[]>,
  nodeCommunity: Map<string, string>,
  originalToCoarse: Map<string, string>,
  kOriginal: Map<string, number>,
): { cNodes: Set<string>; cNeighbors: Map<string, WeightedEdge[]>; cK: Map<string, number> } {
  const cNodes = new Set<string>();
  const accum = new Map<string, number>();
  for (const n of nodes) {
    const c = nodeCommunity.get(n)!;
    cNodes.add(c);
    originalToCoarse.set(n, c);
  }
  // Aggregate undirected edge weights between communities.
  for (const [from, list] of neighbors) {
    const cf = nodeCommunity.get(from);
    if (!cf) continue;
    for (const e of list) {
      const ct = nodeCommunity.get(e.to);
      if (!ct) continue;
      const key = cf < ct ? `${cf}|${ct}` : `${ct}|${cf}`;
      accum.set(key, (accum.get(key) ?? 0) + e.weight);
    }
  }
  // Build coarse neighbor map (symmetric).
  const cNeighbors = new Map<string, WeightedEdge[]>();
  const cK = new Map<string, number>();
  for (const c of cNodes) {
    cNeighbors.set(c, []);
    cK.set(c, 0);
  }
  for (const [key, w] of accum) {
    const [a, b] = key.split('|');
    if (!a || !b) continue;
    cNeighbors.get(a)!.push({ to: b, weight: w });
    cK.set(a, (cK.get(a) ?? 0) + w);
    if (a !== b) {
      cNeighbors.get(b)!.push({ to: a, weight: w });
      cK.set(b, (cK.get(b) ?? 0) + w);
    }
  }
  // k(c) is the SUM of weights of coarse edges incident on c, but each undirected
  // edge counts once per endpoint so total = 2 * sum/2. The Louvain formula uses
  // k(c) = sum of weights of edges attached to c (counting each endpoint once).
  // That's exactly what we accumulated above.
  // Also include self-loops for completeness.
  for (const [, list] of cNeighbors) {
    void list;
  }
  // Sanity: ensure k is non-negative.
  for (const [c, v] of cK) if (v < 0) cK.set(c, 0);
  void kOriginal;
  return { cNodes, cNeighbors, cK };
}

function totalEdgeWeight(neighbors: Map<string, WeightedEdge[]>): number {
  let total = 0;
  for (const [, list] of neighbors) for (const e of list) total += e.weight;
  return total;
}

function computeModularity(
  nodes: Set<string>,
  neighbors: Map<string, WeightedEdge[]>,
  k: Map<string, number>,
  nodeCommunity: Map<string, string>,
  m: number,
): number {
  if (m === 0) return 0;
  let q = 0;
  for (const n of nodes) {
    const c = nodeCommunity.get(n)!;
    const self = weightToCommunity(n, c, nodeCommunity, neighbors);
    const kN = k.get(n) ?? 0;
    const sumTot = sumTotals(c, nodeCommunity, k);
    q += self / m - (sumTot * kN) / (2 * m * m);
  }
  return q;
}

const MAX_PHASES = 6;
const MAX_PASSES_PER_PHASE = 12;

export function detectCommunities(graph: GraphData): CommunitiesSnapshot {
  const generatedAt = new Date().toISOString();
  const { nodes, neighbors } = readGraph(graph);
  if (nodes.size === 0) {
    return { generatedAt, totalCommunities: 0, totalNodes: 0, modularity: 0, communities: [] };
  }
  // `neighbors` is undirected (each undirected edge appears once). k(n) is the
  // sum of weights of edges incident on n. m is the total undirected edge weight.
  let k = computeK(nodes, neighbors);
  let m = totalEdgeWeight(neighbors);
  let workingNodes = nodes;
  let workingNeighbors = neighbors;

  // Final mapping from original node → community id (we keep this stable
  // across coarsening phases by composing mappings).
  const finalCommunity: Map<string, string> = new Map();
  for (const n of nodes) finalCommunity.set(n, n);

  for (let phase = 0; phase < MAX_PHASES; phase++) {
    const nodeCommunity = new Map<string, string>();
    for (const n of workingNodes) nodeCommunity.set(n, n);

    let anyMove = false;
    for (let pass = 0; pass < MAX_PASSES_PER_PHASE; pass++) {
      const moved = louvainGreedy(workingNodes, workingNeighbors, k, m, nodeCommunity);
      anyMove = anyMove || moved;
      if (!moved) break;
    }
    if (!anyMove) break;

    // Compose final mapping.
    for (const [origNode, coarseCommunity] of [...finalCommunity.entries()]) {
      const currentCoarseId = nodeCommunity.get(coarseCommunity);
      if (currentCoarseId) finalCommunity.set(origNode, currentCoarseId);
    }

    if (phase === MAX_PHASES - 1) break;
    const { cNodes, cNeighbors, cK } = coarsen(workingNodes, workingNeighbors, nodeCommunity, new Map<string, string>(), k);
    if (cNodes.size === workingNodes.size) break; // No further coarsening possible.
    workingNodes = cNodes;
    workingNeighbors = cNeighbors;
    k = cK;
    m = totalEdgeWeight(workingNeighbors);
  }

  // Collect communities.
  const buckets = new Map<string, string[]>();
  for (const n of nodes) {
    const c = finalCommunity.get(n) ?? n;
    const list = buckets.get(c) ?? [];
    list.push(n);
    buckets.set(c, list);
  }
  const communities: Community[] = [];
  let id = 0;
  for (const [, members] of [...buckets.entries()].sort((a, b) => b[1]!.length - a[1]!.length)) {
    if (members.length === 0) continue;
    communities.push({
      id: id++,
      members: members.sort(),
      size: members.length,
    });
  }

  // Compute modularity on the ORIGINAL graph (undirected).
  const kOrig = computeK(nodes, neighbors);
  const mOrig = totalEdgeWeight(neighbors);
  const mod = computeModularity(nodes, neighbors, kOrig, finalCommunity, mOrig);

  return {
    generatedAt,
    totalCommunities: communities.length,
    totalNodes: nodes.size,
    modularity: Number(mod.toFixed(4)),
    communities,
  };
}

export async function saveCommunitiesAsync(projectRoot: string, snapshot: CommunitiesSnapshot): Promise<void> {
  const out = communitiesFile(projectRoot);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await Bun.write(out, JSON.stringify(snapshot, null, 2));
}

export async function loadCommunitiesAsync(projectRoot: string): Promise<CommunitiesSnapshot | null> {
  const file = communitiesFile(projectRoot);
  try {
    const buf = await Bun.file(file).text();
    return JSON.parse(buf) as CommunitiesSnapshot;
  } catch {
    return null;
  }
}

function communitiesFile(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), 'communities.json');
}

export function listCommunitiesForSymbol(
  snapshot: CommunitiesSnapshot,
  symbol?: string,
): { communities: Community[] } {
  if (!symbol) return { communities: snapshot.communities };
  const out: Community[] = [];
  for (const c of snapshot.communities) {
    if (c.members.includes(symbol)) out.push(c);
  }
  return { communities: out };
}