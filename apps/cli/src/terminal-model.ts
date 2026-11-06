import { EventEmitter } from 'node:events';
export type DisplayMode = 'minimal' | 'detailed';
export interface Activity {
  id: string;
  title: string;
  body?: string;
  kind: 'message' | 'user' | 'tool' | 'event' | 'error' | 'diff' | 'security';
  important?: boolean;
  expanded?: boolean;
}
export interface TerminalContext {
  repository: string;
  branch: string;
  launchDirectory: string;
  executableDirectory: string;
  workspaceWarning: string;
  execution: string;
  busy: boolean;
  progress: string;
  security: string;
  plan: string;
  checks: string;
  recovery: string;
}
export class TerminalModel extends EventEmitter {
  mode: DisplayMode = 'minimal';
  context: TerminalContext = { repository: '', branch: 'no branch', launchDirectory: '', executableDirectory: '', workspaceWarning: '', execution: 'docker', busy: false, progress: 'Ready', security: 'not run', plan: '', checks: 'Build / test: not run', recovery: '' };
  entries: Activity[] = [];
  private sequence = 0;
  private byId = new Map<string, Activity>();
  update(context: Partial<TerminalContext>): void { if (Object.entries(context).some(([key, value]) => this.context[key as keyof TerminalContext] !== value)) { Object.assign(this.context, context); this.emit('change'); } }
  write(title: string, kind: Activity['kind'] = 'message'): void { this.activity({ id: `local-${++this.sequence}`, title, kind, important: true }); }
  activity(entry: Activity, notify = true): boolean {
    const existing = this.byId.get(entry.id);
    const next = { ...entry, expanded: existing?.expanded ?? entry.expanded };
    if (existing && JSON.stringify(existing) === JSON.stringify(next)) return false;
    if (existing) Object.assign(existing, next);
    else { this.entries.push(next); this.byId.set(entry.id, next); }
    if (notify) this.emit('change');
    return true;
  }
  activities(entries: Activity[]): void { let changed = false; for (const entry of entries) if (this.activity(entry, false)) changed = true; if (changed) this.emit('change'); }
  setMode(mode: DisplayMode): void { if (this.mode !== mode) { this.mode = mode; this.emit('mode', mode); this.emit('change'); } }
  toggleMode(): void { this.setMode(this.mode === 'minimal' ? 'detailed' : 'minimal'); }
  toggleActivity(id: string): void { const entry = this.byId.get(id); if (entry) { entry.expanded = !entry.expanded; this.emit('change'); } }
  visible(): Activity[] { return this.entries.filter(entry => this.mode === 'detailed' || entry.important || entry.kind === 'user' || entry.kind === 'message' || entry.kind === 'error' || entry.kind === 'security'); }
}
