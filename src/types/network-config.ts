import type { CrossChainAddress } from './common.js';

/** @notice Quorum threshold per key tag configured in the driver. */
export class QuorumThreshold {
    constructor(
        public keyTag: number,
        public quorumThreshold: bigint
    ) {}
}

/** @notice Network configuration fetched from the ValSet driver. */
export class NetworkConfig {
    constructor(
        public votingPowerProviders: CrossChainAddress[],
        public keysProvider: CrossChainAddress,
        public settlements: CrossChainAddress[],
        public verificationType: number,
        public maxVotingPower: bigint,
        public minInclusionVotingPower: bigint,
        public maxValidatorsCount: bigint,
        public requiredKeyTags: number[],
        public requiredHeaderKeyTag: number,
        public quorumThresholds: QuorumThreshold[],
        public numCommitters: number,
        public numAggregators: number
    ) {}
}
