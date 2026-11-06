import { createCliRenderer, BoxRenderable, TextRenderable, TextareaRenderable, InputRenderable, InputRenderableEvents, SelectRenderable, SelectRenderableEvents, ScrollBoxRenderable, type CliRenderer } from '@opentui/core';
import { TerminalSurface } from './terminal-surface.js';
import { safeText, terminalHelp } from './terminal-view.js';
import type { TerminalContext, Activity } from './terminal-model.js';

const colors = { background: '#101820', foreground: '#dce5ec', muted: '#8eabbc', accent: '#62d6c5', border: '#35505f', warning: '#efbf77' };
const commands = [
  ['/help', 'Keyboard shortcuts and commands'], ['/tasks', 'Recent tasks'], ['/status', 'Task status and verification'], ['/diff', 'Inspect file changes'], ['/apply', 'Preview and safely transfer verified changes'], ['/details', 'Diagnostics and retained evidence'], ['/security', 'Run a security review'], ['/cancel', 'Stop active work'], ['/config', 'Execution settings'], ['/repo ', 'Select a repository'], ['/resume ', 'Resume a saved task'], ['/retry host', 'Approve host verification and retry before Codex started'], ['/login', 'Provider sign-in'], ['/quit', 'Exit CTX'],
];
export class ScreenTerminalSurface extends TerminalSurface {
  override readonly screen = true;
  private closing = false;
  private header: TextRenderable;
  private warning: TextRenderable;
  private compact: TextRenderable;
  private transcript: ScrollBoxRenderable;
  private sidebar: BoxRenderable;
  private status: TextRenderable;
  private input: TextareaRenderable;
  private composer: BoxRenderable;
  private footer: TextRenderable;
  private lastMode = '';
  private rows = new Map<string, TextRenderable>();
  private overlay?: BoxRenderable;
  private overlayScroll?: ScrollBoxRenderable;
  private paletteInput?: InputRenderable;
  private paletteSelect?: SelectRenderable;
  private readonly renderModel = () => this.refresh();
  private readonly onSignal = () => this.emit('SIGINT');
  private readonly onTerminate = () => this.close();
  private readonly onResize = () => this.refresh();
  constructor(private renderer: CliRenderer) {
    super();
    const root = new BoxRenderable(renderer, { width: '100%', height: '100%', flexDirection: 'column', backgroundColor: colors.background });
    renderer.root.add(root);
    this.header = new TextRenderable(renderer, { content: '', fg: colors.accent, height: 2, flexShrink: 0, wrapMode: 'word' }); root.add(this.header);
    this.warning = new TextRenderable(renderer, { content: '', fg: colors.warning, flexShrink: 0, wrapMode: 'word' }); root.add(this.warning);
    this.compact = new TextRenderable(renderer, { content: '', fg: colors.muted, height: 1, flexShrink: 0 }); root.add(this.compact);
    const body = new BoxRenderable(renderer, { flexDirection: 'row', flexGrow: 1, flexBasis: 0, minHeight: 0 }); root.add(body);
    this.transcript = new ScrollBoxRenderable(renderer, { id: 'transcript', flexGrow: 1, flexBasis: 0, minWidth: 0, minHeight: 0, border: true, borderColor: colors.border, stickyScroll: true, stickyStart: 'bottom' }); body.add(this.transcript);
    this.sidebar = new BoxRenderable(renderer, { width: 32, flexShrink: 0, border: true, borderColor: colors.border });
    const sidebarScroll = new ScrollBoxRenderable(renderer, { width: '100%', height: '100%' });
    this.status = new TextRenderable(renderer, { content: '', fg: colors.muted, wrapMode: 'word', flexShrink: 0 });
    sidebarScroll.add(this.status); this.sidebar.add(sidebarScroll); body.add(this.sidebar);
    this.composer = new BoxRenderable(renderer, { height: 5, flexShrink: 0, border: true, borderColor: colors.accent, title: 'Message CTX' });
    this.input = new TextareaRenderable(renderer, {
      id: 'composer', width: '100%', height: '100%', placeholder: 'Describe a change, or /help', placeholderColor: colors.muted,
      backgroundColor: colors.background, focusedBackgroundColor: colors.background, textColor: colors.foreground, cursorColor: colors.accent,
      keyBindings: [{ name: 'return', action: 'submit' }, { name: 'return', shift: true, action: 'newline' }, { name: 'j', ctrl: true, action: 'newline' }],
      onSubmit: () => this.submit(),
    });
    this.composer.add(this.input); root.add(this.composer);
    this.footer = new TextRenderable(renderer, { content: '', fg: colors.muted, height: 1, flexShrink: 0 }); root.add(this.footer);
    renderer.keyInput.on('keypress', key => {
      if (key.ctrl && key.name === 'c') { key.preventDefault(); this.emit('SIGINT'); }
      else if (key.ctrl && key.name === 'q') { key.preventDefault(); this.close(); }
      else if (key.name === 'escape' && this.overlay) { key.preventDefault(); this.dismiss(); }
      else if (key.name === 'tab') {
        key.preventDefault();
        if (this.paletteInput && this.paletteSelect) { if (this.paletteInput.focused) this.paletteSelect.focus(); else this.paletteInput.focus(); }
        else if (!this.overlay) this.model.toggleMode();
      }
      else if (key.ctrl && key.name === 'p') { key.preventDefault(); this.openPalette(); }
      else if (key.ctrl && key.name === 'o') { key.preventDefault(); this.openActivities(); }
      else if (key.name === 'f1') { key.preventDefault(); this.showHelp(terminalHelp); }
      else if (key.name === 'pageup' || key.name === 'pagedown') { key.preventDefault(); (this.overlayScroll ?? this.transcript).scrollBy(key.name === 'pageup' ? -10 : 10); }
      else if (this.paletteSelect && this.paletteInput?.focused && ['up', 'down'].includes(key.name)) {
        key.preventDefault(); if (key.name === 'up') this.paletteSelect.moveUp(); else this.paletteSelect.moveDown();
      }
    });
    renderer.on('resize', this.onResize);
    process.on('SIGINT', this.onSignal); process.on('SIGTERM', this.onTerminate);
    this.model.on('change', this.renderModel); this.refresh(); this.input.focus();
  }
  private submit(): void {
    if (this.closing || this.overlay) return;
    const value = this.input.plainText.trim(); if (!value) return;
    this.input.setText('');
    if (value === '/help') { this.showHelp(terminalHelp); return; }
    if (value === '/') { this.openPalette(); return; }
    this.model.write(value, 'user'); this.emit('line', value);
  }
  private refresh(): void {
    if (this.renderer.isDestroyed) return;
    const c = this.model.context; const detailed = this.model.mode === 'detailed';
    const label = detailed ? 'Detailed' : 'Minimal';
    const status = c.busy ? 'Working' : c.progress.split(' · ')[0];
    const header = this.renderer.width < 75
      ? [` CTX  ${label} · ${c.execution} · ${status}`, ` ${c.repository.split('/').filter(Boolean).at(-1) ?? '/'} · ${c.branch}`]
      : [` CTX  ${label}  ·  ${c.branch}  ·  ${c.execution}  ·  ${status}`, ` ${c.repository}`];
    this.header.content = safeText(header.map(line => [...line].slice(0, this.renderer.width).join('')).join('\n'));
    this.warning.content = safeText(c.workspaceWarning); this.warning.visible = !!c.workspaceWarning;
    this.compact.content = safeText(` ${c.progress}  ·  Security: ${c.security}`);
    this.sidebar.visible = detailed && this.renderer.width >= 92;
    this.status.content = safeText(`TASK PLAN\n${c.plan || 'No active task'}\n\nVERIFICATION\n${c.checks}\n\nSECURITY\n${c.security}\n\nRECOVERY\n${c.recovery || 'No recovery attempts'}\n\nPATHS\nLaunched from: ${c.launchDirectory}\nExecutable: ${c.executableDirectory}`);
    this.composer.height = this.renderer.height < 18 ? 3 : 5;
    this.footer.content = this.renderer.width < 75 ? ' Enter send · Ctrl-J newline · Tab mode · Ctrl-P menu' : ' Enter send · Shift-Enter/Ctrl-J newline · Tab mode · Ctrl-P commands · Ctrl-O activity · F1 help';
    if (this.lastMode !== this.model.mode) { for (const row of this.rows.values()) { this.transcript.remove(row); row.destroy(); } this.rows.clear(); this.lastMode = this.model.mode; }
    const visible = this.model.visible(); const ids = new Set(visible.map(entry => entry.id));
    for (const [id, row] of this.rows) if (!ids.has(id)) { this.transcript.remove(row); row.destroy(); this.rows.delete(id); }
    for (const entry of visible) {
      let row = this.rows.get(entry.id);
      if (!row) {
        row = new TextRenderable(this.renderer, { id: entry.id, content: '', wrapMode: 'word', flexShrink: 0,
          onMouseDown: () => { if (entry.body) this.model.toggleActivity(entry.id); },
        });
        this.rows.set(entry.id, row); this.transcript.add(row);
      }
      const expandable = !!entry.body;
      row.content = safeText(`${entry.kind === 'user' ? '\nYOU  ' : expandable ? entry.expanded ? '▾ ' : '▸ ' : ''}${entry.title}${expandable && entry.expanded ? '\n' + entry.body : ''}\n`);
      row.fg = entry.kind === 'user' ? colors.accent : entry.kind === 'error' ? colors.warning : entry.kind === 'event' ? colors.muted : colors.foreground;

    }
    if (this.overlay) { this.overlay.width = Math.max(24, this.renderer.width - 4); this.overlay.height = Math.max(6, this.renderer.height - 4); }
  }
  override write(message: string): void { this.model.write(safeText(message)); }
  override activity(entry: Activity): void { this.model.activity(entry); }
  prompt(): void { if (!this.closing && !this.overlay) this.input.focus(); }
  update(context: Partial<TerminalContext>): void { this.model.update(context); }
  private modal(title: string): BoxRenderable {
    this.dismiss(); this.input.blur();
    const panel = new BoxRenderable(this.renderer, { position: 'absolute', left: 2, top: 2, width: Math.max(24, this.renderer.width - 4), height: Math.max(6, this.renderer.height - 4), border: true, borderColor: colors.accent, backgroundColor: colors.background, flexDirection: 'column', zIndex: 10, title });
    this.renderer.root.add(panel); this.overlay = panel; return panel;
  }
  private dismiss(): void {
    if (this.overlay) { this.renderer.root.remove(this.overlay); this.overlay.destroyRecursively(); }
    this.overlay = undefined; this.overlayScroll = undefined; this.paletteInput = undefined; this.paletteSelect = undefined;
    if (!this.closing) this.input.focus();
  }
  override showHelp(text: string): void { this.inspect('Help · Esc close', `${text}\n\nTab  Toggle Minimal / Detailed (preference saved per repository)\nCtrl-P  Command palette · Up/Down choose · Enter execute · Esc close\nCtrl-O  Activity inspector · Enter expand/collapse\nShift-Enter or Ctrl-J  Add a line · Enter  Send\nPage Up / Page Down  Scroll · Ctrl-Q  Exit`); }
  override inspect(title: string, body: string): void {
    const panel = this.modal(title);
    this.overlayScroll = new ScrollBoxRenderable(this.renderer, { width: '100%', flexGrow: 1, minHeight: 0 });
    this.overlayScroll.add(new TextRenderable(this.renderer, { content: safeText(body), fg: colors.foreground, wrapMode: 'word', flexShrink: 0 })); panel.add(this.overlayScroll);
    this.overlayScroll.focus();
  }
  private openPalette(): void {
    const panel = this.modal('Command palette · Esc close');
    const query = new InputRenderable(this.renderer, { placeholder: 'Search commands…', textColor: colors.foreground, focusedBackgroundColor: colors.background });
    const menu = new SelectRenderable(this.renderer, { flexGrow: 1, minHeight: 0, showDescription: true, selectedBackgroundColor: colors.border, selectedTextColor: colors.accent });
    this.paletteInput = query; this.paletteSelect = menu;
    const filter = () => { menu.options = commands.filter(command => command.join(' ').toLowerCase().includes(query.value.toLowerCase())).map(([name, description]) => ({ name, description, value: name })); menu.setSelectedIndex(0); };
    query.on(InputRenderableEvents.INPUT, filter);
    const select = () => { const option = menu.getSelectedOption(); if (!option) return; const command = String(option.value); this.dismiss(); if (command.endsWith(' ')) { this.input.setText(command); this.input.gotoBufferEnd(); } else if (command === '/help') this.showHelp(terminalHelp); else this.emit('line', command); };
    query.on(InputRenderableEvents.ENTER, select); menu.on(SelectRenderableEvents.ITEM_SELECTED, select);
    panel.add(query); panel.add(menu); filter(); query.focus();
  }
  private openActivities(): void {
    const panel = this.modal('Activity inspector · Enter expand · Esc close');
    const entries = this.model.entries.filter(entry => entry.body).slice().reverse();
    const menu = new SelectRenderable(this.renderer, { width: '100%', height: '100%', options: entries.map(entry => ({ name: `${entry.expanded ? '▾' : '▸'} ${safeText(entry.title).split('\n')[0]}`, description: entry.kind, value: entry.id })), selectedBackgroundColor: colors.border, selectedTextColor: colors.accent });
    menu.on(SelectRenderableEvents.ITEM_SELECTED, () => { const id = String(menu.getSelectedOption()?.value); const entry = this.model.entries.find(item => item.id === id); if (!entry) return; this.model.toggleActivity(id); this.inspect(entry.title, entry.body ?? ''); });
    panel.add(menu); menu.focus();
  }
  close(): void { if (!this.closing) { this.closing = true; this.input.blur(); this.emit('close'); } }
  async handoff<T>(operation: () => Promise<T>): Promise<T> { await this.renderer.suspend(); try { return await operation(); } finally { await this.renderer.resume(); this.prompt(); } }
  async destroy(): Promise<void> {
    this.model.removeListener('change', this.renderModel);
    process.removeListener('SIGINT', this.onSignal); process.removeListener('SIGTERM', this.onTerminate); this.renderer.removeListener('resize', this.onResize);
    this.renderer.destroy(); await this.renderer.closed;
  }
}
export async function createScreenSurface(): Promise<ScreenTerminalSurface> {
  const renderer = await createCliRenderer({ screenMode: 'alternate-screen', consoleMode: 'disabled', exitOnCtrlC: false, exitSignals: [] });
  try { return new ScreenTerminalSurface(renderer); } catch (error) { renderer.destroy(); await renderer.closed; throw error; }
}
