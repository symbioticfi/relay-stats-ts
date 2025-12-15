import type { Hex } from 'viem';

/** @notice Preferred block tag for reads (finalized or latest). */
export type BlockTagPreference = 'finalized' | 'latest';

/** @notice Convert finalized flag to a block tag value. */
export const blockTagFromFinality = (finalized: boolean): BlockTagPreference =>
  finalized ? 'finalized' : 'latest';

/** @notice Convert bigint to fixed-length bytes. */
export const bigintToBytes = (value: bigint, size: number): Uint8Array => {
  const hex = value.toString(16).padStart(size * 2, '0');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
};

/** @notice Convert bigint to 32-byte array. */
export const bigintToBytes32 = (value: bigint): Uint8Array => bigintToBytes(value, 32);

/** @notice Convert bytes to bigint. */
export const bytesToBigint = (bytes: Uint8Array): bigint => {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return BigInt(`0x${hex || '0'}`);
};

/** @notice Split bytes into bigint limbs of fixed size (from the end). */
export const bytesToLimbs = (bytes: Uint8Array, limbSize: number): readonly bigint[] => {
  if (limbSize <= 0) return [];
  const result: bigint[] = [];
  for (let offset = bytes.length - limbSize; offset >= 0; offset -= limbSize) {
    result.push(bytesToBigint(bytes.slice(offset, offset + limbSize)));
  }
  return result;
};

/** @notice Sort hex-keyed entries ascending by key. */
export const sortHexAsc = <T extends { key: Hex }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

/** @notice Clamp a bigint within [lowerBound, upperBound] with buffer applied. */
export const clampWithinBuffer = (
  value: bigint,
  buffer: bigint,
  lowerBound: bigint,
  upperBound: bigint,
): bigint => {
  const min = value > buffer ? value - buffer : lowerBound;
  const max = value + buffer > upperBound ? upperBound : value + buffer;
  return max < min ? min : max;
};

/** @notice Compute buffered block range bounded by chain tip. */
export const toBlockRange = (
  fromEstimate: bigint,
  toEstimate: bigint,
  buffer: bigint,
  highestBlock: bigint,
): { fromBlock: bigint; toBlock: bigint } => {
  const bufferedFrom = fromEstimate > buffer ? fromEstimate - buffer : 0n;
  let bufferedTo = toEstimate + buffer;
  if (bufferedTo > highestBlock) bufferedTo = highestBlock;
  if (bufferedTo < bufferedFrom) bufferedTo = bufferedFrom;
  return { fromBlock: bufferedFrom, toBlock: bufferedTo };
};
