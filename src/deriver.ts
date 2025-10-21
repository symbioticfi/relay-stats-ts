/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createPublicClient,
  http,
  PublicClient,
  Address,
  Hex,
  getContract,
  hexToString,
  isHex,
} from 'viem';
import type { Abi } from 'viem';
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
  EpochData,
  ValSetStatus,
  ValSetLogEvent,
  SettlementValSetStatus,
  SettlementValSetLog,
} from './types.js';
// bytesToHex retained in public API exports; not used internally here
import { buildSimpleExtraData, buildZkExtraData } from './extra_data.js';
import {
  VALSET_VERSION,
  AGGREGATOR_MODE,
  AggregatorMode,
  MULTICALL3_ADDRESS,
  MULTICALL_TARGET_GAS,
  MULTICALL_VOTING_CALL_GAS,
  MULTICALL_KEYS_CALL_GAS,
  MULTICALL_VAULT_COLLATERAL_CALL_GAS,
  MULTICALL_ERC20_METADATA_CALL_GAS,
} from './constants.js';
import {
  VALSET_DRIVER_ABI,
  SETTLEMENT_ABI,
  VOTING_POWER_PROVIDER_ABI,
  KEY_REGISTRY_ABI,
  VAULT_ABI,
  ERC20_METADATA_ABI,
} from './abi.js';
import { blockTagFromFinality, type BlockTagPreference } from './utils.js';
import {
  calculateQuorumThreshold,
  composeValidators,
  createValidatorSetHeader,
  encodeValidatorSetHeader,
  hashValidatorSet,
  hashValidatorSetHeader,
  totalActiveVotingPower,
} from './validator_set.js';
import {
  selectDefaultSettlement,
  getOrCreateValSetEventsState,
  ValSetEventsState,
  retrieveValSetEvent as fetchValSetLogEvent,
} from './valset_events.js';

const EPOCH_EVENT_BLOCK_BUFFER = 16n;

const getSettlementContract = (client: PublicClient, settlement: CrossChainAddress) =>
  getContract({
    address: settlement.address,
    abi: SETTLEMENT_ABI,
    client,
  });

type MulticallSettlementStatus = {
  isCommitted: boolean;
  headerHash: Hex | null;
  lastCommittedEpoch: bigint;
};

type MulticallRequest = {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  estimatedGas?: bigint;
};

const tryFetchSettlementStatusViaMulticall = async (
  client: PublicClient,
  settlement: CrossChainAddress,
  epochNumber: number,
  blockTag: BlockTagPreference,
): Promise<MulticallSettlementStatus | null> => {
  const tagsToTry: BlockTagPreference[] =
    blockTag === 'finalized' ? [blockTag, 'latest'] : [blockTag];

  for (const tag of tagsToTry) {
    try {
      const results = (await client.multicall({
        allowFailure: false,
        blockTag: tag,
        multicallAddress: MULTICALL3_ADDRESS as Address,
        contracts: [
          {
            address: settlement.address,
            abi: SETTLEMENT_ABI,
            functionName: 'isValSetHeaderCommittedAt',
            args: [epochNumber] as const,
          },
          {
            address: settlement.address,
            abi: SETTLEMENT_ABI,
            functionName: 'getValSetHeaderHashAt',
            args: [epochNumber] as const,
          },
          {
            address: settlement.address,
            abi: SETTLEMENT_ABI,
            functionName: 'getLastCommittedHeaderEpoch',
          },
        ],
      })) as readonly unknown[];

      const [isCommittedRaw, headerHashRaw, lastCommittedEpochRaw] = results;
      let headerHash: Hex | null = null;
      if (typeof headerHashRaw === 'string') {
        headerHash = headerHashRaw as Hex;
      }

      let lastCommittedEpoch: bigint = 0n;
      if (typeof lastCommittedEpochRaw === 'bigint') {
        lastCommittedEpoch = lastCommittedEpochRaw;
      } else if (
        typeof lastCommittedEpochRaw === 'number' ||
        typeof lastCommittedEpochRaw === 'string'
      ) {
        lastCommittedEpoch = BigInt(lastCommittedEpochRaw);
      }

      return {
        isCommitted: Boolean(isCommittedRaw),
        headerHash,
        lastCommittedEpoch,
      };
    } catch {
      continue;
    }
  }

  return null;
};

export const determineValSetStatus = async (
  clientFactory: (chainId: number) => PublicClient,
  settlements: readonly CrossChainAddress[],
  epoch: number,
  preferFinalized: boolean,
): Promise<ValSetStatus> => {
  const hashes: Map<string, string> = new Map();
  let allCommitted = true;
  let lastCommitted: number = Number.MAX_SAFE_INTEGER;
  const details: SettlementValSetStatus[] = [];

  const blockTag = blockTagFromFinality(preferFinalized);
  const epochNumber = Number(epoch);

  for (const settlement of settlements) {
    const client = clientFactory(settlement.chainId);
    const detail: SettlementValSetStatus = {
      settlement,
      committed: false,
      headerHash: null,
      lastCommittedEpoch: null,
    };

    const multiResult = await tryFetchSettlementStatusViaMulticall(
      client,
      settlement,
      epochNumber,
      blockTag,
    );

    if (multiResult) {
      const committed = Boolean(multiResult.isCommitted);
      detail.committed = committed;
      detail.headerHash = multiResult.headerHash;
      detail.lastCommittedEpoch = Number(multiResult.lastCommittedEpoch);
    } else {
      const settlementContract = getSettlementContract(client, settlement);
      const isCommitted = await settlementContract.read.isValSetHeaderCommittedAt([epochNumber], {
        blockTag,
      });
      detail.committed = Boolean(isCommitted);

      if (detail.committed) {
        const headerHash = (await settlementContract.read.getValSetHeaderHashAt([epochNumber], {
          blockTag,
        })) as Hex;
        detail.headerHash = headerHash ?? null;
      }

      const lastCommittedEpoch = await settlementContract.read.getLastCommittedHeaderEpoch({
        blockTag,
      });
      detail.lastCommittedEpoch = Number(lastCommittedEpoch);
    }

    if (detail.committed && detail.headerHash) {
      hashes.set(`${settlement.chainId}_${settlement.address}`, detail.headerHash);
    }

    if (!detail.committed) {
      allCommitted = false;
    }

    if (detail.lastCommittedEpoch !== null && Number.isFinite(detail.lastCommittedEpoch)) {
      lastCommitted = Math.min(lastCommitted, detail.lastCommittedEpoch);
    }

    details.push(detail);
  }

  let status: ValSetStatus['status'];
  if (allCommitted) {
    status = 'committed';
  } else if (epoch < lastCommitted && lastCommitted !== Number.MAX_SAFE_INTEGER) {
    status = 'missing';
  } else {
    status = 'pending';
  }

  const uniqueHashes = new Set(hashes.values());
  const integrity: ValSetStatus['integrity'] = uniqueHashes.size <= 1 ? 'valid' : 'invalid';

  return { status, integrity, settlements: details };
};

type DriverReadMethod =
  | 'getCurrentEpoch'
  | 'getCurrentEpochDuration'
  | 'getCurrentEpochStart'
  | 'getNextEpoch'
  | 'getNextEpochDuration'
  | 'getNextEpochStart'
  | 'getEpochStart'
  | 'getEpochDuration'
  | 'getEpochIndex';

type DriverReadArgsMap = {
  getCurrentEpoch: [];
  getCurrentEpochDuration: [];
  getCurrentEpochStart: [];
  getNextEpoch: [];
  getNextEpochDuration: [];
  getNextEpochStart: [];
  getEpochStart: [number];
  getEpochDuration: [number];
  getEpochIndex: [number];
};

type CachedNetworkConfigEntry = {
  config: NetworkConfig;
  epochStart: number;
};

export interface ValidatorSetDeriverConfig {
  rpcUrls: string[];
  driverAddress: CrossChainAddress;
  cache?: CacheInterface | null;
  maxSavedEpochs?: number;
}

export class ValidatorSetDeriver {
  private readonly clients = new Map<number, PublicClient>();
  private readonly driverAddress: CrossChainAddress;
  private readonly cache: CacheInterface | null;
  private readonly maxSavedEpochs: number;
  private readonly initializedPromise: Promise<void>;
  private readonly rpcUrls: readonly string[];
  private readonly valsetEventsState = new Map<string, ValSetEventsState>();

  constructor(config: ValidatorSetDeriverConfig) {
    this.driverAddress = config.driverAddress;
    this.cache = config.cache === undefined ? null : config.cache;
    this.maxSavedEpochs = config.maxSavedEpochs || 100;
    this.rpcUrls = Object.freeze([...config.rpcUrls]);
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

    const blockTag = blockTagFromFinality(finalized);
    let networkAddress: Address;
    let subnetwork: Hex;

    const driverClient = this.getClient(this.driverAddress.chainId);
    if (await this.multicallExists(this.driverAddress.chainId, blockTag)) {
      const results = await driverClient.multicall({
        allowFailure: false,
        blockTag,
        multicallAddress: MULTICALL3_ADDRESS as Address,
        contracts: [
          {
            address: this.driverAddress.address,
            abi: VALSET_DRIVER_ABI,
            functionName: 'NETWORK',
          },
          {
            address: this.driverAddress.address,
            abi: VALSET_DRIVER_ABI,
            functionName: 'SUBNETWORK',
          },
        ],
      });

      networkAddress = results[0] as Address;
      subnetwork = results[1] as Hex;
    } else {
      const driver = this.getDriverContract();
      const values = await Promise.all([
        driver.read.NETWORK({ blockTag }),
        driver.read.SUBNETWORK({ blockTag }),
      ]);

      networkAddress = values[0] as Address;
      subnetwork = values[1] as Hex;
    }

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

    const domainTuple = await settlementContract.read.eip712Domain({ blockTag });

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
    return this.loadAggregatorsExtraData({
      mode,
      tags,
      validatorSet: vset,
      finalized,
    });
  }

  public async getEpochData(options?: {
    epoch?: number;
    finalized?: boolean;
    includeNetworkData?: boolean;
    includeValSetEvent?: boolean;
    settlement?: CrossChainAddress;
    aggregatorKeyTags?: number[];
  }): Promise<EpochData> {
    await this.ensureInitialized();

    const finalized = options?.finalized ?? true;
    const { targetEpoch } = await this.resolveEpoch(options?.epoch, finalized);
    const { config, epochStart } = await this.loadNetworkConfigData({ targetEpoch, finalized });

    const useCache = finalized;
    const cacheKey = 'valset';
    let validatorSet: ValidatorSet | null = null;
    if (useCache) {
      const cached = await this.getFromCache('valset', targetEpoch, cacheKey);
      if (cached && this.isValidatorSet(cached) && this.canCacheValidatorSet(cached)) {
        validatorSet = cached;
      } else if (cached) {
        await this.deleteFromCache('valset', targetEpoch, cacheKey);
      }
    }
    if (!validatorSet) {
      validatorSet = await this.buildValidatorSet({
        targetEpoch,
        finalized,
        epochStart,
        config,
        useCache,
      });
    }

    let settlementStatuses: SettlementValSetStatus[] = [];
    let valsetStatusData: ValSetStatus | null = null;
    if (config.settlements.length > 0) {
      valsetStatusData = await this.updateValidatorSetStatus(
        validatorSet,
        config.settlements,
        targetEpoch,
        finalized,
      );
      settlementStatuses = valsetStatusData.settlements;
      if (useCache && this.canCacheValSetStatus(valsetStatusData)) {
        await this.setToCache('valset', targetEpoch, cacheKey, validatorSet);
      }
    }

    const includeNetworkData = options?.includeNetworkData ?? false;
    const includeValSetEvent = options?.includeValSetEvent ?? false;

    const settlement =
      options?.settlement ?? (config.settlements.length > 0 ? config.settlements[0] : undefined);

    let networkData: NetworkData | undefined;
    if (includeNetworkData) {
      networkData = await this.getNetworkData(settlement, finalized);
    }

    const tags =
      options?.aggregatorKeyTags && options.aggregatorKeyTags.length > 0
        ? options.aggregatorKeyTags
        : config.requiredKeyTags;
    const verificationMode = this.getVerificationMode(config);
    const aggregatorsExtraData = await this.loadAggregatorsExtraData({
      mode: verificationMode,
      tags,
      validatorSet,
      finalized,
    });

    if (finalized && this.canCacheValidatorSet(validatorSet)) {
      const requiredTagsSorted = [...config.requiredKeyTags].sort((a, b) => a - b);
      const oppositeMode =
        verificationMode === AGGREGATOR_MODE.SIMPLE ? AGGREGATOR_MODE.ZK : AGGREGATOR_MODE.SIMPLE;
      if (oppositeMode !== verificationMode) {
        await this.loadAggregatorsExtraData({
          mode: oppositeMode,
          tags: requiredTagsSorted,
          validatorSet,
          finalized,
        });
      }
    }

    let valSetEvents: SettlementValSetLog[] | undefined;
    if (includeValSetEvent) {
      if (settlementStatuses.length === 0) {
        valSetEvents = [];
      } else {
        const events: SettlementValSetLog[] = [];
        for (const detail of settlementStatuses) {
          let event: ValSetLogEvent | null = null;
          if (detail.committed) {
            event = await this.retrieveValSetEvent(
              {
                epoch: targetEpoch,
                settlement: detail.settlement,
                finalized,
                mode: verificationMode,
              },
              { overall: valsetStatusData, detail },
            );
          }
          events.push({
            settlement: detail.settlement,
            committed: detail.committed,
            event,
          });
        }

        valSetEvents = events;
      }
    }

    return {
      epoch: targetEpoch,
      finalized,
      epochStart,
      config,
      validatorSet,
      networkData,
      settlementStatuses,
      valSetEvents,
      aggregatorsExtraData,
    };
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
      const currentEpoch = await this.getCurrentEpoch(true);
      const config = await this.getNetworkConfig(currentEpoch, true);

      const requiredChainIds = new Set<number>();
      requiredChainIds.add(this.driverAddress.chainId);
      config.votingPowerProviders.forEach((p) => requiredChainIds.add(Number(p.chainId)));
      requiredChainIds.add(Number(config.keysProvider.chainId));
      config.settlements.forEach((s) => requiredChainIds.add(Number(s.chainId)));

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

  private async resolveEpoch(
    epoch: number | undefined,
    finalized: boolean,
  ): Promise<{ currentEpoch: number; targetEpoch: number }> {
    const currentEpoch = await this.getCurrentEpoch(finalized);
    const targetEpoch = epoch ?? currentEpoch;
    if (targetEpoch > currentEpoch) {
      throw new Error(
        `Requested epoch ${targetEpoch} is not yet available on-chain (latest is ${currentEpoch}).`,
      );
    }
    return { currentEpoch, targetEpoch };
  }

  private getVerificationMode(config: NetworkConfig): AggregatorMode {
    return config.verificationType === 0 ? AGGREGATOR_MODE.ZK : AGGREGATOR_MODE.SIMPLE;
  }

  private isValSetStatus(value: unknown): value is ValSetStatus {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as ValSetStatus;
    return (
      (candidate.status === 'committed' ||
        candidate.status === 'pending' ||
        candidate.status === 'missing') &&
      (candidate.integrity === 'valid' || candidate.integrity === 'invalid') &&
      Array.isArray(candidate.settlements)
    );
  }

  private isValidatorSet(value: unknown): value is ValidatorSet {
    if (!value || typeof value !== 'object' || value === null) return false;
    const candidate = value as ValidatorSet;
    return (
      typeof candidate.epoch === 'number' &&
      typeof candidate.status === 'string' &&
      Array.isArray(candidate.validators)
    );
  }

  private canCacheValSetStatus(status: ValSetStatus): boolean {
    return status.status === 'committed';
  }

  private canCacheValidatorSet(validatorSet: ValidatorSet): boolean {
    return validatorSet.status === 'committed' && validatorSet.integrity === 'valid';
  }

  private isAggregatorExtraCacheEntry(
    value: unknown,
  ): value is { hash: Hex; data: AggregatorExtraDataEntry[] } {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as { hash?: unknown; data?: unknown };
    return typeof candidate.hash === 'string' && Array.isArray(candidate.data);
  }

  private async updateValidatorSetStatus(
    validatorSet: ValidatorSet,
    settlements: readonly CrossChainAddress[],
    epoch: number,
    finalized: boolean,
  ): Promise<ValSetStatus> {
    const statusInfo = await this.loadValSetStatus({
      settlements,
      epoch,
      finalized,
    });

    validatorSet.status = statusInfo.status;
    validatorSet.integrity = statusInfo.integrity;

    if (statusInfo.integrity === 'invalid') {
      throw new Error(
        `Settlement integrity check failed for epoch ${epoch}. ` +
          `Header hashes do not match across settlements, indicating a critical issue with the validator set.`,
      );
    }

    return statusInfo;
  }

  private isCachedNetworkConfigEntry(value: unknown): value is CachedNetworkConfigEntry {
    if (!value || typeof value !== 'object' || value === null) return false;
    const entry = value as CachedNetworkConfigEntry & { epochStart?: unknown };
    return (
      typeof entry.epochStart === 'number' &&
      entry.config !== undefined &&
      typeof (entry.config as NetworkConfig).requiredHeaderKeyTag === 'number'
    );
  }

  private isNetworkConfigStructure(value: unknown): value is NetworkConfig {
    if (!value || typeof value !== 'object' || value === null) return false;
    const candidate = value as NetworkConfig & { keysProvider?: unknown; settlements?: unknown };
    return (
      typeof candidate.keysProvider === 'object' &&
      candidate.keysProvider !== null &&
      Array.isArray(candidate.settlements)
    );
  }

  private mapDriverConfig(config: any): NetworkConfig {
    return {
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
  }

  private async loadNetworkConfigData(params: {
    targetEpoch: number;
    finalized: boolean;
  }): Promise<CachedNetworkConfigEntry> {
    const { targetEpoch, finalized } = params;
    const useCache = finalized;
    const cacheKey = 'config';

    if (useCache) {
      const cached = await this.getFromCache('config', targetEpoch, cacheKey);
      if (cached) {
        if (this.isCachedNetworkConfigEntry(cached)) {
          return cached;
        }
        if (this.isNetworkConfigStructure(cached)) {
          const epochStart = await this.getEpochStart(targetEpoch, finalized);
          const entry: CachedNetworkConfigEntry = {
            config: cached,
            epochStart,
          };
          await this.setToCache('config', targetEpoch, cacheKey, entry);
          return entry;
        }
      }
    }

    const blockTag = blockTagFromFinality(finalized);
    const epochStart = await this.getEpochStart(targetEpoch, finalized);
    const driver = this.getDriverContract();
    const rawConfig = await driver.read.getConfigAt([Number(epochStart)], {
      blockTag,
    });

    const config = this.mapDriverConfig(rawConfig);
    const entry: CachedNetworkConfigEntry = {
      config,
      epochStart,
    };

    if (useCache) {
      await this.setToCache('config', targetEpoch, cacheKey, entry);
    }

    return entry;
  }

  private settlementCacheKey(settlement: CrossChainAddress): string {
    return `${settlement.chainId}_${settlement.address.toLowerCase()}`;
  }

  private settlementsCacheKey(settlements: readonly CrossChainAddress[]): string {
    return settlements
      .map((s) => this.settlementCacheKey(s))
      .sort()
      .join('|');
  }

  private async loadValSetStatus(params: {
    settlements: readonly CrossChainAddress[];
    epoch: number;
    finalized: boolean;
  }): Promise<ValSetStatus> {
    const { settlements, epoch, finalized } = params;
    const useCache = finalized;
    const key = this.settlementsCacheKey(settlements);

    if (useCache) {
      const cached = await this.getFromCache('valset_status', epoch, key);
      if (cached && this.isValSetStatus(cached) && this.canCacheValSetStatus(cached)) {
        return cached;
      }
      if (cached) {
        await this.deleteFromCache('valset_status', epoch, key);
      }
    }

    const status = await determineValSetStatus(
      (chainId) => this.getClient(chainId),
      settlements,
      epoch,
      finalized,
    );

    if (useCache && this.canCacheValSetStatus(status)) {
      await this.setToCache('valset_status', epoch, key, status);
    }

    return status;
  }

  private async loadAggregatorsExtraData(params: {
    mode: AggregatorMode;
    tags: readonly number[];
    validatorSet: ValidatorSet;
    finalized: boolean;
  }): Promise<AggregatorExtraDataEntry[]> {
    const { mode, tags, validatorSet, finalized } = params;
    const sortedTags = [...tags].sort((a, b) => a - b);
    const cacheKey = `${mode}_${sortedTags.join(',')}`;
    const useCache = finalized;
    const cacheable = useCache && this.canCacheValidatorSet(validatorSet);
    const validatorSetHash = cacheable ? this.getValidatorSetHeaderHash(validatorSet) : null;

    if (cacheable && validatorSetHash) {
      const cached = await this.getFromCache('aggregator_extra', validatorSet.epoch, cacheKey);
      if (cached && this.isAggregatorExtraCacheEntry(cached) && cached.hash === validatorSetHash) {
        return cached.data;
      }
      if (cached) {
        await this.deleteFromCache('aggregator_extra', validatorSet.epoch, cacheKey);
      }
    }

    const result =
      mode === AGGREGATOR_MODE.SIMPLE
        ? buildSimpleExtraData(validatorSet, sortedTags)
        : await buildZkExtraData(validatorSet, sortedTags);

    if (cacheable && validatorSetHash) {
      await this.setToCache('aggregator_extra', validatorSet.epoch, cacheKey, {
        hash: validatorSetHash,
        data: result,
      });
    }

    return result;
  }

  private async buildValidatorSet(params: {
    targetEpoch: number;
    finalized: boolean;
    epochStart: number;
    config: NetworkConfig;
    useCache: boolean;
  }): Promise<ValidatorSet> {
    const { targetEpoch, finalized, epochStart, config, useCache } = params;
    const cacheKey = 'valset';

    const timestampNumber = Number(epochStart);

    const allVotingPowers: { chainId: number; votingPowers: OperatorVotingPower[] }[] = [];
    for (const provider of config.votingPowerProviders) {
      const votingPowers = await this.getVotingPowers(provider, timestampNumber, finalized);
      allVotingPowers.push({
        chainId: provider.chainId,
        votingPowers,
      });
    }

    const keys = await this.getKeys(config.keysProvider, timestampNumber, finalized);

    const validators = composeValidators(config, allVotingPowers, keys);
    await this.populateVaultCollateralMetadata(validators, finalized);
    const totalVotingPower = validators
      .filter((validator) => validator.isActive)
      .reduce((sum, validator) => sum + validator.votingPower, 0n);
    const quorumThreshold = calculateQuorumThreshold(config, totalVotingPower);

    const sortedRequiredTags = [...config.requiredKeyTags].sort((a, b) => a - b);

    const baseValset: ValidatorSet = {
      version: VALSET_VERSION,
      requiredKeyTag: config.requiredHeaderKeyTag,
      epoch: targetEpoch,
      captureTimestamp: timestampNumber,
      quorumThreshold,
      validators,
      totalVotingPower,
      status: 'pending',
      integrity: 'valid',
      extraData: [],
    };

    const simpleExtra = buildSimpleExtraData(baseValset, sortedRequiredTags);
    const zkExtra = await buildZkExtraData(baseValset, sortedRequiredTags);

    const combinedEntries = [...simpleExtra, ...zkExtra];
    const deduped = new Map<string, AggregatorExtraDataEntry>();
    for (const entry of combinedEntries) {
      deduped.set(entry.key.toLowerCase(), entry);
    }
    const extraData = Array.from(deduped.values()).sort((left, right) =>
      left.key.toLowerCase().localeCompare(right.key.toLowerCase()),
    );

    const result: ValidatorSet = {
      ...baseValset,
      extraData,
    };

    if (useCache) {
      await this.setToCache('valset', targetEpoch, cacheKey, result);
    }

    return result;
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

  private async multicallExists(chainId: number, blockTag: BlockTagPreference): Promise<boolean> {
    const client = this.getClient(chainId);
    const tagsToTry: BlockTagPreference[] =
      blockTag === 'finalized' ? [blockTag, 'latest'] : [blockTag];

    for (const tag of tagsToTry) {
      try {
        const bytecode = await client.getBytecode({
          address: MULTICALL3_ADDRESS as Address,
          blockTag: tag,
        });
        if (bytecode && bytecode !== '0x') {
          return true;
        }
        if (bytecode !== null) {
          return false;
        }
      } catch {
        // If the network does not support the requested finality, try the next tag.
        continue;
      }
    }

    return false;
  }

  private async executeChunkedMulticall<T>({
    client,
    requests,
    blockTag,
    allowFailure = false,
  }: {
    client: PublicClient;
    requests: readonly MulticallRequest[];
    blockTag: BlockTagPreference;
    allowFailure?: boolean;
  }): Promise<T[]> {
    if (requests.length === 0) return [];

    const chunks: MulticallRequest[][] = [];
    let currentChunk: MulticallRequest[] = [];
    let currentGas: bigint = 0n;

    for (const request of requests) {
      const gasEstimate = request.estimatedGas ?? 0n;

      if (currentChunk.length > 0 && currentGas + gasEstimate > MULTICALL_TARGET_GAS) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentGas = 0n;
      }

      currentChunk.push(request);
      currentGas += gasEstimate;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    const results: T[] = [];

    for (const chunk of chunks) {
      const rawResult = await client.multicall({
        allowFailure,
        blockTag,
        multicallAddress: MULTICALL3_ADDRESS as Address,
        contracts: chunk.map((item) => ({
          address: item.address,
          abi: item.abi,
          functionName: item.functionName as never,
          args: item.args,
        })),
      });

      if (allowFailure) {
        const chunkResult = (
          rawResult as readonly { status: 'success' | 'failure'; result: unknown }[]
        ).map((entry) => (entry.status === 'success' ? (entry.result as T) : (null as T)));
        results.push(...chunkResult);
      } else {
        const chunkResult = rawResult as unknown as T[];
        results.push(...chunkResult);
      }
    }

    return results;
  }

  private async populateVaultCollateralMetadata(
    validators: Validator[],
    finalized: boolean,
  ): Promise<void> {
    const vaultsByChain = new Map<number, Address[]>();

    for (const validator of validators) {
      for (const vault of validator.vaults) {
        let list = vaultsByChain.get(vault.chainId);
        if (!list) {
          list = [];
          vaultsByChain.set(vault.chainId, list);
        }
        list.push(vault.vault);
      }
    }

    if (vaultsByChain.size === 0) return;

    const blockTag = blockTagFromFinality(finalized);
    const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
    const vaultCollateralMap = new Map<string, Address>();
    const tokensByChain = new Map<number, Map<string, Address>>();
    const chainMulticallSupport = new Map<number, boolean>();

    for (const [chainId, vaultAddresses] of vaultsByChain) {
      const client = this.getClient(chainId);
      const uniqueVaults = this.dedupeAddresses(vaultAddresses);
      if (uniqueVaults.length === 0) continue;

      const hasMulticall = await this.multicallExists(chainId, blockTag);
      chainMulticallSupport.set(chainId, hasMulticall);

      let tokensForChain = tokensByChain.get(chainId);
      if (!tokensForChain) {
        tokensForChain = new Map<string, Address>();
        tokensByChain.set(chainId, tokensForChain);
      }
      let collateralResults: (Address | null)[] = [];

      if (hasMulticall) {
        collateralResults = await this.executeChunkedMulticall<Address | null>({
          client,
          requests: uniqueVaults.map((address) => ({
            address,
            abi: VAULT_ABI as Abi,
            functionName: 'collateral',
            args: [],
            estimatedGas: MULTICALL_VAULT_COLLATERAL_CALL_GAS,
          })),
          blockTag,
          allowFailure: true,
        });
      }

      if (collateralResults.length === 0) {
        collateralResults = Array(uniqueVaults.length).fill(null);
      }

      for (let i = 0; i < uniqueVaults.length; i++) {
        if (!collateralResults[i]) {
          try {
            const fallback = (await client.readContract({
              address: uniqueVaults[i],
              abi: VAULT_ABI,
              functionName: 'collateral',
              args: [],
              blockTag,
            })) as Address;
            collateralResults[i] = fallback;
          } catch {
            collateralResults[i] = null;
          }
        }

        const collateral = collateralResults[i];
        if (!collateral || collateral.toLowerCase() === ZERO_ADDRESS) continue;

        vaultCollateralMap.set(
          `${chainId}_${uniqueVaults[i].toLowerCase()}`,
          collateral as Address,
        );
        tokensForChain.set(collateral.toLowerCase(), collateral as Address);
      }
    }

    if (vaultCollateralMap.size === 0) return;

    const metadataMap = new Map<string, { symbol?: string; name?: string }>();

    for (const [chainId, tokenMap] of tokensByChain) {
      const client = this.getClient(chainId);
      const tokens = Array.from(tokenMap.values());
      if (tokens.length === 0) continue;

      const hasMulticall = chainMulticallSupport.get(chainId) ?? false;
      const metadataCalls: { token: Address; field: 'symbol' | 'name' }[] = [];
      const requests: MulticallRequest[] = [];

      for (const token of tokens) {
        metadataCalls.push({ token, field: 'symbol' });
        requests.push({
          address: token,
          abi: ERC20_METADATA_ABI as Abi,
          functionName: 'symbol',
          args: [],
          estimatedGas: MULTICALL_ERC20_METADATA_CALL_GAS,
        });

        metadataCalls.push({ token, field: 'name' });
        requests.push({
          address: token,
          abi: ERC20_METADATA_ABI as Abi,
          functionName: 'name',
          args: [],
          estimatedGas: MULTICALL_ERC20_METADATA_CALL_GAS,
        });
      }

      let metadataResults: (string | null)[];
      if (hasMulticall && requests.length > 0) {
        metadataResults = await this.executeChunkedMulticall<string | null>({
          client,
          requests,
          blockTag,
          allowFailure: true,
        });
      } else {
        metadataResults = Array(requests.length).fill(null);
      }

      const fallbackRequests = new Map<Address, Set<'symbol' | 'name'>>();

      for (let i = 0; i < metadataCalls.length; i++) {
        const call = metadataCalls[i];
        const rawValue = metadataResults[i];
        const normalized = this.normalizeTokenMetadataValue(rawValue);
        if (normalized !== null) {
          const key = `${chainId}_${call.token.toLowerCase()}`;
          const existing = metadataMap.get(key) ?? ({} as { symbol?: string; name?: string });
          if (call.field === 'symbol') {
            existing.symbol = normalized;
          } else {
            existing.name = normalized;
          }
          metadataMap.set(key, existing);
        } else {
          const current = fallbackRequests.get(call.token) ?? new Set<'symbol' | 'name'>();
          current.add(call.field);
          fallbackRequests.set(call.token, current);
        }
      }

      if (fallbackRequests.size > 0) {
        for (const [token, fields] of fallbackRequests) {
          for (const field of fields) {
            const fallbackValue = await this.readTokenMetadataField(client, token, field, blockTag);
            if (!fallbackValue) continue;
            const key = `${chainId}_${token.toLowerCase()}`;
            const existing = metadataMap.get(key) ?? ({} as { symbol?: string; name?: string });
            if (field === 'symbol') {
              existing.symbol = fallbackValue;
            } else {
              existing.name = fallbackValue;
            }
            metadataMap.set(key, existing);
          }
        }
      }
    }

    for (const validator of validators) {
      for (const vault of validator.vaults) {
        const vaultKey = `${vault.chainId}_${vault.vault.toLowerCase()}`;
        const collateral = vaultCollateralMap.get(vaultKey);
        if (!collateral) continue;

        vault.collateral = collateral;
        const metadataKey = `${vault.chainId}_${collateral.toLowerCase()}`;
        const metadata = metadataMap.get(metadataKey);
        if (metadata?.symbol) {
          vault.collateralSymbol = metadata.symbol;
        }
        if (metadata?.name) {
          vault.collateralName = metadata.name;
        }
      }
    }
  }

  private dedupeAddresses(addresses: readonly Address[]): Address[] {
    const seen = new Set<string>();
    const unique: Address[] = [];
    for (const address of addresses) {
      const lower = address.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      unique.push(address);
    }
    return unique;
  }

  private normalizeTokenMetadataValue(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0) {
      return null;
    }

    if (isHex(value)) {
      if (value === '0x') {
        return null;
      }
      try {
        const size = value.length === 66 ? 32 : undefined;
        const decoded = hexToString(value as Hex, size ? { size } : undefined);
        const trimmed = decoded.replace(/\u0000+$/g, '');
        return trimmed.length > 0 ? trimmed : null;
      } catch {
        return null;
      }
    }

    return value;
  }

  private async readTokenMetadataField(
    client: PublicClient,
    token: Address,
    field: 'symbol' | 'name',
    blockTag: BlockTagPreference,
  ): Promise<string | null> {
    try {
      const result = await client.readContract({
        address: token,
        abi: ERC20_METADATA_ABI,
        functionName: field,
        args: [],
        blockTag,
      });
      const normalized = this.normalizeTokenMetadataValue(result);
      if (normalized !== null) {
        return normalized;
      }
    } catch {
      // Ignore read errors; fall through to null
    }

    return null;
  }

  private getDriverContract() {
    const client = this.getClient(this.driverAddress.chainId);
    return getContract({
      address: this.driverAddress.address,
      abi: VALSET_DRIVER_ABI,
      client,
    });
  }

  private async readDriverNumber<M extends DriverReadMethod>(
    method: M,
    finalized: boolean,
    args?: DriverReadArgsMap[M],
  ): Promise<number> {
    await this.ensureInitialized();
    const driver = this.getDriverContract();
    const blockTag = blockTagFromFinality(finalized);
    const reader = (
      driver.read as unknown as Record<
        DriverReadMethod,
        (...params: any[]) => Promise<bigint | number>
      >
    )[method];
    const result =
      args && args.length > 0 ? await reader(args, { blockTag }) : await reader({ blockTag });
    return Number(result);
  }

  // withPreferredBlockTag removed; use explicit { blockTag: blockTagFromFinality(...) }

  private async getFromCache(namespace: string, epoch: number, key: string): Promise<any | null> {
    if (!this.cache) return null;
    try {
      return await this.cache.get(epoch, key);
    } catch {
      return null;
    }
  }

  private async setToCache(
    namespace: string,
    epoch: number,
    key: string,
    value: any,
  ): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.set(epoch, key, value);
    } catch {
      // Ignore cache errors
    }
  }

  private async deleteFromCache(namespace: string, epoch: number, key: string): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.delete(epoch, key);
    } catch {
      // Ignore cache errors
    }
  }

  async getCurrentEpoch(finalized: boolean = true): Promise<number> {
    return this.readDriverNumber('getCurrentEpoch', finalized);
  }

  async getCurrentEpochDuration(finalized: boolean = true): Promise<number> {
    return this.readDriverNumber('getCurrentEpochDuration', finalized);
  }

  async getCurrentEpochStart(finalized: boolean = true): Promise<number> {
    return this.readDriverNumber('getCurrentEpochStart', finalized);
  }

  async getNextEpoch(finalized: boolean = true): Promise<number> {
    return this.readDriverNumber('getNextEpoch', finalized);
  }

  async getNextEpochDuration(finalized: boolean = true): Promise<number> {
    return this.readDriverNumber('getNextEpochDuration', finalized);
  }

  async getNextEpochStart(finalized: boolean = true): Promise<number> {
    return this.readDriverNumber('getNextEpochStart', finalized);
  }

  async getEpochStart(epoch: number, finalized: boolean = true): Promise<number> {
    return this.readDriverNumber('getEpochStart', finalized, [Number(epoch)]);
  }

  async getEpochDuration(epoch: number, finalized: boolean = true): Promise<number> {
    return this.readDriverNumber('getEpochDuration', finalized, [Number(epoch)]);
  }

  async getEpochIndex(timestamp: number, finalized: boolean = true): Promise<number> {
    return this.readDriverNumber('getEpochIndex', finalized, [Number(timestamp)]);
  }

  async getNetworkConfig(epoch?: number, finalized: boolean = true): Promise<NetworkConfig> {
    await this.ensureInitialized();

    const { targetEpoch } = await this.resolveEpoch(epoch, finalized);
    const { config } = await this.loadNetworkConfigData({ targetEpoch, finalized });
    return config;
  }

  async getValidatorSet(epoch?: number, finalized: boolean = true): Promise<ValidatorSet> {
    await this.ensureInitialized();

    const { targetEpoch } = await this.resolveEpoch(epoch, finalized);

    const useCache2 = finalized;
    const cacheKey = 'valset';
    let validatorSet: ValidatorSet | null = null;
    if (useCache2) {
      const cached = await this.getFromCache('valset', targetEpoch, cacheKey);
      if (cached && this.isValidatorSet(cached)) {
        validatorSet = cached;
      } else if (cached) {
        await this.deleteFromCache('valset', targetEpoch, cacheKey);
      }
    }

    const { config, epochStart } = await this.loadNetworkConfigData({ targetEpoch, finalized });

    if (!validatorSet) {
      validatorSet = await this.buildValidatorSet({
        targetEpoch,
        finalized,
        epochStart,
        config,
        useCache: useCache2,
      });
    }

    let statusInfo: ValSetStatus | null = null;
    if (config.settlements.length > 0) {
      statusInfo = await this.updateValidatorSetStatus(
        validatorSet,
        config.settlements,
        targetEpoch,
        finalized,
      );
      if (useCache2 && this.canCacheValSetStatus(statusInfo)) {
        await this.setToCache('valset', targetEpoch, cacheKey, validatorSet);
      }
    }

    return validatorSet;
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

  public getTotalActiveVotingPower(validatorSet: ValidatorSet): bigint {
    return totalActiveVotingPower(validatorSet);
  }

  public getValidatorSetHeader(validatorSet: ValidatorSet): ValidatorSetHeader {
    return createValidatorSetHeader(validatorSet);
  }

  public abiEncodeValidatorSetHeader(header: ValidatorSetHeader): Hex {
    return encodeValidatorSetHeader(header);
  }

  public hashValidatorSetHeader(header: ValidatorSetHeader): Hex {
    return hashValidatorSetHeader(header);
  }

  public getValidatorSetHeaderHash(validatorSet: ValidatorSet): Hex {
    return hashValidatorSet(validatorSet);
  }

  private async getVotingPowers(
    provider: CrossChainAddress,
    timestamp: number,
    preferFinalized: boolean,
  ): Promise<OperatorVotingPower[]> {
    const client = this.getClient(provider.chainId);
    const blockTag = blockTagFromFinality(preferFinalized);
    const timestampBigInt = BigInt(timestamp);
    const timestampNumber = Number(timestamp);
    const providerContract = getContract({
      address: provider.address,
      abi: VOTING_POWER_PROVIDER_ABI,
      client,
    });

    if (await this.multicallExists(provider.chainId, blockTag)) {
      const operators = await providerContract.read.getOperatorsAt([timestampNumber], {
        blockTag,
      });

      if (operators.length === 0) return [];

      const operatorList = Array.from(operators, (operator) => operator as Address);
      const results = await this.executeChunkedMulticall<
        readonly { vault: Address; value: bigint }[]
      >({
        client,
        requests: operatorList.map((operator) => ({
          address: provider.address,
          abi: VOTING_POWER_PROVIDER_ABI,
          functionName: 'getOperatorVotingPowersAt',
          args: [operator, '0x' as Hex, timestampBigInt],
          estimatedGas: MULTICALL_VOTING_CALL_GAS,
        })),
        blockTag,
      });

      if (results.length !== operatorList.length) {
        throw new Error(
          `Multicall result length mismatch for voting powers: expected ${operatorList.length}, got ${results.length}`,
        );
      }

      return operatorList.map((operator, index) => {
        const vaults = (results[index] ?? []) as readonly { vault: Address; value: bigint }[];
        return {
          operator,
          vaults: Array.from(vaults, (v) => ({
            vault: v.vault as Address,
            votingPower: v.value,
          })),
        };
      });
    }

    const votingPowers = await providerContract.read.getVotingPowersAt([[], timestampNumber], {
      blockTag,
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
    const blockTag = blockTagFromFinality(preferFinalized);
    const timestampNumber = Number(timestamp);
    const keyRegistry = getContract({
      address: provider.address,
      abi: KEY_REGISTRY_ABI,
      client,
    });

    if (await this.multicallExists(provider.chainId, blockTag)) {
      const operators = await keyRegistry.read.getKeysOperatorsAt([timestampNumber], {
        blockTag,
      });

      if (operators.length === 0) return [];

      const operatorList = Array.from(operators, (operator) => operator as Address);
      const results = await this.executeChunkedMulticall<
        readonly { tag: number | bigint; payload: Hex }[]
      >({
        client,
        requests: operatorList.map((operator) => ({
          address: provider.address,
          abi: KEY_REGISTRY_ABI,
          functionName: 'getKeysAt',
          args: [operator, timestampNumber],
          estimatedGas: MULTICALL_KEYS_CALL_GAS,
        })),
        blockTag,
      });

      if (results.length !== operatorList.length) {
        throw new Error(
          `Multicall result length mismatch for keys: expected ${operatorList.length}, got ${results.length}`,
        );
      }

      return operatorList.map((operator, index) => {
        const operatorKeys = (results[index] ?? []) as readonly {
          tag: number | bigint;
          payload: Hex;
        }[];
        return {
          operator,
          keys: Array.from(operatorKeys, (key) => ({
            tag: typeof key.tag === 'bigint' ? Number(key.tag) : key.tag,
            payload: key.payload as Hex,
          })),
        };
      });
    }

    const keys = (await client.readContract({
      address: provider.address,
      abi: KEY_REGISTRY_ABI,
      functionName: 'getKeysAt',
      args: [timestampNumber] as const,
      blockTag,
    })) as readonly {
      operator: Address;
      keys: readonly { tag: number | bigint; payload: Hex }[];
    }[];

    return keys.map((k) => ({
      operator: k.operator,
      keys: Array.from(k.keys, (key) => ({
        tag: typeof key.tag === 'bigint' ? Number(key.tag) : key.tag,
        payload: key.payload,
      })),
    }));
  }

  private async getValsetStatus(
    settlements: CrossChainAddress[],
    epoch: number,
    preferFinalized: boolean,
  ) {
    return this.loadValSetStatus({
      settlements,
      epoch,
      finalized: preferFinalized,
    });
  }

  private getOrCreateValSetEventsState(
    blockTag: BlockTagPreference,
    settlement: CrossChainAddress,
  ): ValSetEventsState {
    return getOrCreateValSetEventsState(this.valsetEventsState, blockTag, settlement);
  }

  private async selectSettlementForEvent(
    epoch: number,
    finalized: boolean,
    settlement?: CrossChainAddress,
  ): Promise<CrossChainAddress> {
    if (settlement) return settlement;

    const config = await this.getNetworkConfig(epoch, finalized);
    return selectDefaultSettlement(config.settlements);
  }

  async getValSetStatus(epoch: number, finalized: boolean = true): Promise<ValSetStatus> {
    await this.ensureInitialized();
    const config = await this.getNetworkConfig(epoch, finalized);
    return this.getValsetStatus(config.settlements, epoch, finalized);
  }

  public async getValSetSettlementStatuses(options?: {
    epoch?: number;
    finalized?: boolean;
    settlements?: CrossChainAddress[];
  }): Promise<SettlementValSetStatus[]> {
    await this.ensureInitialized();
    const finalized = options?.finalized ?? true;
    const { targetEpoch } = await this.resolveEpoch(options?.epoch, finalized);

    let settlements = options?.settlements;
    if (!settlements) {
      const config = await this.getNetworkConfig(targetEpoch, finalized);
      settlements = config.settlements;
    }

    if (!settlements || settlements.length === 0) {
      return [];
    }

    const status = await this.getValsetStatus(Array.from(settlements), targetEpoch, finalized);
    return status.settlements;
  }

  public async getValSetLogEvents(options?: {
    epoch?: number;
    finalized?: boolean;
    settlements?: CrossChainAddress[];
  }): Promise<SettlementValSetLog[]> {
    await this.ensureInitialized();
    const finalized = options?.finalized ?? true;
    const { targetEpoch } = await this.resolveEpoch(options?.epoch, finalized);

    const config = await this.getNetworkConfig(targetEpoch, finalized);
    const mode = this.getVerificationMode(config);

    let settlements = options?.settlements;
    if (!settlements) {
      settlements = config.settlements;
    }

    if (!settlements || settlements.length === 0) {
      return [];
    }

    const status = await this.getValsetStatus(Array.from(settlements), targetEpoch, finalized);
    const results: SettlementValSetLog[] = [];

    for (const detail of status.settlements) {
      let event: ValSetLogEvent | null = null;
      if (detail.committed) {
        event = await this.retrieveValSetEvent(
          {
            epoch: targetEpoch,
            settlement: detail.settlement,
            finalized,
            mode,
          },
          { overall: status, detail },
        );
      }

      results.push({
        settlement: detail.settlement,
        committed: detail.committed,
        event,
      });
    }

    return results;
  }

  private async retrieveValSetEvent(
    params: {
      epoch: number;
      settlement: CrossChainAddress;
      finalized: boolean;
      mode: AggregatorMode;
    },
    statusContext?: {
      overall?: ValSetStatus | null;
      detail?: SettlementValSetStatus | null;
    },
  ): Promise<ValSetLogEvent | null> {
    const { epoch, settlement, finalized, mode } = params;
    const blockTag = blockTagFromFinality(finalized);
    const state = this.getOrCreateValSetEventsState(blockTag, settlement);

    const existing = state.map.get(epoch) ?? null;
    if (!finalized) {
      return existing?.event ?? null;
    }

    if (existing) {
      return existing.event;
    }

    const allowEventCache = statusContext?.overall?.status === 'committed';

    const event = await fetchValSetLogEvent(
      { epoch, settlement, finalized, mode },
      (tag, addr) => this.getOrCreateValSetEventsState(tag, addr),
      this.cache,
      (ep, fin) => this.getValSetStatus(ep, fin),
      {
        getStart: (ep, fin) => this.getEpochStart(ep, fin),
        getEnd: async (ep, fin, fallbackStart) => {
          try {
            return await this.getEpochStart(ep, fin);
          } catch {
            try {
              return await this.getNextEpochStart(fin);
            } catch {
              const duration = await this.getCurrentEpochDuration(fin);
              return fallbackStart + duration;
            }
          }
        },
      },
      (chainId) => this.getClient(chainId),
      EPOCH_EVENT_BLOCK_BUFFER,
      statusContext,
      allowEventCache,
    );

    if (event && allowEventCache) {
      const settlementSuffix = `${settlement.chainId}_${settlement.address.toLowerCase()}`;
      await this.setToCache('valset_event', epoch, settlementSuffix, event);
    }

    return event;
  }
}
