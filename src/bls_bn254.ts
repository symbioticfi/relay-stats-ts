import type { Hex } from 'viem';
import { keccak256 } from 'viem';

// Minimal BN254 (altbn128) helpers for G1 in affine coordinates.
// This is a lightweight implementation sufficient for building extraData only.

const FP_MODULUS = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);
// (p+1)/4 used for Tonelli-Shanks on BN254 (as in the Go code)
const SQRT_EXPONENT = BigInt('0x0c19139cb84c680a6e14116da060561765e05aa45a1c72a34f082305b61f3f52');

function mod(a: bigint, m: bigint = FP_MODULUS): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

// reserved helpers (kept simple for clarity)

function modMul(a: bigint, b: bigint): bigint {
  return mod(a * b);
}

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = modMul(result, b);
    b = modMul(b, b);
    e >>= 1n;
  }
  return result;
}

function modInv(a: bigint): bigint {
  // a^(p-2) mod p for prime field
  return modPow(mod(a), FP_MODULUS - 2n);
}

function fromHex(hex: Hex): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error('Invalid hex');
  return new Uint8Array(Buffer.from(h, 'hex'));
}

function toHex(bytes: Uint8Array): Hex {
  return ('0x' + Buffer.from(bytes).toString('hex')) as Hex;
}

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  return BigInt('0x' + Buffer.from(bytes).toString('hex'));
}

function bigIntToBytes32BE(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  const hex = x.toString(16).padStart(64, '0');
  out.set(Buffer.from(hex, 'hex'));
  return out;
}

export type G1 = { x: bigint; y: bigint } | null; // null represents infinity

function isInfinity(p: G1): p is null {
  return p === null;
}

// equality not required by current usage

// y^2 = x^3 + 3 mod p
function curveRhs(x: bigint): bigint {
  return mod(modMul(modMul(x, x), x) + 3n);
}

function sqrtFp(beta: bigint): bigint {
  // BN254 has p % 4 == 3, so sqrt = beta^((p+1)/4)
  return modPow(beta, SQRT_EXPONENT);
}

export function findYFromX(x: bigint): bigint {
  const beta = curveRhs(x);
  return sqrtFp(beta);
}

export function compressG1FromXY(x: bigint, y: bigint): Hex {
  const derivedY = findYFromX(x);
  const flag = y !== derivedY ? 1n : 0n;
  const compressed = mod(2n * x + flag);
  return toHex(bigIntToBytes32BE(compressed));
}

export function parseG1Uncompressed(raw: Hex): G1 {
  const bytes = fromHex(raw);
  if (bytes.length < 64) throw new Error('Expected 64-byte uncompressed G1');
  const x = bytesToBigIntBE(bytes.subarray(bytes.length - 64, bytes.length - 32));
  const y = bytesToBigIntBE(bytes.subarray(bytes.length - 32));
  return { x: mod(x), y: mod(y) };
}

// negation not required by current usage

function pointDouble(p: G1): G1 {
  if (isInfinity(p)) return p;
  if (p.y === 0n) return null;
  const lambda = modMul(3n * modMul(p.x, p.x), modInv(2n * p.y));
  const xr = mod(lambda * lambda - 2n * p.x);
  const yr = mod(lambda * (p.x - xr) - p.y);
  return { x: xr, y: yr };
}

export function pointAdd(a: G1, b: G1): G1 {
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
}

export function aggregateG1(keys: Hex[]): G1 {
  let acc: G1 = null;
  for (const k of keys) {
    const p = parseKeyToPoint(k);
    acc = pointAdd(acc, p);
  }
  return acc;
}

export function compressAggregatedG1(keys: Hex[]): Hex {
  const p = aggregateG1(keys);
  if (p === null) return ('0x' + '00'.repeat(32)) as Hex;
  return compressG1FromXY(p.x, p.y);
}

export function compressRawG1(raw: Hex): Hex {
  const p = parseKeyToPoint(raw);
  if (p === null) return ('0x' + '00'.repeat(32)) as Hex;
  return compressG1FromXY(p.x, p.y);
}

export function keccak(bytes: Uint8Array): Hex {
  return keccak256(toHex(bytes));
}

function parseCompressedToPoint(raw: Hex): G1 {
  const bytes = fromHex(raw);
  if (bytes.length !== 32) throw new Error('Expected 32-byte compressed G1');
  const v = bytesToBigIntBE(bytes);
  const x = v >> 1n;
  const flag = v & 1n;
  let y = findYFromX(x);
  if (flag === 1n) {
    y = mod(-y);
  }
  return { x: mod(x), y };
}

export function parseKeyToPoint(raw: Hex): G1 {
  const bytes = fromHex(raw);
  if (bytes.length >= 64) return parseG1Uncompressed(raw);
  if (bytes.length === 32) return parseCompressedToPoint(raw);
  throw new Error('Unsupported G1 key length');
}
