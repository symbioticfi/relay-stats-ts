export const VALSET_VERSION = 1;
export const SSZ_MAX_VALIDATORS = 1048576;
export const SSZ_MAX_VAULTS = 1024;

// ABIs moved to abi.ts

// Aggregator data modes
export const AGGREGATOR_MODE = {
  SIMPLE: 'simple',
  ZK: 'zk',
} as const;
export type AggregatorMode = (typeof AGGREGATOR_MODE)[keyof typeof AGGREGATOR_MODE];

// Extra data key names (moved from extra_data.ts for reuse)
export const EXTRA_NAME = {
  // Go: SimpleVerificationValidatorSetHashKeccak256Hash = keccak256("validatorSetHashKeccak256")
  SIMPLE_VALIDATORS_KECCAK: 'validatorSetHashKeccak256',
  // Go: SimpleVerificationAggPublicKeyG1Hash = keccak256("aggPublicKeyG1")
  SIMPLE_AGG_G1: 'aggPublicKeyG1',
  // Go: SimpleVerificationTotalVotingPowerHash = keccak256("totalVotingPower")
  SIMPLE_TOTAL_VOTING_POWER: 'totalVotingPower',
  // Go: ZkVerificationTotalActiveValidatorsHash = keccak256("totalActiveValidators")
  ZK_TOTAL_ACTIVE: 'totalActiveValidators',
  // Go: ZkVerificationValidatorSetHashMimcHash = keccak256("validatorSetHashMimc")
  ZK_VALIDATORS_MIMC: 'validatorSetHashMimc',
} as const;

// Extra data prefixes used in key derivation
export const EXTRA_PREFIX = {
  // Go: ExtraDataKeyTagPrefixHash = keccak256("keyTag.")
  TAG: 'keyTag.',
} as const;
