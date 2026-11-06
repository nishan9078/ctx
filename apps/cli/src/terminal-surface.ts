import { EventEmitter } from 'node:events';
import { createInterface, cursorTo, clearLine } from 'node:readline';
import { safeText } from './terminal-view.js';

import { TerminalModel, type TerminalContext, type Activity } from './terminal-model.js';
export type { TerminalContext } from './terminal-model.js';

export abstract class TerminalSurface extends EventEmitter {
  readonly model = new TerminalModel();
  readonly screen: boolean = false;
  activity(entry: Activity): void { this.model.activity(entry); }
  showHelp(text: string): void { this.write(text); }
  inspect(title: string, body: string): void { this.write(`${title}\n${body}`); }
  abstract write(message: string): void;
  abstract prompt(): void;
  abstract close(): void;
  abstract destroy(): Promise<void>;
  abstract update(context: Partial<TerminalContext>): void;
  async handoff<T>(operation: () => Promise<T>): Promise<T> { return operation(); }
}
export class PlainTerminalSurface extends TerminalSurface {
  private input = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY && !!process.stdout.isTTY });
  private closing = false;
  constructor() {
    super();
    this.input.on('line', line => this.emit('line', line));
    this.input.on('SIGINT', () => this.emit('SIGINT'));
    this.input.on('close', () => { this.closing = true; this.emit('close'); });
  }
  write(message: string): void {
    if (process.stdout.isTTY) { cursorTo(process.stdout, 0); clearLine(process.stdout, 0); }
    process.stdout.write(safeText(message) + '\n');
  }
  prompt(): void {
    if (!this.closing) { this.input.setPrompt(process.stdout.isTTY && !process.env.NO_COLOR ? '\x1b[36mctx ›\x1b[0m ' : 'ctx > '); this.input.prompt(true); }
  }
  close(): void { this.input.close(); }
  async destroy(): Promise<void> { this.input.close(); }
  update(context: Partial<TerminalContext>): void { this.model.update(context); }
  override activity(entry: Activity): void { this.model.activity(entry); if (entry.important) this.write(entry.title + (entry.expanded && entry.body ? '\n' + entry.body : '')); }
}
export function supportsScreen(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return (major > 26 || major === 26 && minor >= 4) && process.execArgv.includes('--experimental-ffi');
}
export async function createTerminalSurface(plain = false): Promise<TerminalSurface> {
  if (plain || !process.stdin.isTTY || !process.stdout.isTTY) return new PlainTerminalSurface();
  if (!supportsScreen()) throw new Error('The interactive CTX UI requires Node 26.4+ with --experimental-ffi. Run releases/ctx-linux-x64/ctx or use --plain explicitly.');
  const { createScreenSurface } = await import('./terminal-screen.js');
  return createScreenSurface();
}
