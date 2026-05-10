import * as path from 'path';
import { getDataDir } from '../../git.js';
import { loadGraphAsync } from '../../graph.js';
import { analyzeArchitecture } from './analyzer.js';
import { type ArchitectureSnapshot } from './types.js';

export function architectureFile(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), 'architecture.json');
}

export async function loadArchitectureAsync(projectRoot: string): Promise<ArchitectureSnapshot | null> {
  const file = architectureFile(projectRoot);
  try {
    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) return null;
    return JSON.parse(await bunFile.text()) as ArchitectureSnapshot;
  } catch {
    return null;
  }
}

export async function saveArchitectureAsync(projectRoot: string, snapshot: ArchitectureSnapshot): Promise<void> {
  await Bun.write(architectureFile(projectRoot), JSON.stringify(snapshot, null, 2));
}

export async function refreshArchitectureAsync(projectRoot: string): Promise<ArchitectureSnapshot | null> {
  const graphPath = path.join(getDataDir(projectRoot), 'graph.json');
  const graph = await loadGraphAsync(graphPath);
  if (!graph) return null;

  const snapshot = analyzeArchitecture(graph);
  await saveArchitectureAsync(projectRoot, snapshot);
  return snapshot;
}
