import { bytesToBigInt, bytesToHex, hexToBytes, keccak256, toBytes, type Hex } from 'viem';

const FP_MODULUS = BigInt('0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47');
const SQRT_EXPONENT = BigInt('0xc19139cb84c680a6e14116da060561765e05aa45a1c72a34f082305b61f3f52');

const mod = (a: bigint, m: bigint = FP_MODULUS): bigint => {
    const r = a % m;
    return r >= 0n ? r : r + m;
};

const modMul = (a: bigint, b: bigint): bigint => mod(a * b);

const modPow = (base: bigint, exp: bigint): bigint => {
    let result = 1n;
    let b = mod(base);
    let e = exp;
    while (e > 0n) {
        if (e & 1n) result = modMul(result, b);
        b = modMul(b, b);
        e >>= 1n;
    }
    return result;
};

const modInv = (a: bigint): bigint => modPow(mod(a), FP_MODULUS - 2n);

/** @notice Affine BN254 G1 point (null = point at infinity). */
export type G1 = { x: bigint; y: bigint } | null;

const isInfinity = (p: G1): p is null => p === null;

/** @notice Recover Y coordinate from X on BN254 curve (p+1)/4 exponentiation). */
export const findYFromX = (x: bigint): bigint => {
    const beta = mod(modPow(mod(x), 3n) + 3n);
    return modPow(beta, SQRT_EXPONENT);
};

/** @notice Compress affine point into 32-byte G1 encoding with sign bit. */
export const compressG1FromXY = (x: bigint, y: bigint): Hex => {
    const xMod = mod(x);
    const yMod = mod(y);
    const derivedY = findYFromX(xMod);

    let flag = 1n;
    if (yMod === derivedY) {
        flag = 0n;
    }
    const compressed = 2n * xMod + flag;

    return bytesToHex(toBytes(compressed, { size: 32 }));
};

/** @notice Parse uncompressed 64-byte G1 encoding into affine point. */
export const parseG1Uncompressed = (raw: Hex): G1 => {
    const bytes = hexToBytes(raw);
    if (bytes.length < 64) throw new Error('Expected 64-byte uncompressed G1');
    const x = bytesToBigInt(bytes.slice(0, 32));
    const y = bytesToBigInt(bytes.slice(32, 64));
    return { x: mod(x), y: mod(y) };
};

const pointDouble = (p: G1): G1 => {
    if (isInfinity(p)) return p;
    if (p.y === 0n) return null;
    const lambda = modMul(3n * modMul(p.x, p.x), modInv(2n * p.y));
    const xr = mod(lambda * lambda - 2n * p.x);
    const yr = mod(lambda * (p.x - xr) - p.y);
    return { x: xr, y: yr };
};

/** @notice Add two G1 points (handles infinity). */
export const pointAdd = (a: G1, b: G1): G1 => {
    if (isInfinity(a)) return b;
    if (isInfinity(b)) return a;
    if (a.x === b.x) {
        if (mod(a.y + b.y) === 0n) return null;
        return pointDouble(a);
    }
    const lambda = modMul(b.y - a.y, modInv(b.x - a.x));
    const xr = mod(lambda * lambda - a.x - b.x);
    const yr = mod(lambda * (a.x - xr) - a.y);
    return { x: xr, y: yr };
};

/** @notice Sum many G1 keys into a single affine accumulator. */
export const aggregateG1 = (keys: Hex[]): G1 => {
    let acc: G1 = null;
    for (const k of keys) {
        const p = parseKeyToPoint(k);
        acc = pointAdd(acc, p);
    }
    return acc;
};

/** @notice Aggregate and compress many G1 keys, returning compressed bytes. */
export const compressAggregatedG1 = (keys: Hex[]): Hex => {
    const p = aggregateG1(keys);
    if (p === null) return ('0x' + '00'.repeat(32)) as Hex;
    return compressG1FromXY(p.x, p.y);
};

/** @notice Compress a raw (compressed or uncompressed) G1 key. */
export const compressRawG1 = (raw: Hex): Hex => {
    const p = parseKeyToPoint(raw);
    if (p === null) return ('0x' + '00'.repeat(32)) as Hex;
    return compressG1FromXY(p.x, p.y);
};

/** @notice Compute Keccak256 of bytes, returning a hex string. */
export const keccak = (bytes: Uint8Array): Hex => keccak256(bytesToHex(bytes));

const parseCompressedToPoint = (raw: Hex): G1 => {
    const bytes = hexToBytes(raw);
    if (bytes.length !== 32) throw new Error('Expected 32-byte compressed G1');
    const v = bytesToBigInt(bytes);
    const x = v >> 1n;
    const flag = v & 1n;
    let y = findYFromX(x);
    if (flag === 1n) {
        y = mod(-y);
    }
    return { x: mod(x), y };
};

/** @notice Parse a compressed or uncompressed G1 key into an affine point. */
export const parseKeyToPoint = (raw: Hex): G1 => {
    const bytes = hexToBytes(raw);
    if (bytes.length >= 64) return parseG1Uncompressed(raw);
    if (bytes.length === 32) return parseCompressedToPoint(raw);
    throw new Error('Unsupported G1 key length');
};
