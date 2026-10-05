/**
 * <dataDir>/registry.json — lightweight per-data-folder metadata about companies that is not stored
 * inside each company DB (currently: when each company was last opened). Losing it is harmless.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileTimestamp, readJsonFile, writeJsonAtomic } from '../lib/fsutil.ts';
import type { Logger } from './logger.ts';

interface RegistryEntry {
  lastOpenedAt: string | null;
}

interface RegistryFile {
  version: 1;
  companies: Record<string, RegistryEntry>;
}

export class CompanyRegistry {
  readonly file: string;
  private readonly log: Logger['log'];

  constructor(dataDir: string, log: Logger['log']) {
    this.file = path.join(dataDir, 'registry.json');
    this.log = log;
  }

  /** Set when registry.json exists but could not be read; writes are skipped so it is not clobbered. */
  private unreadable = false;

  private read(): RegistryFile {
    const r = readJsonFile<RegistryFile>(this.file);
    this.unreadable = r.status === 'unreadable';
    if (r.status === 'ok' && r.value && typeof r.value === 'object' && r.value.companies && typeof r.value.companies === 'object') {
      return { version: 1, companies: { ...r.value.companies } };
    }
    if (r.status === 'corrupt') {
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${fileTimestamp()}`);
      } catch {
        /* ignore */
      }
      this.log('warn', 'Company registry was unreadable; starting fresh', { error: r.error });
    }
    return { version: 1, companies: {} };
  }

  lastOpenedAt(id: string): string | null {
    const e = this.read().companies[id];
    return e && typeof e.lastOpenedAt === 'string' ? e.lastOpenedAt : null;
  }

  all(): Record<string, RegistryEntry> {
    return this.read().companies;
  }

  touch(id: string, at: Date): void {
    const reg = this.read();
    reg.companies[id] = { ...(reg.companies[id] ?? {}), lastOpenedAt: at.toISOString() };
    this.write(reg);
  }

  remove(id: string): void {
    const reg = this.read();
    if (!(id in reg.companies)) return;
    delete reg.companies[id];
    this.write(reg);
  }

  private write(reg: RegistryFile): void {
    if (this.unreadable) return;
    try {
      writeJsonAtomic(this.file, reg);
    } catch (err) {
      this.log('warn', 'Could not update company registry', { error: err });
    }
  }
}
