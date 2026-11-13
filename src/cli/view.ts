// A live terminal view (--view): the model redrawn on every change, recently
// changed lines highlighted, plus the latest edits and what's being heard.

const CSI = "\x1b[";
const GREEN = `${CSI}32m`;
const DIM = `${CSI}2m`;
const BOLD = `${CSI}1m`;
const RESET = `${CSI}0m`;
const HIGHLIGHT_MS = 4000;
const FOOTER_LINES = 12;

function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

function fit(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

export class TerminalView {
  private firstSeen = new Map<string, number>();
  private rendered = false;
  private recent: string[] = [];
  private heard = "";
  private status = "";
  private timer?: ReturnType<typeof setTimeout>;
  private fadeTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly out: NodeJS.WriteStream,
    private readonly header: () => string,
    private readonly model: () => string,
  ) {}

  addChanges(changes: string[]): void {
    const at = clock();
    for (const change of changes) this.recent.push(`${at}  ${change}`);
    this.recent = this.recent.slice(-6);
    this.schedule();
  }

  setHeard(text: string): void {
    this.heard = text;
    this.schedule();
  }

  setStatus(text: string): void {
    this.status = text;
    this.schedule();
  }

  schedule(): void {
    this.timer ??= setTimeout(() => this.render(), 30);
  }

  render(): void {
    this.timer = undefined;
    // Some terminals report 0 for an unknown size.
    const width = this.out.columns || 100;
    const rows = this.out.rows || 40;
    const now = Date.now();
    const lines = this.model().trimEnd().split("\n");

    // Lines present at the first render (e.g. a resumed model) aren't "new".
    for (const line of lines) if (!this.firstSeen.has(line)) this.firstSeen.set(line, this.rendered ? now : 0);
    this.rendered = true;
    const fresh = (line: string) => now - (this.firstSeen.get(line) ?? 0) < HIGHLIGHT_MS;

    // Keep the latest change on screen when the model is taller than the terminal.
    const room = Math.max(5, rows - FOOTER_LINES);
    let start = 0;
    if (lines.length > room) {
      const lastFresh = lines.findLastIndex(fresh);
      start = Math.max(0, Math.min(lastFresh - Math.floor(room / 2), lines.length - room));
    }
    const visible = lines.slice(start, start + room);
    const rule = DIM + "─".repeat(Math.min(width, 80)) + RESET;

    const out: string[] = [BOLD + fit(this.header(), width) + RESET, rule];
    if (start > 0) out.push(`${DIM}  … ${start} lines above${RESET}`);
    for (const line of visible) out.push(fresh(line) ? GREEN + fit(line, width) + RESET : fit(line, width));
    const below = lines.length - start - visible.length;
    if (below > 0) out.push(`${DIM}  … ${below} lines below${RESET}`);
    out.push(rule);
    for (const change of this.recent) out.push(fit(change, width));
    if (this.heard) out.push(DIM + fit(`heard: ${this.heard}`, width) + RESET);
    if (this.status) out.push(DIM + fit(this.status, width) + RESET);

    this.out.write(`${CSI}H${out.map((l) => `${l}${CSI}K`).join("\n")}\n${CSI}J`);
    // Re-render once highlights expire so they fade back to normal.
    if (lines.some(fresh)) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = setTimeout(() => this.schedule(), HIGHLIGHT_MS);
      this.fadeTimer.unref?.();
    }
  }

  clear(): void {
    this.out.write(`${CSI}H${CSI}2J`);
  }
}
