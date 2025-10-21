import type { Hex, PublicClient } from 'viem';
import { decodeFunctionData, hexToBytes, bytesToHex } from 'viem';
import type {
  CrossChainAddress,
  ValSetLogEvent,
  ValSetEventKind,
  ValSetStatus,
  ValidatorSetHeader,
  CacheInterface,
  ValSetExtraData,
  SettlementValSetStatus,
  ValSetQuorumProof,
  ValSetQuorumProofSimple,
  ValSetQuorumProofSimpleSigner,
  ValSetQuorumProofZk,
} from './types.js';
import { SETTLEMENT_ABI } from './abi.js';
import { blockTagFromFinality, type BlockTagPreference } from './utils.js';

export const settlementKey = (settlement: CrossChainAddress): string =>
  `${settlement.chainId}_${settlement.address.toLowerCase()}`;

export const valsetEventsStateKey = (
  blockTag: BlockTagPreference,
  settlement: CrossChainAddress,
): string => `${blockTag}_${settlementKey(settlement)}`;

type VerificationMode = 'simple' | 'zk';

const buildValsetCacheKey = (settlement: CrossChainAddress): string => settlementKey(settlement);

const bytesToBigint = (bytes: Uint8Array): bigint => {
  if (bytes.length === 0) return 0n;
  return BigInt(bytesToHex(bytes));
};

const decodeSimpleQuorumProof = (proof: Hex): ValSetQuorumProofSimple | null => {
  const bytes = hexToBytes(proof);
  if (bytes.length < 224) {
    return null;
  }

  const aggregatedSignature = bytesToHex(bytes.slice(0, 64)) as Hex;
  const aggregatedPublicKey = bytesToHex(bytes.slice(64, 192)) as Hex;

  const validatorCountBigint = bytesToBigint(bytes.slice(192, 224));
  if (validatorCountBigint < 0n) return null;
  const validatorCount = Number(validatorCountBigint);
  if (!Number.isSafeInteger(validatorCount) || validatorCount < 0) return null;

  let offset = 224;
  const expectedLength = offset + validatorCount * 64;
  if (bytes.length < expectedLength) return null;

  const signers: ValSetQuorumProofSimpleSigner[] = [];

  for (let i = 0; i < validatorCount; i++) {
    const key = bytesToHex(bytes.slice(offset, offset + 32)) as Hex;
    const votingPower = bytesToBigint(bytes.slice(offset + 32, offset + 64));
    signers.push({
      key,
      votingPower,
    });
    offset += 64;
  }

  const remaining = bytes.length - offset;
  if (remaining < 0 || remaining % 2 !== 0) {
    return null;
  }

  const nonSignerIndices: number[] = [];
  for (let i = offset; i < bytes.length; i += 2) {
    const value = (bytes[i] << 8) | bytes[i + 1];
    nonSignerIndices.push(value);
  }

  return {
    mode: 'simple',
    aggregatedSignature,
    aggregatedPublicKey,
    signers,
    nonSignerIndices,
    rawProof: proof,
  };
};

const decodeZkQuorumProof = (proof: Hex): ValSetQuorumProofZk | null => {
  const bytes = hexToBytes(proof);
  if (bytes.length < 416) {
    return null;
  }

  const proofElements: Hex[] = [];
  let offset = 0;
  for (let i = 0; i < 8; i++) {
    proofElements.push(bytesToHex(bytes.slice(offset, offset + 32)) as Hex);
    offset += 32;
  }

  const commitments: Hex[] = [];
  for (let i = 0; i < 2; i++) {
    commitments.push(bytesToHex(bytes.slice(offset, offset + 32)) as Hex);
    offset += 32;
  }

  const commitmentPok: Hex[] = [];
  for (let i = 0; i < 2; i++) {
    commitmentPok.push(bytesToHex(bytes.slice(offset, offset + 32)) as Hex);
    offset += 32;
  }

  const votingPower = bytesToBigint(bytes.slice(offset, offset + 32));

  return {
    mode: 'zk',
    proof: proofElements,
    commitments,
    commitmentPok,
    signersVotingPower: votingPower,
    rawProof: proof,
  };
};

const decodeQuorumProof = (proof: Hex, mode: VerificationMode): ValSetQuorumProof | null => {
  if (!proof || proof === '0x') return null;
  if (mode === 'zk') {
    return decodeZkQuorumProof(proof);
  }
  return decodeSimpleQuorumProof(proof);
};

const fetchQuorumProofFromTransaction = async (
  client: PublicClient,
  transactionHash: Hex,
  mode: VerificationMode,
): Promise<ValSetQuorumProof | null> => {
  try {
    const tx = await client.getTransaction({ hash: transactionHash });
    if (!tx || tx.input === undefined || tx.input === '0x') {
      return null;
    }

    const decoded = decodeFunctionData({
      abi: SETTLEMENT_ABI,
      data: tx.input as Hex,
    });

    if (decoded.functionName !== 'commitValSetHeader') {
      return null;
    }

    const proofArg = (decoded.args?.[2] ?? null) as Hex | null;
    if (!proofArg) {
      return null;
    }

    return decodeQuorumProof(proofArg, mode);
  } catch {
    return null;
  }
};
export const getOrCreateValSetEventsState = (
  states: Map<string, ValSetEventsState>,
  blockTag: BlockTagPreference,
  settlement: CrossChainAddress,
): ValSetEventsState => {
  const key = valsetEventsStateKey(blockTag, settlement);
  let state = states.get(key);
  if (!state) {
    state = { settlement, map: new Map() };
    states.set(key, state);
  }
  return state;
};

type StoredValSetEvent = {
  event: ValSetLogEvent;
  logIndex: number | null;
};

export interface ValSetEventsState {
  settlement: CrossChainAddress;
  map: Map<number, StoredValSetEvent>;
}

type SettlementEventHeaderLike = {
  version: bigint | number | string;
  requiredKeyTag: bigint | number | string;
  epoch: bigint | number | string;
  captureTimestamp: bigint | number | string;
  quorumThreshold: bigint | number | string;
  totalVotingPower: bigint | number | string;
  validatorsSszMRoot: Hex;
};

type SettlementEventArgs = {
  valSetHeader?: SettlementEventHeaderLike;
  extraData?: readonly {
    key: Hex;
    value: Hex;
  }[];
};

export const ingestSettlementEvents = async (
  client: PublicClient,
  settlement: CrossChainAddress,
  state: ValSetEventsState,
  fromBlock: bigint,
  toBlock: bigint,
  mode: VerificationMode,
): Promise<void> => {
  const filteredEvents = SETTLEMENT_ABI.filter(
    (item): item is Extract<(typeof SETTLEMENT_ABI)[number], { type: 'event' }> =>
      item.type === 'event' && (item.name === 'SetGenesis' || item.name === 'CommitValSetHeader'),
  );

  const logs = await client.getLogs({
    address: settlement.address,
    events: filteredEvents,
    fromBlock,
    toBlock,
  });

  const blockTimestampCache = new Map<bigint, number>();
  const transactionProofCache = new Map<string, ValSetQuorumProof | null>();

  for (const log of logs) {
    const rawHeader = toRawValSetHeader(
      (log.args as SettlementEventArgs | undefined)?.valSetHeader,
    );
    if (!rawHeader) continue;

    const extraData = toEventExtraData((log.args as SettlementEventArgs | undefined)?.extraData);

    const blockNumber = log.blockNumber;
    let blockTimestamp: number | undefined;
    if (typeof blockNumber === 'bigint') {
      const cachedTimestamp = blockTimestampCache.get(blockNumber);
      if (cachedTimestamp !== undefined) {
        blockTimestamp = cachedTimestamp;
      } else {
        const block = await client.getBlock({ blockNumber });
        const timestampNumber = Number(block.timestamp);
        blockTimestampCache.set(blockNumber, timestampNumber);
        blockTimestamp = timestampNumber;
      }
    }

    const metadata = {
      blockNumber,
      blockTimestamp,
      transactionHash: (log.transactionHash ?? undefined) as Hex | undefined,
      logIndex: log.logIndex ?? undefined,
    };

    const kind: ValSetEventKind = log.eventName === 'SetGenesis' ? 'genesis' : 'commit';
    let quorumProof: ValSetQuorumProof | null = null;
    if (metadata.transactionHash && kind === 'commit') {
      const key = metadata.transactionHash.toLowerCase();
      if (transactionProofCache.has(key)) {
        quorumProof = transactionProofCache.get(key) ?? null;
      } else {
        quorumProof = await fetchQuorumProofFromTransaction(client, metadata.transactionHash, mode);
        transactionProofCache.set(key, quorumProof ?? null);
      }
    }

    processValSetEventLog(state.map, rawHeader, extraData, kind, metadata, quorumProof);
  }
};

const isNewerValSetEvent = (candidate: StoredValSetEvent, existing: StoredValSetEvent): boolean => {
  const candidateBlock = candidate.event.blockNumber ?? -1n;
  const existingBlock = existing.event.blockNumber ?? -1n;
  if (candidateBlock !== existingBlock) {
    return candidateBlock > existingBlock;
  }
  const candidateIndex = candidate.logIndex ?? -1;
  const existingIndex = existing.logIndex ?? -1;
  return candidateIndex > existingIndex;
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

type RawValSetHeader = {
  version: bigint;
  requiredKeyTag: bigint;
  epoch: bigint;
  captureTimestamp: bigint;
  quorumThreshold: bigint;
  totalVotingPower: bigint;
  validatorsSszMRoot: Hex;
};
const toRawValSetHeader = (
  value: SettlementEventHeaderLike | null | undefined,
): RawValSetHeader | null => {
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
  store: Map<number, StoredValSetEvent>,
  header: RawValSetHeader,
  extraData: ValSetExtraData[],
  kind: ValSetEventKind,
  metadata: {
    blockNumber?: bigint;
    blockTimestamp?: number;
    transactionHash?: Hex;
    logIndex?: number;
  },
  quorumProof: ValSetQuorumProof | null,
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

  const candidate: StoredValSetEvent = {
    event,
    logIndex: metadata.logIndex ?? null,
  };

  const existing = store.get(parsedHeader.epoch);
  if (!existing || isNewerValSetEvent(candidate, existing)) {
    store.set(parsedHeader.epoch, candidate);
  }
};

export const getValSetLogEventFromSet = (
  settlement: CrossChainAddress,
  state: ValSetEventsState,
  epoch: number,
): ValSetLogEvent | null => state.map.get(epoch)?.event ?? null;

export const selectDefaultSettlement = (
  settlements: readonly CrossChainAddress[],
): CrossChainAddress => {
  const settlement = settlements[0];
  if (!settlement) {
    throw new Error('No settlement configured to retrieve validator set events');
  }
  return settlement;
};

export const pruneValSetEventState = async (
  states: Map<string, ValSetEventsState>,
  cache: CacheInterface | null,
  epoch: number,
): Promise<void> => {
  const seen = new Set<string>();
  for (const state of states.values()) {
    state.map.delete(epoch);
    if (!cache) continue;
    const key = settlementKey(state.settlement);
    if (seen.has(key)) continue;
    seen.add(key);
    await cache.delete(epoch, key);
  }
};

export const findBlockNumberForTimestamp = async (
  client: PublicClient,
  timestamp: number,
  highestBlock: bigint,
  highestTimestamp: number,
): Promise<bigint> => {
  if (timestamp >= highestTimestamp) return highestBlock;

  let low = 0n;
  let high = highestBlock;
  let best = 0n;

  while (low <= high) {
    const mid = (low + high) >> 1n;
    const block = await client.getBlock({ blockNumber: mid });
    const blockTimestamp = Number(block.timestamp);

    if (blockTimestamp <= timestamp) {
      best = mid;
      low = mid + 1n;
    } else {
      if (mid === 0n) return 0n;
      high = mid - 1n;
    }
  }

  return best;
};

export const estimateEpochBlockRange = async (
  client: PublicClient,
  startTimestamp: number,
  endTimestamp: number,
  buffer: bigint,
  blockTag: BlockTagPreference,
): Promise<{ fromBlock: bigint; toBlock: bigint }> => {
  const latestBlock = await client.getBlock({ blockTag });
  const latestNumber = latestBlock.number ?? 0n;
  const latestTimestamp = Number(latestBlock.timestamp);

  const fromEstimate = await findBlockNumberForTimestamp(
    client,
    startTimestamp,
    latestNumber,
    latestTimestamp,
  );
  const toEstimate = await findBlockNumberForTimestamp(
    client,
    endTimestamp,
    latestNumber,
    latestTimestamp,
  );

  const bufferedFrom = fromEstimate > buffer ? fromEstimate - buffer : 0n;
  let bufferedTo = toEstimate + buffer;
  if (bufferedTo > latestNumber) bufferedTo = latestNumber;
  if (bufferedTo < bufferedFrom) bufferedTo = bufferedFrom;

  return { fromBlock: bufferedFrom, toBlock: bufferedTo };
};

export const loadValSetEvent = async (
  state: ValSetEventsState,
  cache: CacheInterface | null,
  clientFactory: (chainId: number) => PublicClient,
  params: {
    epoch: number;
    settlement: CrossChainAddress;
    finalized: boolean;
    startTimestamp: number;
    endTimestamp: number;
    buffer: bigint;
    mode: VerificationMode;
    allowCache: boolean;
  },
): Promise<ValSetLogEvent | null> => {
  const { epoch, settlement, finalized, startTimestamp, endTimestamp, buffer, mode, allowCache } =
    params;
  const blockTag = blockTagFromFinality(finalized);

  const existing = state.map.get(epoch) ?? null;
  if (!finalized) return existing?.event ?? null;
  if (existing) return existing.event;

  const cacheKey = buildValsetCacheKey(settlement);
  if (cache) {
    const cached = await cache.get(epoch, cacheKey);
    if (cached) {
      const event = cached as ValSetLogEvent;
      state.map.set(epoch, { event, logIndex: null });
      return event;
    }
  }

  const client = clientFactory(settlement.chainId);
  const { fromBlock, toBlock } = await estimateEpochBlockRange(
    client,
    startTimestamp,
    endTimestamp,
    buffer,
    blockTag,
  );

  if (toBlock >= fromBlock) {
    await ingestSettlementEvents(client, settlement, state, fromBlock, toBlock, mode);
  }

  const stored = state.map.get(epoch) ?? null;
  const event = stored?.event ?? null;

  if (event && cache && allowCache) {
    await cache.set(epoch, cacheKey, event);
  }

  return event;
};

export const retrieveValSetEvent = async (
  params: {
    epoch: number;
    settlement: CrossChainAddress;
    finalized: boolean;
    mode: VerificationMode;
  },
  stateFactory: (blockTag: BlockTagPreference, settlement: CrossChainAddress) => ValSetEventsState,
  cache: CacheInterface | null,
  statusFetcher: (epoch: number, finalized: boolean) => Promise<ValSetStatus>,
  blockMetrics: {
    getStart: (epoch: number, finalized: boolean) => Promise<number>;
    getEnd: (epoch: number, finalized: boolean, fallbackStart: number) => Promise<number>;
  },
  clientFactory: (chainId: number) => PublicClient,
  buffer: bigint,
  statusContext?: {
    overall?: ValSetStatus | null;
    detail?: SettlementValSetStatus | null;
  },
  allowCache: boolean = false,
): Promise<ValSetLogEvent | null> => {
  const { epoch, settlement, finalized, mode } = params;
  const blockTag = blockTagFromFinality(finalized);
  const state = stateFactory(blockTag, settlement);

  const existing = state.map.get(epoch) ?? null;
  if (!finalized) return existing?.event ?? null;

  const startTimestamp = await blockMetrics.getStart(epoch, finalized);
  const endTimestamp = await blockMetrics.getEnd(epoch + 1, finalized, startTimestamp);
  const event =
    existing?.event ??
    (await loadValSetEvent(state, cache, clientFactory, {
      epoch,
      settlement,
      finalized,
      startTimestamp,
      endTimestamp,
      buffer,
      mode,
      allowCache,
    }));

  if (!event) {
    let overallStatus = statusContext?.overall ?? null;
    let settlementStatus = statusContext?.detail ?? null;

    if (!overallStatus) {
      overallStatus = await statusFetcher(epoch, finalized);
    }

    if (!settlementStatus && overallStatus) {
      settlementStatus =
        overallStatus.settlements.find(
          (item) =>
            item.settlement.chainId === settlement.chainId &&
            item.settlement.address.toLowerCase() === settlement.address.toLowerCase(),
        ) ?? null;
    }

    if (settlementStatus && settlementStatus.committed) {
      throw new Error(
        `Validator set epoch ${epoch} is committed for settlement ${settlement.address} but no events were found using ${blockTag} data.`,
      );
    }

    if (overallStatus && overallStatus.status !== 'committed') {
      throw new Error(
        `Validator set epoch ${epoch} is not committed yet (status: ${overallStatus.status}).`,
      );
    }

    const status = overallStatus ?? (await statusFetcher(epoch, finalized));

    if (status.status !== 'committed') {
      throw new Error(
        `Validator set epoch ${epoch} is not committed yet (status: ${status.status}).`,
      );
    }

    throw new Error(
      `Validator set epoch ${epoch} is committed but no settlement events were found using ${blockTag} data.`,
    );
  }

  return event;
};
