import {
    ValidatorSetDeriver,
    getActiveCommitter,
    type ValidatorSet,
    type EpochData,
    type NetworkConfig,
} from '@symbioticfi/relay-stats-ts';
import { fileURLToPath } from 'url';
import { ui, parseRpcUrls, parseChainId, parseDriverAddress, formatError } from './utils.js';

const rpcUrls = parseRpcUrls(process.env.RELAY_STATS_RPC_URLS);
const driverChainId = parseChainId(process.env.RELAY_STATS_DRIVER_CHAIN_ID);
const driverAddress = parseDriverAddress(process.env.RELAY_STATS_DRIVER_ADDRESS);

async function main() {
    ui.heading('Initializing relay-stats-ts deriver...');
    ui.info('Driver', `chain ${driverChainId} / ${driverAddress}`);
    ui.info('RPCs', rpcUrls.join(', '));

    const deriver = await ValidatorSetDeriver.create({
        rpcUrls,
        driverAddress: { chainId: driverChainId, address: driverAddress },
        cache: null,
    });

    const currentEpoch = await deriver.getCurrentEpoch();
    ui.info('Current Epoch', currentEpoch);

    const config = await deriver.getCurrentNetworkConfig();
    displayConfig(config);

    const snapshot = await deriver.getEpochData({
        epoch: currentEpoch,
        finalized: true,
        includeNetworkData: true,
        includeValSetEvent: true,
    });
    displayEpochSnapshot(snapshot);

    const from = Math.max(1, currentEpoch - 2);
    const snapshots = await deriver.getEpochsData({
        epochRange: { from, to: currentEpoch },
        finalized: true,
    });

    ui.section(`Epochs ${from}..${currentEpoch}`);
    for (const s of snapshots) {
        ui.bullet(
            `Epoch ${s.epoch}: ${s.validatorSet.validators.length} validators, ` +
                `VP ${s.validatorSet.totalVotingPower}, status ${s.validatorSet.status}`
        );
    }
}

function displayConfig(config: NetworkConfig) {
    ui.section('Network Config');
    ui.info('Voting Power Providers', config.votingPowerProviders.length);
    ui.info(
        'Keys Provider',
        `chain ${config.keysProvider.chainId} / ${config.keysProvider.address}`
    );
    ui.info('Settlements', config.settlements.length);
    ui.info('Max Validators', config.maxValidatorsCount.toString());
    ui.info('Max Voting Power', config.maxVotingPower.toString());
    ui.info('Min Inclusion VP', config.minInclusionVotingPower.toString());
    ui.info('Aggregators', config.numAggregators);
    ui.info('Committers', config.numCommitters);
    ui.info('Committer Slot Duration', `${config.committerSlotDuration}s`);
}

function displayEpochSnapshot(snapshot: EpochData) {
    const { validatorSet, validatorRoles, config } = snapshot;

    ui.section(`Epoch ${snapshot.epoch} Validator Set`);
    ui.info('Validators', validatorSet.validators.length);
    ui.info('Total Voting Power', validatorSet.totalVotingPower.toString());
    ui.info('Quorum Threshold', validatorSet.quorumThreshold.toString());
    ui.info('Status', validatorSet.status);
    ui.info('Integrity', validatorSet.integrity);

    const top = [...validatorSet.validators]
        .sort((a, b) =>
            b.votingPower > a.votingPower ? 1 : b.votingPower < a.votingPower ? -1 : 0
        )
        .slice(0, 5);
    ui.section('Top Operators');
    top.forEach((v, i) => {
        ui.numbered(
            i + 1,
            `${v.operator} — ${v.votingPower} VP, ${v.vaults.length} vaults, ${v.keys.length} keys`
        );
    });

    ui.section('Scheduler');
    displayRoleAssignments('Aggregators', validatorRoles.aggregatorIndices, validatorSet);
    displayRoleAssignments('Committers', validatorRoles.committerIndices, validatorSet);

    const now = Math.floor(Date.now() / 1000);
    const active = getActiveCommitter({
        committerIndices: validatorRoles.committerIndices,
        captureTimestamp: validatorSet.captureTimestamp,
        currentTime: now,
        committerSlotDuration: config.committerSlotDuration,
    });
    if (active) {
        const v = validatorSet.validators[active.validatorIndex];
        ui.info('Active Committer', `${v.operator} (slot ${active.slotStart}-${active.slotEnd})`);
    } else {
        ui.warn('No active committer at current time');
    }

    if (snapshot.settlementStatuses && snapshot.settlementStatuses.length > 0) {
        ui.section('Settlement Status');
        for (const s of snapshot.settlementStatuses) {
            ui.bullet(
                `chain ${s.settlement.chainId} / ${s.settlement.address}: ` +
                    `committed=${s.committed}, lastEpoch=${s.lastCommittedEpoch}`
            );
        }
    }

    if (snapshot.networkData) {
        ui.section('Network Data');
        ui.info('Address', snapshot.networkData.address);
        ui.info('Subnetwork', snapshot.networkData.subnetwork);
        ui.info(
            'EIP-712',
            `${snapshot.networkData.eip712Data.name} v${snapshot.networkData.eip712Data.version}`
        );
    }
}

function displayRoleAssignments(label: string, indices: number[], valset: ValidatorSet) {
    const names = indices.map(i => `${valset.validators[i].operator} [${i}]`);
    ui.info(label, names.join(', ') || 'none');
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
    main().catch(error => {
        ui.error(formatError(error));
        process.exit(1);
    });
}

export { main };
