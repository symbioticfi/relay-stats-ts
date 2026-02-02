import type { CrossChainAddress } from './common.js';

/** @notice Quorum threshold per key tag configured in the driver. */
export interface QuorumThreshold {
    keyTag: number;
    quorumThreshold: bigint;
}

/** @notice Network configuration fetched from the ValSet driver. */
export interface NetworkConfig {
    votingPowerProviders: CrossChainAddress[];
    keysProvider: CrossChainAddress;
    settlements: CrossChainAddress[];
    verificationType: number;
    maxVotingPower: bigint;
    minInclusionVotingPower: bigint;
    maxValidatorsCount: bigint;
    requiredKeyTags: number[];
    requiredHeaderKeyTag: number;
    quorumThresholds: QuorumThreshold[];
    numCommitters: number;
    numAggregators: number;
}
