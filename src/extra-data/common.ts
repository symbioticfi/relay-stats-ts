import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import type { KeyTag, ValidatorSet } from '../types/index.js';
import { KeyType, getKeyType } from '../types/index.js';
import { compressAggregatedG1, compressRawG1, parseKeyToPoint } from '../utils/bn254.js';
import { FIELD_MODULUS, mimcBn254Hash } from '../utils/mimc.js';
import { hexToBytes } from '../utils/ssz.js';
import { EXTRA_PREFIX } from '../constants.js';
import { bigintToBytes32, bytesToBigint, bytesToLimbs, sortHexAsc } from '../utils/core.js';

export const keccakName = (name: string): Hex => {
  const hex = `0x${Buffer.from(name, 'utf8').toString('hex')}` as Hex;
  return keccak256(hex);
};

export const computeExtraDataKey = (verificationType: number, name: string): Hex => {
  const encoded = encodeAbiParameters(
    [
      { name: 'vt', type: 'uint32' },
      { name: 'name', type: 'bytes32' },
    ],
    [verificationType, keccakName(name)],
  );
  return keccak256(encoded);
};

export const computeExtraDataKeyTagged = (verificationType: number, tag: number, name: string): Hex => {
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
};

export const modField = (value: bigint): bigint => {
  const remainder = value % FIELD_MODULUS;
  return remainder >= 0n ? remainder : remainder + FIELD_MODULUS;
};

export const filterBlsBn254Tags = (keyTags: readonly KeyTag[]): readonly KeyTag[] => {
  const tags: KeyTag[] = [];
  for (const tag of keyTags) {
    if (getKeyType(tag) === KeyType.KeyTypeBlsBn254) {
      tags.push(tag);
    }
  }
  return tags;
};

type ValidatorTuple = { keySerialized: Hex; votingPower: bigint };

export const collectValidatorsForSimple = (
  validatorSet: ValidatorSet,
  tag: number,
): { validatorTuples: ValidatorTuple[]; aggregatedKeyCompressed: Hex } => {
  const tuples: ValidatorTuple[] = [];
  const activeKeys: Hex[] = [];

  for (const validator of validatorSet.validators) {
    if (!validator.isActive) continue;

    let payload: Hex | null = null;
    for (const key of validator.keys) {
      if (key.tag === tag) {
        payload = key.payload;
        break;
      }
    }

    if (!payload) {
      throw new Error(`Failed to find key by keyTag ${tag} for validator ${validator.operator}`);
    }

    tuples.push({
      keySerialized: compressRawG1(payload),
      votingPower: validator.votingPower,
    });
    activeKeys.push(payload);
  }

  tuples.sort((left, right) =>
    left.keySerialized < right.keySerialized
      ? -1
      : left.keySerialized > right.keySerialized
        ? 1
        : 0,
  );

  return {
    validatorTuples: tuples,
    aggregatedKeyCompressed: compressAggregatedG1(activeKeys),
  };
};

export type ZkValidatorTuple = ValidatorTuple & { x: bigint; y: bigint };

export const collectValidatorsForZk = (
  validatorSet: ValidatorSet,
  tag: number,
): readonly ZkValidatorTuple[] => {
  const tuples: ZkValidatorTuple[] = [];

  for (const validator of validatorSet.validators) {
    if (!validator.isActive) continue;

    let payload: Hex | null = null;
    for (const key of validator.keys) {
      if (key.tag === tag) {
        payload = key.payload;
        break;
      }
    }

    if (!payload) {
      throw new Error(`Failed to find key by keyTag ${tag} for validator ${validator.operator}`);
    }

    const point = parseKeyToPoint(payload);
    if (point === null) {
      throw new Error(`Validator ${validator.operator} key resolves to point at infinity`);
    }

    tuples.push({
      keySerialized: compressRawG1(payload),
      votingPower: validator.votingPower,
      x: modField(point.x),
      y: modField(point.y),
    });
  }

  tuples.sort((left, right) => {
    if (left.x === right.x && left.y === right.y) return 0;
    const leftBeforeRight = left.x < right.x || left.y < right.y;
    return leftBeforeRight ? -1 : 1;
  });

  return tuples;
};

export const keccakValidatorsData = (tuples: readonly ValidatorTuple[]): Hex => {
  const encoded = encodeAbiParameters(
    [
      {
        name: 'validators',
        type: 'tuple[]',
        components: [
          { name: 'keySerialized', type: 'bytes' },
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
  const tail = encodedBytes.slice(32);
  return keccak256(tail);
};

export const mimcHashValidators = async (tuples: readonly ZkValidatorTuple[]): Promise<Hex> => {
  if (tuples.length === 0) {
    return `0x${'0'.repeat(64)}` as Hex;
  }

  let state = 0n;

  for (const validator of tuples) {
    if (validator.x === 0n && validator.y === 0n) break;

    const xLimbs = bytesToLimbs(bigintToBytes32(validator.x), 8);
    const yLimbs = bytesToLimbs(bigintToBytes32(validator.y), 8);
    const votingPowerField = bytesToBigint(bigintToBytes32(validator.votingPower));

    for (const limb of [...xLimbs, ...yLimbs]) {
      state = modField(mimcBn254Hash(state, limb));
    }

    state = modField(mimcBn254Hash(state, votingPowerField));
  }

  const finalHash = modField(state);
  const bytes = bigintToBytes32(finalHash);
  return `0x${Buffer.from(bytes).toString('hex')}` as Hex;
};

export const sortExtraData = <T extends { key: Hex }>(items: readonly T[]): T[] =>
  sortHexAsc(items);
