import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DisplayMode } from './terminal-model.js';
export async function loadDisplayMode(repository: string): Promise<DisplayMode> {
  try { const data = JSON.parse(await readFile(join(repository, '.harness', 'ui.json'), 'utf8')); return data.mode === 'detailed' ? 'detailed' : 'minimal'; } catch { return 'minimal'; }
}
export async function saveDisplayMode(repository: string, mode: DisplayMode): Promise<void> {
  const directory = join(repository, '.harness'); await mkdir(directory, { recursive: true });
  const temporary = join(directory, `ui-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ mode }) + '\n', { mode: 0o600 }); await rename(temporary, join(directory, 'ui.json'));
}
