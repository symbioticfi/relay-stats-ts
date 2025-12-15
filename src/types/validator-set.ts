import type { Hex } from 'viem';
import type { Validator } from './validator.js';

/** @notice Full validator set payload (governed by the driver). */
export class ValidatorSet {
  constructor(
    public version: number,
    public requiredKeyTag: number,
    public epoch: number,
    public captureTimestamp: number,
    public quorumThreshold: bigint,
    public validators: Validator[],
    public totalVotingPower: bigint,
    public status: 'committed' | 'pending' | 'missing',
    public integrity: 'valid' | 'invalid',
    public extraData: ValSetExtraData[],
  ) {}
}

/** @notice Aggregator extra-data entry (bytes32 key/value). */
export class AggregatorExtraDataEntry {
  constructor(public key: Hex, public value: Hex) {}
}

export type ValSetExtraData = AggregatorExtraDataEntry;

/** @notice Compact header committed on settlements (hash/SSZ root + metadata). */
export class ValidatorSetHeader {
  constructor(
    public version: number,
    public requiredKeyTag: number,
    public epoch: number,
    public captureTimestamp: number,
    public quorumThreshold: bigint,
    public totalVotingPower: bigint,
    public validatorsSszMRoot: Hex,
  ) {}
}
