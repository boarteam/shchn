import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Writes via a temp file and a rename, so a watcher never sees a half-written file. */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

/** Coalesces bursts of updates into one write per event-loop turn. */
export class CoalescedWriter {
  private scheduled = false;
  private last?: string;

  constructor(
    private readonly path: string,
    private readonly render: () => string,
  ) {}

  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => this.flush());
  }

  flush(): void {
    this.scheduled = false;
    const content = this.render();
    if (content === this.last) return;
    writeAtomic(this.path, content);
    this.last = content;
  }
}

/** Append-only JSON Lines log: one record per batch and per applied edit. */
export class JsonlLog {
  constructor(private readonly path: string | null) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }

  append(record: Record<string, unknown>): void {
    if (this.path) appendFileSync(this.path, `${JSON.stringify(record)}\n`);
  }
}
