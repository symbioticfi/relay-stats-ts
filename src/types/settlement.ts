import type { Hex } from 'viem';
import type { CrossChainAddress } from './common.js';
import type { ValidatorSetHeader, ValSetExtraData } from './validator-set.js';

/** @notice Settlement event kinds expressed as string literals. */
export const ValSetEventKind = {
    Genesis: 'genesis',
    Commit: 'commit',
} as const;
export type ValSetEventKindType = (typeof ValSetEventKind)[keyof typeof ValSetEventKind];

/** @notice BLS simple quorum proof signer payload. */
export interface ValSetQuorumProofSimpleSigner {
    key: Hex;
    votingPower: bigint;
}

/** @notice Simple (aggregated signature) quorum proof data. */
export interface ValSetQuorumProofSimple {
    mode: 'simple';
    aggregatedSignature: Hex;
    aggregatedPublicKey: Hex;
    signers: ValSetQuorumProofSimpleSigner[];
    nonSignerIndices: number[];
    rawProof: Hex;
}

/** @notice ZK quorum proof data. */
export interface ValSetQuorumProofZk {
    mode: 'zk';
    proof: Hex[];
    commitments: Hex[];
    commitmentPok: Hex[];
    signersVotingPower: bigint;
    rawProof: Hex;
}

export type ValSetQuorumProof = ValSetQuorumProofSimple | ValSetQuorumProofZk;

/** @notice Parsed validator-set event emitted by a settlement. */
export interface ValSetLogEvent {
    kind: ValSetEventKindType;
    header: ValidatorSetHeader;
    extraData: ValSetExtraData[];
    blockNumber: bigint | null;
    blockTimestamp: number | null;
    transactionHash: Hex | null;
    quorumProof: ValSetQuorumProof | null;
}

/** @notice Commitment status for a settlement at a given epoch. */
export interface SettlementValSetStatus {
    settlement: CrossChainAddress;
    committed: boolean;
    headerHash: Hex | null;
    lastCommittedEpoch: number | null;
}

/** @notice Validator-set log data scoped to a settlement. */
export interface SettlementValSetLog {
    settlement: CrossChainAddress;
    committed: boolean;
    event: ValSetLogEvent | null;
}

/** @notice Overall validator-set status across settlements. */
export interface ValSetStatus {
    status: 'committed' | 'pending' | 'missing';
    integrity: 'valid' | 'invalid';
    settlements: SettlementValSetStatus[];
}
