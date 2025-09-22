import { CacheInterface } from './types';

export class MemoryCache implements CacheInterface {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cache: Map<string, any> = new Map();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async get(key: string): Promise<any | null> {
    return this.cache.get(key) || null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async set(key: string, value: any): Promise<void> {
    this.cache.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }
}
