/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createPublicClient,
  http,
  PublicClient,
  Address,
  Hex,
  getContract,
  encodeAbiParameters,
  keccak256,
} from 'viem';
import {
  CrossChainAddress,
  NetworkConfig,
  ValidatorSet,
  Validator,
  OperatorVotingPower,
  OperatorWithKeys,
  CacheInterface,
  ValidatorSetHeader,
  NetworkData,
  Eip712Domain,
  AggregatorExtraDataEntry,
} from './types.js';
import { sszTreeRoot } from './ssz.js';
// bytesToHex retained in public API exports; not used internally here
import { buildSimpleExtraData, buildZkExtraData } from './extra_data.js';
import {
  VALSET_VERSION,
  SSZ_MAX_VALIDATORS,
  SSZ_MAX_VAULTS,
  AGGREGATOR_MODE,
  AggregatorMode,
} from './constants.js';
import {
  VALSET_DRIVER_ABI,
  SETTLEMENT_ABI,
  VOTING_POWER_PROVIDER_ABI,
  KEY_REGISTRY_ABI,
} from './abi.js';

// Map a boolean preference to a BlockTag for viem reads
function toBlockTag(finalized: boolean): 'finalized' | 'latest' {
  return finalized ? 'finalized' : 'latest';
}

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
   * Derive auxiliary network data used by the Relay system.
   * - Reads NETWORK and SUBNETWORK from the ValSet Driver
   * - Reads EIP-712 domain from a given settlement contract
   */
  async getNetworkData(
    settlement?: CrossChainAddress,
    finalized: boolean = true,
  ): Promise<NetworkData> {
    await this.ensureInitialized();

    const driver = this.getDriverContract();

    // Read network address and subnetwork id from the driver
    const [networkAddress, subnetwork] = await Promise.all([
      driver.read.NETWORK({ blockTag: toBlockTag(finalized) }),
      driver.read.SUBNETWORK({ blockTag: toBlockTag(finalized) }),
    ]);

    // Resolve settlement: use provided or first from config
    let targetSettlement: CrossChainAddress | undefined = settlement;
    if (!targetSettlement) {
      const cfg = await this.getNetworkConfig(undefined, finalized);
      targetSettlement = cfg.settlements[0];
    }
    if (!targetSettlement) {
      throw new Error('No settlement available to fetch EIP-712 domain');
    }

    // Read EIP-712 domain from the settlement contract on its chain
    const settlementClient = this.getClient(targetSettlement.chainId);
    const settlementContract = getContract({
      address: targetSettlement.address,
      abi: SETTLEMENT_ABI,
      client: settlementClient,
    });

    const domainTuple = await settlementContract.read.eip712Domain({
      blockTag: toBlockTag(finalized),
    });

    const [fields, name, version, chainId, verifyingContract, salt, extensions] =
      domainTuple as readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]];

    const eip712Data: Eip712Domain = {
      fields: fields as string,
      name,
      version,
      chainId,
      verifyingContract,
      salt,
      extensions: [...extensions],
    };

    return {
      address: networkAddress as Address,
      subnetwork: subnetwork as Hex,
      eip712Data,
    };
  }

  /** Build extraData array for aggregators to be used in voting power provider calls */
  private async buildAggregatorsExtraData(
    config: NetworkConfig,
    epochStartTs: number,
    type?: 'simple' | 'zk',
  ): Promise<Hex[]> {
    const numAggregators = Number(config.numAggregators);
    if (!Number.isFinite(numAggregators) || numAggregators <= 0) return [] as Hex[];

    const extraType: 'simple' | 'zk' = type ?? 'simple';
    if (extraType === 'simple') {
      const items: Hex[] = [];
      for (let i = 0; i < numAggregators; i++) {
        items.push(
          encodeAbiParameters(
            [
              { name: 'aggregatorIndex', type: 'uint16' },
              { name: 'epochStart', type: 'uint48' },
            ],
            [i, epochStartTs],
          ) as Hex,
        );
      }
      return items;
    }

    // zk: include subnetwork as part of the encoded context
    const driver = this.getDriverContract();
    const subnetwork = (await driver.read.SUBNETWORK({
      blockTag: toBlockTag(true),
    })) as Hex;

    const items: Hex[] = [];
    for (let i = 0; i < numAggregators; i++) {
      items.push(
        encodeAbiParameters(
          [
            { name: 'aggregatorIndex', type: 'uint16' },
            { name: 'epochStart', type: 'uint48' },
            { name: 'subnetwork', type: 'bytes32' },
          ],
          [i, epochStartTs, subnetwork],
        ) as Hex,
      );
    }
    return items;
  }

  /**
   * Build key/value style extraData entries like relay Aggregator.GenerateExtraData
   * - simple: keccak(ValidatorsData) and compressed aggregated G1 key
   * - zk: totalActiveValidators and MiMC-based validators hash
   * Note: This is a lightweight TS analog without bn254 ops; it uses available data.
   */
  public async getAggregatorsExtraData(
    mode: AggregatorMode,
    keyTags?: number[],
    finalized: boolean = true,
    epoch?: number,
  ): Promise<AggregatorExtraDataEntry[]> {
    const vset = await this.getValidatorSet(epoch, finalized);
    // If keyTags not provided, use requiredKeyTags from network config
    const config = await this.getNetworkConfig(vset.epoch, finalized);
    const tags = keyTags && keyTags.length > 0 ? keyTags : config.requiredKeyTags;
    if (mode === AGGREGATOR_MODE.SIMPLE) return buildSimpleExtraData(vset, tags);
    return await buildZkExtraData(vset, tags);
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
      const currentEpoch = await driver.read.getCurrentEpoch({
        blockTag: toBlockTag(true),
      });
      const timestamp = await driver.read.getEpochStart([Number(currentEpoch)], {
        blockTag: toBlockTag(true),
      });
      const config: any = await driver.read.getConfigAt([Number(timestamp)], {
        blockTag: toBlockTag(true),
      });

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

  // withPreferredBlockTag removed; use explicit { blockTag: toBlockTag(...) }

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

  async getCurrentEpoch(finalized: boolean = true): Promise<number> {
    await this.ensureInitialized();
    const driver = this.getDriverContract();
    const epoch = await driver.read.getCurrentEpoch({
      blockTag: toBlockTag(finalized),
    });
    return Number(epoch);
  }

  async getNetworkConfig(epoch?: number, finalized: boolean = true): Promise<NetworkConfig> {
    await this.ensureInitialized();

    const useCache = finalized;
    const cacheKey = `config_${epoch || 'current'}`;
    if (useCache) {
      const cached = await this.getFromCache(cacheKey);
      if (cached) return cached;
    }

    const driver = this.getDriverContract();

    if (epoch === undefined) {
      epoch = await this.getCurrentEpoch(finalized);
    }

    const timestamp = await driver.read.getEpochStart([Number(epoch)], {
      blockTag: toBlockTag(finalized),
    });
    const config: any = await driver.read.getConfigAt([Number(timestamp)], {
      blockTag: toBlockTag(finalized),
    });

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

    if (useCache) {
      await this.setToCache(cacheKey, result);
      await this.cleanupOldCache(epoch);
    }

    return result;
  }

  async getValidatorSet(epoch?: number, finalized: boolean = true): Promise<ValidatorSet> {
    await this.ensureInitialized();

    const useCache2 = finalized;
    const cacheKey = `valset_${epoch || 'current'}`;
    if (useCache2) {
      const cached = await this.getFromCache(cacheKey);
      if (cached) return cached;
    }

    if (epoch === undefined) {
      epoch = await this.getCurrentEpoch(finalized);
    }

    const config = await this.getNetworkConfig(epoch, finalized);
    const driver = this.getDriverContract();

    const timestamp = await driver.read.getEpochStart([Number(epoch)], {
      blockTag: toBlockTag(finalized),
    });

    // Get voting powers from all providers
    const allVotingPowers: { chainId: number; votingPowers: OperatorVotingPower[] }[] = [];
    for (const provider of config.votingPowerProviders) {
      const votingPowers = await this.getVotingPowers(provider, Number(timestamp), finalized);
      allVotingPowers.push({
        chainId: provider.chainId,
        votingPowers,
      });
    }

    // Get keys
    const keys = await this.getKeys(config.keysProvider, Number(timestamp), finalized);

    // Form validators
    const validators = this.formValidators(config, allVotingPowers, keys);

    // Calculate total voting power
    const totalVotingPower = validators
      .filter((v) => v.isActive)
      .reduce((sum, v) => sum + v.votingPower, 0n);

    // Calculate quorum threshold
    const quorumThreshold = this.calcQuorumThreshold(config, totalVotingPower);

    // Get settlement status
    const { status, integrity } = await this.getValsetStatus(
      config.settlements,
      epoch,
      finalized,
    );

    const valset: ValidatorSet = {
      version: VALSET_VERSION,
      requiredKeyTag: config.requiredHeaderKeyTag,
      epoch,
      captureTimestamp: Number(timestamp),
      quorumThreshold,
      validators,
      totalVotingPower,
      status: status,
      integrity: integrity,
    };

    const result: ValidatorSet = {
      ...valset,
    };

    // Raise error if integrity status is invalid
    if (result.integrity === 'invalid') {
      throw new Error(
        `Settlement integrity check failed for epoch ${epoch}. ` +
          `Header hashes do not match across settlements, indicating a critical issue with the validator set.`,
      );
    }

    if (useCache2) {
      await this.setToCache(cacheKey, result);
      await this.cleanupOldCache(epoch);
    }

    return result;
  }

  /**
   * Get the current validator set (simplified interface)
   */
  async getCurrentValidatorSet(): Promise<ValidatorSet> {
    return this.getValidatorSet(undefined, true);
  }

  /**
   * Get the current network configuration (simplified interface)
   */
  async getCurrentNetworkConfig(): Promise<NetworkConfig> {
    return this.getNetworkConfig(undefined, true);
  }

  // ================================
  // ValidatorSetHeader helpers
  // ================================

  /** Sum voting power of active validators only */
  public getTotalActiveVotingPower(v: ValidatorSet): bigint {
    let total: bigint = 0n;
    for (const validator of v.validators) {
      if (validator.isActive) total += validator.votingPower;
    }
    return total;
  }

  /** Construct ValidatorSetHeader from a ValidatorSet */
  public getValidatorSetHeader(v: ValidatorSet): ValidatorSetHeader {
    const sszMroot = sszTreeRoot(v);
    return {
      version: v.version,
      requiredKeyTag: v.requiredKeyTag,
      epoch: v.epoch,
      captureTimestamp: v.captureTimestamp,
      quorumThreshold: v.quorumThreshold,
      totalVotingPower: this.getTotalActiveVotingPower(v),
      validatorsSszMRoot: sszMroot,
    };
  }

  /** ABI-encode a ValidatorSetHeader per Solidity signature */
  public abiEncodeValidatorSetHeader(h: ValidatorSetHeader): Hex {
    return encodeAbiParameters(
      [
        { name: 'version', type: 'uint8' },
        { name: 'requiredKeyTag', type: 'uint8' },
        { name: 'epoch', type: 'uint48' },
        { name: 'captureTimestamp', type: 'uint48' },
        { name: 'quorumThreshold', type: 'uint256' },
        { name: 'totalVotingPower', type: 'uint256' },
        { name: 'validatorsSszMRoot', type: 'bytes32' },
      ],
      [
        h.version,
        h.requiredKeyTag,
        h.epoch,
        h.captureTimestamp,
        h.quorumThreshold,
        h.totalVotingPower,
        h.validatorsSszMRoot,
      ],
    ) as Hex;
  }

  /** Keccak256 hash of the ABI-encoded header */
  public hashValidatorSetHeader(h: ValidatorSetHeader): Hex {
    const encoded = this.abiEncodeValidatorSetHeader(h);
    return keccak256(encoded);
  }

  /** Convenience: Build header from set and return its hash */
  public getValidatorSetHeaderHash(v: ValidatorSet): Hex {
    const header = this.getValidatorSetHeader(v);
    return this.hashValidatorSetHeader(header);
  }

  private async getVotingPowers(
    provider: CrossChainAddress,
    timestamp: number,
    preferFinalized: boolean,
  ): Promise<OperatorVotingPower[]> {
    const client = this.getClient(provider.chainId);
    const providerContract = getContract({
      address: provider.address,
      abi: VOTING_POWER_PROVIDER_ABI,
      client,
    });

    const votingPowers = await providerContract.read.getVotingPowersAt([[], Number(timestamp)], {
      blockTag: toBlockTag(preferFinalized),
    });

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
    preferFinalized: boolean,
  ): Promise<OperatorWithKeys[]> {
    const client = this.getClient(provider.chainId);
    const keyRegistry = getContract({
      address: provider.address,
      abi: KEY_REGISTRY_ABI,
      client,
    });

    const keys = await keyRegistry.read.getKeysAt([Number(timestamp)], {
      blockTag: toBlockTag(preferFinalized),
    });

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
        validator.vaults.sort(
          (
            a: { votingPower: bigint; vault: Address },
            b: { votingPower: bigint; vault: Address },
          ) => {
            const powerDiff: bigint = b.votingPower - a.votingPower;
            if (powerDiff !== 0n) {
              return powerDiff > 0n ? 1 : -1;
            }
            return a.vault.toLowerCase().localeCompare(b.vault.toLowerCase());
          },
        );
        validator.vaults = validator.vaults.slice(0, SSZ_MAX_VAULTS);

        // Recalculate total voting power
        validator.votingPower = validator.vaults.reduce((sum, v) => sum + v.votingPower, 0n);
      }

      // Sort vaults by address for final output
      validator.vaults.sort((a: { vault: Address }, b: { vault: Address }) =>
        a.vault.toLowerCase().localeCompare(b.vault.toLowerCase()),
      );
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
    validators.sort((a: Validator, b: Validator) => {
      const powerDiff: bigint = b.votingPower - a.votingPower;
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
        break;
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

  private async getValsetStatus(
    settlements: CrossChainAddress[],
    epoch: number,
    preferFinalized: boolean,
  ): Promise<{
    status: 'committed' | 'pending' | 'missing';
    integrity: 'valid' | 'invalid';
  }> {
    const hashes: Map<string, string> = new Map();
    let allCommitted = true;
    let lastCommitted: number = Number.MAX_SAFE_INTEGER;

    for (const settlement of settlements) {
      const client = this.getClient(settlement.chainId);
      const settlementContract = getContract({
        address: settlement.address,
        abi: SETTLEMENT_ABI,
        client,
      });

      try {
        const isCommitted = await settlementContract.read.isValSetHeaderCommittedAt(
          [Number(epoch)],
          { blockTag: toBlockTag(preferFinalized) },
        );

        if (!isCommitted) {
          allCommitted = false;
          break;
        }

        const headerHash = (await settlementContract.read.getValSetHeaderHashAt([Number(epoch)], {
          blockTag: toBlockTag(preferFinalized),
        })) as Hex;
        if (headerHash) {
          hashes.set(`${settlement.chainId}_${settlement.address}`, headerHash);
        }

        const lastCommittedEpoch = await settlementContract.read.getLastCommittedHeaderEpoch({
          blockTag: toBlockTag(preferFinalized),
        });
        
        lastCommitted = Math.min(lastCommitted, Number(lastCommittedEpoch));
      } catch (error) {
        console.error(`Failed to get status for settlement ${settlement.address}:`, error);
        allCommitted = false;
      }
    }

    // Determine global settlement status
    let status: 'committed' | 'pending' | 'missing';
    if (allCommitted) {
      status = 'committed';
    } else if (epoch < lastCommitted && lastCommitted != Number.MAX_SAFE_INTEGER) {
      status = 'missing';
    } else {
      status = 'pending';
    }

    // Check integrity - all committed hashes should match
    const uniqueHashes = new Set(hashes.values());
    const integrity = uniqueHashes.size <= 1 ? 'valid' : 'invalid';

    return { status: status, integrity: integrity };
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
