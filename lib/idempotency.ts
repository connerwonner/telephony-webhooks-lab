// claim() must be atomic: exactly one caller per key gets `true`.
// Redis:    SET key 1 NX EX 86400  -> "OK" means first
// Postgres: INSERT ... ON CONFLICT (key) DO NOTHING -> rowCount === 1 means first
export interface IdempotencyStore {
  claim(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
}
export class MemoryStore implements IdempotencyStore {
  private seen = new Set<string>();
  async claim(key: string) { if (this.seen.has(key)) return false; this.seen.add(key); return true; }
  async release(key: string) { this.seen.delete(key); }
}
let store: IdempotencyStore = new MemoryStore();
export const getStore = () => store;
export const setStore = (s: IdempotencyStore) => { store = s; };
