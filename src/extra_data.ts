import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import type { AggregatorExtraDataEntry, ValidatorSet, KeyTag } from './types.js';
import { KeyType, getKeyType } from './types.js';
import { compressAggregatedG1, compressRawG1, parseKeyToPoint } from './bls_bn254.js';
import { hexToBytes } from './ssz.js';
import { EXTRA_NAME, EXTRA_PREFIX } from './constants.js';
import { FIELD_MODULUS, mimcBn254Hash } from './mimc_bn254.js';

// Names mirror relay constants for deterministic key derivation

// Key derivation helpers (TS analogs of helpers.GetExtraDataKey* in relay)
function keccakName(name: string): Hex {
  const hex = ('0x' + Buffer.from(name, 'utf8').toString('hex')) as Hex;
  return keccak256(hex);
}

function computeExtraDataKey(verificationType: number, name: string): Hex {
  const encoded = encodeAbiParameters(
    [
      { name: 'vt', type: 'uint32' },
      { name: 'name', type: 'bytes32' },
    ],
    [verificationType, keccakName(name)],
  );
  return keccak256(encoded);
}

function computeExtraDataKeyTagged(verificationType: number, tag: number, name: string): Hex {
  const prefix = keccakName(EXTRA_PREFIX.TAG);
  const nameHash = keccakName(name);
  const encoded = encodeAbiParameters(
    [
      { name: 'vt', type: 'uint32' },
      { name: 'prefix', type: 'bytes32' },
      { name: 'tag', type: 'uint8' },
      { name: 'name', type: 'bytes32' },
    ],
    [verificationType, prefix, tag, nameHash],
  );
  return keccak256(encoded);
}

function bigintToBytes32(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, '0');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return BigInt('0x' + hex);
}

function bytesToLimbs(bytes: Uint8Array): bigint[] {
  const limbs: bigint[] = [];
  for (let i = 24; i >= 0; i -= 8) {
    const chunk = bytes.slice(i, i + 8);
    limbs.push(bytesToBigint(chunk));
  }
  return limbs;
}

function modField(value: bigint): bigint {
  const r = value % FIELD_MODULUS;
  return r >= 0n ? r : r + FIELD_MODULUS;
}

/**
 * Filter key tags to only include BLS BN254 keys for aggregation
 * Only BLS BN254 keys should be aggregated and extra dataed
 */
function filterBlsBn254Tags(keyTags: KeyTag[]): KeyTag[] {
  const needToAggregateTags: KeyTag[] = [];
  for (const tag of keyTags) {
    // only bn254 bls for now
    if (getKeyType(tag) === KeyType.KeyTypeBlsBn254) {
      needToAggregateTags.push(tag);
    }
  }
  return needToAggregateTags;
}

// Simple mode: collect validators with compressed G1 keys, sorted by keySerialized
function collectValidatorsForSimple(
  vset: ValidatorSet,
  tag: number,
): {
  validatorTuples: { keySerialized: Hex; votingPower: bigint }[];
  aggregatedKeyCompressed: Hex;
} {
  const tuples: { keySerialized: Hex; votingPower: bigint }[] = [];
  const activeKeys: Hex[] = [] as Hex[];
  for (const val of vset.validators) {
    if (!val.isActive) {
      continue;
    }

    let foundKey: Hex | null = null;
    for (const k of val.keys) {
      if (k.tag === tag) {
        foundKey = k.payload;
        break;
      }
    }

    if (!foundKey) {
      throw new Error(`Failed to find key by keyTag ${tag} for validator ${val.operator}`);
    }

    const keySerialized = compressRawG1(foundKey);
    tuples.push({ keySerialized, votingPower: val.votingPower });
    activeKeys.push(foundKey);
  }
  tuples.sort((a, b) =>
    a.keySerialized < b.keySerialized ? -1 : a.keySerialized > b.keySerialized ? 1 : 0,
  );
  const aggregatedKeyCompressed = compressAggregatedG1(activeKeys);
  return { validatorTuples: tuples, aggregatedKeyCompressed };
}

// ZK mode: collect validators for MiMC hashing (different from simple)
type ZkValidatorTuple = {
  keySerialized: Hex;
  votingPower: bigint;
  x: bigint;
  y: bigint;
};

function collectValidatorsForZk(
  vset: ValidatorSet,
  tag: number,
): ZkValidatorTuple[] {
  const tuples: ZkValidatorTuple[] = [];

  for (const val of vset.validators) {
    if (!val.isActive) continue;

    let foundKey: Hex | null = null;
    for (const k of val.keys) {
      if (k.tag === tag) {
        foundKey = k.payload;
        break;
      }
    }

    if (!foundKey) {
      throw new Error(`Failed to find key by keyTag ${tag} for validator ${val.operator}`);
    }

    const point = parseKeyToPoint(foundKey);
    if (point === null) {
      throw new Error(`Validator ${val.operator} key resolves to point at infinity`);
    }

    tuples.push({
      keySerialized: compressRawG1(foundKey),
      votingPower: val.votingPower,
      x: modField(point.x),
      y: modField(point.y),
    });
  }

  tuples.sort((a, b) => {
    if (a.x === b.x && a.y === b.y) return 0;
    const leftBeforeRight = a.x < b.x || a.y < b.y;
    return leftBeforeRight ? -1 : 1;
  });

  return tuples;
}

function keccakValidatorsData(
  tuples: { keySerialized: Hex; votingPower: bigint }[],
): Hex {
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
    [
      tuples.map((tuple) => ({
        keySerialized: tuple.keySerialized,
        VotingPower: tuple.votingPower,
      })),
    ],
  );

  const encodedBytes = hexToBytes(encoded);
  const withoutOffset = encodedBytes.slice(32);
  // encodeAbiParameters returns offsets in the first 32 bytes; the Go code hashes the tail as raw bytes
  return keccak256(withoutOffset);
}

async function mimcHashValidators(tuples: ZkValidatorTuple[]): Promise<Hex> {
  if (tuples.length === 0) {
    return ('0x' + '0'.repeat(64)) as Hex;
  }

  let state = 0n;

  for (const validator of tuples) {
    if (validator.x === 0n && validator.y === 0n) break;

    const xLimbs = bytesToLimbs(bigintToBytes32(validator.x));
    const yLimbs = bytesToLimbs(bigintToBytes32(validator.y));
    const vpField = bytesToBigint(bigintToBytes32(validator.votingPower));

    for (const limb of [...xLimbs, ...yLimbs]) {
      state = modField(mimcBn254Hash(state, limb));
    }

    state = modField(mimcBn254Hash(state, vpField));
  }

  const finalHash = modField(state);
  const asBytes = bigintToBytes32(finalHash);
  return ('0x' + Buffer.from(asBytes).toString('hex')) as Hex;
}

export function buildSimpleExtraData(
  vset: ValidatorSet,
  keyTags: number[],
): AggregatorExtraDataEntry[] {
  const entries: AggregatorExtraDataEntry[] = [];
  // Filter to only BLS BN254 keys for aggregation
  const filteredTags = filterBlsBn254Tags(keyTags);
  
  for (const tag of filteredTags) {
    const { validatorTuples, aggregatedKeyCompressed } = collectValidatorsForSimple(vset, tag);
    if (validatorTuples.length === 0) continue;
    // Generate keccak hash of validators data (like Go: keccak(ValidatorsData))
    const validatorsKeccak = keccakValidatorsData(validatorTuples);
    const setHashKey = computeExtraDataKeyTagged(1, tag, EXTRA_NAME.SIMPLE_VALIDATORS_KECCAK);
    entries.push({ key: setHashKey, value: validatorsKeccak });
    
    // Add compressed aggregated G1 key (like Go: compressed aggregated G1 key)
    const aggKeyKey = computeExtraDataKeyTagged(1, tag, EXTRA_NAME.SIMPLE_AGG_G1);
    entries.push({ key: aggKeyKey, value: aggregatedKeyCompressed });
  }
  
  // Sort extra data by key to ensure deterministic order (like Go)
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export async function buildZkExtraData(
  vset: ValidatorSet,
  keyTags: number[],
): Promise<AggregatorExtraDataEntry[]> {
  const entries: AggregatorExtraDataEntry[] = [];
  
  // Add total active validators (like Go: totalActiveValidators)
  const totalActive = vset.validators.filter((v) => v.isActive).length;
  const totalActiveKey = computeExtraDataKey(0, EXTRA_NAME.ZK_TOTAL_ACTIVE);
  const totalActiveBytes32 = ('0x' + totalActive.toString(16).padStart(64, '0')) as Hex;
  entries.push({ key: totalActiveKey, value: totalActiveBytes32 });

  // Filter to only BLS BN254 keys for aggregation
  const filteredTags = filterBlsBn254Tags(keyTags);
  
  // Generate MiMC-based validator set hash for each key tag (like Go: aggregatedPubKeys loop)
  for (const tag of filteredTags) {
    const tuples = collectValidatorsForZk(vset, tag);
    if (tuples.length === 0) continue;

    // Generate MiMC accumulator (like Go: validatorSetMimcAccumulator)
    const mimcAccumulator = await mimcHashValidators(tuples);
    
    // Add validator set hash key (like Go: validatorSetHashKey)
    const validatorSetHashKey = computeExtraDataKeyTagged(0, tag, EXTRA_NAME.ZK_VALIDATORS_MIMC);
    entries.push({ key: validatorSetHashKey, value: mimcAccumulator });
  }

  // Sort extra data by key to ensure deterministic order (like Go)
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
