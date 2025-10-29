import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import type { AggregatorExtraDataEntry, KeyTag, ValidatorSet } from './types.js';
import { KeyType, getKeyType } from './types.js';
import { compressAggregatedG1, compressRawG1, parseKeyToPoint } from './bls_bn254.js';
import { FIELD_MODULUS, mimcBn254Hash } from './mimc_bn254.js';
import { hexToBytes } from './encoding.js';
import { EXTRA_NAME, EXTRA_PREFIX } from './constants.js';
import { bigintToBytes32, bytesToBigint, bytesToLimbs, sortHexAsc } from './utils.js';

const keccakName = (name: string): Hex => {
  const hex = `0x${Buffer.from(name, 'utf8').toString('hex')}` as Hex;
  return keccak256(hex);
};

const computeExtraDataKey = (verificationType: number, name: string): Hex => {
  const encoded = encodeAbiParameters(
    [
      { name: 'vt', type: 'uint32' },
      { name: 'name', type: 'bytes32' },
    ],
    [verificationType, keccakName(name)],
  );
  return keccak256(encoded);
};

const computeExtraDataKeyTagged = (verificationType: number, tag: number, name: string): Hex => {
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

const modField = (value: bigint): bigint => {
  const remainder = value % FIELD_MODULUS;
  return remainder >= 0n ? remainder : remainder + FIELD_MODULUS;
};

const filterBlsBn254Tags = (keyTags: readonly KeyTag[]): readonly KeyTag[] => {
  const tags: KeyTag[] = [];
  for (const tag of keyTags) {
    if (getKeyType(tag) === KeyType.KeyTypeBlsBn254) {
      tags.push(tag);
    }
  }
  return tags;
};

type ValidatorTuple = { keySerialized: Hex; votingPower: bigint };

const collectValidatorsForSimple = (
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

type ZkValidatorTuple = ValidatorTuple & { x: bigint; y: bigint };

const collectValidatorsForZk = (
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

const keccakValidatorsData = (tuples: readonly ValidatorTuple[]): Hex => {
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

const mimcHashValidators = async (tuples: readonly ZkValidatorTuple[]): Promise<Hex> => {
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

export const buildSimpleExtraData = (
  validatorSet: ValidatorSet,
  keyTags: readonly number[],
): AggregatorExtraDataEntry[] => {
  const entries: AggregatorExtraDataEntry[] = [];
  const filteredTags = filterBlsBn254Tags(keyTags);

  for (const tag of filteredTags) {
    const { validatorTuples, aggregatedKeyCompressed } = collectValidatorsForSimple(
      validatorSet,
      tag,
    );
    if (validatorTuples.length === 0) continue;

    const validatorsKeccak = keccakValidatorsData(validatorTuples);
    const validatorKey = computeExtraDataKeyTagged(1, tag, EXTRA_NAME.SIMPLE_VALIDATORS_KECCAK);
    entries.push({ key: validatorKey, value: validatorsKeccak });

    const aggregatedKey = computeExtraDataKeyTagged(1, tag, EXTRA_NAME.SIMPLE_AGG_G1);
    entries.push({ key: aggregatedKey, value: aggregatedKeyCompressed });
  }

  return sortHexAsc(entries);
};

export const buildZkExtraData = async (
  validatorSet: ValidatorSet,
  keyTags: readonly number[],
): Promise<AggregatorExtraDataEntry[]> => {
  const entries: AggregatorExtraDataEntry[] = [];
  const totalActive = validatorSet.validators.filter((validator) => validator.isActive).length;

  const totalActiveKey = computeExtraDataKey(0, EXTRA_NAME.ZK_TOTAL_ACTIVE);
  const totalActiveBytes = `0x${totalActive.toString(16).padStart(64, '0')}` as Hex;
  entries.push({ key: totalActiveKey, value: totalActiveBytes });

  const filteredTags = filterBlsBn254Tags(keyTags);
  for (const tag of filteredTags) {
    const tuples = collectValidatorsForZk(validatorSet, tag);
    if (tuples.length === 0) continue;

    const mimcAccumulator = await mimcHashValidators(tuples);
    const validatorsKey = computeExtraDataKeyTagged(0, tag, EXTRA_NAME.ZK_VALIDATORS_MIMC);
    entries.push({ key: validatorsKey, value: mimcAccumulator });
  }

  return sortHexAsc(entries);
};
