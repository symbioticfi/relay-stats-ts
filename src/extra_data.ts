import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import type { AggregatorExtraDataEntry, ValidatorSet } from './types.js';
import { compressAggregatedG1, compressRawG1 } from './bls_bn254.js';
import { hexToBytes } from './ssz.js';
import { EXTRA_NAME, EXTRA_PREFIX } from './constants.js';

// Names mirror relay constants for deterministic key derivation

// Key derivation helpers (TS analogs of helpers.GetExtraDataKey* in relay)
function keccakName(name: string): Hex {
  const hex = ('0x' + Buffer.from(name, 'utf8').toString('hex')) as Hex;
  return keccak256(hex);
}

function computeExtraDataKey(verificationType: number, name: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'vt', type: 'uint32' },
        { name: 'name', type: 'bytes32' },
      ],
      [verificationType, keccakName(name)],
    ),
  );
}

function computeExtraDataKeyTagged(verificationType: number, tag: number, name: string): Hex {
  const prefix = keccakName(EXTRA_PREFIX.TAG);
  const nameHash = keccakName(name);
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'vt', type: 'uint32' },
        { name: 'prefix', type: 'bytes32' },
        { name: 'tag', type: 'uint8' },
        { name: 'name', type: 'bytes32' },
      ],
      [verificationType, prefix, tag, nameHash],
    ),
  );
}

function bytes8ToBigInt(b: Uint8Array): bigint {
  return BigInt('0x' + Buffer.from(b).toString('hex'));
}

function collectValidatorsForTag(
  vset: ValidatorSet,
  tag: number,
): {
  validatorTuples: { keySerialized: Hex; votingPower: bigint; raw: Hex }[];
  aggregatedKeyCompressed: Hex;
} {
  const tuples: { keySerialized: Hex; votingPower: bigint; raw: Hex }[] = [];
  const activeKeys: Hex[] = [] as Hex[];
  for (const val of vset.validators) {
    if (!val.isActive) continue;
    for (const k of val.keys) {
      if (k.tag === tag) {
        const keySerialized = compressRawG1(k.payload);
        tuples.push({ keySerialized, votingPower: val.votingPower, raw: k.payload });
        activeKeys.push(k.payload);
        break;
      }
    }
  }
  // Sort by keySerialized ascending
  tuples.sort((a, b) =>
    a.keySerialized < b.keySerialized ? -1 : a.keySerialized > b.keySerialized ? 1 : 0,
  );
  const aggregatedKeyCompressed = compressAggregatedG1(activeKeys);
  return { validatorTuples: tuples, aggregatedKeyCompressed };
}

function keccakValidatorsData(tuples: { keySerialized: Hex; votingPower: bigint }[]): Hex {
  const arr: { keySerialized: Hex; VotingPower: bigint }[] = tuples.map((t) => ({
    keySerialized: t.keySerialized,
    VotingPower: t.votingPower,
  }));
  const encoded = encodeAbiParameters(
    [
      {
        name: 'validators',
        type: 'tuple[]',
        components: [
          { name: 'keySerialized', type: 'bytes32' },
          { name: 'VotingPower', type: 'uint256' },
        ],
      },
    ],
    [arr],
  );
  const bytes = hexToBytes(encoded);
  const body = bytes.slice(32);
  return keccak256(('0x' + Buffer.from(body).toString('hex')) as Hex);
}

async function mimcHashValidators(
  tuples: { keySerialized: Hex; votingPower: bigint; raw: Hex }[],
): Promise<Hex> {
  // Load circomlibjs in ESM-safe way
  const moduleName: string = 'circomlibjs';
  const mod: unknown = await import(moduleName);
  // The package is CommonJS; ESM default interop varies by runtime
  const circomlib = mod as Record<string, unknown> as Record<string, unknown> & {
    default?: Record<string, unknown>;
  };
  const resolved = (circomlib.default ?? circomlib) as {
    mimc7: { multiHash: (arr: Array<bigint | number>, key: bigint) => unknown };
  };
  const mimc = resolved.mimc7;
  const inputs: bigint[] = [];
  for (const t of tuples) {
    const rawBytes = hexToBytes(t.raw);
    if (rawBytes.length < 64) continue;
    const xBytes = rawBytes.slice(rawBytes.length - 64, rawBytes.length - 32);
    const yBytes = rawBytes.slice(rawBytes.length - 32);
    inputs.push(bytes8ToBigInt(xBytes.slice(24, 32)));
    inputs.push(bytes8ToBigInt(xBytes.slice(16, 24)));
    inputs.push(bytes8ToBigInt(xBytes.slice(8, 16)));
    inputs.push(bytes8ToBigInt(xBytes.slice(0, 8)));
    inputs.push(bytes8ToBigInt(yBytes.slice(24, 32)));
    inputs.push(bytes8ToBigInt(yBytes.slice(16, 24)));
    inputs.push(bytes8ToBigInt(yBytes.slice(8, 16)));
    inputs.push(bytes8ToBigInt(yBytes.slice(0, 8)));
    const vpBytes = new Uint8Array(32);
    const vpHex = t.votingPower.toString(16).padStart(64, '0');
    vpBytes.set(Buffer.from(vpHex, 'hex'));
    inputs.push(bytes8ToBigInt(vpBytes.slice(24, 32)));
    inputs.push(bytes8ToBigInt(vpBytes.slice(16, 24)));
    inputs.push(bytes8ToBigInt(vpBytes.slice(8, 16)));
    inputs.push(bytes8ToBigInt(vpBytes.slice(0, 8)));
  }
  const outUnknown: unknown = mimc.multiHash(inputs, 0n);
  const bi: bigint =
    typeof outUnknown === 'bigint'
      ? outUnknown
      : BigInt((outUnknown as { toString: () => string }).toString());
  return ('0x' + bi.toString(16).padStart(64, '0')) as Hex;
}

export function buildSimpleExtraData(
  vset: ValidatorSet,
  keyTags: number[],
): AggregatorExtraDataEntry[] {
  const entries: AggregatorExtraDataEntry[] = [];
  for (const tag of keyTags) {
    const { validatorTuples, aggregatedKeyCompressed } = collectValidatorsForTag(vset, tag);
    if (validatorTuples.length === 0) continue;
    const validatorsKeccak = keccakValidatorsData(validatorTuples);
    const setHashKey = computeExtraDataKeyTagged(1, tag, EXTRA_NAME.SIMPLE_VALIDATORS_KECCAK);
    entries.push({ key: setHashKey, value: validatorsKeccak });
    const aggKeyKey = computeExtraDataKeyTagged(1, tag, EXTRA_NAME.SIMPLE_AGG_G1);
    entries.push({ key: aggKeyKey, value: aggregatedKeyCompressed });
  }
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export async function buildZkExtraData(
  vset: ValidatorSet,
  keyTags: number[],
): Promise<AggregatorExtraDataEntry[]> {
  const entries: AggregatorExtraDataEntry[] = [];
  const totalActive = vset.validators.filter((v) => v.isActive).length;
  const totalActiveHex = ('0x' + totalActive.toString(16).padStart(64, '0')) as Hex;
  const totalKey = computeExtraDataKey(2, EXTRA_NAME.ZK_TOTAL_ACTIVE);
  entries.push({ key: totalKey, value: totalActiveHex });

  // Use the first required tag as MiMC input baseline
  const firstTag = keyTags[0];
  if (firstTag !== undefined) {
    const tuples = collectValidatorsForTag(vset, firstTag).validatorTuples;
    if (tuples.length > 0) {
      const mimcHash = await mimcHashValidators(tuples);
      const setHashKey = computeExtraDataKey(2, EXTRA_NAME.ZK_VALIDATORS_MIMC);
      entries.push({ key: setHashKey, value: mimcHash });
    }
  }

  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
