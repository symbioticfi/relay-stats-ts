import { Address, Hex } from 'viem';
import type { NetworkConfig } from './network-config.js';
import type { ValidatorSet, AggregatorExtraDataEntry } from './validator-set.js';
import type { SettlementValSetLog, SettlementValSetStatus } from './settlement.js';

/** @notice Cross-chain address (chainId + EVM address). */
export class CrossChainAddress {
  constructor(public chainId: number, public address: Address) {}
}

/** @notice EIP-712 domain data exposed by settlement contracts. */
export class Eip712Domain {
  constructor(
    public fields: string,
    public name: string,
    public version: string,
    public chainId: bigint,
    public verifyingContract: Address,
    public salt: Hex,
    public extensions: bigint[],
  ) {}
}

/** @notice Network metadata fetched from driver and settlement. */
export class NetworkData {
  constructor(public address: Address, public subnetwork: Hex, public eip712Data: Eip712Domain) {}
}

/** @notice Combined epoch snapshot produced by the deriver. */
export class EpochData {
  constructor(
    public epoch: number,
    public finalized: boolean,
    public epochStart: number,
    public config: NetworkConfig,
    public validatorSet: ValidatorSet,
    public networkData?: NetworkData,
    public settlementStatuses?: SettlementValSetStatus[],
    public valSetEvents?: SettlementValSetLog[],
    public aggregatorsExtraData?: AggregatorExtraDataEntry[],
  ) {}
}

/** @notice Cache contract used by the deriver to persist finalized data. */
export interface CacheInterface {
  get(epoch: number, key: string): Promise<unknown | null>;
  set(epoch: number, key: string, value: unknown): Promise<void>;
  delete(epoch: number, key: string): Promise<void>;
  clear(epoch: number): Promise<void>;
}
