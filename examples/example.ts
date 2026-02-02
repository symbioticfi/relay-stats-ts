// example/example.ts
import {
    ValidatorSetDeriver,
    AGGREGATOR_MODE,
    ValSetEventKind,
    type ValidatorSet,
    type NetworkData,
    type AggregatorExtraDataEntry,
    type NetworkConfig,
    type ValSetLogEvent,
    type ValSetExtraData,
    type ValSetEventKindType,
    type CrossChainAddress,
    type EpochRange,
    fetchSettlementEventsRange,
} from '@symbioticfi/relay-stats-ts';
import { createPublicClient, http, type Address, type Hex, type PublicClient } from 'viem';
import { fileURLToPath } from 'url';

const DEFAULT_RPC_URLS = ['http://localhost:8545', 'http://localhost:8546'];
const DEFAULT_DRIVER_ADDRESS: Address = '0x43C27243F96591892976FFf886511807B65a33d5';
const DEFAULT_DRIVER_CHAIN_ID = 31337;

const rpcUrls = parseRpcUrls(process.env.RELAY_STATS_RPC_URLS);
const driverChainId = parseChainId(process.env.RELAY_STATS_DRIVER_CHAIN_ID);
const driverAddress = parseDriverAddress(process.env.RELAY_STATS_DRIVER_ADDRESS);

const rpcMetrics = installRpcMetrics(rpcUrls);

const COLORS = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    gray: '\x1b[90m',
};

const ui = {
    heading: (text: string) => console.log(`${COLORS.bold}${COLORS.cyan}${text}${COLORS.reset}`),
    section: (title: string) =>
        console.log(`\n${COLORS.bold}${COLORS.magenta}=== ${title} ===${COLORS.reset}`),
    info: (label: string, value: unknown) =>
        console.log(`${COLORS.bold}${label}:${COLORS.reset} ${value}`),
    success: (message: string) => console.log(`${COLORS.green}✔ ${message}${COLORS.reset}`),
    warn: (message: string) => console.log(`${COLORS.yellow}⚠ ${message}${COLORS.reset}`),
    error: (message: string) => console.log(`${COLORS.red}✘ ${message}${COLORS.reset}`),
    bullet: (text: string) => console.log(`  ${COLORS.gray}•${COLORS.reset} ${text}`),
    numbered: (index: number, text: string) =>
        console.log(`  ${COLORS.gray}${index}.${COLORS.reset} ${text}`),
    blank: () => console.log(),
};

/**
 * Main example demonstrating validator set derivation
 */
async function main() {
    ui.heading('🚀 Initializing relay-stats-ts deriver...');

    try {
        // Initialize the deriver without cache
        ui.info('RPC URLs', rpcUrls.map(url => shortUrl(url)).join(', '));
        ui.info('Driver Chain ID', driverChainId);
        ui.info('Driver Address', driverAddress);
        const clientsByChainId = await verifyRpcUrls(rpcUrls, driverChainId);

        const deriver = await ValidatorSetDeriver.create({
            rpcUrls,
            driverAddress: {
                chainId: driverChainId,
                address: driverAddress,
            },
            cache: null,
        });

        ui.success('Deriver initialized successfully!');
        ui.blank();

        // Get the current epoch number
        let currentEpoch: number;
        try {
            currentEpoch = await deriver.getCurrentEpoch();
            ui.info('Current Epoch', currentEpoch);
            ui.blank();
        } catch {
            ui.error('Could not get current epoch from contract');
            ui.bullet('Ensure the contract exposes getCurrentEpoch and is deployed correctly.');
            ui.blank();
            return;
        }
        const epochRange = resolveEpochRange(
            currentEpoch,
            process.env.RELAY_STATS_EPOCH_RANGE,
            process.env.RELAY_STATS_EPOCH_FROM,
            process.env.RELAY_STATS_EPOCH_TO
        );

        // Get network configuration for current epoch
        ui.section('Network Configuration (Current Epoch)');
        let networkConfig: NetworkConfig | null = null;
        try {
            networkConfig = await deriver.getCurrentNetworkConfig();
            ui.info('Voting Power Providers', networkConfig.votingPowerProviders.length);
            ui.info(
                'Keys Provider',
                `Chain ${networkConfig.keysProvider.chainId} · ${networkConfig.keysProvider.address}`
            );
            ui.info('Settlements', networkConfig.settlements.length);
            networkConfig.settlements.forEach((settlement, index) => {
                ui.numbered(index + 1, `Chain ${settlement.chainId} · ${settlement.address}`);
            });
            ui.info('Max Voting Power', networkConfig.maxVotingPower.toString());
            ui.info('Min Inclusion Voting Power', networkConfig.minInclusionVotingPower.toString());
            ui.info('Max Validators Count', networkConfig.maxValidatorsCount.toString());
            ui.info('Required Header Key Tag', networkConfig.requiredHeaderKeyTag);
            ui.info('Number of Committers', networkConfig.numCommitters);
            ui.info('Number of Aggregators', networkConfig.numAggregators);
            ui.blank();
        } catch {
            ui.error('Could not get network configuration from contract');
            ui.bullet('Verify the contract implements getConfigAt and is deployed correctly.');
            ui.blank();
            return;
        }

        // Fetch additional network metadata (NETWORK/SUBNETWORK + EIP-712 domain)
        try {
            const networkData = await deriver.getNetworkData();
            displayNetworkData(networkData);
        } catch (error) {
            ui.warn('Could not fetch network extra data');
            ui.bullet(`Reason: ${error instanceof Error ? error.message : String(error)}`);
            ui.blank();
        }

        // Get validator set for epoch 1
        ui.section('Validator Set for Epoch 1');
        let epoch1Valset: ValidatorSet | null = null;
        try {
            epoch1Valset = await deriver.getValidatorSet(1);
            displayValidatorSet(epoch1Valset, 1);
        } catch {
            ui.error('Could not get validator set for epoch 1');
            ui.bullet('This may indicate missing contract methods or insufficient data.');
            epoch1Valset = null;
        }

        // Get validator set for current epoch
        ui.section(`Validator Set for Current Epoch (${currentEpoch})`);
        let currentValset: ValidatorSet | null = null;
        let currentValsetStatus: {
            status: 'committed' | 'pending' | 'missing';
            integrity: 'valid' | 'invalid';
        } | null = null;
        try {
            currentValset = await deriver.getCurrentValidatorSet();
            displayValidatorSet(currentValset, currentEpoch);
        } catch {
            ui.error('Could not get validator set for current epoch');
            ui.bullet('This may indicate missing contract methods or insufficient data.');
            currentValset = null;
        }

        try {
            const status = await deriver.getValSetStatus(currentEpoch);
            currentValsetStatus = status;
            ui.info(
                'Validator Set Status',
                `${getStatusEmoji(status.status)} ${status.status} · integrity ${status.integrity}`
            );
        } catch (error) {
            ui.warn('Could not fetch validator set status');
            ui.bullet(`Reason: ${error instanceof Error ? error.message : String(error)}`);
            currentValsetStatus = null;
        }

        // Compare epochs
        if (epoch1Valset && currentValset) {
            ui.section('Epoch Comparison');
            ui.info('Epochs', `1 → ${currentEpoch}`);
            ui.info(
                'Active Validators',
                `${epoch1Valset.validators.filter(v => v.isActive).length} → ${currentValset.validators.filter(v => v.isActive).length}`
            );
            ui.info(
                'Total Voting Power',
                `${epoch1Valset.totalVotingPower.toString()} → ${currentValset.totalVotingPower.toString()}`
            );
            const epoch1QuorumPct =
                (epoch1Valset.quorumThreshold * 10000n) / epoch1Valset.totalVotingPower;
            const currentQuorumPct =
                (currentValset.quorumThreshold * 10000n) / currentValset.totalVotingPower;
            ui.info(
                'Quorum Threshold',
                `${epoch1Valset.quorumThreshold.toString()} (${epoch1QuorumPct.toString()}bp) → ${currentValset.quorumThreshold.toString()} (${currentQuorumPct.toString()}bp)`
            );
        } else {
            ui.section('Epoch Comparison');
            ui.warn('Cannot compare epochs - validator sets not available');
        }

        // Get top 10 operators with all data
        if (currentValset) {
            ui.section('Top 10 Operators (Current Epoch)');
            const topOperators = currentValset.validators
                .filter(v => v.isActive)
                .sort((a, b) => {
                    const diff = b.votingPower - a.votingPower;
                    return diff > 0n ? 1 : diff < 0n ? -1 : 0;
                })
                .slice(0, 10);

            topOperators.forEach((validator, index) => {
                ui.numbered(index + 1, `${validator.operator}`);
                ui.info('    Voting Power', validator.votingPower.toString());
                ui.info(
                    '    Status',
                    validator.isActive
                        ? `${COLORS.green}Active${COLORS.reset}`
                        : `${COLORS.red}Inactive${COLORS.reset}`
                );
                ui.info('    Vaults', validator.vaults.length);
                validator.vaults.forEach((vault, vaultIndex) => {
                    const collateralParts: string[] = [];
                    if (vault.collateral) {
                        collateralParts.push(vault.collateral);
                    }
                    if (vault.collateralSymbol) {
                        collateralParts.push(`symbol ${vault.collateralSymbol}`);
                    }
                    if (vault.collateralName) {
                        collateralParts.push(`name ${vault.collateralName}`);
                    }
                    const collateralInfo =
                        collateralParts.length > 0
                            ? ` – collateral ${collateralParts.join(', ')}`
                            : '';
                    ui.numbered(
                        vaultIndex + 1,
                        `Chain ${vault.chainId} · ${vault.vault} (${vault.votingPower.toString()} VP)${collateralInfo}`
                    );
                });
                ui.info('    Keys', validator.keys.length);
                validator.keys.forEach(key => {
                    ui.bullet(`Tag ${key.tag}: ${key.payload}`);
                });
            });
        } else {
            ui.section('Top 10 Operators (Current Epoch)');
            ui.warn('Cannot show operators - validator set not available');
        }

        if (currentValset) {
            ui.section('Validator Set Header Utilities');
            const activeVotingPower = deriver.getTotalActiveVotingPower(currentValset);
            ui.info('Total Active Voting Power', activeVotingPower.toString());

            const header = deriver.getValidatorSetHeader(currentValset);
            ui.bullet('Validator Set Header');
            ui.info('    Epoch', header.epoch);
            ui.info('    Capture Timestamp', header.captureTimestamp);
            ui.info('    Validators SSZ Root', header.validatorsSszMRoot);

            const encodedHeader = deriver.abiEncodeValidatorSetHeader(header);
            ui.info('ABI Encoded Header', encodedHeader);

            const headerHash = deriver.hashValidatorSetHeader(header);
            ui.info('Header Hash (from header)', headerHash);

            const computedHashViaSet = deriver.getValidatorSetHeaderHash(currentValset);
            ui.info('Header Hash (from validator set)', computedHashViaSet);
        }

        let epochIndexForCapture: number | null = null;
        ui.section('Epoch Timeline');
        try {
            const currentEpochDurationVal = await deriver.getCurrentEpochDuration();
            const currentEpochStartVal = await deriver.getCurrentEpochStart();
            const nextEpochNumber = await deriver.getNextEpoch();
            const nextEpochStartVal = await deriver.getNextEpochStart();
            const nextEpochDurationVal = await deriver.getNextEpochDuration();
            const epochDurationForCurrent = await deriver.getEpochDuration(currentEpoch);
            const epochStartForCurrent = await deriver.getEpochStart(currentEpoch);

            ui.info('Current Epoch Start', currentEpochStartVal);
            ui.info('Current Epoch Duration', currentEpochDurationVal);
            ui.info('Next Epoch', nextEpochNumber);
            ui.info('Next Epoch Start', nextEpochStartVal);
            ui.info('Next Epoch Duration', nextEpochDurationVal);
            ui.info(`Epoch Duration (index ${currentEpoch})`, epochDurationForCurrent);
            ui.info(`Epoch Start (index ${currentEpoch})`, epochStartForCurrent);

            if (currentValset) {
                epochIndexForCapture = await deriver.getEpochIndex(currentValset.captureTimestamp);
                ui.info(
                    'Capture Timestamp Epoch',
                    `${currentValset.captureTimestamp} → epoch ${epochIndexForCapture}`
                );
            }
        } catch (error) {
            ui.warn('Could not fetch epoch timeline info');
            ui.bullet(`Reason: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Fetch aggregator extra data for relayer/aggregator flows
        ui.section('Aggregator Extra Data');
        try {
            const simpleExtraData = await deriver.getAggregatorsExtraData(
                AGGREGATOR_MODE.SIMPLE,
                undefined,
                true,
                currentEpoch
            );
            displayAggregatorExtraData('Simple', simpleExtraData);
        } catch (error) {
            ui.warn('Simple mode unavailable');
            ui.bullet(`Reason: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
            const zkExtraData = await deriver.getAggregatorsExtraData(
                AGGREGATOR_MODE.ZK,
                undefined,
                true,
                currentEpoch
            );
            displayAggregatorExtraData('ZK', zkExtraData);
        } catch (error) {
            ui.warn('ZK mode unavailable');
            ui.bullet(`Reason: ${error instanceof Error ? error.message : String(error)}`);
        }

        ui.section('Settlement ValSet Events (Current Epoch)');
        if (networkConfig && networkConfig.settlements.length > 0) {
            if (currentValsetStatus && currentValsetStatus.status !== 'committed') {
                ui.warn(
                    `Validator set is ${currentValsetStatus.status}; skipping settlement event retrieval until committed.`
                );
            } else {
                for (const settlement of networkConfig.settlements) {
                    ui.info('Settlement', `Chain ${settlement.chainId} · ${settlement.address}`);
                    await tryDisplayValSetEvent(
                        deriver,
                        settlement,
                        currentEpoch,
                        'By epoch lookup',
                        `epoch ${currentEpoch}`
                    );

                    if (epochIndexForCapture !== null) {
                        await tryDisplayValSetEvent(
                            deriver,
                            settlement,
                            epochIndexForCapture,
                            'By capture timestamp lookup',
                            currentValset
                                ? `timestamp ${currentValset.captureTimestamp} (epoch ${epochIndexForCapture})`
                                : `epoch ${epochIndexForCapture}`
                        );
                    } else if (currentValset) {
                        ui.warn(
                            'Epoch index for capture timestamp unavailable; skipping timestamp lookup.'
                        );
                    }
                }
            }
        } else {
            ui.warn('No settlement configured; cannot demonstrate settlement events.');
        }

        await displayEpochSnapshot(deriver, currentEpoch);
        await displayEpochRangeSnapshots(deriver, epochRange);
        await measureEpochRpcCalls(currentEpoch, 10);
        await measureEventRangeRpcCalls(
            deriver,
            clientsByChainId,
            currentEpoch,
            [1, 2, 3, 5, 10, 20, 40]
        );
    } catch (error) {
        ui.error(
            `Failed to initialize deriver: ${error instanceof Error ? error.message : String(error)}`
        );
        ui.section('Troubleshooting');
        ui.numbered(1, 'RPC endpoints might be inaccessible.');
        ui.numbered(2, 'Driver contract address may be incorrect.');
        ui.numbered(3, 'Contract could be undeployed or non-responsive.');
        ui.info('Next Steps', 'Verify RPC URLs and contract addresses, then retry.');
        return;
    }
}

function displayNetworkData(networkData: NetworkData) {
    ui.section('Network Extra Data');
    ui.info('Network Address', networkData.address);
    ui.info('Subnetwork ID', networkData.subnetwork);
    ui.bullet('EIP-712 Domain');
    ui.info('    Name', networkData.eip712Data.name);
    ui.info('    Version', networkData.eip712Data.version);
    ui.info('    Chain ID', networkData.eip712Data.chainId.toString());
    ui.info('    Verifying Contract', networkData.eip712Data.verifyingContract);
    ui.info('    Salt', networkData.eip712Data.salt);
    if (networkData.eip712Data.extensions.length > 0) {
        ui.info('    Extensions', networkData.eip712Data.extensions.length);
        networkData.eip712Data.extensions.forEach((ext, index) => {
            ui.numbered(index + 1, ext.toString());
        });
    }
}

function parseRpcUrls(raw: string | undefined): string[] {
    if (!raw) {
        return DEFAULT_RPC_URLS;
    }

    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            const urls = parsed.map(value => String(value).trim()).filter(Boolean);
            if (urls.length > 0) {
                return urls;
            }
        }
    } catch {
        // fall through to delimiter-based parsing
    }

    const split = raw
        .split(/[\n,]/)
        .map(value => value.trim())
        .filter(Boolean);
    return split.length > 0 ? split : DEFAULT_RPC_URLS;
}

function parseChainId(raw: string | undefined): number {
    if (!raw) {
        return DEFAULT_DRIVER_CHAIN_ID;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
        ui.warn(
            `Invalid RELAY_STATS_DRIVER_CHAIN_ID="${raw}". Falling back to ${DEFAULT_DRIVER_CHAIN_ID}.`
        );
        return DEFAULT_DRIVER_CHAIN_ID;
    }
    return parsed;
}

function parseDriverAddress(raw: string | undefined): Address {
    if (!raw) {
        return DEFAULT_DRIVER_ADDRESS;
    }
    const trimmed = raw.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
        ui.warn(
            `Invalid RELAY_STATS_DRIVER_ADDRESS="${trimmed}". Falling back to ${DEFAULT_DRIVER_ADDRESS}.`
        );
        return DEFAULT_DRIVER_ADDRESS;
    }
    return trimmed as Address;
}

function resolveEpochRange(
    currentEpoch: number,
    rawRange: string | undefined,
    rawFrom: string | undefined,
    rawTo: string | undefined
): EpochRange {
    const fallback: EpochRange = {
        from: Math.max(0, currentEpoch - 2),
        to: currentEpoch,
    };

    if (rawRange) {
        const parsed = parseEpochRangeString(rawRange);
        if (!parsed) {
            ui.warn(
                `Invalid RELAY_STATS_EPOCH_RANGE="${rawRange}". Using ${fallback.from}..${fallback.to}.`
            );
            return fallback;
        }
        const normalized = normalizeEpochRange(parsed, currentEpoch);
        if (normalized.from !== parsed.from || normalized.to !== parsed.to) {
            ui.warn(
                `Adjusted epoch range ${parsed.from}..${parsed.to} to ${normalized.from}..${normalized.to}.`
            );
        }
        return normalized;
    }

    if (rawFrom || rawTo) {
        const from = parseEpochValue(rawFrom);
        const to = parseEpochValue(rawTo);
        if (from === null && to === null) {
            ui.warn(
                `Invalid RELAY_STATS_EPOCH_FROM="${rawFrom}" / RELAY_STATS_EPOCH_TO="${rawTo}". Using ${fallback.from}..${fallback.to}.`
            );
            return fallback;
        }
        const parsed: EpochRange = {
            from: from ?? fallback.from,
            to: to ?? fallback.to,
        };
        const normalized = normalizeEpochRange(parsed, currentEpoch);
        if (normalized.from !== parsed.from || normalized.to !== parsed.to) {
            ui.warn(
                `Adjusted epoch range ${parsed.from}..${parsed.to} to ${normalized.from}..${normalized.to}.`
            );
        }
        return normalized;
    }

    return fallback;
}

function parseEpochRangeString(raw: string): EpochRange | null {
    const normalized = raw.replace(/\.\./g, '-');
    const parts = normalized.split(/[\s,-]+/).filter(Boolean);
    if (parts.length !== 2) return null;
    const from = Number.parseInt(parts[0], 10);
    const to = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return { from, to };
}

function parseEpochValue(raw: string | undefined): number | null {
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
}

function normalizeEpochRange(range: EpochRange, currentEpoch: number): EpochRange {
    let { from, to } = range;
    if (from > to) {
        [from, to] = [to, from];
    }
    if (from < 0) from = 0;
    if (to < 0) to = 0;
    if (to > currentEpoch) to = currentEpoch;
    if (from > currentEpoch) from = currentEpoch;
    return { from, to };
}

async function verifyRpcUrls(
    urls: string[],
    _expectedChainId: number
): Promise<Map<number, PublicClient>> {
    ui.section('RPC Health Check');
    const clientsByChainId = new Map<number, PublicClient>();
    for (const url of urls) {
        try {
            const client = createPublicClient({ transport: http(url) });
            const cid = await client.getChainId();
            ui.success(`RPC ${url} reachable (chainId ${cid})`);
            clientsByChainId.set(cid, client);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ui.error(`RPC ${url} unreachable: ${message}`);
        }
    }
    ui.blank();
    return clientsByChainId;
}

/**
 * Helper function to display validator set information
 */
function displayValidatorSet(valset: ValidatorSet, epoch: number) {
    try {
        const activeValidators = valset.validators.filter(v => v.isActive);
        const totalValidators = valset.validators.length;

        ui.info('Version', valset.version);
        ui.info('Capture Timestamp', valset.captureTimestamp);
        ui.info('Total Validators', totalValidators);
        ui.info('Active Validators', activeValidators.length);
        ui.info('Total Voting Power', valset.totalVotingPower.toString());
        ui.info('Quorum Threshold', valset.quorumThreshold.toString());
        ui.info('Required Key Tag', valset.requiredKeyTag);
        ui.info('Status', `${getStatusEmoji(valset.status)} ${valset.status}`);
        ui.info('Integrity', `${valset.integrity === 'valid' ? '✅' : '❌'} ${valset.integrity}`);

        if (valset.status === 'committed' && valset.integrity === 'valid') {
            ui.success('Validator set is committed and integrity verified.');
        } else {
            if (valset.status === 'pending') {
                ui.warn('Validator set is pending on-chain updates.');
            } else if (valset.status === 'missing') {
                ui.warn('Validator set data is missing - investigate driver and settlements.');
            }
            if (valset.integrity === 'invalid') {
                ui.error('Integrity check failed - header hashes do not match.');
            }
        }

        // Show voting power distribution
        if (activeValidators.length > 0) {
            const avgVotingPower = valset.totalVotingPower / BigInt(activeValidators.length);
            const maxVotingPower = activeValidators[0].votingPower;
            const minVotingPower = activeValidators[activeValidators.length - 1].votingPower;

            ui.bullet('Voting Power Distribution');
            ui.info('    Max', maxVotingPower.toString());
            ui.info('    Avg', avgVotingPower.toString());
            ui.info('    Min', minVotingPower.toString());
        }
    } catch (error) {
        ui.warn(
            `Error displaying validator set for epoch ${epoch}: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

async function tryDisplayValSetEvent(
    deriver: ValidatorSetDeriver,
    settlement: CrossChainAddress,
    epoch: number,
    label: string,
    contextLabel: string
) {
    const result = await fetchValSetEvent(deriver, settlement, epoch);
    if (result.event) {
        displayValSetLogEvent(label, result.event, settlement);
    } else {
        ui.warn(`Failed to get event for ${contextLabel}`);
        if (result.reason) {
            ui.bullet(`Reason: ${result.reason}`);
        }
    }
}

async function fetchValSetEvent(
    deriver: ValidatorSetDeriver,
    settlement: CrossChainAddress,
    epoch: number
): Promise<{
    event: ValSetLogEvent | null;
    reason?: string;
}> {
    try {
        const events = await deriver.getValSetLogEvents({
            epoch,
            settlements: [settlement],
            finalized: true,
        });
        const event = events[0]?.event ?? null;
        return { event };
    } catch (finalizedError) {
        const finalizedReason = formatError(finalizedError);
        return { event: null, reason: finalizedReason };
    }
}

function displayAggregatorExtraData(modeLabel: string, entries: AggregatorExtraDataEntry[]) {
    if (entries.length === 0) {
        ui.bullet(`${modeLabel}: no entries returned`);
        return;
    }
    ui.bullet(`${modeLabel}:`);
    entries.forEach((entry, index) => {
        ui.numbered(index + 1, `key=${entry.key} value=${entry.value}`);
    });
}

type EventWithLegacyMetadata = ValSetLogEvent & {
    blockTimestamp?: number | null;
    blockHash?: Hex | null;
    logIndex?: number | null;
};

function displayValSetLogEvent(
    label: string,
    event: ValSetLogEvent,
    settlement: CrossChainAddress
) {
    const metadata = event as EventWithLegacyMetadata;
    ui.bullet(label);
    ui.info('    Settlement', `chain ${settlement.chainId} · ${settlement.address}`);
    ui.info('    Event Kind', formatValSetEventKind(event.kind));
    ui.info('    Epoch', event.header.epoch);
    ui.info('    Capture Timestamp', event.header.captureTimestamp);
    ui.info('    Total Voting Power', event.header.totalVotingPower.toString());
    ui.info('    Validators SSZ Root', event.header.validatorsSszMRoot);
    if (event.blockNumber !== null) {
        ui.info('    Block Number', event.blockNumber.toString());
    }
    if (metadata.blockTimestamp !== undefined && metadata.blockTimestamp !== null) {
        ui.info('    Block Timestamp', String(metadata.blockTimestamp));
    } else if (metadata.blockHash) {
        ui.info('    Block Hash', metadata.blockHash);
    }
    if (event.transactionHash) {
        ui.info('    Tx Hash', event.transactionHash);
    }
    if (metadata.logIndex !== undefined && metadata.logIndex !== null) {
        ui.info('    Log Index', metadata.logIndex);
    }
    if (event.quorumProof) {
        ui.info('    Quorum Proof Mode', event.quorumProof.mode);
        if (event.quorumProof.mode === 'simple') {
            ui.info('    Aggregated Signature', event.quorumProof.aggregatedSignature);
            ui.info('    Aggregated Public Key', event.quorumProof.aggregatedPublicKey);
            ui.info('    Signers', `${event.quorumProof.signers.length}`);
            const signerPreview = event.quorumProof.signers.slice(0, 3);
            signerPreview.forEach((signer, index) => {
                ui.numbered(
                    index + 1,
                    `signer key=${signer.key} votingPower=${signer.votingPower.toString()}`
                );
            });
            if (event.quorumProof.signers.length > signerPreview.length) {
                ui.bullet(
                    `... ${event.quorumProof.signers.length - signerPreview.length} additional signers omitted`
                );
            }
            if (event.quorumProof.nonSignerIndices.length > 0) {
                const indicesPreview = event.quorumProof.nonSignerIndices.slice(0, 6);
                ui.info(
                    '    Non-Signer Indices',
                    `${indicesPreview.join(', ')}${
                        event.quorumProof.nonSignerIndices.length > indicesPreview.length
                            ? ', ...'
                            : ''
                    }`
                );
            } else {
                ui.info('    Non-Signer Indices', 'none');
            }
        } else {
            ui.info('    ZK Proof Elements', event.quorumProof.proof.length);
            ui.info('    Commitments', event.quorumProof.commitments.join(', '));
            ui.info('    Commitment PoK', event.quorumProof.commitmentPok.join(', '));
            ui.info('    Signers Voting Power', event.quorumProof.signersVotingPower.toString());
        }
    } else {
        ui.info('    Quorum Proof', 'unavailable');
    }
    displayValSetExtraData(event.extraData);
}

function displayValSetExtraData(entries: ValSetExtraData[]) {
    if (!entries || entries.length === 0) {
        ui.info('    Extra Data', 'none');
        return;
    }
    ui.info('    Extra Data Entries', entries.length);
    entries.forEach((entry, index) => {
        ui.numbered(index + 1, `key=${entry.key} value=${entry.value}`);
    });
}

async function displayEpochSnapshot(
    deriver: ValidatorSetDeriver,
    epoch: number,
    finalized: boolean = true
) {
    ui.section(`Epoch ${epoch} Snapshot (getEpochData)`);
    try {
        const snapshot = await deriver.getEpochData({
            epoch,
            finalized,
            includeNetworkData: true,
            includeValSetEvent: true,
        });

        displayValidatorSet(snapshot.validatorSet, snapshot.epoch);

        if (snapshot.networkData) {
            ui.bullet('Network Snapshot');
            ui.info('    Address', snapshot.networkData.address);
            ui.info('    Subnetwork', snapshot.networkData.subnetwork);
            ui.info('    EIP-712 Name', snapshot.networkData.eip712Data.name);
            ui.info('    EIP-712 Version', snapshot.networkData.eip712Data.version);
        }

        if (snapshot.aggregatorsExtraData && snapshot.aggregatorsExtraData.length > 0) {
            displayAggregatorExtraData('Simple', snapshot.aggregatorsExtraData);
        }

        if (snapshot.settlementStatuses && snapshot.settlementStatuses.length > 0) {
            ui.section('Settlement Commit Status');
            snapshot.settlementStatuses.forEach((detail, index) => {
                ui.numbered(
                    index + 1,
                    `Chain ${detail.settlement.chainId} · ${detail.settlement.address}`
                );
                ui.info('    Committed', detail.committed ? 'yes' : 'no');
                if (detail.headerHash) {
                    ui.info('    Header Hash', detail.headerHash);
                }
                if (detail.lastCommittedEpoch !== null) {
                    ui.info('    Last Committed Epoch', detail.lastCommittedEpoch);
                }
            });
        }

        if (snapshot.valSetEvents && snapshot.valSetEvents.length > 0) {
            ui.section('Validator Set Events (getEpochData)');
            snapshot.valSetEvents.forEach((entry, index) => {
                ui.numbered(
                    index + 1,
                    `Chain ${entry.settlement.chainId} · ${entry.settlement.address}`
                );
                ui.info('    Committed', entry.committed ? 'yes' : 'no');
                if (entry.event) {
                    displayValSetLogEvent('    Event', entry.event, entry.settlement);
                } else if (entry.committed) {
                    ui.warn('    Event unavailable despite committed settlement.');
                } else {
                    ui.info('    Event', 'skipped (settlement not committed)');
                }
            });
        } else {
            ui.warn('Validator set events not available (no committed settlements yet).');
        }
    } catch (error) {
        ui.error(
            `getEpochData failed for epoch ${epoch}: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

async function displayEpochRangeSnapshots(
    deriver: ValidatorSetDeriver,
    epochRange: EpochRange,
    finalized: boolean = true
) {
    ui.section(`Epoch Range Snapshot (${epochRange.from} → ${epochRange.to})`);
    try {
        const [snapshots, starts, durations] = await Promise.all([
            deriver.getEpochsData({
                epochRange,
                finalized,
                includeNetworkData: false,
                includeValSetEvent: false,
            }),
            deriver.getEpochStarts(epochRange, finalized),
            deriver.getEpochDurations(epochRange, finalized),
        ]);

        const startByEpoch = new Map(starts.map(entry => [entry.epoch, entry.start]));
        const durationByEpoch = new Map(durations.map(entry => [entry.epoch, entry.duration]));

        snapshots.forEach((snapshot, index) => {
            ui.numbered(index + 1, `Epoch ${snapshot.epoch}`);
            ui.info(
                '    Status',
                `${getStatusEmoji(snapshot.validatorSet.status)} ${snapshot.validatorSet.status}`
            );
            ui.info(
                '    Integrity',
                `${snapshot.validatorSet.integrity === 'valid' ? '✅' : '❌'} ${snapshot.validatorSet.integrity}`
            );
            ui.info('    Validators', snapshot.validatorSet.validators.length);
            ui.info(
                '    Active Validators',
                snapshot.validatorSet.validators.filter(v => v.isActive).length
            );
            const start = startByEpoch.get(snapshot.epoch);
            if (start !== undefined) {
                ui.info('    Start', start);
            }
            const duration = durationByEpoch.get(snapshot.epoch);
            if (duration !== undefined) {
                ui.info('    Duration', duration);
            }
        });
    } catch (error) {
        ui.error(
            `getEpochsData failed for range ${epochRange.from}..${epochRange.to}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}

type RpcMetricsSnapshot = {
    totalRequests: number;
    totalRpcCalls: number;
    methodCounts: Map<string, number>;
};

type RpcMetrics = {
    enable: () => void;
    disable: () => void;
    reset: () => void;
    snapshot: () => RpcMetricsSnapshot;
};

function installRpcMetrics(urls: string[]): RpcMetrics {
    if (!globalThis.fetch) {
        throw new Error('global fetch is unavailable; cannot track RPC calls');
    }

    const urlSet = new Set(urls);
    const state = {
        enabled: false,
        totalRequests: 0,
        totalRpcCalls: 0,
        methodCounts: new Map<string, number>(),
    };

    const originalFetch = globalThis.fetch.bind(globalThis);

    globalThis.fetch = async (input: any, init?: any) => {
        const url =
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (state.enabled && isTrackedUrl(url, urlSet)) {
            state.totalRequests += 1;
            const body = init?.body;
            if (typeof body === 'string') {
                try {
                    const parsed = JSON.parse(body);
                    const batch = Array.isArray(parsed) ? parsed : [parsed];
                    state.totalRpcCalls += batch.length;
                    for (const entry of batch) {
                        const method = typeof entry?.method === 'string' ? entry.method : null;
                        if (!method) continue;
                        state.methodCounts.set(method, (state.methodCounts.get(method) ?? 0) + 1);
                    }
                } catch {
                    // ignore parse failures
                }
            }
        }
        return originalFetch(input, init);
    };

    return {
        enable: () => {
            state.enabled = true;
        },
        disable: () => {
            state.enabled = false;
        },
        reset: () => {
            state.totalRequests = 0;
            state.totalRpcCalls = 0;
            state.methodCounts.clear();
        },
        snapshot: () => ({
            totalRequests: state.totalRequests,
            totalRpcCalls: state.totalRpcCalls,
            methodCounts: new Map(state.methodCounts),
        }),
    };
}

function isTrackedUrl(url: string, urlSet: Set<string>): boolean {
    for (const tracked of urlSet) {
        if (url.startsWith(tracked)) return true;
    }
    return false;
}

function getMethodCount(snapshot: RpcMetricsSnapshot, method: string): number {
    return snapshot.methodCounts.get(method) ?? 0;
}

async function measureEpochRpcCalls(currentEpoch: number, windowSize: number) {
    const epochRange = buildRollingEpochRange(currentEpoch, windowSize);
    ui.section('RPC Call Metrics (Sequential vs Range)');
    const rangeSize = epochRange.to - epochRange.from + 1;
    const options = {
        finalized: true,
        includeNetworkData: false,
        includeSettlementStatus: false,
        includeCollateralMetadata: false,
        includeValSetEvent: false,
    } as const;

    const sequentialDeriver = await ValidatorSetDeriver.create({
        rpcUrls,
        driverAddress: {
            chainId: driverChainId,
            address: driverAddress,
        },
        cache: null,
    });

    rpcMetrics.reset();
    rpcMetrics.enable();
    try {
        for (let epoch = epochRange.from; epoch <= epochRange.to; epoch++) {
            await sequentialDeriver.getEpochData({ epoch, ...options });
        }
    } finally {
        rpcMetrics.disable();
    }
    const sequentialMetrics = rpcMetrics.snapshot();

    const rangeDeriver = await ValidatorSetDeriver.create({
        rpcUrls,
        driverAddress: {
            chainId: driverChainId,
            address: driverAddress,
        },
        cache: null,
    });

    rpcMetrics.reset();
    rpcMetrics.enable();
    try {
        await rangeDeriver.getEpochsData({ epochRange, ...options });
    } finally {
        rpcMetrics.disable();
    }
    const rangeMetrics = rpcMetrics.snapshot();

    const sequentialEthCalls = getMethodCount(sequentialMetrics, 'eth_call');
    const rangeEthCalls = getMethodCount(rangeMetrics, 'eth_call');
    const perEpochEthCalls = rangeSize > 0 ? rangeEthCalls / rangeSize : 0;
    const sequentialTotalCalls = sequentialMetrics.totalRpcCalls;
    const rangeTotalCalls = rangeMetrics.totalRpcCalls;
    const sequentialTotalRequests = sequentialMetrics.totalRequests;
    const rangeTotalRequests = rangeMetrics.totalRequests;

    ui.info('Sequential', `${epochRange.from}..${epochRange.to} (${rangeSize} epochs)`);
    ui.info('Range', `${epochRange.from}..${epochRange.to} (${rangeSize} epochs)`);
    ui.info('Sequential eth_call', sequentialEthCalls);
    ui.info('Range eth_call', rangeEthCalls);
    ui.info('Range eth_call/epoch', perEpochEthCalls.toFixed(2));
    ui.info('Sequential total RPC calls (sum)', sequentialTotalCalls);
    ui.info('Range total RPC calls (sum)', rangeTotalCalls);
    ui.info('Sequential total HTTP requests (sum)', sequentialTotalRequests);
    ui.info('Range total HTTP requests (sum)', rangeTotalRequests);
}

async function measureEventRangeRpcCalls(
    deriver: ValidatorSetDeriver,
    clientsByChainId: Map<number, PublicClient>,
    currentEpoch: number,
    rangeSizes: number[]
) {
    ui.section('RPC Call Metrics (Event Logs by Range Size)');
    const config = await deriver.getNetworkConfig(currentEpoch, true);
    if (config.settlements.length === 0) {
        ui.warn('No settlements configured; skipping event log metrics.');
        return;
    }

    for (const size of rangeSizes) {
        const rangeSize = Math.max(1, Math.floor(size));
        const fromEpoch = Math.max(0, currentEpoch - rangeSize + 1);
        const toEpoch = currentEpoch;

        const [startFrom, startTo] = await Promise.all([
            deriver.getEpochStart(fromEpoch, true),
            deriver.getEpochStart(toEpoch, true),
        ]);
        let duration = 0;
        try {
            duration = await deriver.getEpochDuration(toEpoch, true);
        } catch {
            duration = await deriver.getCurrentEpochDuration(true);
        }

        rpcMetrics.reset();
        rpcMetrics.enable();
        try {
            await Promise.all(
                config.settlements.map(settlement => {
                    const client = clientsByChainId.get(settlement.chainId);
                    if (!client) {
                        ui.warn(`No RPC client for chain ${settlement.chainId}; skipping.`);
                        return Promise.resolve(new Map());
                    }
                    return fetchSettlementEventsRange(
                        client,
                        settlement,
                        fromEpoch,
                        toEpoch,
                        startFrom,
                        startTo,
                        duration,
                        true
                    );
                })
            );
        } finally {
            rpcMetrics.disable();
        }

        const metrics = rpcMetrics.snapshot();
        ui.info('Epoch Range', `${fromEpoch}..${toEpoch} (${rangeSize} epochs)`);
        ui.info('Total RPC calls (sum)', metrics.totalRpcCalls);
        ui.info('Total HTTP requests (sum)', metrics.totalRequests);
        ui.info('eth_getLogs', getMethodCount(metrics, 'eth_getLogs'));
        ui.info('eth_getBlockByNumber', getMethodCount(metrics, 'eth_getBlockByNumber'));
    }
}

function buildRollingEpochRange(currentEpoch: number, windowSize: number): EpochRange {
    const size = Math.max(1, Math.floor(windowSize));
    const from = Math.max(0, currentEpoch - size + 1);
    return { from, to: currentEpoch };
}

/**
 * Helper function to get status emoji
 */
function getStatusEmoji(status: string): string {
    switch (status) {
        case 'committed':
            return '✅';
        case 'pending':
            return '⏳';
        case 'missing':
            return '⚠️';
        default:
            return '❓';
    }
}

function shortUrl(url: string, maxLength: number = 36): string {
    if (url.length <= maxLength) {
        return url;
    }
    const half = Math.floor((maxLength - 3) / 2);
    if (half <= 0) {
        return '...';
    }
    return `${url.slice(0, half)}...${url.slice(-half)}`;
}

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function formatValSetEventKind(kind: ValSetEventKindType): string {
    if (kind === ValSetEventKind.Genesis) return 'SetGenesis';
    if (kind === ValSetEventKind.Commit) return 'CommitValSetHeader';
    return String(kind);
}

// Run the example (ESM-friendly main check)
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch(console.error);
}

export { main };
