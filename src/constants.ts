export const VALSET_VERSION = 1;
export const SSZ_MAX_VALIDATORS = 1048576;
export const SSZ_MAX_VAULTS = 1024;

export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const MULTICALL_TARGET_GAS = 50_000_000n;
export const MULTICALL_VOTING_CALL_GAS = 130_000n;
export const MULTICALL_KEYS_CALL_GAS = 95_000n;
export const MULTICALL_VAULT_COLLATERAL_CALL_GAS = 80_000n;
export const MULTICALL_ERC20_METADATA_CALL_GAS = 90_000n;
export const EVENT_SCAN_RANGE = 100n;
export const EPOCH_EVENT_BLOCK_BUFFER = 16n;

export const CACHE_NAMESPACE = {
  CONFIG: 'config',
  VALSET: 'valset',
  VALSET_STATUS: 'valset_status',
  AGGREGATOR_EXTRA: 'aggregator_extra',
  VALSET_EVENT: 'valset_event',
  MULTICALL_SUPPORT: 'multicall_support',
} as const;

export const AGGREGATOR_MODE = {
  SIMPLE: 'simple',
  ZK: 'zk',
} as const;
export type AggregatorMode = (typeof AGGREGATOR_MODE)[keyof typeof AGGREGATOR_MODE];

export const EXTRA_NAME = {
  SIMPLE_VALIDATORS_KECCAK: 'validatorSetHashKeccak256',
  SIMPLE_AGG_G1: 'aggPublicKeyG1',
  SIMPLE_TOTAL_VOTING_POWER: 'totalVotingPower',
  ZK_TOTAL_ACTIVE: 'totalActiveValidators',
  ZK_VALIDATORS_MIMC: 'validatorSetHashMimc',
} as const;

export const EXTRA_PREFIX = {
  TAG: 'keyTag.',
} as const;
