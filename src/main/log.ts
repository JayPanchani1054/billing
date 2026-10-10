/**
 * Main-process logging facade. Until the core runtime exists (or if it fails to start) messages go to
 * the console; afterwards they are forwarded to runtime.app.log, which owns the rotating log file.
 * Never log passwords, document payloads or full GSTIN/PAN lists (docs/ARCHITECTURE.md §8).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSink = (level: LogLevel, message: string, meta?: unknown) => void;

let sink: LogSink | null = null;
let mirrorToConsole = true;

export function setLogSink(next: LogSink | null, options: { mirrorToConsole: boolean }): void {
  sink = next;
  mirrorToConsole = options.mirrorToConsole;
}

export function log(level: LogLevel, message: string, meta?: unknown): void {
  if (sink) {
    try {
      sink(level, message, meta);
    } catch {
      // A failing logger must never take the app down; fall through to the console.
      mirrorToConsole = true;
    }
  }
  if (!sink || mirrorToConsole) {
    const line = `[pevqori:${level}] ${message}`;
    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (meta === undefined) out(line);
    else out(line, meta);
  }
}

/** Serialisable description of a thrown value for the log file (stack stays out of the UI). */
export function describeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { name: 'NonError', message: String(err) };
}
