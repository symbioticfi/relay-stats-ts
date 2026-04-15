import type { Address, Hex } from 'viem';
import type { NetworkConfig } from './network-config.js';
import type { SettlementValSetLog, SettlementValSetStatus } from './settlement.js';
import type { AggregatorExtraDataEntry, ValidatorSet } from './validator-set.js';

/** @notice Cross-chain address (chainId + EVM address). */
export interface CrossChainAddress {
    chainId: number;
    address: Address;
}

/** @notice EIP-712 domain data exposed by settlement contracts. */
export interface Eip712Domain {
    fields: string;
    name: string;
    version: string;
    chainId: bigint;
    verifyingContract: Address;
    salt: Hex;
    extensions: bigint[];
}

/** @notice Network metadata fetched from driver and settlement. */
export interface NetworkData {
    address: Address;
    subnetwork: Hex;
    eip712Data: Eip712Domain;
}

/** @notice Combined epoch snapshot produced by the deriver. */
export interface EpochData {
    epoch: number;
    finalized: boolean;
    epochStart: number;
    config: NetworkConfig;
    validatorSet: ValidatorSet;
    networkData?: NetworkData;
    settlementStatuses?: SettlementValSetStatus[];
    valSetEvents?: SettlementValSetLog[];
    aggregatorsExtraData?: AggregatorExtraDataEntry[];
    validatorRoles: ValidatorRoles;
}

/** @notice Cache contract used by the deriver to persist finalized data. */
export interface CacheInterface {
    get(epoch: number, key: string): Promise<unknown | null>;
    set(epoch: number, key: string, value: unknown): Promise<void>;
    delete(epoch: number, key: string): Promise<void>;
    clear(epoch: number): Promise<void>;
}

/** @notice Inclusive epoch range for batch helpers. */
export interface EpochRange {
    from: number;
    to: number;
}

/**
 * @notice Validator role assignments (aggregators and committers) for the epoch.
 * All indices reference `validatorSet.validators` (which contains only active validators).
 */
export interface ValidatorRoles {
    aggregatorIndices: number[];
    committerIndices: number[];
}

/**
 * @notice Active committer slot information at a given point in time.
 * `validatorIndex` references `validatorSet.validators`.
 */
export interface ActiveCommitterInfo {
    validatorIndex: number;
    slotStart: number;
    slotEnd: number;
}
