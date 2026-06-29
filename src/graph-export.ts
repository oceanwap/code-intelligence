/**
 * Graph export (US-002 / P1-6).
 *
 * Renders the indexed call graph in three formats:
 *   - HTML: vis.js (CDN include) — interactive, opens in browser.
 *   - SVG: hand-rolled dot layout over `graph.json:files` + cross-file imports.
 *   - GraphML: standard XML graph interchange format.
 *
 * Reads `graph.json` + `attention.json` from the active branch. We keep the
 * implementation self-contained — no graphviz dependency.
 */

import * as path from 'node:path';
import { getDataDir } from './git.js';
import { loadGraphAsync, type GraphData } from './graph.js';
import { loadAttentionAsync } from './cognition/attention/engine.js';
import { validateGraphPath } from './utils/security.js';

export type GraphExportFormat = 'html' | 'svg' | 'graphml';

export interface GraphExportResult {
  format: GraphExportFormat;
  outPath: string;
  byteCount: number;
  nodeCount: number;
  edgeCount: number;
}

export async function writeGraphExportAsync(
  projectRoot: string,
  format: GraphExportFormat,
  outPath: string,
  options: { rootForValidation?: string } = {},
): Promise<GraphExportResult> {
  if (!['html', 'svg', 'graphml'].includes(format)) {
    throw new Error(`Unsupported format: "${format}"`);
  }
  const graphPath = path.join(getDataDir(projectRoot), 'graph.json');
  const graph = await loadGraphAsync(graphPath);
  if (!graph) throw new Error(`No graph.json at ${graphPath}. Run code-intel index first.`);
  const attention = await loadAttentionAsync(projectRoot);

  // Allow caller to specify the containment root. Defaults to the project root
  // itself (so users can write into the project) and falls back to cwd.
  const root = options.rootForValidation ?? projectRoot ?? process.cwd();
  const safeOut = validateGraphPath(outPath, root);
  const { nodes, edges } = buildGraphvizNodes(graph, attention);

  let body: string;
  if (format === 'html') {
    body = renderHtml(nodes, edges);
  } else if (format === 'svg') {
    body = renderSvg(nodes, edges);
  } else {
    body = renderGraphMl(nodes, edges);
  }

  await Bun.write(safeOut, body);
  const stat = await Bun.file(safeOut).stat();
  return {
    format,
    outPath: safeOut,
    byteCount: stat.size,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}

interface DisplayNode {
  id: string;
  label: string;
  type: 'file' | 'symbol';
  weight: number;
}
interface DisplayEdge {
  from: string;
  to: string;
  weight: number;
}

function buildGraphvizNodes(graph: GraphData, attention: { symbols?: Array<{ symbol: string; attentionScore?: number }> } | null): { nodes: DisplayNode[]; edges: DisplayEdge[] } {
  const nodes: DisplayNode[] = [];
  const edges: DisplayEdge[] = [];
  const seen = new Set<string>();
  const attentionMap = new Map<string, number>();
  for (const s of attention?.symbols ?? []) {
    if (typeof s.symbol === 'string' && typeof s.attentionScore === 'number') {
      attentionMap.set(s.symbol, s.attentionScore);
    }
  }
  // Files as nodes (carriers of the layout).
  for (const [file, imports] of Object.entries(graph.files)) {
    if (!seen.has(file)) {
      seen.add(file);
      nodes.push({ id: `f:${file}`, label: file, type: 'file', weight: 1 });
    }
    for (const imp of imports) {
      const target = graph.resolvedImports?.[file]?.find(t => t.endsWith(imp.replace(/^\.\.?\//, ''))) ?? imp;
      const targetId = `f:${target}`;
      if (!seen.has(targetId)) {
        seen.add(targetId);
        nodes.push({ id: targetId, label: target, type: 'file', weight: 1 });
      }
      edges.push({ from: `f:${file}`, to: targetId, weight: 1 });
    }
  }
  // Symbol-level graph (for HTML / GraphML — denser).
  for (const [sym, callees] of Object.entries(graph.symbols)) {
    if (!seen.has(`s:${sym}`)) {
      seen.add(`s:${sym}`);
      nodes.push({ id: `s:${sym}`, label: sym, type: 'symbol', weight: attentionMap.get(sym) ?? 1 });
    }
    for (const callee of callees) {
      if (!seen.has(`s:${callee}`)) {
        seen.add(`s:${callee}`);
        nodes.push({ id: `s:${callee}`, label: callee, type: 'symbol', weight: attentionMap.get(callee) ?? 1 });
      }
      edges.push({ from: `s:${sym}`, to: `s:${callee}`, weight: 1 });
    }
  }
  return { nodes, edges };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderHtml(nodes: DisplayNode[], edges: DisplayEdge[]): string {
  const data = JSON.stringify({ nodes, edges });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>code-intelligence graph</title>
  <script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
  <style>
    html, body, #graph { margin: 0; padding: 0; height: 100vh; width: 100vw; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    #info { position: fixed; top: 8px; left: 8px; background: rgba(255,255,255,0.85); padding: 6px 10px; border-radius: 4px; font-size: 12px; }
  </style>
</head>
<body>
  <div id="info">code-intelligence graph — ${nodes.length} nodes, ${edges.length} edges (powered by vis.js CDN)</div>
  <div id="graph"></div>
  <script>
    const data = ${data};
    const nodes = new vis.DataSet(data.nodes.map(n => ({
      id: n.id, label: n.label,
      shape: n.type === 'file' ? 'box' : 'ellipse',
      size: 6 + (n.weight || 1) * 4,
      color: n.type === 'file' ? '#cce5ff' : '#ffd9b3',
    })));
    const edges = new vis.DataSet(data.edges.map(e => ({ from: e.from, to: e.to, arrows: 'to' })));
    new vis.Network(document.getElementById('graph'), { nodes, edges }, { physics: { stabilization: { iterations: 200 } } });
  </script>
</body>
</html>
`;
}

function renderSvg(nodes: DisplayNode[], edges: DisplayEdge[]): string {
  // Simple dot layout: place file nodes on a circle, symbol nodes clustered
  // around their file. Pure SVG, no external libs.
  const fileNodes = nodes.filter(n => n.type === 'file');
  const symNodes = nodes.filter(n => n.type === 'symbol');
  const W = 1200, H = 800;
  const cx = W / 2, cy = H / 2;
  const positions = new Map<string, { x: number; y: number }>();
  fileNodes.forEach((n, i) => {
    const angle = (i / Math.max(1, fileNodes.length)) * 2 * Math.PI;
    const r = Math.min(W, H) * 0.35;
    positions.set(n.id, { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
  });
  // Place symbol nodes by hashing their first file match.
  symNodes.forEach((n, i) => {
    const angle = (i / Math.max(1, symNodes.length)) * 2 * Math.PI;
    const r = Math.min(W, H) * 0.18;
    positions.set(n.id, { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
  });
  const nodeSvg = nodes.map(n => {
    const p = positions.get(n.id);
    if (!p) return '';
    const fill = n.type === 'file' ? '#cce5ff' : '#ffd9b3';
    const r = n.type === 'file' ? 6 : 3;
    return `<g><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${fill}" stroke="#333" stroke-width="0.5"/><title>${escapeXml(n.label)}</title></g>`;
  }).join('');
  const edgeSvg = edges.map(e => {
    const a = positions.get(e.from);
    const b = positions.get(e.to);
    if (!a || !b) return '';
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#999" stroke-width="0.4" opacity="0.5"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
<rect width="100%" height="100%" fill="#fafafa"/>
<g class="edges">${edgeSvg}</g>
<g class="nodes">${nodeSvg}</g>
<text x="10" y="20" font-family="monospace" font-size="12" fill="#333">code-intelligence graph — ${nodes.length} nodes, ${edges.length} edges</text>
</svg>
`;
}

function renderGraphMl(nodes: DisplayNode[], edges: DisplayEdge[]): string {
  const keyDecls = [
    '<key id="label" for="node" attr.name="label" attr.type="string"/>',
    '<key id="type" for="node" attr.name="type" attr.type="string"/>',
    '<key id="weight" for="node" attr.name="weight" attr.type="double"/>',
  ];
  const nodeXml = nodes.map(n =>
    `    <node id="${escapeXml(n.id)}">\n      <data key="label">${escapeXml(n.label)}</data>\n      <data key="type">${n.type}</data>\n      <data key="weight">${n.weight}</data>\n    </node>`,
  ).join('\n');
  const edgeXml = edges.map((e, i) =>
    `    <edge id="e${i}" source="${escapeXml(e.from)}" target="${escapeXml(e.to)}"/>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  ${keyDecls.join('\n  ')}
  <graph id="code-intelligence" edgedefault="directed">
${nodeXml}
${edgeXml}
  </graph>
</graphml>
`;
}