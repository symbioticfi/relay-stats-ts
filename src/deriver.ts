import { Address, Hex, PublicClient } from 'viem';
import {
    buildSettlementKey,
    buildSettlementStatusKey,
    cacheDelete,
    cacheGet,
    cacheGetTyped,
    cacheSet,
    pruneMap,
} from './cache.js';
import {
    DRIVER_METHOD,
    buildClientMap,
    getClientOrThrow,
    multicallExists as hasMulticall,
    readDriverNumber,
    fetchNetworkIdentifiers,
    fetchSettlementDomain,
    fetchVotingPowers,
    fetchKeysAt,
    readDriverConfigAt,
    type DriverReadArgsMap,
    type DriverReadMethod,
} from './client.js';
import {
    isCachedNetworkConfigEntry,
    mapDriverConfig,
    type RawDriverConfig,
    type CachedNetworkConfigEntry,
} from './config.js';
import {
    AGGREGATOR_MODE,
    AggregatorMode,
    CACHE_NAMESPACE,
    EPOCH_EVENT_BLOCK_BUFFER,
    VALSET_VERSION,
} from './constants.js';
import { buildSimpleExtraData, buildZkExtraData } from './extra-data/index.js';
import { applyCollateralMetadata } from './metadata.js';
import {
    determineValSetStatus,
    getOrCreateValSetEventsState,
    retrieveValSetEvent as fetchValSetLogEvent,
    ValSetEventsState,
} from './settlement.js';
import {
    AggregatorExtraDataEntry,
    CacheInterface,
    CrossChainAddress,
    EpochData,
    NetworkConfig,
    NetworkData,
    OperatorVotingPower,
    OperatorWithKeys,
    SettlementValSetLog,
    SettlementValSetStatus,
    ValSetLogEvent,
    ValSetStatus,
    ValidatorSet,
    ValidatorSetHeader,
} from './types/index.js';
import { blockTagFromFinality, type BlockTagPreference } from './utils/core.js';
import {
    calculateQuorumThreshold,
    composeValidators,
    createValidatorSetHeader,
    encodeValidatorSetHeader,
    hashValidatorSet,
    hashValidatorSetHeader,
    totalActiveVotingPower,
} from './validator_set.js';

const logger = console;

export interface ValidatorSetDeriverConfig {
    rpcUrls: string[];
    driverAddress: CrossChainAddress;
    cache?: CacheInterface | null;
    maxSavedEpochs?: number;
}

// === Public API ===
export class ValidatorSetDeriver {
    /** @notice Static factory that initializes clients and validates coverage. */
    static async create(config: ValidatorSetDeriverConfig): Promise<ValidatorSetDeriver> {
        const deriver = new ValidatorSetDeriver(config);
        await deriver.ensureInitialized();

        await deriver.validateRequiredChains();

        return deriver;
    }

    /** @notice Public factory; use to ensure clients are initialized/validated. */
    private readonly clients = new Map<number, PublicClient>();
    private readonly driverAddress: CrossChainAddress;
    private readonly cache: CacheInterface | null;
    private readonly maxSavedEpochs: number;
    private readonly initializedPromise: Promise<void>;
    private readonly rpcUrls: readonly string[];
    private readonly valsetEventsState = new Map<string, ValSetEventsState>(); // ancorCache
    private readonly multicallSupport = new Map<string, boolean>();
    private readonly settlementBlockAnchors = new Map<
        string,
        { epoch: number; block: bigint; blocksPerEpoch: bigint }
    >();

    constructor(config: ValidatorSetDeriverConfig) {
        this.driverAddress = config.driverAddress;
        this.cache = config.cache === undefined ? null : config.cache;
        this.maxSavedEpochs = config.maxSavedEpochs || 100;
        this.rpcUrls = Object.freeze([...config.rpcUrls]);
        this.initializedPromise = this.initializeClients();
    }

    // === Epoch/config ===
    /** @notice Derive network metadata (NETWORK/SUBNETWORK + settlement EIP-712 domain). */
    async getNetworkData(
        settlement?: CrossChainAddress,
        finalized: boolean = true
    ): Promise<NetworkData> {
        await this.ensureInitialized();
        const cacheKey = settlement
            ? buildSettlementKey(settlement)
            : this.driverAddress.address.toLowerCase();
        const networkCacheKey = `network_${cacheKey}`;
        if (finalized && this.cache) {
            const cached = await cacheGetTyped<NetworkData>(
                this.cache,
                CACHE_NAMESPACE.VALSET,
                0,
                networkCacheKey,
                (value): value is NetworkData => Boolean((value as NetworkData)?.eip712Data)
            );
            if (cached) return cached;
        }
        const blockTag = blockTagFromFinality(finalized);
        const driverClient = this.getClient(this.driverAddress.chainId);

        const useMulticall = await this.multicallExists(this.driverAddress.chainId, blockTag);
        const { network: networkAddress, subnetwork } = await fetchNetworkIdentifiers({
            client: driverClient,
            driver: this.driverAddress,
            blockTag,
            useMulticall,
        });

        let targetSettlement: CrossChainAddress | undefined = settlement;
        if (!targetSettlement) {
            const cfg = await this.getNetworkConfig(undefined, finalized);
            targetSettlement = cfg.settlements[0];
        }
        if (!targetSettlement) {
            throw new Error('No settlement available to fetch EIP-712 domain');
        }

        const settlementClient = this.getClient(targetSettlement.chainId);
        const eip712Data = await fetchSettlementDomain({
            client: settlementClient,
            settlement: targetSettlement,
            blockTag,
        });

        const result: NetworkData = {
            address: networkAddress as Address,
            subnetwork: subnetwork as Hex,
            eip712Data,
        };
        if (finalized && this.cache) {
            await cacheSet(this.cache, CACHE_NAMESPACE.VALSET, 0, networkCacheKey, result);
        }
        return result;
    }

    /** @notice Build aggregator extraData entries for simple or zk verification modes. */
    public async getAggregatorsExtraData(
        mode: AggregatorMode,
        keyTags?: number[],
        finalized: boolean = true,
        epoch?: number
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

    /** @notice One-shot epoch snapshot: validator set, statuses, events, extras, metadata. */
    public async getEpochData(options?: {
        epoch?: number;
        finalized?: boolean;
        includeNetworkData?: boolean;
        includeSettlementStatus?: boolean;
        includeCollateralMetadata?: boolean;
        includeValSetEvent?: boolean;
        settlement?: CrossChainAddress;
        aggregatorKeyTags?: number[];
    }): Promise<EpochData> {
        await this.ensureInitialized();

        const finalized = options?.finalized ?? true;
        const { targetEpoch } = await this.resolveEpoch(options?.epoch, finalized);
        const { config, epochStart } = await this.loadNetworkConfigData({ targetEpoch, finalized });

        const includeNetworkData = options?.includeNetworkData ?? false;
        const includeSettlementStatus = options?.includeSettlementStatus ?? true;
        const includeCollateralMetadata = options?.includeCollateralMetadata ?? true;
        const useCache = finalized;
        const cacheKey = 'valset';
        let validatorSet: ValidatorSet | null = null;
        if (useCache) {
            const cached = await cacheGetTyped<ValidatorSet>(
                this.cache,
                CACHE_NAMESPACE.VALSET,
                targetEpoch,
                cacheKey,
                (value): value is ValidatorSet =>
                    this.isValidatorSet(value) && this.canCacheValidatorSet(value)
            );
            if (cached) {
                validatorSet = cached;
            }
        }
        if (!validatorSet) {
            validatorSet = await this.buildValidatorSet({
                targetEpoch,
                finalized,
                epochStart,
                config,
                useCache,
                includeCollateralMetadata,
            });
        }

        let settlementStatuses: SettlementValSetStatus[] = [];
        let valsetStatusData: ValSetStatus | null = null;
        const includeValSetEvent = options?.includeValSetEvent ?? false;
        let settlement: CrossChainAddress | undefined;
        if (config.settlements.length > 0) {
            settlement = options?.settlement ?? config.settlements[0];
        }

        let networkData: NetworkData | undefined;
        if (includeNetworkData && settlement) {
            networkData = await this.getNetworkData(settlement, finalized);
        }

        if (includeSettlementStatus && config.settlements.length > 0) {
            valsetStatusData = await this.updateValidatorSetStatus(
                validatorSet,
                config.settlements,
                targetEpoch,
                finalized
            );
            settlementStatuses = valsetStatusData.settlements;
            if (useCache && valsetStatusData && this.canCacheValSetStatus(valsetStatusData)) {
                const statusKey = buildSettlementStatusKey(config.settlements);
                await cacheSet(
                    this.cache,
                    CACHE_NAMESPACE.VALSET_STATUS,
                    targetEpoch,
                    statusKey,
                    valsetStatusData
                );
            }
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

        let valSetEvents: SettlementValSetLog[] | undefined;
        if (includeValSetEvent && includeSettlementStatus) {
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
                            { overall: valsetStatusData, detail }
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

    private async initializeClients(): Promise<void> {
        const clientMap = await buildClientMap(this.rpcUrls);
        this.clients.clear();
        for (const [chainId, client] of clientMap.entries()) {
            this.clients.set(chainId, client);
        }

        if (!this.clients.has(this.driverAddress.chainId)) {
            throw new Error(
                `Driver chain ID ${this.driverAddress.chainId} not found in provided RPC URLs`
            );
        }
    }

    private async validateRequiredChains(): Promise<void> {
        try {
            const currentEpoch = await this.getCurrentEpoch(true);
            const config = await this.getNetworkConfig(currentEpoch, true);

            const requiredChainIds = new Set<number>();
            requiredChainIds.add(this.driverAddress.chainId);
            config.votingPowerProviders.forEach(p => requiredChainIds.add(Number(p.chainId)));
            requiredChainIds.add(Number(config.keysProvider.chainId));
            config.settlements.forEach(s => requiredChainIds.add(Number(s.chainId)));

            const missingChains: number[] = [];
            for (const chainId of requiredChainIds) {
                if (!this.clients.has(chainId)) {
                    missingChains.push(chainId);
                }
            }

            if (missingChains.length > 0) {
                throw new Error(
                    `Missing RPC clients for required chains: ${missingChains.join(', ')}. ` +
                        `Please ensure RPC URLs are provided for all chains used by voting power providers, keys provider, and settlements.`
                );
            }
        } catch (error) {
            if (error instanceof Error && error.message.includes('Missing RPC clients')) {
                throw error; // Re-throw our validation error
            }
            // For other errors (like contract not available), just warn
            logger.warn(
                'Warning: Could not validate required chains. This might be expected for test environments.'
            );
            logger.warn('Error:', error instanceof Error ? error.message : String(error));
        }
    }

    private async resolveEpoch(
        epoch: number | undefined,
        finalized: boolean
    ): Promise<{ currentEpoch: number; targetEpoch: number }> {
        const currentEpoch = await this.getCurrentEpoch(finalized);
        const targetEpoch = epoch ?? currentEpoch;
        if (targetEpoch > currentEpoch) {
            // TODO: do we need that validation? if epoch is defined then we do redundant call
            throw new Error(
                `Requested epoch ${targetEpoch} is not yet available on-chain (latest is ${currentEpoch}).`
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
        if (!value || typeof value !== 'object') return false;
        const candidate = value as ValidatorSet;
        return Array.isArray(candidate.validators);
    }

    private canCacheValSetStatus(status: ValSetStatus): boolean {
        return status.status === 'committed';
    }

    private canCacheValidatorSet(validatorSet: ValidatorSet): boolean {
        return validatorSet.status === 'committed' && validatorSet.integrity === 'valid';
    }

    private isAggregatorExtraCacheEntry(
        value: unknown
    ): value is { hash: Hex; data: AggregatorExtraDataEntry[] } {
        if (!value || typeof value !== 'object') return false;
        const candidate = value as { hash?: unknown; data?: unknown };
        return typeof candidate.hash === 'string' && Array.isArray(candidate.data);
    }

    private async updateValidatorSetStatus(
        validatorSet: ValidatorSet,
        settlements: readonly CrossChainAddress[],
        epoch: number,
        finalized: boolean
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
                    `Header hashes do not match across settlements, indicating a critical issue with the validator set.`
            );
        }

        return statusInfo;
    }

    private async loadNetworkConfigData(params: {
        targetEpoch: number;
        finalized: boolean;
    }): Promise<CachedNetworkConfigEntry> {
        const { targetEpoch, finalized } = params;
        const useCache = finalized;
        const cacheKey = 'config';

        if (useCache) {
            const cached = await cacheGetTyped<CachedNetworkConfigEntry>(
                this.cache,
                CACHE_NAMESPACE.CONFIG,
                targetEpoch,
                cacheKey,
                isCachedNetworkConfigEntry
            );
            if (cached) {
                return cached;
            }
        }

        const blockTag = blockTagFromFinality(finalized);
        const epochStart = await this.getEpochStart(targetEpoch, finalized);
        const driverClient = this.getClient(this.driverAddress.chainId);
        const rawConfig = (await readDriverConfigAt(
            driverClient,
            this.driverAddress,
            Number(epochStart),
            blockTag
        )) as RawDriverConfig;

        const config = mapDriverConfig(rawConfig);
        const entry: CachedNetworkConfigEntry = {
            config,
            epochStart,
        };

        if (useCache) {
            await cacheSet(this.cache, CACHE_NAMESPACE.CONFIG, targetEpoch, cacheKey, entry);
        }

        return entry;
    }

    private async loadValSetStatus(params: {
        settlements: readonly CrossChainAddress[];
        epoch: number;
        finalized: boolean;
    }): Promise<ValSetStatus> {
        const { settlements, epoch, finalized } = params;
        const useCache = finalized;
        const key = buildSettlementStatusKey(settlements);

        if (useCache) {
            const cached = await cacheGet(this.cache, CACHE_NAMESPACE.VALSET_STATUS, epoch, key);
            if (cached && this.isValSetStatus(cached) && this.canCacheValSetStatus(cached)) {
                return cached;
            }
            if (cached) {
                await cacheDelete(this.cache, CACHE_NAMESPACE.VALSET_STATUS, epoch, key);
            }
        }

        const status = await determineValSetStatus(
            chainId => this.getClient(chainId),
            settlements,
            epoch,
            finalized
        );

        if (useCache && this.canCacheValSetStatus(status)) {
            await cacheSet(this.cache, CACHE_NAMESPACE.VALSET_STATUS, epoch, key, status);
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
            const cached = await cacheGetTyped<{
                hash: Hex;
                data: AggregatorExtraDataEntry[];
            }>(
                this.cache,
                CACHE_NAMESPACE.AGGREGATOR_EXTRA,
                validatorSet.epoch,
                cacheKey,
                this.isAggregatorExtraCacheEntry
            );
            if (cached && cached.hash === validatorSetHash) {
                return cached.data;
            }
        }

        const result =
            mode === AGGREGATOR_MODE.SIMPLE
                ? buildSimpleExtraData(validatorSet, sortedTags)
                : await buildZkExtraData(validatorSet, sortedTags);

        if (cacheable && validatorSetHash) {
            await cacheSet(
                this.cache,
                CACHE_NAMESPACE.AGGREGATOR_EXTRA,
                validatorSet.epoch,
                cacheKey,
                {
                    hash: validatorSetHash,
                    data: result,
                }
            );
        }

        return result;
    }

    private async buildValidatorSet(params: {
        targetEpoch: number;
        finalized: boolean;
        epochStart: number;
        config: NetworkConfig;
        useCache: boolean;
        includeCollateralMetadata: boolean;
    }): Promise<ValidatorSet> {
        const { targetEpoch, finalized, epochStart, config, useCache, includeCollateralMetadata } =
            params;
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
        if (includeCollateralMetadata) {
            await applyCollateralMetadata({
                validators,
                finalized,
                getClient: chainId => this.getClient(chainId),
                hasMulticall: (chainId, tag) => this.multicallExists(chainId, tag),
            });
        }
        const totalVotingPower = validators
            .filter(validator => validator.isActive)
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
            left.key.toLowerCase().localeCompare(right.key.toLowerCase())
        );

        const result: ValidatorSet = {
            ...baseValset,
            extraData,
        };

        if (useCache) {
            await cacheSet(this.cache, CACHE_NAMESPACE.VALSET, targetEpoch, cacheKey, result);
        }

        return result;
    }

    private async ensureInitialized(): Promise<void> {
        await this.initializedPromise;
    }

    private getClient(chainId: number): PublicClient {
        return getClientOrThrow(this.clients, chainId);
    }

    private async multicallExists(chainId: number, blockTag: BlockTagPreference): Promise<boolean> {
        const key = `${chainId}:${blockTag}`;
        const persisted = await cacheGetTyped<boolean>(
            this.cache,
            CACHE_NAMESPACE.MULTICALL_SUPPORT,
            0,
            key,
            (value): value is boolean => typeof value === 'boolean'
        );
        if (persisted !== null) {
            this.multicallSupport.set(key, persisted);
            return persisted;
        }

        const cached = this.multicallSupport.get(key);
        if (cached !== undefined) return cached;

        const client = this.getClient(chainId);
        const exists = await hasMulticall(client, blockTag);
        this.multicallSupport.set(key, exists);
        await cacheSet(this.cache, CACHE_NAMESPACE.MULTICALL_SUPPORT, 0, key, exists);
        if (this.multicallSupport.size > this.maxSavedEpochs && this.maxSavedEpochs > 0) {
            const [first] = this.multicallSupport.keys();
            this.multicallSupport.delete(first);
            await cacheDelete(this.cache, CACHE_NAMESPACE.MULTICALL_SUPPORT, 0, first);
        }
        return exists;
    }

    private async readDriverNumber<M extends DriverReadMethod>(
        method: M,
        finalized: boolean,
        args?: DriverReadArgsMap[M]
    ): Promise<number> {
        await this.ensureInitialized();
        const blockTag = blockTagFromFinality(finalized);
        const client = this.getClient(this.driverAddress.chainId);
        return readDriverNumber({
            client,
            driver: this.driverAddress,
            method,
            blockTag,
            args,
        });
    }

    // === Epoch/config ===
    async getCurrentEpoch(finalized: boolean = true): Promise<number> {
        return this.readDriverNumber(DRIVER_METHOD.CURRENT_EPOCH, finalized);
    }

    async getCurrentEpochDuration(finalized: boolean = true): Promise<number> {
        return this.readDriverNumber(DRIVER_METHOD.CURRENT_EPOCH_DURATION, finalized);
    }

    async getCurrentEpochStart(finalized: boolean = true): Promise<number> {
        return this.readDriverNumber(DRIVER_METHOD.CURRENT_EPOCH_START, finalized);
    }

    /** @notice Get the next epoch index (scheduled). */
    async getNextEpoch(finalized: boolean = true): Promise<number> {
        return this.readDriverNumber(DRIVER_METHOD.NEXT_EPOCH, finalized);
    }

    /** @notice Get the duration of the next epoch (seconds). */
    async getNextEpochDuration(finalized: boolean = true): Promise<number> {
        return this.readDriverNumber(DRIVER_METHOD.NEXT_EPOCH_DURATION, finalized);
    }

    /** @notice Get the start timestamp of the next epoch. */
    async getNextEpochStart(finalized: boolean = true): Promise<number> {
        return this.readDriverNumber(DRIVER_METHOD.NEXT_EPOCH_START, finalized);
    }

    /** @notice Get the start timestamp of a specific epoch. */
    async getEpochStart(epoch: number, finalized: boolean = true): Promise<number> {
        return this.readDriverNumber(DRIVER_METHOD.EPOCH_START, finalized, [Number(epoch)]);
    }

    /** @notice Get the duration of a specific epoch (seconds). */
    async getEpochDuration(epoch: number, finalized: boolean = true): Promise<number> {
        return this.readDriverNumber(DRIVER_METHOD.EPOCH_DURATION, finalized, [Number(epoch)]);
    }

    /** @notice Resolve epoch index for a given timestamp. */
    async getEpochIndex(timestamp: number, finalized: boolean = true): Promise<number> {
        return this.readDriverNumber(DRIVER_METHOD.EPOCH_INDEX, finalized, [Number(timestamp)]);
    }

    async getNetworkConfig(epoch?: number, finalized: boolean = true): Promise<NetworkConfig> {
        await this.ensureInitialized();

        const { targetEpoch } = await this.resolveEpoch(epoch, finalized);
        const { config } = await this.loadNetworkConfigData({ targetEpoch, finalized });
        return config;
    }

    async getValidatorSet(
        epoch?: number,
        finalized: boolean = true,
        includeCollateralMetadata: boolean = true
    ): Promise<ValidatorSet> {
        await this.ensureInitialized();

        const { targetEpoch } = await this.resolveEpoch(epoch, finalized);

        const useCache = finalized;
        const cacheKey = CACHE_NAMESPACE.VALSET;
        let validatorSet: ValidatorSet | null = null;
        if (useCache) {
            const cached = await cacheGetTyped<ValidatorSet>(
                this.cache,
                CACHE_NAMESPACE.VALSET,
                targetEpoch,
                cacheKey,
                this.isValidatorSet
            );
            if (cached) {
                validatorSet = cached;
            }
        }

        const { config, epochStart } = await this.loadNetworkConfigData({ targetEpoch, finalized });

        if (!validatorSet) {
            validatorSet = await this.buildValidatorSet({
                targetEpoch,
                finalized,
                epochStart,
                config,
                useCache,
                includeCollateralMetadata,
            });
        }

        let statusInfo: ValSetStatus | null = null;
        if (config.settlements.length > 0) {
            statusInfo = await this.updateValidatorSetStatus(
                validatorSet,
                config.settlements,
                targetEpoch,
                finalized
            );
            if (useCache && statusInfo && this.canCacheValSetStatus(statusInfo)) {
                const statusKey = buildSettlementStatusKey(config.settlements);
                await cacheSet(
                    this.cache,
                    CACHE_NAMESPACE.VALSET_STATUS,
                    targetEpoch,
                    statusKey,
                    statusInfo
                );
            }
        }

        return validatorSet;
    }

    // === ValidatorSet build ===
    /** @notice Get the current validator set (finalized). */
    async getCurrentValidatorSet(includeCollateralMetadata: boolean = true): Promise<ValidatorSet> {
        return this.getValidatorSet(undefined, true, includeCollateralMetadata);
    }

    /** @notice Get the current network configuration (finalized). */
    async getCurrentNetworkConfig(): Promise<NetworkConfig> {
        return this.getNetworkConfig(undefined, true);
    }

    /** @notice Compute total active voting power for a validator set. */
    public getTotalActiveVotingPower(validatorSet: ValidatorSet): bigint {
        return totalActiveVotingPower(validatorSet);
    }

    // === Settlement/events ===
    /** @notice Build a validator-set header from a full set. */
    public getValidatorSetHeader(validatorSet: ValidatorSet): ValidatorSetHeader {
        return createValidatorSetHeader(validatorSet);
    }

    /** @notice ABI encode a validator-set header. */
    public abiEncodeValidatorSetHeader(header: ValidatorSetHeader): Hex {
        return encodeValidatorSetHeader(header);
    }

    /** @notice Keccak hash of a validator-set header. */
    public hashValidatorSetHeader(header: ValidatorSetHeader): Hex {
        return hashValidatorSetHeader(header);
    }

    /** @notice Hash a full validator set (header derived). */
    public getValidatorSetHeaderHash(validatorSet: ValidatorSet): Hex {
        return hashValidatorSet(validatorSet);
    }

    // === Metadata hydration ===
    private async getVotingPowers(
        provider: CrossChainAddress,
        timestamp: number,
        finalized: boolean
    ): Promise<OperatorVotingPower[]> {
        const client = this.getClient(provider.chainId);
        const blockTag = blockTagFromFinality(finalized);
        const timestampSeconds = BigInt(timestamp);
        const useMulticall = await this.multicallExists(provider.chainId, blockTag);

        try {
            return await fetchVotingPowers({
                client,
                provider,
                blockTag,
                timestamp: timestampSeconds,
                useMulticall,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(
                `Failed to fetch voting powers for provider ${provider.address} on chain ${provider.chainId} at blockTag=${String(blockTag)} timestamp=${timestampSeconds.toString()} (multicall=${useMulticall}): ${message}`
            );
            if (!useMulticall) throw error;
            const fallback = await fetchVotingPowers({
                client,
                provider,
                blockTag,
                timestamp: timestampSeconds,
                useMulticall: false,
            });
            this.multicallSupport.set(`${provider.chainId}:${blockTag}`, false);
            return fallback;
        }
    }

    private async getKeys(
        provider: CrossChainAddress,
        timestamp: number,
        finalized: boolean
    ): Promise<OperatorWithKeys[]> {
        const client = this.getClient(provider.chainId);
        const blockTag = blockTagFromFinality(finalized);
        const timestampSeconds = BigInt(timestamp);
        const useMulticall = await this.multicallExists(provider.chainId, blockTag);

        return fetchKeysAt({
            client,
            provider,
            blockTag,
            timestamp: timestampSeconds,
            useMulticall,
        });
    }

    private async getValsetStatus(
        settlements: CrossChainAddress[],
        epoch: number,
        finalized: boolean
    ) {
        const status = await this.loadValSetStatus({
            settlements,
            epoch,
            finalized,
        });
        this.pruneValSetEventsState();
        return status;
    }

    private getOrCreateValSetEventsState(
        blockTag: BlockTagPreference,
        settlement: CrossChainAddress
    ): ValSetEventsState {
        return getOrCreateValSetEventsState(this.valsetEventsState, blockTag, settlement);
    }

    private pruneValSetEventsState(): void {
        if (this.maxSavedEpochs <= 0) return;
        for (const state of this.valsetEventsState.values()) {
            const epochs = Array.from(state.map.keys()).sort((a, b) => a - b);
            if (epochs.length <= this.maxSavedEpochs) continue;
            const excess = epochs.length - this.maxSavedEpochs;
            for (let i = 0; i < excess; i++) {
                state.map.delete(epochs[i]);
            }
        }

        pruneMap(this.settlementBlockAnchors, this.maxSavedEpochs);
    }

    public async getValSetStatus(epoch: number, finalized: boolean = true): Promise<ValSetStatus> {
        await this.ensureInitialized();
        const config = await this.getNetworkConfig(epoch, finalized);
        return this.getValsetStatus(config.settlements, epoch, finalized);
    }

    /** @notice Settlement commitment status for an epoch (all or provided settlements). */
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

    /** @notice Settlement-indexed validator-set events (committed settlements only). */
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
                    { overall: status, detail }
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
        }
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
            chainId => this.getClient(chainId),
            EPOCH_EVENT_BLOCK_BUFFER,
            statusContext,
            allowEventCache
        );

        this.pruneValSetEventsState();

        return event;
    }
}
