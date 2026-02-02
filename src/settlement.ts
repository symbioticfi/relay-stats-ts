import {
    getContract,
    type Address,
    type GetContractReturnType,
    type Hex,
    type PublicClient,
} from 'viem';
import { SETTLEMENT_ABI } from './abis/index.js';
import { buildSettlementKey } from './cache.js';
import { ValSetEventKind } from './types/index.js';
import type {
    CrossChainAddress,
    SettlementValSetStatus,
    ValSetStatus,
    ValSetLogEvent,
    ValSetEventKindType,
    ValidatorSetHeader,
    ValSetExtraData,
    ValSetQuorumProof,
} from './types/index.js';
import { blockTagFromFinality, type BlockTagPreference } from './utils/core.js';
import { hashValidatorSetHeader } from './validator_set.js';

export const selectDefaultSettlement = (
    settlements: readonly CrossChainAddress[]
): CrossChainAddress => {
    const settlement = settlements[0];
    if (!settlement) {
        throw new Error('No settlement configured to retrieve validator set events');
    }
    return settlement;
};

type BlockTimeEstimate = {
    avgBlockTime: number;
    sampledAt: bigint;
};

const blockTimeEstimates = new Map<string, BlockTimeEstimate>();
const BLOCK_TIME_CACHE_MAX_DELTA = 1000n;

const resolveAvgBlockTime = async (
    client: PublicClient,
    chainId: number,
    blockTag: BlockTagPreference,
    headNumber: bigint,
    headTimestamp: number
): Promise<number> => {
    const key = `${chainId}:${blockTag}`;
    const cached = blockTimeEstimates.get(key);
    if (cached && headNumber >= cached.sampledAt) {
        const delta = headNumber - cached.sampledAt;
        if (delta <= BLOCK_TIME_CACHE_MAX_DELTA) {
            return cached.avgBlockTime;
        }
    }

    const sampleCount = headNumber > 2000n ? 2000n : headNumber;
    let sampleTimestamp = headTimestamp;
    if (sampleCount > 0n) {
        const sampleBlock = await client.getBlock({ blockNumber: headNumber - sampleCount });
        sampleTimestamp = Number(sampleBlock.timestamp);
    }
    const avg = (headTimestamp - sampleTimestamp) / Math.max(1, Number(sampleCount));
    const avgBlockTime = Math.max(1, Number.isFinite(avg) ? avg : 1);
    blockTimeEstimates.set(key, { avgBlockTime, sampledAt: headNumber });
    return avgBlockTime;
};

/** @notice Build a settlement contract wrapper. */
const getSettlementContract = (
    client: PublicClient,
    settlement: CrossChainAddress
): GetContractReturnType<typeof SETTLEMENT_ABI, PublicClient, Address> =>
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

const tryFetchSettlementStatusViaMulticall = async (
    client: PublicClient,
    settlement: CrossChainAddress,
    epochNumber: number,
    blockTag: BlockTagPreference
): Promise<MulticallSettlementStatus | null> => {
    try {
        const results = (await client.multicall({
            allowFailure: false,
            blockTag,
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
        return null;
    }
};

const tryFetchSettlementStatusesViaMulticall = async (
    client: PublicClient,
    settlement: CrossChainAddress,
    epochNumbers: readonly number[],
    blockTag: BlockTagPreference
): Promise<MulticallSettlementStatus[] | null> => {
    if (epochNumbers.length === 0) return [];

    try {
        const settlementContract = getSettlementContract(client, settlement);
        const [perEpochResults, lastCommittedRaw] = await Promise.all([
            Promise.all(
                epochNumbers.map(async epochNumber => {
                    const [isCommittedRaw, headerHashRaw] = await Promise.all([
                        settlementContract.read.isValSetHeaderCommittedAt([epochNumber], {
                            blockTag,
                        }),
                        settlementContract.read.getValSetHeaderHashAt([epochNumber], {
                            blockTag,
                        }),
                    ]);
                    return { isCommittedRaw, headerHashRaw };
                })
            ),
            settlementContract.read.getLastCommittedHeaderEpoch({ blockTag }),
        ]);

        let lastCommittedEpoch: bigint = 0n;
        if (typeof lastCommittedRaw === 'bigint') {
            lastCommittedEpoch = lastCommittedRaw;
        } else if (typeof lastCommittedRaw === 'number' || typeof lastCommittedRaw === 'string') {
            lastCommittedEpoch = BigInt(lastCommittedRaw);
        }

        const statuses: MulticallSettlementStatus[] = [];
        for (let i = 0; i < epochNumbers.length; i++) {
            const { isCommittedRaw, headerHashRaw } = perEpochResults[i];
            let headerHash: Hex | null = null;
            if (typeof headerHashRaw === 'string') {
                headerHash = headerHashRaw as Hex;
            }
            statuses.push({
                isCommitted: Boolean(isCommittedRaw),
                headerHash,
                lastCommittedEpoch,
            });
        }

        return statuses;
    } catch {
        return null;
    }
};

const buildValSetStatusFromDetails = (
    epoch: number,
    details: SettlementValSetStatus[]
): ValSetStatus => {
    const hashes = new Set<string>();
    let allCommitted = true;
    let lastCommitted: number = Number.MAX_SAFE_INTEGER;

    for (const detail of details) {
        if (detail.committed && detail.headerHash) {
            hashes.add(detail.headerHash);
        }
        if (!detail.committed) {
            allCommitted = false;
        }
        if (detail.lastCommittedEpoch !== null && Number.isFinite(detail.lastCommittedEpoch)) {
            lastCommitted = Math.min(lastCommitted, detail.lastCommittedEpoch);
        }
    }

    let status: ValSetStatus['status'];
    if (allCommitted) {
        status = 'committed';
    } else if (epoch < lastCommitted && lastCommitted !== Number.MAX_SAFE_INTEGER) {
        status = 'missing';
    } else {
        status = 'pending';
    }

    const integrity: ValSetStatus['integrity'] = hashes.size <= 1 ? 'valid' : 'invalid';

    return { status, integrity, settlements: details };
};

export const buildValSetStatusFromEvents = (params: {
    epoch: number;
    settlements: readonly CrossChainAddress[];
    eventsBySettlement: Map<string, Map<number, ValSetLogEvent>>;
    lastCommittedBySettlement: Map<string, number>;
}): ValSetStatus => {
    const { epoch, settlements, eventsBySettlement, lastCommittedBySettlement } = params;
    if (settlements.length === 0) {
        return { status: 'committed', integrity: 'valid', settlements: [] };
    }

    const details: SettlementValSetStatus[] = [];
    for (const settlement of settlements) {
        const key = buildSettlementKey(settlement);
        const event = eventsBySettlement.get(key)?.get(epoch) ?? null;
        details.push({
            settlement,
            committed: Boolean(event),
            headerHash: event ? hashValidatorSetHeader(event.header) : null,
            lastCommittedEpoch: lastCommittedBySettlement.get(key) ?? null,
        });
    }

    return buildValSetStatusFromDetails(epoch, details);
};

export const determineValSetStatus = async (
    clientFactory: (chainId: number) => PublicClient,
    settlements: readonly CrossChainAddress[],
    epoch: number,
    preferFinalized: boolean
): Promise<ValSetStatus> => {
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
            blockTag
        );

        if (multiResult) {
            const committed = Boolean(multiResult.isCommitted);
            detail.committed = committed;
            detail.headerHash = multiResult.headerHash;
            detail.lastCommittedEpoch = Number(multiResult.lastCommittedEpoch);
        } else {
            const settlementContract = getSettlementContract(client, settlement);
            const isCommitted = await settlementContract.read.isValSetHeaderCommittedAt(
                [epochNumber],
                {
                    blockTag,
                }
            );
            detail.committed = Boolean(isCommitted);

            if (detail.committed) {
                const headerHash = (await settlementContract.read.getValSetHeaderHashAt(
                    [epochNumber],
                    {
                        blockTag,
                    }
                )) as Hex;
                detail.headerHash = headerHash ?? null;
            }

            const lastCommittedEpoch = await settlementContract.read.getLastCommittedHeaderEpoch({
                blockTag,
            });
            detail.lastCommittedEpoch = Number(lastCommittedEpoch);
        }

        details.push(detail);
    }
    return buildValSetStatusFromDetails(epoch, details);
};

export const determineValSetStatuses = async (
    clientFactory: (chainId: number) => PublicClient,
    settlements: readonly CrossChainAddress[],
    epochs: readonly number[],
    preferFinalized: boolean
): Promise<ValSetStatus[]> => {
    if (epochs.length === 0) return [];

    const epochNumbers = epochs.map(epoch => Number(epoch));
    const uniqueEpochs = Array.from(new Set(epochNumbers));
    const blockTag = blockTagFromFinality(preferFinalized);

    const detailsByEpoch = new Map<number, SettlementValSetStatus[]>();
    for (const epoch of uniqueEpochs) {
        detailsByEpoch.set(epoch, []);
    }

    for (const settlement of settlements) {
        const client = clientFactory(settlement.chainId);
        const multiResults = await tryFetchSettlementStatusesViaMulticall(
            client,
            settlement,
            uniqueEpochs,
            blockTag
        );

        let lastCommittedEpoch: number | null = null;
        if (multiResults) {
            if (multiResults.length !== uniqueEpochs.length) {
                throw new Error(
                    `Multicall result length mismatch for settlement ${settlement.address}: expected ${uniqueEpochs.length}, got ${multiResults.length}`
                );
            }

            for (let i = 0; i < uniqueEpochs.length; i++) {
                const epochNumber = uniqueEpochs[i];
                const multiResult = multiResults[i];
                const detail: SettlementValSetStatus = {
                    settlement,
                    committed: Boolean(multiResult.isCommitted),
                    headerHash: multiResult.headerHash,
                    lastCommittedEpoch: Number(multiResult.lastCommittedEpoch),
                };
                detailsByEpoch.get(epochNumber)!.push(detail);
                lastCommittedEpoch = detail.lastCommittedEpoch;
            }
        } else {
            const settlementContract = getSettlementContract(client, settlement);
            const lastCommittedRaw = await settlementContract.read.getLastCommittedHeaderEpoch({
                blockTag,
            });
            lastCommittedEpoch = Number(lastCommittedRaw);

            for (const epochNumber of uniqueEpochs) {
                const detail: SettlementValSetStatus = {
                    settlement,
                    committed: false,
                    headerHash: null,
                    lastCommittedEpoch,
                };

                const isCommitted = await settlementContract.read.isValSetHeaderCommittedAt(
                    [epochNumber],
                    {
                        blockTag,
                    }
                );
                detail.committed = Boolean(isCommitted);

                if (detail.committed) {
                    const headerHash = (await settlementContract.read.getValSetHeaderHashAt(
                        [epochNumber],
                        {
                            blockTag,
                        }
                    )) as Hex;
                    detail.headerHash = headerHash ?? null;
                }

                detailsByEpoch.get(epochNumber)!.push(detail);
            }
        }

        if (lastCommittedEpoch === null) {
            throw new Error(
                `Unable to resolve last committed epoch for settlement ${settlement.address}`
            );
        }
    }

    const statusByEpoch = new Map<number, ValSetStatus>();

    for (const epoch of uniqueEpochs) {
        const details = detailsByEpoch.get(epoch) ?? [];
        statusByEpoch.set(epoch, buildValSetStatusFromDetails(epoch, details));
    }

    return epochNumbers.map(epoch => statusByEpoch.get(epoch)!);
};

export const fetchSettlementEventsRange = async (
    client: PublicClient,
    settlement: CrossChainAddress,
    fromEpoch: number,
    toEpoch: number,
    epochStartFrom: number,
    epochStartTo: number,
    epochDuration: number,
    finalized: boolean
): Promise<Map<number, ValSetLogEvent>> => {
    const startEpoch = Math.min(fromEpoch, toEpoch);
    const endEpoch = Math.max(fromEpoch, toEpoch);
    const rangeSize = Math.max(1, endEpoch - startEpoch + 1);
    const padEpochs = Math.max(2, Math.ceil(rangeSize * 0.1));

    const windowStart = Math.max(0, epochStartFrom - padEpochs * epochDuration);
    const windowEnd = epochStartTo + (padEpochs + 1) * epochDuration;
    const blockTag = blockTagFromFinality(finalized);

    const head = await client.getBlock({ blockTag });
    const headNumber = head.number ?? 0n;
    const headTimestamp = Number(head.timestamp);
    const avgBlockTime = await resolveAvgBlockTime(
        client,
        settlement.chainId,
        blockTag,
        headNumber,
        headTimestamp
    );

    const startOffset = Math.max(0, headTimestamp - windowStart);
    const endOffset = Math.max(0, headTimestamp - windowEnd);
    let fromBlock = headNumber - BigInt(Math.ceil(startOffset / avgBlockTime));
    let toBlock = headNumber - BigInt(Math.floor(endOffset / avgBlockTime));

    if (fromBlock < 0n) fromBlock = 0n;
    if (toBlock < 0n) toBlock = 0n;
    if (fromBlock > headNumber) fromBlock = headNumber;
    if (toBlock > headNumber) toBlock = headNumber;
    if (fromBlock > toBlock) [fromBlock, toBlock] = [toBlock, fromBlock];

    const filteredEvents = SETTLEMENT_ABI.filter(
        (item): item is Extract<(typeof SETTLEMENT_ABI)[number], { type: 'event' }> =>
            item.type === 'event' &&
            (item.name === 'SetGenesis' || item.name === 'CommitValSetHeader')
    );

    const logs = await client.getLogs({
        address: settlement.address,
        events: filteredEvents,
        fromBlock,
        toBlock,
    });

    const store = new Map<number, { event: ValSetLogEvent; logIndex: number | null }>();

    for (const log of logs) {
        const rawHeader = toRawValSetHeader(
            (log.args as SettlementEventArgs | undefined)?.valSetHeader
        );
        if (!rawHeader) continue;

        const epoch = Number(rawHeader.epoch);
        if (epoch < startEpoch || epoch > endEpoch) continue;

        const extraData = toEventExtraData(
            (log.args as SettlementEventArgs | undefined)?.extraData
        );

        const metadata = {
            blockNumber: log.blockNumber,
            blockTimestamp: undefined,
            transactionHash: (log.transactionHash ?? undefined) as Hex | undefined,
            logIndex: log.logIndex ?? undefined,
        };

        const kind: ValSetEventKindType =
            log.eventName === 'SetGenesis' ? ValSetEventKind.Genesis : ValSetEventKind.Commit;

        processValSetEventLog(store, rawHeader, extraData, kind, metadata, null);
    }

    const events = new Map<number, ValSetLogEvent>();
    for (const [epoch, value] of store.entries()) {
        events.set(epoch, value.event);
    }

    return events;
};

type RawValSetHeader = {
    version: bigint;
    requiredKeyTag: bigint;
    epoch: bigint;
    captureTimestamp: bigint;
    quorumThreshold: bigint;
    totalVotingPower: bigint;
    validatorsSszMRoot: Hex;
};

type SettlementEventArgs = {
    valSetHeader?: RawValSetHeader | null;
    extraData?: readonly {
        key: Hex;
        value: Hex;
    }[];
};

const toRawValSetHeader = (value: RawValSetHeader | null | undefined): RawValSetHeader | null => {
    if (!value) return null;
    const toBigInt = (input: bigint | number | string | undefined): bigint | null => {
        if (typeof input === 'bigint') return input;
        if (typeof input === 'number') return BigInt(input);
        if (typeof input === 'string' && input.trim() !== '') return BigInt(input);
        return null;
    };

    const version = toBigInt(value.version);
    const requiredKeyTag = toBigInt(value.requiredKeyTag);
    const epoch = toBigInt(value.epoch);
    const captureTimestamp = toBigInt(value.captureTimestamp);
    const quorumThreshold = toBigInt(value.quorumThreshold);
    const totalVotingPower = toBigInt(value.totalVotingPower);
    const validatorsSszMRoot = value.validatorsSszMRoot as Hex | undefined;

    if (
        version === null ||
        requiredKeyTag === null ||
        epoch === null ||
        captureTimestamp === null ||
        quorumThreshold === null ||
        totalVotingPower === null ||
        !validatorsSszMRoot
    ) {
        return null;
    }

    return {
        version,
        requiredKeyTag,
        epoch,
        captureTimestamp,
        quorumThreshold,
        totalVotingPower,
        validatorsSszMRoot,
    } satisfies RawValSetHeader;
};

const parseValSetHeaderFromEvent = (raw: RawValSetHeader): ValidatorSetHeader => ({
    version: Number(raw.version),
    requiredKeyTag: Number(raw.requiredKeyTag),
    epoch: Number(raw.epoch),
    captureTimestamp: Number(raw.captureTimestamp),
    quorumThreshold: BigInt(raw.quorumThreshold),
    totalVotingPower: BigInt(raw.totalVotingPower),
    validatorsSszMRoot: raw.validatorsSszMRoot as Hex,
});

const toEventExtraData = (value: SettlementEventArgs['extraData']): ValSetExtraData[] => {
    if (!value || value.length === 0) return [];
    const entries: ValSetExtraData[] = [];
    for (const item of value) {
        if (!item || typeof item.key !== 'string' || typeof item.value !== 'string') continue;
        entries.push({
            key: item.key as Hex,
            value: item.value as Hex,
        });
    }
    return entries;
};

const processValSetEventLog = (
    store: Map<number, { event: ValSetLogEvent; logIndex: number | null }>,
    header: RawValSetHeader,
    extraData: ValSetExtraData[],
    kind: ValSetEventKindType,
    metadata: {
        blockNumber?: bigint;
        blockTimestamp?: number;
        transactionHash?: Hex;
        logIndex?: number;
    },
    quorumProof: ValSetQuorumProof | null
): void => {
    const parsedHeader = parseValSetHeaderFromEvent(header);
    const event: ValSetLogEvent = {
        kind,
        header: parsedHeader,
        extraData,
        blockNumber: metadata.blockNumber ?? null,
        blockTimestamp: metadata.blockTimestamp ?? null,
        transactionHash: metadata.transactionHash ?? null,
        quorumProof: quorumProof ?? null,
    };

    const candidate = {
        event,
        logIndex: metadata.logIndex ?? null,
    };

    const existing = store.get(parsedHeader.epoch);
    if (!existing || isNewerValSetEvent(candidate, existing)) {
        store.set(parsedHeader.epoch, candidate);
    }
};

const isNewerValSetEvent = (
    candidate: { event: ValSetLogEvent; logIndex: number | null },
    existing: { event: ValSetLogEvent; logIndex: number | null }
): boolean => {
    const candidateBlock = candidate.event.blockNumber ?? -1n;
    const existingBlock = existing.event.blockNumber ?? -1n;
    if (candidateBlock !== existingBlock) {
        return candidateBlock > existingBlock;
    }
    const candidateIndex = candidate.logIndex ?? -1;
    const existingIndex = existing.logIndex ?? -1;
    return candidateIndex > existingIndex;
};
