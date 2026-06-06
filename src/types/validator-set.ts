import type { Hex } from 'viem';
import type { Validator } from './validator.js';

/** @notice Validator set payload derived from the driver. */
export interface ValidatorSet {
    version: number;
    requiredKeyTag: number;
    epoch: number;
    captureTimestamp: number;
    quorumThreshold: bigint;
    /** Active validators, sorted by operator address. */
    validators: Validator[];
    /** Full validator set, including inactive validators, when available. */
    allValidators?: Validator[];
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
