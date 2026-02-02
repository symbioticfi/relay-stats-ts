import { EXTRA_NAME } from '../constants.js';
import type { AggregatorExtraDataEntry, ValidatorSet } from '../types/index.js';
import {
    collectValidatorsForSimple,
    computeExtraDataKeyTagged,
    filterBlsBn254Tags,
    keccakValidatorsData,
    sortExtraData,
} from './common.js';

/** @notice Build simple-mode aggregator extra data for BLS BN254 validators. */
const SIMPLE_AGGREGATOR_TAG = 1;

export const buildSimpleExtraData = (
    validatorSet: ValidatorSet,
    keyTags: readonly number[]
): AggregatorExtraDataEntry[] => {
    const entries: AggregatorExtraDataEntry[] = [];
    const filteredTags = filterBlsBn254Tags(keyTags);

    for (const tag of filteredTags) {
        const { validatorTuples, aggregatedKeyCompressed } = collectValidatorsForSimple(
            validatorSet,
            tag
        );
        if (validatorTuples.length === 0) continue;

        const validatorsKeccak = keccakValidatorsData(validatorTuples);
        const validatorKey = computeExtraDataKeyTagged(
            SIMPLE_AGGREGATOR_TAG,
            tag,
            EXTRA_NAME.SIMPLE_VALIDATORS_KECCAK
        );
        entries.push({ key: validatorKey, value: validatorsKeccak });

        const aggregatedKey = computeExtraDataKeyTagged(
            SIMPLE_AGGREGATOR_TAG,
            tag,
            EXTRA_NAME.SIMPLE_AGG_G1
        );
        entries.push({ key: aggregatedKey, value: aggregatedKeyCompressed });
    }

    return sortExtraData(entries);
};
