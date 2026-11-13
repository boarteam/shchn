import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

// Writes 16-bit mono PCM to a WAV file as it arrives (--save-audio), so a
// session's audio can be replayed later with `live --audio`.

function header(dataBytes: number, sampleRate: number): Buffer {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); // fmt chunk size
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28); // bytes per second
  b.writeUInt16LE(2, 32); // bytes per sample frame
  b.writeUInt16LE(16, 34); // bits per sample
  b.write("data", 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

export class WavWriter {
  private readonly fd: number;
  private bytes = 0;
  private closed = false;

  constructor(
    readonly path: string,
    private readonly sampleRate: number,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "w");
    writeSync(this.fd, header(0, sampleRate));
  }

  write(pcm: Buffer): void {
    if (this.closed) return; // ffmpeg can flush a last frame after the session closed the file
    writeSync(this.fd, pcm);
    this.bytes += pcm.length;
  }

  /** Fills in the sizes the header needs and closes the file. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    writeSync(this.fd, header(this.bytes, this.sampleRate), 0, 44, 0);
    closeSync(this.fd);
  }
}
