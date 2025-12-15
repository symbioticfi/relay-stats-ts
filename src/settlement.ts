import {
  getContract,
  type Address,
  type Hex,
  type PublicClient,
  decodeFunctionData,
  hexToBytes,
  bytesToHex,
} from 'viem';
import { SETTLEMENT_ABI } from './abis/index.js';
import { MULTICALL3_ADDRESS, EVENT_SCAN_RANGE } from './constants.js';
import {
  CrossChainAddress,
  CacheInterface,
  SettlementValSetStatus,
  ValSetStatus,
  ValSetLogEvent,
  ValSetEventKind,
  ValidatorSetHeader,
  ValSetExtraData,
  ValSetQuorumProof,
  ValSetQuorumProofSimple,
  ValSetQuorumProofSimpleSigner,
  ValSetQuorumProofZk,
} from './types/index.js';
import { blockTagFromFinality, type BlockTagPreference } from './utils/core.js';

export const settlementKey = (settlement: CrossChainAddress): string =>
  `${settlement.chainId}_${settlement.address.toLowerCase()}`;

export const valsetEventsStateKey = (
  blockTag: BlockTagPreference,
  settlement: CrossChainAddress,
): string => `${blockTag}_${settlementKey(settlement)}`;

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
export interface ValSetEventsState {
  settlement: CrossChainAddress;
  map: Map<number, { event: ValSetLogEvent; logIndex: number | null }>;
}

/** @notice Build a settlement contract wrapper. */
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

type VerificationMode = 'simple' | 'zk';

const bytesToBigint = (bytes: Uint8Array): bigint => {
  if (bytes.length === 0) return 0n;
  return BigInt(bytesToHex(bytes));
};

const SIMPLE_SIG_LEN = 64;
const SIMPLE_PUBKEY_LEN = 128;
const SIMPLE_COUNT_LEN = 32;
const SIMPLE_SIGNER_ENTRY_LEN = 64;
const ZK_ELEMENT_LEN = 32;
const ZK_PROOF_ELEMENTS = 8;
const ZK_COMMITMENTS = 2;
const ZK_COMMITMENT_POK = 2;
const ZK_MIN_BYTES =
  ZK_ELEMENT_LEN * (ZK_PROOF_ELEMENTS + ZK_COMMITMENTS + ZK_COMMITMENT_POK + 1);

const decodeSimpleQuorumProof = (proof: Hex): ValSetQuorumProofSimple | null => {
  const bytes = hexToBytes(proof);
  const headerLen = SIMPLE_SIG_LEN + SIMPLE_PUBKEY_LEN + SIMPLE_COUNT_LEN;
  if (bytes.length < headerLen) {
    return null;
  }

  const aggregatedSignature = bytesToHex(bytes.slice(0, SIMPLE_SIG_LEN)) as Hex;
  const aggregatedPublicKey = bytesToHex(bytes.slice(SIMPLE_SIG_LEN, SIMPLE_SIG_LEN + SIMPLE_PUBKEY_LEN)) as Hex;

  const countStart = SIMPLE_SIG_LEN + SIMPLE_PUBKEY_LEN;
  const validatorCountBigint = bytesToBigint(bytes.slice(countStart, countStart + SIMPLE_COUNT_LEN));
  if (validatorCountBigint < 0n) return null;
  const validatorCount = Number(validatorCountBigint);
  if (!Number.isSafeInteger(validatorCount) || validatorCount < 0) return null;

  let offset = headerLen;
  const expectedLength = offset + validatorCount * SIMPLE_SIGNER_ENTRY_LEN;
  if (bytes.length < expectedLength) return null;

  const signers: ValSetQuorumProofSimpleSigner[] = [];

  for (let i = 0; i < validatorCount; i++) {
    const key = bytesToHex(bytes.slice(offset, offset + SIMPLE_SIGNER_ENTRY_LEN / 2)) as Hex;
    const votingPower = bytesToBigint(bytes.slice(offset + SIMPLE_SIGNER_ENTRY_LEN / 2, offset + SIMPLE_SIGNER_ENTRY_LEN));
    signers.push({
      key,
      votingPower,
    });
    offset += SIMPLE_SIGNER_ENTRY_LEN;
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
  if (bytes.length < ZK_MIN_BYTES) {
    return null;
  }

  const proofElements: Hex[] = [];
  let offset = 0;
  for (let i = 0; i < ZK_PROOF_ELEMENTS; i++) {
    proofElements.push(bytesToHex(bytes.slice(offset, offset + ZK_ELEMENT_LEN)) as Hex);
    offset += ZK_ELEMENT_LEN;
  }

  const commitments: Hex[] = [];
  for (let i = 0; i < ZK_COMMITMENTS; i++) {
    commitments.push(bytesToHex(bytes.slice(offset, offset + ZK_ELEMENT_LEN)) as Hex);
    offset += ZK_ELEMENT_LEN;
  }

  const commitmentPok: Hex[] = [];
  for (let i = 0; i < ZK_COMMITMENT_POK; i++) {
    commitmentPok.push(bytesToHex(bytes.slice(offset, offset + ZK_ELEMENT_LEN)) as Hex);
    offset += ZK_ELEMENT_LEN;
  }

  const votingPower = bytesToBigint(bytes.slice(offset, offset + ZK_ELEMENT_LEN));

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

const toRawValSetHeader = (
  value: RawValSetHeader | null | undefined,
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
  kind: typeof ValSetEventKind.Genesis | typeof ValSetEventKind.Commit,
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
  existing: { event: ValSetLogEvent; logIndex: number | null },
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

const ingestSettlementEvents = async (
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
    const rawHeader = toRawValSetHeader((log.args as SettlementEventArgs | undefined)?.valSetHeader);
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

    const kind =
      log.eventName === 'SetGenesis' ? ValSetEventKind.Genesis : ValSetEventKind.Commit;
    let quorumProof: ValSetQuorumProof | null = null;
    if (metadata.transactionHash && kind === ValSetEventKind.Commit) {
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

  if (existing) {
    return existing.event;
  }

  const client = clientFactory(settlement.chainId);
  const latestBlock = await client.getBlock({ blockTag });
  const toBlock = latestBlock.number ?? 0n;
  const fromBlock = toBlock > EVENT_SCAN_RANGE ? toBlock - EVENT_SCAN_RANGE : 0n;

  if (toBlock >= fromBlock) {
    await ingestSettlementEvents(client, settlement, state, fromBlock, toBlock, mode);
  }

  const stored = state.map.get(epoch) ?? null;
  let event = stored?.event ?? null;

  if (!event && finalized) {
    const latestState = stateFactory('latest', settlement);
    const latestClient = clientFactory(settlement.chainId);
    const latestBlock = await latestClient.getBlock({ blockTag: 'latest' });
    const latestTo = latestBlock.number ?? 0n;
    const latestFrom = latestTo > EVENT_SCAN_RANGE ? latestTo - EVENT_SCAN_RANGE : 0n;
    if (latestTo >= latestFrom) {
      await ingestSettlementEvents(
        latestClient,
        settlement,
        latestState,
        latestFrom,
        latestTo,
        mode,
      );
      event = latestState.map.get(epoch)?.event ?? null;
    }
  }

  if (event && cache && allowCache) {
    const cacheKey = `${settlement.chainId}_${settlement.address.toLowerCase()}`;
    await cache.set(epoch, cacheKey, event);
  }

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
