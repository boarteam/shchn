// Incremental reader for `{"ops":[{...},{...}]}` arriving token by token. Each
// op is returned as soon as its closing brace arrives, so it can be applied
// while the model is still writing the next one.

export class OpsStreamParser {
  private buffer = "";
  private position = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private elementStart = -1;

  /** Feeds more text and returns the array elements completed by it. */
  push(text: string): unknown[] {
    this.buffer += text;
    const completed: unknown[] = [];
    for (; this.position < this.buffer.length; this.position++) {
      const c = this.buffer[this.position];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') this.inString = false;
        continue;
      }
      if (c === '"') {
        this.inString = true;
      } else if (c === "{" || c === "[") {
        this.depth++;
        // depth 1: the root object, 2: the ops array, 3: one op.
        if (this.depth === 3 && c === "{") this.elementStart = this.position;
      } else if (c === "}" || c === "]") {
        if (this.depth === 3 && c === "}" && this.elementStart >= 0) {
          completed.push(JSON.parse(this.buffer.slice(this.elementStart, this.position + 1)));
          this.elementStart = -1;
        }
        this.depth--;
      }
    }
    return completed;
  }

  get text(): string {
    return this.buffer;
  }
}
