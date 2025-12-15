import type { Address } from 'viem';
import type { NetworkConfig } from './types/index.js';

export type RawCrossChainAddress = {
  chainId: bigint | number | string;
  addr: Address;
};

export type RawQuorumThreshold = {
  keyTag: bigint | number | string;
  quorumThreshold: bigint;
};

export type RawDriverConfig = {
  numAggregators: bigint | number | string;
  numCommitters: bigint | number | string;
  votingPowerProviders: RawCrossChainAddress[];
  keysProvider: RawCrossChainAddress;
  settlements: RawCrossChainAddress[];
  maxVotingPower: bigint;
  minInclusionVotingPower: bigint;
  maxValidatorsCount: bigint;
  requiredKeyTags: (number | bigint)[];
  quorumThresholds: RawQuorumThreshold[];
  requiredHeaderKeyTag: number | bigint;
  verificationType: number | bigint;
};

export type CachedNetworkConfigEntry = {
  config: NetworkConfig;
  epochStart: number;
};

export const mapDriverConfig = (config: RawDriverConfig): NetworkConfig => ({
  votingPowerProviders: config.votingPowerProviders.map((p) => ({
    chainId: Number(p.chainId),
    address: p.addr,
  })),
  keysProvider: {
    chainId: Number(config.keysProvider.chainId),
    address: config.keysProvider.addr,
  },
  settlements: config.settlements.map((s) => ({
    chainId: Number(s.chainId),
    address: s.addr,
  })),
  verificationType: Number(config.verificationType ?? 0),
  maxVotingPower: config.maxVotingPower,
  minInclusionVotingPower: config.minInclusionVotingPower,
  maxValidatorsCount: config.maxValidatorsCount,
  requiredKeyTags: config.requiredKeyTags.map((tag) => Number(tag)),
  requiredHeaderKeyTag: Number(config.requiredHeaderKeyTag),
  quorumThresholds: config.quorumThresholds.map((q) => ({
    keyTag: Number(q.keyTag),
    quorumThreshold: q.quorumThreshold,
  })),
  numCommitters: Number(config.numCommitters),
  numAggregators: Number(config.numAggregators),
});

export const isCachedNetworkConfigEntry = (
  value: unknown,
): value is CachedNetworkConfigEntry => {
  if (!value || typeof value !== 'object') return false;
  const entry = value as CachedNetworkConfigEntry & { epochStart?: unknown };
  return (
    typeof entry.epochStart === 'number' &&
    entry.config !== undefined &&
    typeof (entry.config as NetworkConfig).requiredHeaderKeyTag === 'number'
  );
};

export const isNetworkConfigStructure = (value: unknown): value is NetworkConfig => {
  if (!value || typeof value !== 'object' || value === null) return false;
  const candidate = value as NetworkConfig & { keysProvider?: unknown; settlements?: unknown };
  return (
    typeof candidate.keysProvider === 'object' &&
    candidate.keysProvider !== null &&
    Array.isArray(candidate.settlements)
  );
};
