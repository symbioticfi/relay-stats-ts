import type { CacheInterface } from './types/index.js';

export const cacheFullKey = (namespace: string, key: string): string => `${namespace}:${key}`;

export const cacheGet = async (
    cache: CacheInterface | null,
    namespace: string,
    epoch: number,
    key: string
): Promise<unknown | null> => {
    if (!cache) return null;
    try {
        return await cache.get(epoch, cacheFullKey(namespace, key));
    } catch {
        return null;
    }
};

export const cacheSet = async (
    cache: CacheInterface | null,
    namespace: string,
    epoch: number,
    key: string,
    value: unknown
): Promise<void> => {
    if (!cache) return;
    try {
        await cache.set(epoch, cacheFullKey(namespace, key), value);
    } catch {
        // ignore cache errors
    }
};

export const cacheDelete = async (
    cache: CacheInterface | null,
    namespace: string,
    epoch: number,
    key: string
): Promise<void> => {
    if (!cache) return;
    try {
        await cache.delete(epoch, cacheFullKey(namespace, key));
    } catch {
        // ignore cache errors
    }
};

export const cacheGetTyped = async <T>(
    cache: CacheInterface | null,
    namespace: string,
    epoch: number,
    key: string,
    guard: (v: unknown) => v is T
): Promise<T | null> => {
    const value = await cacheGet(cache, namespace, epoch, key);
    return value && guard(value) ? value : null;
};

export const pruneMap = <K, V>(map: Map<K, V>, maxEntries: number): void => {
    if (maxEntries <= 0) return;
    while (map.size > maxEntries) {
        const first = map.keys().next();
        if (first.done) break;
        map.delete(first.value);
    }
};

export const buildSettlementStatusKey = (
    settlements: readonly { chainId: number; address: string }[]
): string =>
    settlements
        .map(s => `${s.chainId}_${s.address.toLowerCase()}`)
        .sort()
        .join('|');

export const buildSettlementKey = (settlement: { chainId: number; address: string }): string =>
    `${settlement.chainId}_${settlement.address.toLowerCase()}`;
