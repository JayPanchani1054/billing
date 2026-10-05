/**
 * Tiny observable map keyed by nav entry key (screen titles, rail actions, dirty flags, hints).
 * Values are replaced, never mutated, so `get(key)` is a valid useSyncExternalStore snapshot.
 */
export class KeyedStore<T> {
  private readonly map = new Map<string, T>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  get(key: string): T | undefined {
    return this.map.get(key);
  }

  /** Set a value; `equals` skips notifications when nothing meaningful changed. */
  set(key: string, value: T, equals?: (a: T, b: T) => boolean): void {
    const prev = this.map.get(key);
    if (prev !== undefined && (prev === value || (equals && equals(prev, value)))) {
      this.map.set(key, value); // keep the latest (fresh closures) without notifying
      return;
    }
    this.map.set(key, value);
    this.bump();
  }

  delete(key: string): void {
    if (this.map.delete(key)) this.bump();
  }

  values(): T[] {
    return [...this.map.values()];
  }

  entries(): Array<[string, T]> {
    return [...this.map.entries()];
  }

  /** Changes on every notified update (snapshot for "anything changed" subscribers). */
  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private bump(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }
}
