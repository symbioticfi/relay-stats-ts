import type { AggregatorExtraDataEntry } from '../types/index.js';
import { EXTRA_NAME } from '../constants.js';
import {
  collectValidatorsForZk,
  computeExtraDataKey,
  computeExtraDataKeyTagged,
  filterBlsBn254Tags,
  mimcHashValidators,
  sortExtraData,
} from './common.js';
import type { ValidatorSet } from '../types/index.js';

/** @notice Build zk-mode aggregator extra data for BLS BN254 validators. */
export const buildZkExtraData = async (
  validatorSet: ValidatorSet,
  keyTags: readonly number[],
): Promise<AggregatorExtraDataEntry[]> => {
  const entries: AggregatorExtraDataEntry[] = [];
  const totalActive = validatorSet.validators.filter((validator) => validator.isActive).length;

  const totalActiveKey = computeExtraDataKey(0, EXTRA_NAME.ZK_TOTAL_ACTIVE);
  const totalActiveBytes = `0x${totalActive.toString(16).padStart(64, '0')}` as const;
  entries.push({ key: totalActiveKey, value: totalActiveBytes });

  const filteredTags = filterBlsBn254Tags(keyTags);
  for (const tag of filteredTags) {
    const tuples = collectValidatorsForZk(validatorSet, tag);
    if (tuples.length === 0) continue;

    const mimcAccumulator = await mimcHashValidators(tuples);
    const validatorsKey = computeExtraDataKeyTagged(0, tag, EXTRA_NAME.ZK_VALIDATORS_MIMC);
    entries.push({ key: validatorsKey, value: mimcAccumulator });
  }

  return sortExtraData(entries);
};
