import Queue from 'yocto-queue';
import { CACHE_PERSISTENT_EPOCH } from './constants.js';
import type { CacheInterface } from './types/index.js';

const logger = console;

const logCacheError = (
    action: string,
    namespace: string,
    epoch: number,
    key: string,
    error: unknown
): void => {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[cache] ${action} failed`, { namespace, epoch, key, error: message });
};

export const cacheClear = async (cache: CacheInterface | null, epoch: number): Promise<void> => {
    if (!cache) return;
    try {
        await cache.clear(epoch);
    } catch (error) {
        logCacheError('clear', 'epoch', epoch, '*', error);
    }
};

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
    } catch (error) {
        logCacheError('get', namespace, epoch, key, error);
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
    } catch (error) {
        logCacheError('set', namespace, epoch, key, error);
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
    } catch (error) {
        logCacheError('delete', namespace, epoch, key, error);
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

export type CacheNamespaceAccessor = {
    get: (epoch: number, key: string) => Promise<unknown | null>;
    getTyped: <T>(epoch: number, key: string, guard: (v: unknown) => v is T) => Promise<T | null>;
    set: (epoch: number, key: string, value: unknown) => Promise<void>;
    delete: (epoch: number, key: string) => Promise<void>;
};

export const createCacheNamespace = (
    cache: CacheInterface | null,
    namespace: string
): CacheNamespaceAccessor => ({
    get: (epoch, key) => cacheGet(cache, namespace, epoch, key),
    getTyped: (epoch, key, guard) => cacheGetTyped(cache, namespace, epoch, key, guard),
    set: (epoch, key, value) => cacheSet(cache, namespace, epoch, key, value),
    delete: (epoch, key) => cacheDelete(cache, namespace, epoch, key),
});

export type CacheEpochTracker = {
    noteEpoch: (epoch: number) => Promise<void>;
    noteEpochs: (epochs: readonly number[]) => Promise<void>;
};

export const createCacheEpochTracker = (
    cache: CacheInterface | null,
    options: {
        maxSavedEpochs: number;
        persistentEpoch?: number;
    }
): CacheEpochTracker => {
    const queue = new Queue<number>();
    const queuedEpochs = new Set<number>();
    const persistentEpoch = options.persistentEpoch ?? CACHE_PERSISTENT_EPOCH;

    const evictIfNeeded = async (): Promise<void> => {
        if (options.maxSavedEpochs <= 0) return;
        while (queue.size > options.maxSavedEpochs) {
            const evicted = queue.dequeue();
            if (evicted === undefined) break;
            queuedEpochs.delete(evicted);
            await cacheClear(cache, evicted);
        }
    };

    const noteEpoch = async (epoch: number): Promise<void> => {
        if (!cache) return;
        if (!Number.isFinite(epoch) || epoch < 0) return;
        if (epoch === persistentEpoch) return;
        if (options.maxSavedEpochs <= 0) {
            await cacheClear(cache, epoch);
            return;
        }
        if (queuedEpochs.has(epoch)) return;
        queuedEpochs.add(epoch);
        queue.enqueue(epoch);
        await evictIfNeeded();
    };

    const noteEpochs = async (epochs: readonly number[]): Promise<void> => {
        for (const epoch of epochs) {
            await noteEpoch(epoch);
        }
    };

    return { noteEpoch, noteEpochs };
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
