import { Address, Hex, PublicClient } from 'viem';
import { SETTLEMENT_ABI } from './abis/index.js';
import {
    buildSettlementKey,
    buildSettlementStatusKey,
    createCacheEpochTracker,
    createCacheNamespace,
    type CacheEpochTracker,
    type CacheNamespaceAccessor,
} from './cache.js';
import {
    DRIVER_METHOD,
    buildClientMap,
    fetchKeysAtBatch,
    fetchNetworkIdentifiers,
    fetchSettlementDomain,
    fetchVotingPowersBatch,
    getClientOrThrow,
    readDriverConfigAtBatch,
    readDriverNumber,
    readDriverNumbersBatch,
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
    CACHE_PERSISTENT_EPOCH,
} from './constants.js';
import { buildSimpleExtraData, buildZkExtraData } from './extra-data/index.js';
import {
    buildValSetStatusFromEvents,
    determineValSetStatus,
    fetchSettlementEventsRange,
} from './settlement.js';
import type {
    AggregatorExtraDataEntry,
    CacheInterface,
    CrossChainAddress,
    EpochData,
    EpochRange,
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
import { blockTagFromFinality } from './utils/core.js';
import {
    buildValidatorSetsBatch,
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
    private readonly cacheNs: {
        config: CacheNamespaceAccessor;
        valset: CacheNamespaceAccessor;
        valsetStatus: CacheNamespaceAccessor;
        aggregatorExtra: CacheNamespaceAccessor;
    };
    private readonly maxSavedEpochs: number;
    private readonly cacheTracker: CacheEpochTracker;
    private readonly initializedPromise: Promise<void>;
    private readonly rpcUrls: readonly string[];

    constructor(config: ValidatorSetDeriverConfig) {
        this.driverAddress = config.driverAddress;
        this.cache = config.cache === undefined ? null : config.cache;
        const cachePrefix = `driver_${this.driverAddress.chainId}_${this.driverAddress.address.toLowerCase()}`;
        this.cacheNs = {
            config: createCacheNamespace(this.cache, `${cachePrefix}:${CACHE_NAMESPACE.CONFIG}`),
            valset: createCacheNamespace(this.cache, `${cachePrefix}:${CACHE_NAMESPACE.VALSET}`),
            valsetStatus: createCacheNamespace(
                this.cache,
                `${cachePrefix}:${CACHE_NAMESPACE.VALSET_STATUS}`
            ),
            aggregatorExtra: createCacheNamespace(
                this.cache,
                `${cachePrefix}:${CACHE_NAMESPACE.AGGREGATOR_EXTRA}`
            ),
        };
        this.maxSavedEpochs = config.maxSavedEpochs ?? 100;
        this.cacheTracker = createCacheEpochTracker(this.cache, {
            maxSavedEpochs: this.maxSavedEpochs,
            persistentEpoch: CACHE_PERSISTENT_EPOCH,
        });
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
        if (finalized) {
            const cacheEpoch = CACHE_PERSISTENT_EPOCH;
            const cached = await this.cacheNs.valset.getTyped(
                cacheEpoch,
                networkCacheKey,
                (value): value is NetworkData => Boolean((value as NetworkData)?.eip712Data)
            );
            if (cached) return cached;
        }
        const blockTag = blockTagFromFinality(finalized);
        const driverClient = this.getClient(this.driverAddress.chainId);

        const { network: networkAddress, subnetwork } = await fetchNetworkIdentifiers({
            client: driverClient,
            driver: this.driverAddress,
            blockTag,
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
        if (finalized) {
            const cacheEpoch = CACHE_PERSISTENT_EPOCH;
            await this.cacheNs.valset.set(cacheEpoch, networkCacheKey, result);
            await this.cacheTracker.noteEpoch(cacheEpoch);
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
        const results = await this.getAggregatorsExtraDataForEpochs({
            epochRange: epoch !== undefined ? { from: epoch, to: epoch } : undefined,
            mode,
            keyTags,
            finalized,
        });
        return results[0]?.data ?? [];
    }

    public async getAggregatorsExtraDataForEpochs(options: {
        epochRange?: EpochRange;
        mode: AggregatorMode;
        keyTags?: number[];
        finalized?: boolean;
    }): Promise<{ epoch: number; data: AggregatorExtraDataEntry[] }[]> {
        await this.ensureInitialized();

        const finalized = options.finalized ?? true;
        const { targetEpochs } = await this.resolveEpochRange(options.epochRange, finalized);
        const uniqueEpochs = Array.from(new Set(targetEpochs));

        const configEntries = await this.loadNetworkConfigDataBatch({
            targetEpochs: uniqueEpochs,
            finalized,
        });
        const validatorSets = await this.loadValidatorSetsByEpoch({
            targetEpochs: uniqueEpochs,
            finalized,
            includeCollateralMetadata: true,
            configEntries,
        });

        const results: { epoch: number; data: AggregatorExtraDataEntry[] }[] = [];
        for (const epoch of targetEpochs) {
            const config = configEntries.get(epoch)!.config;
            const validatorSet = validatorSets.get(epoch)!;
            const tags =
                options.keyTags && options.keyTags.length > 0
                    ? options.keyTags
                    : config.requiredKeyTags;
            const data = await this.loadAggregatorsExtraData({
                mode: options.mode,
                tags,
                validatorSet,
                finalized,
            });
            results.push({ epoch, data });
        }

        return results;
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
        const { epoch, ...rest } = options ?? {};
        const results = await this.getEpochsData({
            ...rest,
            epochRange: epoch !== undefined ? { from: epoch, to: epoch } : undefined,
        });
        if (results.length === 0) {
            throw new Error('No epoch data available.');
        }
        return results[0];
    }

    public async getEpochsData(options?: {
        epochRange?: EpochRange;
        finalized?: boolean;
        includeNetworkData?: boolean;
        includeSettlementStatus?: boolean;
        includeCollateralMetadata?: boolean;
        includeValSetEvent?: boolean;
        settlement?: CrossChainAddress;
        aggregatorKeyTags?: number[];
    }): Promise<EpochData[]> {
        await this.ensureInitialized();

        const finalized = options?.finalized ?? true;
        const { targetEpochs } = await this.resolveEpochRange(options?.epochRange, finalized);
        const uniqueEpochs = Array.from(new Set(targetEpochs));

        const includeNetworkData = options?.includeNetworkData ?? false;
        const includeSettlementStatus = options?.includeSettlementStatus ?? true;
        const includeCollateralMetadata = options?.includeCollateralMetadata ?? true;
        const includeValSetEvent = options?.includeValSetEvent ?? false;
        const settlementOverride = options?.settlement;
        const aggregatorKeyTags = options?.aggregatorKeyTags;

        const configEntries = await this.loadNetworkConfigDataBatch({
            targetEpochs: uniqueEpochs,
            finalized,
        });

        const validatorSets = await this.loadValidatorSetsByEpoch({
            targetEpochs: uniqueEpochs,
            finalized,
            includeCollateralMetadata,
            configEntries,
        });

        const settlementsByEpoch = new Map<number, readonly CrossChainAddress[]>();
        for (const epoch of uniqueEpochs) {
            settlementsByEpoch.set(epoch, configEntries.get(epoch)!.config.settlements);
        }

        let statusByEpoch = new Map<number, ValSetStatus>();
        let eventsBySettlement = new Map<string, Map<number, ValSetLogEvent>>();
        if ((includeSettlementStatus || includeValSetEvent) && targetEpochs.length > 0) {
            const fromEpoch = targetEpochs[0];
            const toEpoch = targetEpochs[targetEpochs.length - 1];
            const epochRange = { from: fromEpoch, to: toEpoch };
            const uniqueSettlements = new Map<string, CrossChainAddress>();
            for (const epoch of uniqueEpochs) {
                for (const settlement of configEntries.get(epoch)!.config.settlements) {
                    uniqueSettlements.set(buildSettlementKey(settlement), settlement);
                }
            }

            if (uniqueSettlements.size > 0) {
                const { epochStartFrom, epochStartTo, epochDuration } =
                    await this.resolveEpochWindow({
                        fromEpoch,
                        toEpoch,
                        finalized,
                        epochStartFrom: configEntries.get(fromEpoch)?.epochStart,
                        epochStartTo: configEntries.get(toEpoch)?.epochStart,
                    });
                eventsBySettlement = await this.fetchSettlementEventsByRange({
                    settlements: Array.from(uniqueSettlements.values()),
                    epochRange,
                    epochStartFrom,
                    epochStartTo,
                    epochDuration,
                    finalized,
                });
            }

            if (includeSettlementStatus) {
                statusByEpoch = await this.loadValSetStatusBatch({
                    settlementsByEpoch,
                    epochs: uniqueEpochs,
                    epochRange,
                    finalized,
                    eventsBySettlement,
                });
                this.applyValidatorSetStatuses(validatorSets, statusByEpoch);
                await this.updateCachedValidatorSets(validatorSets, statusByEpoch, finalized);
            }
        }

        const results: EpochData[] = [];
        for (const epoch of targetEpochs) {
            const entry = configEntries.get(epoch)!;
            const validatorSet = validatorSets.get(epoch)!;
            const config = entry.config;

            let settlementStatuses: SettlementValSetStatus[] = [];
            let valsetStatusData: ValSetStatus | null = null;
            if (includeSettlementStatus && config.settlements.length > 0) {
                valsetStatusData = statusByEpoch.get(epoch) ?? null;
                settlementStatuses = valsetStatusData?.settlements ?? [];
            }

            let networkData: NetworkData | undefined;
            let settlement: CrossChainAddress | undefined;
            if (config.settlements.length > 0) {
                settlement = settlementOverride ?? config.settlements[0];
            }

            if (includeNetworkData && settlement) {
                networkData = await this.getNetworkData(settlement, finalized);
            }

            const tags =
                aggregatorKeyTags && aggregatorKeyTags.length > 0
                    ? aggregatorKeyTags
                    : config.requiredKeyTags;
            const verificationMode = this.getVerificationMode(config);
            const aggregatorsExtraData = await this.loadAggregatorsExtraData({
                mode: verificationMode,
                tags,
                validatorSet,
                finalized,
            });

            let valSetEvents: SettlementValSetLog[] | undefined;
            if (includeValSetEvent) {
                if (config.settlements.length === 0) {
                    valSetEvents = [];
                } else {
                    valSetEvents = config.settlements.map(settlement => {
                        const key = buildSettlementKey(settlement);
                        const event = eventsBySettlement.get(key)?.get(epoch) ?? null;
                        return {
                            settlement,
                            committed: Boolean(event),
                            event,
                        };
                    });
                }
            }

            results.push({
                epoch,
                finalized,
                epochStart: entry.epochStart,
                config,
                validatorSet,
                networkData,
                settlementStatuses,
                valSetEvents,
                aggregatorsExtraData,
            });
        }

        return results;
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

    private normalizeEpochRange(epochRange: EpochRange): { from: number; to: number } {
        const from = Number(epochRange.from);
        const to = Number(epochRange.to);
        if (!Number.isFinite(from) || !Number.isFinite(to)) {
            throw new Error(
                `Invalid epoch range: from=${String(epochRange.from)} to=${String(epochRange.to)}.`
            );
        }
        if (from > to) {
            throw new Error(`Invalid epoch range: from ${from} is greater than to ${to}.`);
        }
        return { from, to };
    }

    private expandEpochRange(epochRange: EpochRange): number[] {
        const { from, to } = this.normalizeEpochRange(epochRange);
        const targetEpochs: number[] = [];
        for (let epoch = from; epoch <= to; epoch++) {
            targetEpochs.push(epoch);
        }
        return targetEpochs;
    }

    private async resolveEpochRange(
        epochRange: EpochRange | undefined,
        finalized: boolean
    ): Promise<{ currentEpoch: number; targetEpochs: number[] }> {
        const currentEpoch = await this.getCurrentEpoch(finalized);
        if (!epochRange) {
            return { currentEpoch, targetEpochs: [currentEpoch] };
        }

        const { from, to } = this.normalizeEpochRange(epochRange);
        if (to > currentEpoch) {
            throw new Error(
                `Requested epoch ${to} is not yet available on-chain (latest is ${currentEpoch}).`
            );
        }

        const targetEpochs: number[] = [];
        for (let epoch = from; epoch <= to; epoch++) {
            targetEpochs.push(epoch);
        }

        return { currentEpoch, targetEpochs };
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

    private isAggregatorExtraCacheEntry(
        value: unknown
    ): value is { hash: Hex; data: AggregatorExtraDataEntry[] } {
        if (!value || typeof value !== 'object') return false;
        const candidate = value as { hash?: unknown; data?: unknown };
        return typeof candidate.hash === 'string' && Array.isArray(candidate.data);
    }

    private async resolveEpochWindow(params: {
        fromEpoch: number;
        toEpoch: number;
        finalized: boolean;
        epochStartFrom?: number;
        epochStartTo?: number;
        epochDuration?: number;
    }): Promise<{ epochStartFrom: number; epochStartTo: number; epochDuration: number }> {
        const { fromEpoch, toEpoch, finalized } = params;
        const epochStartFrom =
            params.epochStartFrom ?? (await this.getEpochStart(fromEpoch, finalized));
        const epochStartTo =
            params.epochStartTo ??
            (fromEpoch === toEpoch ? epochStartFrom : await this.getEpochStart(toEpoch, finalized));
        let epochDuration = params.epochDuration ?? 0;
        if (epochDuration <= 0) {
            try {
                epochDuration = await this.getEpochDuration(toEpoch, finalized);
            } catch {
                epochDuration = await this.getCurrentEpochDuration(finalized);
            }
        }
        return { epochStartFrom, epochStartTo, epochDuration };
    }

    private async fetchSettlementEventsByRange(params: {
        settlements: readonly CrossChainAddress[];
        epochRange: EpochRange;
        epochStartFrom: number;
        epochStartTo: number;
        epochDuration: number;
        finalized: boolean;
    }): Promise<Map<string, Map<number, ValSetLogEvent>>> {
        const { settlements, epochRange, epochStartFrom, epochStartTo, epochDuration, finalized } =
            params;
        const eventsBySettlement = new Map<string, Map<number, ValSetLogEvent>>();
        if (settlements.length === 0) return eventsBySettlement;

        await Promise.all(
            settlements.map(async settlement => {
                const client = this.getClient(settlement.chainId);
                const events = await fetchSettlementEventsRange(
                    client,
                    settlement,
                    epochRange.from,
                    epochRange.to,
                    epochStartFrom,
                    epochStartTo,
                    epochDuration,
                    finalized
                );
                eventsBySettlement.set(buildSettlementKey(settlement), events);
            })
        );

        return eventsBySettlement;
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

    private applyValidatorSetStatuses(
        validatorSets: Map<number, ValidatorSet>,
        statuses: Map<number, ValSetStatus>
    ): void {
        for (const [epoch, statusInfo] of statuses.entries()) {
            const validatorSet = validatorSets.get(epoch);
            if (!validatorSet) continue;
            validatorSet.status = statusInfo.status;
            validatorSet.integrity = statusInfo.integrity;

            if (statusInfo.integrity === 'invalid') {
                throw new Error(
                    `Settlement integrity check failed for epoch ${epoch}. ` +
                        `Header hashes do not match across settlements, indicating a critical issue with the validator set.`
                );
            }
        }
    }

    private async updateCachedValidatorSets(
        validatorSets: Map<number, ValidatorSet>,
        statuses: Map<number, ValSetStatus>,
        finalized: boolean
    ): Promise<void> {
        if (!finalized) return;
        const updates: Promise<void>[] = [];
        const updatedEpochs: number[] = [];
        for (const epoch of statuses.keys()) {
            const validatorSet = validatorSets.get(epoch);
            if (!validatorSet) continue;
            updatedEpochs.push(epoch);
            updates.push(this.cacheNs.valset.set(epoch, CACHE_NAMESPACE.VALSET, validatorSet));
        }
        if (updates.length === 0) return;
        await Promise.all(updates);
        await this.cacheTracker.noteEpochs(updatedEpochs);
    }

    private async loadNetworkConfigDataBatch(params: {
        targetEpochs: readonly number[];
        finalized: boolean;
    }): Promise<Map<number, CachedNetworkConfigEntry>> {
        const { targetEpochs, finalized } = params;
        const cacheKey = 'config';

        const entries = new Map<number, CachedNetworkConfigEntry>();
        const missingEpochs: number[] = [];

        if (finalized) {
            const cachedEntries = await Promise.all(
                targetEpochs.map(async targetEpoch => ({
                    epoch: targetEpoch,
                    cached: await this.cacheNs.config.getTyped(
                        targetEpoch,
                        cacheKey,
                        isCachedNetworkConfigEntry
                    ),
                }))
            );
            for (const { epoch, cached } of cachedEntries) {
                if (cached) {
                    entries.set(epoch, cached);
                } else {
                    missingEpochs.push(epoch);
                }
            }
        } else {
            missingEpochs.push(...targetEpochs);
        }

        if (missingEpochs.length === 0) {
            return entries;
        }

        const blockTag = blockTagFromFinality(finalized);
        const epochStarts = await this.readDriverNumbersBatch(
            DRIVER_METHOD.EPOCH_START,
            finalized,
            missingEpochs.map(epoch => [Number(epoch)])
        );
        const driverClient = this.getClient(this.driverAddress.chainId);
        const rawConfigs = await readDriverConfigAtBatch(
            driverClient,
            this.driverAddress,
            epochStarts,
            blockTag
        );

        if (rawConfigs.length !== missingEpochs.length) {
            throw new Error(
                `Config batch result length mismatch: expected ${missingEpochs.length}, got ${rawConfigs.length}`
            );
        }

        for (let i = 0; i < missingEpochs.length; i++) {
            const targetEpoch = missingEpochs[i];
            const rawConfig = rawConfigs[i] as RawDriverConfig;
            const config = mapDriverConfig(rawConfig);
            const entry: CachedNetworkConfigEntry = {
                config,
                epochStart: epochStarts[i],
            };
            entries.set(targetEpoch, entry);
        }

        if (finalized) {
            await Promise.all(
                missingEpochs.map(epoch =>
                    this.cacheNs.config.set(epoch, cacheKey, entries.get(epoch)!)
                )
            );
            await this.cacheTracker.noteEpochs(missingEpochs);
        }

        return entries;
    }

    private async loadValSetStatus(params: {
        settlements: readonly CrossChainAddress[];
        epoch: number;
        finalized: boolean;
    }): Promise<ValSetStatus> {
        const { settlements, epoch, finalized } = params;
        const key = buildSettlementStatusKey(settlements);

        if (finalized) {
            const cached = await this.cacheNs.valsetStatus.get(epoch, key);
            if (cached && this.isValSetStatus(cached) && cached.status === 'committed') {
                return cached;
            }
        }

        const status = await determineValSetStatus(
            chainId => this.getClient(chainId),
            settlements,
            epoch,
            finalized
        );

        if (finalized) {
            await this.cacheNs.valsetStatus.set(epoch, key, status);
            await this.cacheTracker.noteEpoch(epoch);
        }

        return status;
    }

    private async loadValSetStatusBatch(params: {
        settlementsByEpoch: Map<number, readonly CrossChainAddress[]>;
        epochs?: readonly number[];
        epochRange?: EpochRange;
        finalized: boolean;
        eventsBySettlement?: Map<string, Map<number, ValSetLogEvent>>;
    }): Promise<Map<number, ValSetStatus>> {
        const { settlementsByEpoch, finalized } = params;
        const epochs =
            params.epochs ?? (params.epochRange ? this.expandEpochRange(params.epochRange) : []);
        if (epochs.length === 0) {
            return new Map<number, ValSetStatus>();
        }

        const results = new Map<number, ValSetStatus>();
        const refreshEpochs: number[] = [];

        if (finalized) {
            const cachedStatuses = await Promise.all(
                epochs.map(async epoch => {
                    const settlements = settlementsByEpoch.get(epoch) ?? [];
                    const key = buildSettlementStatusKey(settlements);
                    const cached = await this.cacheNs.valsetStatus.get(epoch, key);
                    return { epoch, cached };
                })
            );

            for (const { epoch, cached } of cachedStatuses) {
                if (cached && this.isValSetStatus(cached) && cached.status === 'committed') {
                    results.set(epoch, cached);
                } else {
                    refreshEpochs.push(epoch);
                }
            }
        } else {
            refreshEpochs.push(...epochs);
        }

        if (refreshEpochs.length === 0) {
            return results;
        }

        const fromEpoch = Math.min(...refreshEpochs);
        const toEpoch = Math.max(...refreshEpochs);
        const epochRange = params.epochRange ?? { from: fromEpoch, to: toEpoch };

        const uniqueSettlements = new Map<string, CrossChainAddress>();
        for (const epoch of refreshEpochs) {
            const settlements = settlementsByEpoch.get(epoch) ?? [];
            for (const settlement of settlements) {
                uniqueSettlements.set(buildSettlementKey(settlement), settlement);
            }
        }

        const loadLastCommittedBySettlement = async (): Promise<Map<string, number>> => {
            const lastCommittedBySettlement = new Map<string, number>();
            if (uniqueSettlements.size === 0) {
                return lastCommittedBySettlement;
            }
            const blockTag = blockTagFromFinality(finalized);
            await Promise.all(
                Array.from(uniqueSettlements.values()).map(async settlement => {
                    const client = this.getClient(settlement.chainId);
                    const lastCommittedRaw = await client.readContract({
                        address: settlement.address,
                        abi: SETTLEMENT_ABI,
                        functionName: 'getLastCommittedHeaderEpoch',
                        args: [],
                        blockTag,
                    });
                    lastCommittedBySettlement.set(
                        buildSettlementKey(settlement),
                        Number(lastCommittedRaw)
                    );
                })
            );
            return lastCommittedBySettlement;
        };

        let eventsBySettlement = params.eventsBySettlement;
        if (!eventsBySettlement) {
            if (uniqueSettlements.size === 0) {
                eventsBySettlement = new Map<string, Map<number, ValSetLogEvent>>();
            } else {
                const scanWindow = await this.resolveEpochWindow({
                    fromEpoch: epochRange.from,
                    toEpoch: epochRange.to,
                    finalized,
                });
                eventsBySettlement = await this.fetchSettlementEventsByRange({
                    settlements: Array.from(uniqueSettlements.values()),
                    epochRange,
                    epochStartFrom: scanWindow.epochStartFrom,
                    epochStartTo: scanWindow.epochStartTo,
                    epochDuration: scanWindow.epochDuration,
                    finalized,
                });
            }
        }
        if (!eventsBySettlement) {
            eventsBySettlement = new Map<string, Map<number, ValSetLogEvent>>();
        }

        const lastCommittedBySettlement = await loadLastCommittedBySettlement();
        for (const epoch of refreshEpochs) {
            const settlements = settlementsByEpoch.get(epoch) ?? [];
            const status = buildValSetStatusFromEvents({
                epoch,
                settlements,
                eventsBySettlement,
                lastCommittedBySettlement,
            });
            results.set(epoch, status);
        }

        if (finalized) {
            await Promise.all(
                refreshEpochs.map(epoch => {
                    const settlements = settlementsByEpoch.get(epoch) ?? [];
                    const cacheKey = buildSettlementStatusKey(settlements);
                    return this.cacheNs.valsetStatus.set(epoch, cacheKey, results.get(epoch)!);
                })
            );
            await this.cacheTracker.noteEpochs(refreshEpochs);
        }

        return results;
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
        const validatorSetHash = finalized ? hashValidatorSet(validatorSet) : null;

        if (finalized && validatorSetHash) {
            const cached = await this.cacheNs.aggregatorExtra.getTyped(
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

        if (finalized && validatorSetHash) {
            await this.cacheNs.aggregatorExtra.set(validatorSet.epoch, cacheKey, {
                hash: validatorSetHash,
                data: result,
            });
            await this.cacheTracker.noteEpoch(validatorSet.epoch);
        }

        return result;
    }

    private async loadValidatorSetsByEpoch(params: {
        targetEpochs: readonly number[];
        finalized: boolean;
        includeCollateralMetadata: boolean;
        configEntries: Map<number, CachedNetworkConfigEntry>;
    }): Promise<Map<number, ValidatorSet>> {
        const { targetEpochs, finalized, includeCollateralMetadata, configEntries } = params;
        const results = new Map<number, ValidatorSet>();
        const missingEpochs: number[] = [];
        const cacheValidator = (value: unknown): value is ValidatorSet =>
            this.isValidatorSet(value);

        if (finalized) {
            const cachedSets = await Promise.all(
                targetEpochs.map(async targetEpoch => ({
                    epoch: targetEpoch,
                    cached: await this.cacheNs.valset.getTyped(
                        targetEpoch,
                        CACHE_NAMESPACE.VALSET,
                        cacheValidator
                    ),
                }))
            );
            for (const { epoch, cached } of cachedSets) {
                if (cached) {
                    results.set(epoch, cached);
                } else {
                    missingEpochs.push(epoch);
                }
            }
        } else {
            missingEpochs.push(...targetEpochs);
        }

        if (missingEpochs.length > 0) {
            const built = await buildValidatorSetsBatch({
                targetEpochs: missingEpochs,
                finalized,
                includeCollateralMetadata,
                configEntries,
                getVotingPowersBatch: (provider, timestamps, isFinalized) =>
                    this.getVotingPowersBatch(provider, timestamps, isFinalized),
                getKeysBatch: (provider, timestamps, isFinalized) =>
                    this.getKeysBatch(provider, timestamps, isFinalized),
                getClient: chainId => this.getClient(chainId),
            });
            for (const [epoch, validatorSet] of built.entries()) {
                results.set(epoch, validatorSet);
            }
            if (finalized) {
                await Promise.all(
                    missingEpochs.map(epoch =>
                        this.cacheNs.valset.set(epoch, CACHE_NAMESPACE.VALSET, results.get(epoch)!)
                    )
                );
                await this.cacheTracker.noteEpochs(missingEpochs);
            }
        }

        return results;
    }

    private async ensureInitialized(): Promise<void> {
        await this.initializedPromise;
    }

    private getClient(chainId: number): PublicClient {
        return getClientOrThrow(this.clients, chainId);
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

    private async readDriverNumbersBatch<M extends DriverReadMethod>(
        method: M,
        finalized: boolean,
        argsList: readonly DriverReadArgsMap[M][]
    ): Promise<number[]> {
        await this.ensureInitialized();
        const blockTag = blockTagFromFinality(finalized);
        const client = this.getClient(this.driverAddress.chainId);
        return readDriverNumbersBatch({
            client,
            driver: this.driverAddress,
            method,
            blockTag,
            argsList,
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
        const [result] = await this.getEpochStarts({ from: epoch, to: epoch }, finalized);
        if (!result) {
            throw new Error(`No epoch start found for epoch ${epoch}.`);
        }
        return result.start;
    }

    /** @notice Get the start timestamps for an epoch range. */
    async getEpochStarts(
        epochRange: EpochRange,
        finalized: boolean = true
    ): Promise<{ epoch: number; start: number }[]> {
        const epochNumbers = this.expandEpochRange(epochRange);
        const starts = await this.readDriverNumbersBatch(
            DRIVER_METHOD.EPOCH_START,
            finalized,
            epochNumbers.map(epoch => [epoch])
        );
        return epochNumbers.map((epoch, index) => ({ epoch, start: starts[index] }));
    }

    /** @notice Get the duration of a specific epoch (seconds). */
    async getEpochDuration(epoch: number, finalized: boolean = true): Promise<number> {
        const [result] = await this.getEpochDurations({ from: epoch, to: epoch }, finalized);
        if (!result) {
            throw new Error(`No epoch duration found for epoch ${epoch}.`);
        }
        return result.duration;
    }

    /** @notice Get the durations for an epoch range (seconds). */
    async getEpochDurations(
        epochRange: EpochRange,
        finalized: boolean = true
    ): Promise<{ epoch: number; duration: number }[]> {
        const epochNumbers = this.expandEpochRange(epochRange);
        const durations = await this.readDriverNumbersBatch(
            DRIVER_METHOD.EPOCH_DURATION,
            finalized,
            epochNumbers.map(epoch => [epoch])
        );
        return epochNumbers.map((epoch, index) => ({ epoch, duration: durations[index] }));
    }

    /** @notice Resolve epoch index for a given timestamp. */
    async getEpochIndex(timestamp: number, finalized: boolean = true): Promise<number> {
        return this.readDriverNumber(DRIVER_METHOD.EPOCH_INDEX, finalized, [Number(timestamp)]);
    }

    async getNetworkConfig(epoch?: number, finalized: boolean = true): Promise<NetworkConfig> {
        const results = await this.getNetworkConfigs(
            epoch !== undefined ? { from: epoch, to: epoch } : undefined,
            finalized
        );
        if (results.length === 0) {
            throw new Error('No network config available.');
        }
        return results[0].config;
    }

    async getNetworkConfigs(
        epochRange?: EpochRange,
        finalized: boolean = true
    ): Promise<{ epoch: number; config: NetworkConfig }[]> {
        await this.ensureInitialized();

        const { targetEpochs } = await this.resolveEpochRange(epochRange, finalized);
        const uniqueEpochs = Array.from(new Set(targetEpochs));
        const configEntries = await this.loadNetworkConfigDataBatch({
            targetEpochs: uniqueEpochs,
            finalized,
        });

        return targetEpochs.map(epoch => ({
            epoch,
            config: configEntries.get(epoch)!.config,
        }));
    }

    async getValidatorSet(
        epoch?: number,
        finalized: boolean = true,
        includeCollateralMetadata: boolean = true
    ): Promise<ValidatorSet> {
        const results = await this.getValidatorSets(
            epoch !== undefined ? { from: epoch, to: epoch } : undefined,
            finalized,
            includeCollateralMetadata
        );
        if (results.length === 0) {
            throw new Error('No validator set available.');
        }
        return results[0];
    }

    async getValidatorSets(
        epochRange?: EpochRange,
        finalized: boolean = true,
        includeCollateralMetadata: boolean = true
    ): Promise<ValidatorSet[]> {
        await this.ensureInitialized();

        const { targetEpochs } = await this.resolveEpochRange(epochRange, finalized);
        const uniqueEpochs = Array.from(new Set(targetEpochs));
        const configEntries = await this.loadNetworkConfigDataBatch({
            targetEpochs: uniqueEpochs,
            finalized,
        });

        const validatorSets = await this.loadValidatorSetsByEpoch({
            targetEpochs: uniqueEpochs,
            finalized,
            includeCollateralMetadata,
            configEntries,
        });

        const epochsWithSettlements: number[] = [];
        const settlementsByEpoch = new Map<number, readonly CrossChainAddress[]>();
        for (const epoch of uniqueEpochs) {
            const settlements = configEntries.get(epoch)!.config.settlements;
            if (settlements.length === 0) continue;
            settlementsByEpoch.set(epoch, settlements);
            epochsWithSettlements.push(epoch);
        }

        if (epochsWithSettlements.length > 0) {
            const statusByEpoch = await this.loadValSetStatusBatch({
                settlementsByEpoch,
                epochs: epochsWithSettlements,
                finalized,
            });
            this.applyValidatorSetStatuses(validatorSets, statusByEpoch);
            await this.updateCachedValidatorSets(validatorSets, statusByEpoch, finalized);
        }

        return targetEpochs.map(epoch => validatorSets.get(epoch)!);
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
    private async getVotingPowersBatch(
        provider: CrossChainAddress,
        timestamps: readonly number[],
        finalized: boolean
    ): Promise<OperatorVotingPower[][]> {
        const client = this.getClient(provider.chainId);
        const blockTag = blockTagFromFinality(finalized);
        const timestampSeconds = timestamps.map(timestamp => BigInt(timestamp));

        return await fetchVotingPowersBatch({
            client,
            provider,
            blockTag,
            timestamps: timestampSeconds,
            useMulticall: true,
        });
    }

    private async getKeysBatch(
        provider: CrossChainAddress,
        timestamps: readonly number[],
        finalized: boolean
    ): Promise<OperatorWithKeys[][]> {
        const client = this.getClient(provider.chainId);
        const blockTag = blockTagFromFinality(finalized);
        const timestampSeconds = timestamps.map(timestamp => BigInt(timestamp));
        return fetchKeysAtBatch({
            client,
            provider,
            blockTag,
            timestamps: timestampSeconds,
            useMulticall: true,
        });
    }

    public async getValSetStatus(epoch: number, finalized: boolean = true): Promise<ValSetStatus> {
        const results = await this.getValSetStatuses({ from: epoch, to: epoch }, finalized);
        if (results.length === 0) {
            throw new Error(`No status available for epoch ${epoch}.`);
        }
        return results[0].status;
    }

    public async getValSetStatuses(
        epochRange: EpochRange,
        finalized: boolean = true
    ): Promise<{ epoch: number; status: ValSetStatus }[]> {
        await this.ensureInitialized();
        const { targetEpochs } = await this.resolveEpochRange(epochRange, finalized);
        const uniqueEpochs = Array.from(new Set(targetEpochs));

        const configEntries = await this.loadNetworkConfigDataBatch({
            targetEpochs: uniqueEpochs,
            finalized,
        });
        const settlementsByEpoch = new Map<number, readonly CrossChainAddress[]>();
        for (const epoch of uniqueEpochs) {
            settlementsByEpoch.set(epoch, configEntries.get(epoch)!.config.settlements);
        }

        const statusByEpoch = await this.loadValSetStatusBatch({
            settlementsByEpoch,
            epochRange,
            finalized,
        });

        return targetEpochs.map(epoch => ({
            epoch,
            status: statusByEpoch.get(epoch)!,
        }));
    }

    /** @notice Settlement commitment status for an epoch (all or provided settlements). */
    public async getValSetSettlementStatuses(options?: {
        epoch?: number;
        finalized?: boolean;
        settlements?: CrossChainAddress[];
    }): Promise<SettlementValSetStatus[]> {
        const finalized = options?.finalized ?? true;
        const epoch = options?.epoch;
        const results = await this.getValSetSettlementStatusesForEpochs({
            epochRange: epoch !== undefined ? { from: epoch, to: epoch } : undefined,
            finalized,
            settlements: options?.settlements,
        });
        return results[0]?.settlements ?? [];
    }

    /** @notice Settlement commitment status for an epoch range (all or provided settlements). */
    public async getValSetSettlementStatusesForEpochs(options?: {
        epochRange?: EpochRange;
        finalized?: boolean;
        settlements?: CrossChainAddress[];
    }): Promise<{ epoch: number; settlements: SettlementValSetStatus[] }[]> {
        await this.ensureInitialized();
        const finalized = options?.finalized ?? true;
        const { targetEpochs } = await this.resolveEpochRange(options?.epochRange, finalized);
        const uniqueEpochs = Array.from(new Set(targetEpochs));

        const settlementsByEpoch = new Map<number, readonly CrossChainAddress[]>();
        if (options?.settlements) {
            for (const epoch of uniqueEpochs) {
                settlementsByEpoch.set(epoch, options.settlements);
            }
        } else {
            const configEntries = await this.loadNetworkConfigDataBatch({
                targetEpochs: uniqueEpochs,
                finalized,
            });
            for (const epoch of uniqueEpochs) {
                settlementsByEpoch.set(epoch, configEntries.get(epoch)!.config.settlements);
            }
        }

        const resolvedRange = options?.epochRange ?? {
            from: targetEpochs[0],
            to: targetEpochs[targetEpochs.length - 1],
        };
        const statusByEpoch = await this.loadValSetStatusBatch({
            settlementsByEpoch,
            epochRange: resolvedRange,
            finalized,
        });

        return targetEpochs.map(epoch => ({
            epoch,
            settlements: statusByEpoch.get(epoch)?.settlements ?? [],
        }));
    }

    /** @notice Settlement-indexed validator-set events (committed settlements only). */
    public async getValSetLogEvents(options?: {
        epoch?: number;
        finalized?: boolean;
        settlements?: CrossChainAddress[];
    }): Promise<SettlementValSetLog[]> {
        const finalized = options?.finalized ?? true;
        const epoch = options?.epoch;
        const results = await this.getValSetLogEventsForEpochs({
            epochRange: epoch !== undefined ? { from: epoch, to: epoch } : undefined,
            finalized,
            settlements: options?.settlements,
        });
        return results[0]?.logs ?? [];
    }

    /** @notice Settlement-indexed validator-set events for an epoch range (committed settlements only). */
    public async getValSetLogEventsForEpochs(options?: {
        epochRange?: EpochRange;
        finalized?: boolean;
        settlements?: CrossChainAddress[];
    }): Promise<{ epoch: number; logs: SettlementValSetLog[] }[]> {
        await this.ensureInitialized();
        const finalized = options?.finalized ?? true;
        const { targetEpochs } = await this.resolveEpochRange(options?.epochRange, finalized);
        const uniqueEpochs = Array.from(new Set(targetEpochs));
        if (uniqueEpochs.length === 0) return [];

        const fromEpoch = targetEpochs[0];
        const toEpoch = targetEpochs[targetEpochs.length - 1];

        const configEntries = await this.loadNetworkConfigDataBatch({
            targetEpochs: uniqueEpochs,
            finalized,
        });

        const settlementsByEpoch = new Map<number, readonly CrossChainAddress[]>();
        for (const epoch of uniqueEpochs) {
            const config = configEntries.get(epoch)!.config;
            settlementsByEpoch.set(epoch, options?.settlements ?? config.settlements);
        }

        let epochDuration = 0;
        try {
            epochDuration = await this.getEpochDuration(toEpoch, finalized);
        } catch {
            epochDuration = await this.getCurrentEpochDuration(finalized);
        }

        const epochStartFrom =
            configEntries.get(fromEpoch)?.epochStart ??
            (await this.getEpochStart(fromEpoch, finalized));
        const epochStartTo =
            configEntries.get(toEpoch)?.epochStart ??
            (await this.getEpochStart(toEpoch, finalized));

        const uniqueSettlements = new Map<string, CrossChainAddress>();
        for (const settlements of settlementsByEpoch.values()) {
            for (const settlement of settlements) {
                uniqueSettlements.set(buildSettlementKey(settlement), settlement);
            }
        }

        const eventsBySettlement = await this.fetchSettlementEventsByRange({
            settlements: Array.from(uniqueSettlements.values()),
            epochRange: { from: fromEpoch, to: toEpoch },
            epochStartFrom,
            epochStartTo,
            epochDuration,
            finalized,
        });

        return targetEpochs.map(epoch => {
            const settlements = settlementsByEpoch.get(epoch) ?? [];
            const logs = settlements.map(settlement => {
                const key = buildSettlementKey(settlement);
                const event = eventsBySettlement.get(key)?.get(epoch) ?? null;
                return {
                    settlement,
                    committed: Boolean(event),
                    event,
                };
            });
            return { epoch, logs };
        });
    }
}
