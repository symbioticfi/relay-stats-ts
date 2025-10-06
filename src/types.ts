import { Address, Hex } from 'viem';

// Key type definitions
export enum KeyType {
  KeyTypeBlsBn254 = 0,
  KeyTypeEcdsaSecp256k1 = 1,
  KeyTypeInvalid = 255, // Invalid key type
}

export type KeyTag = number;

export function getKeyType(tag: KeyTag): KeyType {
  switch (tag >> 4) {
    case 0:
      return KeyType.KeyTypeBlsBn254;
    case 1:
      return KeyType.KeyTypeEcdsaSecp256k1;
    default:
      return KeyType.KeyTypeInvalid;
  }
}

export interface CrossChainAddress {
  chainId: number;
  address: Address;
}

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

export interface QuorumThreshold {
  keyTag: number;
  quorumThreshold: bigint;
}

export interface ValidatorKey {
  tag: number;
  payload: Hex;
}

export interface ValidatorVault {
  vault: Address;
  votingPower: bigint;
  chainId: number;
}

export interface Validator {
  operator: Address;
  votingPower: bigint;
  isActive: boolean;
  keys: ValidatorKey[];
  vaults: ValidatorVault[];
}

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
}

export interface ValidatorSetHeader {
  version: number;
  requiredKeyTag: number;
  epoch: number;
  captureTimestamp: number;
  quorumThreshold: bigint;
  totalVotingPower: bigint;
  validatorsSszMRoot: Hex;
}

export interface OperatorVotingPower {
  operator: Address;
  vaults: VaultVotingPower[];
}

export interface VaultVotingPower {
  vault: Address;
  votingPower: bigint;
}

export interface OperatorWithKeys {
  operator: Address;
  keys: ValidatorKey[];
}

export interface Eip712Domain {
  fields: string;
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: Address;
  salt: Hex;
  extensions: bigint[];
}

export interface NetworkData {
  address: Address;
  subnetwork: Hex;
  eip712Data: Eip712Domain;
}

// Aggregator extra data entry (key/value are bytes32)
export interface AggregatorExtraDataEntry {
  key: Hex;
  value: Hex;
}

export interface CacheInterface {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(key: string): Promise<any | null>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set(key: string, value: any): Promise<void>;

  delete(key: string): Promise<void>;

  clear(): Promise<void>;
}
