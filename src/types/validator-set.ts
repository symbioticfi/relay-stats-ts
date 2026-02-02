import type { Hex } from 'viem';
import type { Validator } from './validator.js';

/** @notice Full validator set payload (governed by the driver). */
export interface ValidatorSet {
    version: number;
    requiredKeyTag: number;
    epoch: number;
    captureTimestamp: number;
    quorumThreshold: bigint;
    validators: Validator[];
    totalVotingPower: bigint;
    status: 'committed' | 'pending' | 'missing';
    integrity: 'valid' | 'invalid';
    extraData: ValSetExtraData[];
}

/** @notice Aggregator extra-data entry (bytes32 key/value). */
export interface AggregatorExtraDataEntry {
    key: Hex;
    value: Hex;
}

export type ValSetExtraData = AggregatorExtraDataEntry;

/** @notice Compact header committed on settlements (hash/SSZ root + metadata). */
export interface ValidatorSetHeader {
    version: number;
    requiredKeyTag: number;
    epoch: number;
    captureTimestamp: number;
    quorumThreshold: bigint;
    totalVotingPower: bigint;
    validatorsSszMRoot: Hex;
}
