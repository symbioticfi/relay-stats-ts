import type { Hex } from 'viem';
import type { CrossChainAddress } from './common.js';
import type { ValidatorSetHeader, ValSetExtraData } from './validator-set.js';

/** @notice Settlement event kinds expressed as class constants. */
export class ValSetEventKind {
    static readonly Genesis = 'genesis';
    static readonly Commit = 'commit';
}
export type ValSetEventKindType = typeof ValSetEventKind.Genesis | typeof ValSetEventKind.Commit;

/** @notice BLS simple quorum proof signer payload. */
export class ValSetQuorumProofSimpleSigner {
    constructor(
        public key: Hex,
        public votingPower: bigint
    ) {}
}

/** @notice Simple (aggregated signature) quorum proof data. */
export class ValSetQuorumProofSimple {
    constructor(
        public mode: 'simple',
        public aggregatedSignature: Hex,
        public aggregatedPublicKey: Hex,
        public signers: ValSetQuorumProofSimpleSigner[],
        public nonSignerIndices: number[],
        public rawProof: Hex
    ) {}
}

/** @notice ZK quorum proof data. */
export class ValSetQuorumProofZk {
    constructor(
        public mode: 'zk',
        public proof: Hex[],
        public commitments: Hex[],
        public commitmentPok: Hex[],
        public signersVotingPower: bigint,
        public rawProof: Hex
    ) {}
}

export type ValSetQuorumProof = ValSetQuorumProofSimple | ValSetQuorumProofZk;

/** @notice Parsed validator-set event emitted by a settlement. */
export class ValSetLogEvent {
    constructor(
        public kind: ValSetEventKindType,
        public header: ValidatorSetHeader,
        public extraData: ValSetExtraData[],
        public blockNumber: bigint | null,
        public blockTimestamp: number | null,
        public transactionHash: Hex | null,
        public quorumProof: ValSetQuorumProof | null = null
    ) {}
}

/** @notice Commitment status for a settlement at a given epoch. */
export class SettlementValSetStatus {
    constructor(
        public settlement: CrossChainAddress,
        public committed: boolean,
        public headerHash: Hex | null,
        public lastCommittedEpoch: number | null
    ) {}
}

/** @notice Validator-set log data scoped to a settlement. */
export class SettlementValSetLog {
    constructor(
        public settlement: CrossChainAddress,
        public committed: boolean,
        public event: ValSetLogEvent | null
    ) {}
}

/** @notice Overall validator-set status across settlements. */
export class ValSetStatus {
    constructor(
        public status: 'committed' | 'pending' | 'missing',
        public integrity: 'valid' | 'invalid',
        public settlements: SettlementValSetStatus[]
    ) {}
}
