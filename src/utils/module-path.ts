/**
 * Shared utility for deriving a logical module name from a file path.
 *
 * Maps paths like "src/auth/service.ts" → "src/auth",
 * "test/auth/service.test.ts" → "test/auth", etc.
 *
 * This is the single canonical implementation — do not duplicate this
 * function in cognition engines or other modules.
 */
export function moduleFromFile(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return '<root>';
  if (parts[0] === 'src') return parts.length >= 2 ? `src/${parts[1]}` : 'src';
  if (parts[0] === 'test' || parts[0] === 'tests') return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
  if (parts[0] === 'docs') return 'docs';
  if (parts[0] === 'bin') return 'bin';
  return parts[0];
}
