import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runTask } from '../../packages/core/src/orchestrator.js';
const [root, repositoryPath, mode] = process.argv.slice(2);
const stop = async (workspace: string) => {
  process.send?.({ ready: true, workspace });
  await new Promise<void>(() => { setInterval(() => {}, 1000); });
};
await runTask({ environment: { mode: 'host' }, request: 'feature', repositoryPath, outputDirectory: root, leaseDurationMs: 300,
  plan: { version: 1, steps: [
    { id: 'first', title: 'First', instructions: 'first', dependencies: [], acceptanceCriteria: ['First feature exists'] },
    { id: 'second', title: 'Second', instructions: 'second', dependencies: ['first'], acceptanceCriteria: ['Second feature exists'] },
  ] },
  build: mode === 'verification' ? `node -e 'const fs=require("fs");fs.appendFileSync("build-effects", "once\\n");setTimeout(()=>{},500)'` : undefined,
}, { async execute(input) {
  await appendFile(join(input.workspacePath, 'agent-effects'), 'once\n');
  await writeFile(join(input.workspacePath, 'feature.js'), 'export const feature = true;\n');
  await input.onEvent?.({ type: 'thread.started', data: { thread_id: 'durable-session' } });
  if (mode === 'ambiguous') await stop(input.workspacePath);
  await input.onEvent?.({ type: 'item.completed', data: { item: { type: 'agent_message', text: 'First feature done' } } });
  await input.onEvent?.({ type: 'turn.completed', data: { usage: { input_tokens: 2, output_tokens: 1 } } });
  if (mode === 'confirmed') await stop(input.workspacePath);
  return { outcome: 'completed', summary: 'Done', sessionId: 'durable-session' };
} });
