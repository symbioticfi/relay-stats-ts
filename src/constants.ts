export const VALSET_VERSION = 1;
export const SSZ_MAX_VALIDATORS = 1048576;
export const SSZ_MAX_VAULTS = 1024;
export const CACHE_PERSISTENT_EPOCH = Number.MAX_SAFE_INTEGER - 1;

export const CACHE_NAMESPACE = {
    CONFIG: 'config',
    VALSET: 'valset',
    VALSET_STATUS: 'valset_status',
    AGGREGATOR_EXTRA: 'aggregator_extra',
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
