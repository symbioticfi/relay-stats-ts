import { bytesToBigInt, type Hex } from 'viem';

/** @notice Preferred block tag for reads (finalized or latest). */
export type BlockTagPreference = 'finalized' | 'latest';

/** @notice Convert finalized flag to a block tag value. */
export const blockTagFromFinality = (finalized: boolean): BlockTagPreference =>
    finalized ? 'finalized' : 'latest';

/** @notice Split bytes into bigint limbs of fixed size (from the end). */
export const bytesToLimbs = (bytes: Uint8Array, limbSize: number): readonly bigint[] => {
    if (limbSize <= 0) return [];
    const result: bigint[] = [];
    for (let offset = bytes.length - limbSize; offset >= 0; offset -= limbSize) {
        result.push(bytesToBigInt(bytes.slice(offset, offset + limbSize)));
    }
    return result;
};

/** @notice Sort hex-keyed entries ascending by key. */
export const sortHexAsc = <T extends { key: Hex }>(items: readonly T[]): T[] =>
    [...items].sort((a, b) => {
        if (a.key < b.key) return -1;
        if (a.key > b.key) return 1;
        return 0;
    });
