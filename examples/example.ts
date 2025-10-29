// example/example.ts
import { ValidatorSetDeriver, AGGREGATOR_MODE } from '@symbioticfi/relay-stats-ts';
import type {
  ValidatorSet,
  NetworkData,
  AggregatorExtraDataEntry,
  NetworkConfig,
  ValSetLogEvent,
  ValSetExtraData,
  ValSetEventKind,
  CrossChainAddress,
} from '@symbioticfi/relay-stats-ts';
import type { Address, Hex } from 'viem';
import { fileURLToPath } from 'url';

const DEFAULT_RPC_URLS = ['http://localhost:8545', 'http://localhost:8546'];
const DEFAULT_DRIVER_ADDRESS: Address = '0xE1A1629C2a0447eA1e787527329805B234ac605C';
const DEFAULT_DRIVER_CHAIN_ID = 31337;

const rpcUrls = parseRpcUrls(process.env.RELAY_STATS_RPC_URLS);
const driverChainId = parseChainId(process.env.RELAY_STATS_DRIVER_CHAIN_ID);
const driverAddress = parseDriverAddress(process.env.RELAY_STATS_DRIVER_ADDRESS);

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
  heading: (text: string) =>
    console.log(`${COLORS.bold}${COLORS.cyan}${text}${COLORS.reset}`),
  section: (title: string) =>
    console.log(`\n${COLORS.bold}${COLORS.magenta}=== ${title} ===${COLORS.reset}`),
  info: (label: string, value: unknown) =>
    console.log(`${COLORS.bold}${label}:${COLORS.reset} ${value}`),
  success: (message: string) =>
    console.log(`${COLORS.green}✔ ${message}${COLORS.reset}`),
  warn: (message: string) =>
    console.log(`${COLORS.yellow}⚠ ${message}${COLORS.reset}`),
  error: (message: string) =>
    console.log(`${COLORS.red}✘ ${message}${COLORS.reset}`),
  bullet: (text: string) =>
    console.log(`  ${COLORS.gray}•${COLORS.reset} ${text}`),
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
      ui.info('RPC URLs', rpcUrls.map((url) => shortUrl(url)).join(', '));
      ui.info('Driver Chain ID', driverChainId);
      ui.info('Driver Address', driverAddress);

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

      // Get network configuration for current epoch
      ui.section('Network Configuration (Current Epoch)');
      let networkConfig: NetworkConfig | null = null;
      try {
        networkConfig = await deriver.getCurrentNetworkConfig();
        ui.info('Voting Power Providers', networkConfig.votingPowerProviders.length);
        ui.info(
          'Keys Provider',
          `Chain ${networkConfig.keysProvider.chainId} · ${networkConfig.keysProvider.address}`,
        );
        ui.info('Settlements', networkConfig.settlements.length);
        networkConfig.settlements.forEach((settlement, index) => {
          ui.numbered(
            index + 1,
            `Chain ${settlement.chainId} · ${settlement.address}`,
          );
        });
        ui.info('Max Voting Power', networkConfig.maxVotingPower.toString());
        ui.info(
          'Min Inclusion Voting Power',
          networkConfig.minInclusionVotingPower.toString(),
        );
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
      let currentValsetStatus: { status: 'committed' | 'pending' | 'missing'; integrity: 'valid' | 'invalid' } | null = null;
      try {
        currentValset = await deriver.getCurrentValidatorSet();
        displayValidatorSet(currentValset, currentEpoch);
      } catch {
        ui.error('Could not get validator set for current epoch');
        ui.bullet('This may indicate missing contract methods or insufficient data.');
        currentValset = null;
      }

      try {
        currentValsetStatus = await deriver.getValSetStatus(currentEpoch);
        ui.info(
          'Validator Set Status',
          `${getStatusEmoji(currentValsetStatus.status)} ${currentValsetStatus.status} · integrity ${currentValsetStatus.integrity}`,
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
          `${epoch1Valset.validators.filter((v) => v.isActive).length} → ${currentValset.validators.filter((v) => v.isActive).length}`,
        );
        ui.info(
          'Total Voting Power',
          `${epoch1Valset.totalVotingPower.toString()} → ${currentValset.totalVotingPower.toString()}`,
        );
        const epoch1QuorumPct = (epoch1Valset.quorumThreshold * 10000n) / epoch1Valset.totalVotingPower;
        const currentQuorumPct = (currentValset.quorumThreshold * 10000n) / currentValset.totalVotingPower;
        ui.info(
          'Quorum Threshold',
          `${epoch1Valset.quorumThreshold.toString()} (${epoch1QuorumPct.toString()}bp) → ${currentValset.quorumThreshold.toString()} (${currentQuorumPct.toString()}bp)`,
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
          ui.info('    Status', validator.isActive ? `${COLORS.green}Active${COLORS.reset}` : `${COLORS.red}Inactive${COLORS.reset}`);
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
              collateralParts.length > 0 ? ` – collateral ${collateralParts.join(', ')}` : '';
            ui.numbered(
              vaultIndex + 1,
              `Chain ${vault.chainId} · ${vault.vault} (${vault.votingPower.toString()} VP)${collateralInfo}`,
            );
          });
          ui.info('    Keys', validator.keys.length);
          validator.keys.forEach((key) => {
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
            `${currentValset.captureTimestamp} → epoch ${epochIndexForCapture}`,
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
          currentEpoch,
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
          currentEpoch,
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
            `Validator set is ${currentValsetStatus.status}; skipping settlement event retrieval until committed.`,
          );
        } else {
          for (const settlement of networkConfig.settlements) {
            ui.info(
              'Settlement',
              `Chain ${settlement.chainId} · ${settlement.address}`,
            );
            await tryDisplayValSetEvent(
              deriver,
              settlement,
              currentEpoch,
              'By epoch lookup',
              `epoch ${currentEpoch}`,
            );

            if (epochIndexForCapture !== null) {
              await tryDisplayValSetEvent(
                deriver,
                settlement,
                epochIndexForCapture,
                'By capture timestamp lookup',
                currentValset
                  ? `timestamp ${currentValset.captureTimestamp} (epoch ${epochIndexForCapture})`
                  : `epoch ${epochIndexForCapture}`,
              );
            } else if (currentValset) {
              ui.warn('Epoch index for capture timestamp unavailable; skipping timestamp lookup.');
            }
          }
        }
      } else {
        ui.warn('No settlement configured; cannot demonstrate settlement events.');
      }

      await displayEpochSnapshot(deriver, currentEpoch);

    } catch (error) {
      ui.error(`Failed to initialize deriver: ${error instanceof Error ? error.message : String(error)}`);
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
        const urls = parsed.map((value) => String(value).trim()).filter(Boolean);
        if (urls.length > 0) {
          return urls;
        }
      }
    } catch {
      // fall through to delimiter-based parsing
    }

    const split = raw
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    return split.length > 0 ? split : DEFAULT_RPC_URLS;
  }

  function parseChainId(raw: string | undefined): number {
    if (!raw) {
      return DEFAULT_DRIVER_CHAIN_ID;
    }
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      console.warn(
        `Invalid RELAY_STATS_DRIVER_CHAIN_ID="${raw}". Falling back to ${DEFAULT_DRIVER_CHAIN_ID}.`,
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
      console.warn(
        `Invalid RELAY_STATS_DRIVER_ADDRESS="${trimmed}". Falling back to ${DEFAULT_DRIVER_ADDRESS}.`,
      );
      return DEFAULT_DRIVER_ADDRESS;
    }
    return trimmed as Address;
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
      ui.info(
        'Integrity',
        `${valset.integrity === 'valid' ? '✅' : '❌'} ${valset.integrity}`,
      );

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
        `Error displaying validator set for epoch ${epoch}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function tryDisplayValSetEvent(
    deriver: ValidatorSetDeriver,
    settlement: CrossChainAddress,
    epoch: number,
    label: string,
    contextLabel: string,
  ) {
    const result = await fetchValSetEvent(deriver, settlement, epoch);
    if (result.event) {
      if (result.origin === 'latest' && result.reason) {
        ui.warn(`Finalized lookup failed (${result.reason}). Fallback to latest succeeded.`);
      }
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
    epoch: number,
  ): Promise<{
    event: ValSetLogEvent | null;
    origin: 'finalized' | 'latest' | null;
    reason?: string;
  }> {
    try {
      const events = await deriver.getValSetLogEvents({
        epoch,
        settlements: [settlement],
        finalized: true,
      });
      const event = events[0]?.event ?? null;
      return { event, origin: 'finalized' };
    } catch (finalizedError) {
      const finalizedReason = formatError(finalizedError);
      try {
        const events = await deriver.getValSetLogEvents({
          epoch,
          settlements: [settlement],
          finalized: false,
        });
        const event = events[0]?.event ?? null;
        return { event, origin: 'latest', reason: finalizedReason };
      } catch (latestError) {
        const latestReason = formatError(latestError);
        return {
          event: null,
          origin: null,
          reason: `Finalized failed: ${finalizedReason}; Latest failed: ${latestReason}`,
        };
      }
    }
  }

  function displayAggregatorExtraData(
    modeLabel: string,
    entries: AggregatorExtraDataEntry[],
  ) {
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
    settlement: CrossChainAddress,
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
            `signer key=${signer.key} votingPower=${signer.votingPower.toString()}`,
          );
        });
        if (event.quorumProof.signers.length > signerPreview.length) {
          ui.bullet(
            `... ${event.quorumProof.signers.length - signerPreview.length} additional signers omitted`,
          );
        }
        if (event.quorumProof.nonSignerIndices.length > 0) {
          const indicesPreview = event.quorumProof.nonSignerIndices.slice(0, 6);
          ui.info(
            '    Non-Signer Indices',
            `${indicesPreview.join(', ')}${
              event.quorumProof.nonSignerIndices.length > indicesPreview.length ? ', ...' : ''
            }`,
          );
        } else {
          ui.info('    Non-Signer Indices', 'none');
        }
      } else {
        ui.info('    ZK Proof Elements', event.quorumProof.proof.length);
        ui.info('    Commitments', event.quorumProof.commitments.join(', '));
        ui.info('    Commitment PoK', event.quorumProof.commitmentPok.join(', '));
        ui.info(
          '    Signers Voting Power',
          event.quorumProof.signersVotingPower.toString(),
        );
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
    finalized: boolean = true,
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
            `Chain ${detail.settlement.chainId} · ${detail.settlement.address}`,
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
            `Chain ${entry.settlement.chainId} · ${entry.settlement.address}`,
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
        `getEpochData failed for epoch ${epoch}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Helper function to get status emoji
   */
  function getStatusEmoji(status: string): string {
    switch (status) {
      case 'committed': return '✅';
      case 'pending': return '⏳';
      case 'missing': return '⚠️';
      default: return '❓';
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

  function formatValSetEventKind(kind: ValSetEventKind): string {
    switch (kind) {
      case 'genesis':
        return 'SetGenesis';
      case 'commit':
        return 'CommitValSetHeader';
      default:
        return kind;
    }
  }

  // Run the example (ESM-friendly main check)
  const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  if (isMainModule) {
    main().catch(console.error);
  }
  
  export { main };
