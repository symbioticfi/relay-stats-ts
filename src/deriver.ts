/* eslint-disable @typescript-eslint/no-explicit-any */
import { createPublicClient, http, PublicClient, Address, Hex, getContract } from 'viem';
import {
  CrossChainAddress,
  NetworkConfig,
  ValidatorSet,
  Validator,
  OperatorVotingPower,
  OperatorWithKeys,
  CacheInterface,
} from './types';
import {
  VALSET_VERSION,
  SSZ_MAX_VALIDATORS,
  SSZ_MAX_VAULTS,
  VALSET_DRIVER_ABI,
  SETTLEMENT_ABI,
  VOTING_POWER_PROVIDER_ABI,
  KEY_REGISTRY_ABI,
} from './constants';

export interface ValidatorSetDeriverConfig {
  rpcUrls: string[];
  driverAddress: CrossChainAddress;
  cache?: CacheInterface | null;
  maxSavedEpochs?: number;
}

export class ValidatorSetDeriver {
  private clients: Map<number, PublicClient> = new Map();
  private driverAddress: CrossChainAddress;
  private cache: CacheInterface | null;
  private maxSavedEpochs: number;
  private initializedPromise: Promise<void>;
  private rpcUrls: string[];

  constructor(config: ValidatorSetDeriverConfig) {
    this.driverAddress = config.driverAddress;
    this.cache = config.cache === undefined ? null : config.cache;
    this.maxSavedEpochs = config.maxSavedEpochs || 100;
    this.rpcUrls = config.rpcUrls;
    this.initializedPromise = this.initializeClients();
  }

  /**
   * Static factory method that ensures the deriver is fully initialized before returning
   */
  static async create(config: ValidatorSetDeriverConfig): Promise<ValidatorSetDeriver> {
    const deriver = new ValidatorSetDeriver(config);
    await deriver.ensureInitialized();

    // Validate all required chains are available
    await deriver.validateRequiredChains();

    return deriver;
  }

  private async initializeClients(): Promise<void> {
    const initPromises = this.rpcUrls.map(async (url) => {
      const client = createPublicClient({
        transport: http(url),
      });

      const chainId = await client.getChainId();
      this.clients.set(chainId, client);
      return chainId;
    });

    await Promise.all(initPromises);

    if (!this.clients.has(this.driverAddress.chainId)) {
      throw new Error(
        `Driver chain ID ${this.driverAddress.chainId} not found in provided RPC URLs`,
      );
    }
  }

  private async validateRequiredChains(): Promise<void> {
    try {
      const driver = this.getDriverContract();
      const currentEpoch = await driver.read.getCurrentEpoch();
      const timestamp = await driver.read.getEpochStart([Number(currentEpoch)]);
      const config: any = await driver.read.getConfigAt([Number(timestamp)]);

      const requiredChainIds = new Set<number>();
      requiredChainIds.add(this.driverAddress.chainId);

      config.votingPowerProviders.forEach((p: any) => requiredChainIds.add(Number(p.chainId)));
      requiredChainIds.add(Number(config.keysProvider.chainId));
      config.settlements.forEach((s: any) => requiredChainIds.add(Number(s.chainId)));

      const missingChains: number[] = [];
      for (const chainId of requiredChainIds) {
        if (!this.clients.has(chainId)) {
          missingChains.push(chainId);
        }
      }

      if (missingChains.length > 0) {
        throw new Error(
          `Missing RPC clients for required chains: ${missingChains.join(', ')}. ` +
            `Please ensure RPC URLs are provided for all chains used by voting power providers, keys provider, and settlements.`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing RPC clients')) {
        throw error; // Re-throw our validation error
      }
      // For other errors (like contract not available), just warn
      console.warn(
        'Warning: Could not validate required chains. This might be expected for test environments.',
      );
      console.warn('Error:', error instanceof Error ? error.message : String(error));
    }
  }

  private async ensureInitialized(): Promise<void> {
    await this.initializedPromise;
  }

  private getClient(chainId: number): PublicClient {
    const client = this.clients.get(chainId);
    if (!client) {
      throw new Error(`No client for chain ID ${chainId}`);
    }
    return client;
  }

  private getDriverContract() {
    const client = this.getClient(this.driverAddress.chainId);
    return getContract({
      address: this.driverAddress.address,
      abi: VALSET_DRIVER_ABI,
      client,
    });
  }

  private async getFromCache(key: string): Promise<any | null> {
    if (!this.cache) return null;
    try {
      return await this.cache.get(key);
    } catch {
      return null;
    }
  }

  private async setToCache(key: string, value: any): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.set(key, value);
    } catch {
      // Ignore cache errors
    }
  }

  async getCurrentEpoch(): Promise<number> {
    await this.ensureInitialized();
    const driver = this.getDriverContract();
    const epoch = await driver.read.getCurrentEpoch();
    return Number(epoch);
  }

  async getNetworkConfig(epoch?: number): Promise<NetworkConfig> {
    await this.ensureInitialized();

    const cacheKey = `config_${epoch || 'current'}`;
    const cached = await this.getFromCache(cacheKey);
    if (cached) return cached;

    const driver = this.getDriverContract();

    if (epoch === undefined) {
      epoch = await this.getCurrentEpoch();
    }

    const timestamp = await driver.read.getEpochStart([Number(epoch)]);
    const config: any = await driver.read.getConfigAt([Number(timestamp)]);

    const result: NetworkConfig = {
      votingPowerProviders: config.votingPowerProviders.map((p: any) => ({
        chainId: Number(p.chainId),
        address: p.addr as Address,
      })),
      keysProvider: {
        chainId: Number(config.keysProvider.chainId),
        address: config.keysProvider.addr as Address,
      },
      settlements: config.settlements.map((s: any) => ({
        chainId: Number(s.chainId),
        address: s.addr as Address,
      })),
      verificationType: Number(config.verificationType),
      maxVotingPower: config.maxVotingPower,
      minInclusionVotingPower: config.minInclusionVotingPower,
      maxValidatorsCount: config.maxValidatorsCount,
      requiredKeyTags: config.requiredKeyTags.map(Number),
      requiredHeaderKeyTag: Number(config.requiredHeaderKeyTag),
      quorumThresholds: config.quorumThresholds.map((q: any) => ({
        keyTag: Number(q.keyTag),
        quorumThreshold: q.quorumThreshold,
      })),
      numCommitters: Number(config.numCommitters),
      numAggregators: Number(config.numAggregators),
    };

    await this.setToCache(cacheKey, result);
    await this.cleanupOldCache(epoch);

    return result;
  }

  async getValidatorSet(epoch?: number): Promise<ValidatorSet> {
    await this.ensureInitialized();

    const cacheKey = `valset_${epoch || 'current'}`;
    const cached = await this.getFromCache(cacheKey);
    if (cached) return cached;

    if (epoch === undefined) {
      epoch = await this.getCurrentEpoch();
    }

    const config = await this.getNetworkConfig(epoch);
    const driver = this.getDriverContract();

    const timestamp = await driver.read.getEpochStart([Number(epoch)]);

    // Get voting powers from all providers
    const allVotingPowers: { chainId: number; votingPowers: OperatorVotingPower[] }[] = [];
    for (const provider of config.votingPowerProviders) {
      const votingPowers = await this.getVotingPowers(provider, Number(timestamp));
      allVotingPowers.push({
        chainId: provider.chainId,
        votingPowers,
      });
    }

    // Get keys
    const keys = await this.getKeys(config.keysProvider, Number(timestamp));

    // Form validators
    const validators = this.formValidators(config, allVotingPowers, keys);

    // Calculate total voting power
    const totalVotingPower = validators
      .filter((v) => v.isActive)
      .reduce((sum, v) => sum + v.votingPower, 0n);

    // Calculate quorum threshold
    const quorumThreshold = this.calcQuorumThreshold(config, totalVotingPower);

    // Get settlement status
    const { settlementStatus, integrityStatus } = await this.getSettlementStatus(
      config.settlements,
      epoch,
    );

    const valset: ValidatorSet = {
      version: VALSET_VERSION,
      requiredKeyTag: config.requiredHeaderKeyTag,
      epoch,
      captureTimestamp: Number(timestamp),
      quorumThreshold,
      validators,
      totalVotingPower,
      settlementStatus,
      integrityStatus,
    };

    const result: ValidatorSet = {
      ...valset,
    };

    // Raise error if integrity status is invalid
    if (result.integrityStatus === 'invalid') {
      throw new Error(
        `Settlement integrity check failed for epoch ${epoch}. ` +
          `Header hashes do not match across settlements, indicating a critical issue with the validator set.`,
      );
    }

    await this.setToCache(cacheKey, result);
    await this.cleanupOldCache(epoch);

    return result;
  }

  /**
   * Get the current validator set (simplified interface)
   */
  async getCurrentValidatorSet(): Promise<ValidatorSet> {
    return this.getValidatorSet();
  }

  /**
   * Get the current network configuration (simplified interface)
   */
  async getCurrentNetworkConfig(): Promise<NetworkConfig> {
    return this.getNetworkConfig();
  }

  private async getVotingPowers(
    provider: CrossChainAddress,
    timestamp: number,
  ): Promise<OperatorVotingPower[]> {
    const client = this.getClient(provider.chainId);
    const providerContract = getContract({
      address: provider.address,
      abi: VOTING_POWER_PROVIDER_ABI,
      client,
    });

    const votingPowers = await providerContract.read.getVotingPowersAt([[], Number(timestamp)]);

    return votingPowers.map((vp: any) => ({
      operator: vp.operator as Address,
      vaults: vp.vaults.map((v: any) => ({
        vault: v.vault as Address,
        votingPower: v.value,
      })),
    }));
  }

  private async getKeys(
    provider: CrossChainAddress,
    timestamp: number,
  ): Promise<OperatorWithKeys[]> {
    const client = this.getClient(provider.chainId);
    const keyRegistry = getContract({
      address: provider.address,
      abi: KEY_REGISTRY_ABI,
      client,
    });

    const keys = await keyRegistry.read.getKeysAt([Number(timestamp)]);

    return keys.map((k: any) => ({
      operator: k.operator as Address,
      keys: k.keys.map((key: any) => ({
        tag: key.tag,
        payload: key.payload as Hex,
      })),
    }));
  }

  private formValidators(
    config: NetworkConfig,
    votingPowers: { chainId: number; votingPowers: OperatorVotingPower[] }[],
    keys: OperatorWithKeys[],
  ): Validator[] {
    const validatorsMap = new Map<string, Validator>();

    // Process voting powers
    for (const chainVp of votingPowers) {
      for (const vp of chainVp.votingPowers) {
        const operatorAddr = vp.operator.toLowerCase() as Address;

        if (!validatorsMap.has(operatorAddr)) {
          validatorsMap.set(operatorAddr, {
            operator: vp.operator,
            votingPower: 0n,
            isActive: false,
            keys: [],
            vaults: [],
          });
        }

        const validator = validatorsMap.get(operatorAddr)!;

        for (const vault of vp.vaults) {
          validator.votingPower = validator.votingPower + vault.votingPower;
          validator.vaults.push({
            vault: vault.vault,
            votingPower: vault.votingPower,
            chainId: chainVp.chainId,
          });
        }
      }
    }

    // Limit vaults per validator to SSZ max
    for (const validator of validatorsMap.values()) {
      if (validator.vaults.length > SSZ_MAX_VAULTS) {
        // Sort by voting power descending, then by address
        validator.vaults.sort((a, b) => {
          const powerDiff = b.votingPower - a.votingPower;
          if (powerDiff !== 0n) {
            return powerDiff > 0n ? 1 : -1;
          }
          return a.vault.toLowerCase().localeCompare(b.vault.toLowerCase());
        });
        validator.vaults = validator.vaults.slice(0, SSZ_MAX_VAULTS);

        // Recalculate total voting power
        validator.votingPower = validator.vaults.reduce((sum, v) => sum + v.votingPower, 0n);
      }

      // Sort vaults by address for final output
      validator.vaults.sort((a, b) => a.vault.toLowerCase().localeCompare(b.vault.toLowerCase()));
    }

    // Process keys
    for (const rk of keys) {
      const operatorAddr = rk.operator.toLowerCase() as Address;
      const validator = validatorsMap.get(operatorAddr);

      if (validator) {
        validator.keys = rk.keys;
      }
    }

    // Convert map to array and sort
    let validators = Array.from(validatorsMap.values());

    // Sort by voting power descending, then by operator address
    validators.sort((a, b) => {
      const powerDiff = b.votingPower - a.votingPower;
      if (powerDiff !== 0n) {
        return powerDiff > 0n ? 1 : -1;
      }
      return a.operator.toLowerCase().localeCompare(b.operator.toLowerCase());
    });

    // Limit validators to SSZ max
    if (validators.length > SSZ_MAX_VALIDATORS) {
      validators = validators.slice(0, SSZ_MAX_VALIDATORS);
    }

    // Mark validators as active
    this.markValidatorsActive(config, validators);

    // Sort by operator address for final output
    validators.sort((a, b) => a.operator.toLowerCase().localeCompare(b.operator.toLowerCase()));

    return validators;
  }

  private markValidatorsActive(config: NetworkConfig, validators: Validator[]): void {
    let totalActive = 0;

    for (const validator of validators) {
      // Check minimum voting power
      if (validator.votingPower < config.minInclusionVotingPower) {
        continue;
      }

      // Check if validator has keys
      if (validator.keys.length === 0) {
        continue;
      }

      totalActive++;
      validator.isActive = true;

      // Cap voting power if needed
      if (config.maxVotingPower !== 0n && validator.votingPower > config.maxVotingPower) {
        validator.votingPower = config.maxVotingPower;
      }

      // Check max validators count
      if (config.maxValidatorsCount !== 0n && totalActive >= Number(config.maxValidatorsCount)) {
        break;
      }
    }
  }

  private calcQuorumThreshold(config: NetworkConfig, totalVotingPower: bigint): bigint {
    const threshold = config.quorumThresholds.find((q) => q.keyTag === config.requiredHeaderKeyTag);

    if (!threshold) {
      throw new Error(`No quorum threshold for key tag ${config.requiredHeaderKeyTag}`);
    }

    // Normalize threshold: totalVotingPower * quorumThreshold / 10^18, rounded up by +1
    return (totalVotingPower * threshold.quorumThreshold) / 1000000000000000000n + 1n;
  }

  private async getSettlementStatus(
    settlements: CrossChainAddress[],
    epoch: number,
  ): Promise<{
    settlementStatus: 'committed' | 'pending' | 'missing';
    integrityStatus: 'valid' | 'invalid';
  }> {
    const hashes: Map<string, string> = new Map();
    const currentEpoch = await this.getCurrentEpoch();
    let hasMissing = false;
    let hasPending = false;
    let allCommitted = true;

    for (const settlement of settlements) {
      const client = this.getClient(settlement.chainId);
      const settlementContract = getContract({
        address: settlement.address,
        abi: SETTLEMENT_ABI,
        client,
      });

      try {
        const isCommitted = await settlementContract.read.isValSetHeaderCommittedAt([
          Number(epoch),
        ]);

        if (isCommitted) {
          const headerHash = (await settlementContract.read.getValSetHeaderHashAt([
            Number(epoch),
          ])) as Hex;
          if (headerHash) {
            hashes.set(`${settlement.chainId}_${settlement.address}`, headerHash);
          }
        } else {
          allCommitted = false;
          const lastCommitted = await settlementContract.read.getLastCommittedHeaderEpoch();

          if (lastCommitted > BigInt(epoch)) {
            hasMissing = true;
          } else if (epoch === currentEpoch) {
            hasPending = true;
          } else {
            hasMissing = true;
          }
        }
      } catch (error) {
        console.error(`Failed to get status for settlement ${settlement.address}:`, error);
        allCommitted = false;
        hasMissing = true;
      }
    }

    // Determine global settlement status
    let settlementStatus: 'committed' | 'pending' | 'missing';
    if (allCommitted) {
      settlementStatus = 'committed';
    } else if (hasMissing) {
      settlementStatus = 'missing';
    } else if (hasPending) {
      settlementStatus = 'pending';
    } else {
      settlementStatus = 'missing'; // fallback
    }

    // Check integrity - all committed hashes should match
    const uniqueHashes = new Set(hashes.values());
    const integrityStatus = uniqueHashes.size <= 1 ? 'valid' : 'invalid';

    return { settlementStatus, integrityStatus };
  }

  private async cleanupOldCache(currentEpoch: number): Promise<void> {
    if (!this.cache || currentEpoch <= this.maxSavedEpochs) return;

    const oldestToKeep = currentEpoch - this.maxSavedEpochs;

    for (let epoch = 0; epoch < oldestToKeep; epoch++) {
      await this.cache.delete(`config_${epoch}`);
      await this.cache.delete(`valset_${epoch}`);
    }
  }
}
