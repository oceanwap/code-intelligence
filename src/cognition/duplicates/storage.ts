import * as path from 'path';
import { getDataDir } from '../../git.js';
import { type SemanticDuplicateSnapshot } from './types.js';

export function semanticDuplicatesFile(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), 'semantic-duplicates.json');
}

export async function loadSemanticDuplicatesAsync(
  projectRoot: string
): Promise<SemanticDuplicateSnapshot | null> {
  const file = semanticDuplicatesFile(projectRoot);
  try {
    const bunFile = Bun.file(file);
    if (!(await bunFile.exists())) return null;
    return JSON.parse(await bunFile.text()) as SemanticDuplicateSnapshot;
  } catch {
    return null;
  }
}

export async function saveSemanticDuplicatesAsync(
  projectRoot: string,
  snapshot: SemanticDuplicateSnapshot
): Promise<void> {
  await Bun.write(semanticDuplicatesFile(projectRoot), JSON.stringify(snapshot, null, 2));
}
