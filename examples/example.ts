// example/example.ts
import { ValidatorSetDeriver, AGGREGATOR_MODE } from '@symbioticfi/relay-stats-ts';
import type {
  ValidatorSet,
  NetworkData,
  AggregatorExtraDataEntry,
  NetworkConfig,
  ValSetLogicEvent,
  ValSetExtraData,
  ValSetEventKind,
  CrossChainAddress,
} from '@symbioticfi/relay-stats-ts';
import type { Address } from 'viem';
import { fileURLToPath } from 'url';

const DEFAULT_RPC_URLS = ['http://localhost:8545', 'http://localhost:8546'];
const DEFAULT_DRIVER_ADDRESS: Address = '0xE1A1629C2a0447eA1e787527329805B234ac605C';
const DEFAULT_DRIVER_CHAIN_ID = 31337;

const rpcUrls = parseRpcUrls(process.env.RELAY_STATS_RPC_URLS);
const driverChainId = parseChainId(process.env.RELAY_STATS_DRIVER_CHAIN_ID);
const driverAddress = parseDriverAddress(process.env.RELAY_STATS_DRIVER_ADDRESS);
  
  /**
   * Main example demonstrating validator set derivation
   */
  async function main() {
    console.log('🚀 Initializing relay-stats-ts deriver...')
    
    try {
      // Initialize the deriver without cache
      console.log(`RPC URLs: ${rpcUrls.map((url) => shortUrl(url)).join(', ')}`);
      console.log(`Driver Chain ID: ${driverChainId}`);
      console.log(`Driver Address: ${driverAddress}`);

      const deriver = await ValidatorSetDeriver.create({
          rpcUrls,
          driverAddress: {
            chainId: driverChainId,
            address: driverAddress,
          },
          cache: null,
        });

      console.log('✅ Deriver initialized successfully!\n');
  
      // Get the current epoch number
      let currentEpoch: number;
      try {
        currentEpoch = await deriver.getCurrentEpoch();
        console.log(`Current Epoch: ${currentEpoch}\n`);
      } catch {
        console.log('❌ Could not get current epoch from contract');
        console.log('   This indicates the contract does not have the getCurrentEpoch() method implemented');
        console.log('   or the contract is not properly deployed.\n');
        return;
      }
  
      // Get network configuration for current epoch
      console.log('=== Network Configuration (Current Epoch) ===');
      let networkConfig: NetworkConfig | null = null;
      try {
        networkConfig = await deriver.getCurrentNetworkConfig();
        console.log(`Voting Power Providers: ${networkConfig.votingPowerProviders.length}`);
        console.log(
          `Keys Provider: Chain ${networkConfig.keysProvider.chainId}, ${networkConfig.keysProvider.address}`,
        );
        console.log(`Settlements: ${networkConfig.settlements.length}`);
        console.log(`Max Voting Power: ${networkConfig.maxVotingPower.toString()}`);
        console.log(`Min Inclusion Voting Power: ${networkConfig.minInclusionVotingPower.toString()}`);
        console.log(`Max Validators Count: ${networkConfig.maxValidatorsCount.toString()}`);
        console.log(`Required Header Key Tag: ${networkConfig.requiredHeaderKeyTag}`);
        console.log(`Number of Committers: ${networkConfig.numCommitters}`);
        console.log(`Number of Aggregators: ${networkConfig.numAggregators}\n`);
      } catch {
        console.log('❌ Could not get network configuration from contract');
        console.log('   This indicates the contract does not have the getConfigAt() method implemented');
        console.log('   or the contract is not properly deployed.\n');
        return;
      }

      // Fetch additional network metadata (NETWORK/SUBNETWORK + EIP-712 domain)
      try {
        const networkData = await deriver.getNetworkData();
        displayNetworkData(networkData);
      } catch (error) {
        console.log('⚠️  Could not fetch network extra data');
        console.log(
          `   Reason: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }

      // Get validator set for epoch 1
      console.log('=== Validator Set for Epoch 1 ===');
      let epoch1Valset: ValidatorSet | null = null;
      try {
        epoch1Valset = await deriver.getValidatorSet(1);
        displayValidatorSet(epoch1Valset, 1);
      } catch {
        console.log('❌ Could not get validator set for epoch 1');
        console.log('   This indicates missing contract methods or insufficient data');
        epoch1Valset = null;
      }
  
      // Get validator set for current epoch
      console.log(`\n=== Validator Set for Current Epoch (${currentEpoch}) ===`);
      let currentValset: ValidatorSet | null = null;
      let currentValsetStatus: { status: 'committed' | 'pending' | 'missing'; integrity: 'valid' | 'invalid' } | null = null;
      try {
        currentValset = await deriver.getCurrentValidatorSet();
        displayValidatorSet(currentValset, currentEpoch);
      } catch {
        console.log('❌ Could not get validator set for current epoch');
        console.log('   This indicates missing contract methods or insufficient data');
        currentValset = null;
      }

      try {
        currentValsetStatus = await deriver.getValSetStatus(currentEpoch);
        console.log(
          `Validator Set Status (via getValSetStatus): ${getStatusEmoji(currentValsetStatus.status)} ${currentValsetStatus.status}, integrity ${currentValsetStatus.integrity}`,
        );
      } catch (error) {
        console.log('⚠️  Could not fetch validator set status');
        console.log(`   Reason: ${error instanceof Error ? error.message : String(error)}`);
        currentValsetStatus = null;
      }
  
      // Compare epochs
      if (epoch1Valset && currentValset) {
        console.log('\n=== Epoch Comparison ===');
        console.log(`Epoch 1 -> Current (${currentEpoch}):`);
        console.log(`  Active Validators: ${epoch1Valset.validators.filter(v => v.isActive).length} -> ${currentValset.validators.filter(v => v.isActive).length}`);
        console.log(`  Total Voting Power: ${epoch1Valset.totalVotingPower.toString()} -> ${currentValset.totalVotingPower.toString()}`);
        const epoch1QuorumPct = (epoch1Valset.quorumThreshold * 10000n) / epoch1Valset.totalVotingPower;
        const currentQuorumPct = (currentValset.quorumThreshold * 10000n) / currentValset.totalVotingPower;
        console.log(`  Quorum Threshold: ${epoch1Valset.quorumThreshold.toString()} (${epoch1QuorumPct.toString()}bp) -> ${currentValset.quorumThreshold.toString()} (${currentQuorumPct.toString()}bp)`);
      } else {
        console.log('\n=== Epoch Comparison ===');
        console.log('⚠️  Cannot compare epochs - validator sets not available');
      }

      // Get top 10 operators with all data
      if (currentValset) {
        console.log('\n=== Top 10 Operators (Current Epoch) ===');
        const topOperators = currentValset.validators
          .filter(v => v.isActive)
          .sort((a, b) => {
            const diff = b.votingPower - a.votingPower;
            return diff > 0n ? 1 : diff < 0n ? -1 : 0;
          })
          .slice(0, 10);

        topOperators.forEach((validator, index) => {
          console.log(`\n${index + 1}. Operator: ${validator.operator}`);
          console.log(`   Voting Power: ${validator.votingPower.toString()}`);
          console.log(`   Status: ${validator.isActive ? '✅ Active' : '❌ Inactive'}`);
          console.log(`   Vaults (${validator.vaults.length}):`);
          validator.vaults.forEach((vault, vaultIndex) => {
            console.log(`     ${vaultIndex + 1}. Chain ${vault.chainId}: ${vault.vault} (${vault.votingPower.toString()} VP)`);
          });
          console.log(`   Keys (${validator.keys.length}):`);
          validator.keys.forEach((key, keyIndex) => {
            console.log(`     ${keyIndex + 1}. Tag ${key.tag}: ${key.payload}`);
          });
        });
      } else {
        console.log('\n=== Top 10 Operators (Current Epoch) ===');
        console.log('⚠️  Cannot show operators - validator set not available');
      }

      if (currentValset) {
        console.log('\n=== Validator Set Header Utilities ===');
        const activeVotingPower = deriver.getTotalActiveVotingPower(currentValset);
        console.log(`Total Active Voting Power: ${activeVotingPower.toString()}`);

        const header = deriver.getValidatorSetHeader(currentValset);
        console.log('Validator Set Header:');
        console.log(`  Epoch: ${header.epoch}`);
        console.log(`  Capture Timestamp: ${header.captureTimestamp}`);
        console.log(`  Validators SSZ Root: ${header.validatorsSszMRoot}`);

        const encodedHeader = deriver.abiEncodeValidatorSetHeader(header);
        console.log(`ABI Encoded Header: ${encodedHeader}`);

        const headerHash = deriver.hashValidatorSetHeader(header);
        console.log(`Header Hash (from header): ${headerHash}`);

        const computedHashViaSet = deriver.getValidatorSetHeaderHash(currentValset);
        console.log(`Header Hash (from validator set): ${computedHashViaSet}`);
      }


      let epochIndexForCapture: number | null = null;
      console.log('\n=== Epoch Timeline ===');
      try {
        const currentEpochDurationVal = await deriver.getCurrentEpochDuration();
        const currentEpochStartVal = await deriver.getCurrentEpochStart();
        const nextEpochNumber = await deriver.getNextEpoch();
        const nextEpochStartVal = await deriver.getNextEpochStart();
        const nextEpochDurationVal = await deriver.getNextEpochDuration();
        const epochDurationForCurrent = await deriver.getEpochDuration(currentEpoch);
        const epochStartForCurrent = await deriver.getEpochStart(currentEpoch);

        console.log(`Current Epoch Start: ${currentEpochStartVal}`);
        console.log(`Current Epoch Duration: ${currentEpochDurationVal}`);
        console.log(`Next Epoch: ${nextEpochNumber}`);
        console.log(`Next Epoch Start: ${nextEpochStartVal}`);
        console.log(`Next Epoch Duration: ${nextEpochDurationVal}`);
        console.log(`Epoch Duration (index ${currentEpoch}): ${epochDurationForCurrent}`);
        console.log(`Epoch Start (index ${currentEpoch}): ${epochStartForCurrent}`);

        if (currentValset) {
          epochIndexForCapture = await deriver.getEpochIndex(currentValset.captureTimestamp);
          console.log(
            `Epoch index for capture timestamp ${currentValset.captureTimestamp}: ${epochIndexForCapture}`,
          );
        }
      } catch (error) {
        console.log('⚠️  Could not fetch epoch timeline info');
        console.log(`   Reason: ${error instanceof Error ? error.message : String(error)}`);
      }


      // Fetch aggregator extra data for relayer/aggregator flows
      console.log('\n=== Aggregator Extra Data ===');
      try {
        const simpleExtraData = await deriver.getAggregatorsExtraData(
          AGGREGATOR_MODE.SIMPLE,
          undefined,
          true,
          currentEpoch,
        );
        displayAggregatorExtraData('Simple', simpleExtraData);
      } catch (error) {
        console.log('⚠️  Simple mode unavailable');
        console.log(
          `   Reason: ${error instanceof Error ? error.message : String(error)}`,
        );
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
        console.log('⚠️  ZK mode unavailable');
        console.log(
          `   Reason: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      console.log('\n=== Settlement ValSet Events (Current Epoch) ===');
      if (networkConfig && networkConfig.settlements.length > 0) {
        if (currentValsetStatus && currentValsetStatus.status !== 'committed') {
          console.log(
            `Validator set is ${currentValsetStatus.status}; skipping settlement event retrieval until committed.`,
          );
        } else {
          for (const settlement of networkConfig.settlements) {
            console.log(
              `Using settlement on chain ${settlement.chainId}: ${settlement.address}`,
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
              console.log('⚠️  Epoch index for capture timestamp unavailable; skipping timestamp lookup.');
            }
          }
        }
      } else {
        console.log('⚠️  No settlement configured; cannot demonstrate settlement events.');
      }


        } catch (error) {
      console.error('❌ Failed to initialize deriver:', error instanceof Error ? error.message : String(error));
      console.log('\n💡 This indicates:');
      console.log('   1. RPC endpoints are not accessible');
      console.log('   2. Driver contract address is incorrect');
      console.log('   3. Contract is not deployed or not responding');
      console.log('\nPlease check your RPC URLs and contract addresses.');
      return;
    }
  }

  function displayNetworkData(networkData: NetworkData) {
    console.log('\n=== Network Extra Data ===');
    console.log(`Network Address: ${networkData.address}`);
    console.log(`Subnetwork ID: ${networkData.subnetwork}`);
    console.log('EIP-712 Domain:');
    console.log(`  Name: ${networkData.eip712Data.name}`);
    console.log(`  Version: ${networkData.eip712Data.version}`);
    console.log(`  Chain ID: ${networkData.eip712Data.chainId.toString()}`);
    console.log(`  Verifying Contract: ${networkData.eip712Data.verifyingContract}`);
    console.log(`  Salt: ${networkData.eip712Data.salt}`);
    if (networkData.eip712Data.extensions.length > 0) {
      console.log('  Extensions:');
      networkData.eip712Data.extensions.forEach((ext, index) => {
        console.log(`    ${index + 1}. ${ext.toString()}`);
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
      
      console.log(`Version: ${valset.version}`);
      console.log(`Capture Timestamp: ${valset.captureTimestamp}`);
      console.log(`Total Validators: ${totalValidators}`);
      console.log(`Active Validators: ${activeValidators.length}`);
      console.log(`Total Voting Power: ${valset.totalVotingPower.toString()}`);
      // Calculate percentage for display (threshold is in absolute units)
      console.log(`Quorum Threshold: ${valset.quorumThreshold.toString()}`);
      console.log(`Required Key Tag: ${valset.requiredKeyTag}`);
      console.log(`Validator Set Status: ${getStatusEmoji(valset.status)} ${valset.status}`);
      console.log(
        `Validator Set Integrity: ${valset.integrity === 'valid' ? '✅' : '❌'} ${valset.integrity}`,
      );

      if (valset.status === 'committed' && valset.integrity === 'valid') {
        console.log('  ✅ Validator set is committed and integrity verified.');
      } else {
        if (valset.status === 'pending') {
          console.log('  ⏳ Validator set is pending on-chain updates.');
        } else if (valset.status === 'missing') {
          console.log('  ⚠️ Validator set data is missing - investigate driver and settlements.');
        }
        if (valset.integrity === 'invalid') {
          console.log('  ❌ Integrity check failed - header hashes do not match.');
        }
      }
      
      // Show voting power distribution
      if (activeValidators.length > 0) {
        const avgVotingPower = valset.totalVotingPower / BigInt(activeValidators.length);
        const maxVotingPower = activeValidators[0].votingPower;
        const minVotingPower = activeValidators[activeValidators.length - 1].votingPower;
        
        console.log(`Voting Power Distribution:`);
        console.log(`  Max: ${maxVotingPower.toString()}`);
        console.log(`  Avg: ${avgVotingPower.toString()}`);
        console.log(`  Min: ${minVotingPower.toString()}`);
      }
        } catch (error) {
      console.log(`⚠️  Error displaying validator set for epoch ${epoch}:`, error instanceof Error ? error.message : String(error));
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
        console.log(
          `  ⚠️  Finalized lookup failed (${result.reason}). Fallback to latest succeeded.`,
        );
      }
      displayValSetLogicEvent(label, result.event, settlement);
    } else {
      console.log(`⚠️  Failed to get event for ${contextLabel}`);
      if (result.reason) {
        console.log(`   Reason: ${result.reason}`);
      }
    }
  }

  async function fetchValSetEvent(
    deriver: ValidatorSetDeriver,
    settlement: CrossChainAddress,
    epoch: number,
  ): Promise<{
    event: ValSetLogicEvent | null;
    origin: 'finalized' | 'latest' | null;
    reason?: string;
  }> {
    try {
      const event = await deriver.getValSetLogicEvent({
        epoch,
        settlement,
        finalized: true,
      });
      return { event, origin: 'finalized' };
    } catch (finalizedError) {
      const finalizedReason = formatError(finalizedError);
      try {
        const event = await deriver.getValSetLogicEvent({
          epoch,
          settlement,
          finalized: false,
        });
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
      console.log(`- ${modeLabel}: no entries returned`);
      return;
    }
    console.log(`- ${modeLabel}:`);
    entries.forEach((entry, index) => {
      console.log(`    ${index + 1}. key=${entry.key} value=${entry.value}`);
    });
  }

  function displayValSetLogicEvent(
    label: string,
    event: ValSetLogicEvent,
    settlement: CrossChainAddress,
  ) {
    console.log(`- ${label}`);
    console.log(`  Settlement: chain ${settlement.chainId} at ${settlement.address}`);
    console.log(`  Event Kind: ${formatValSetEventKind(event.kind)}`);
    console.log(`  Epoch: ${event.header.epoch}`);
    console.log(`  Capture Timestamp: ${event.header.captureTimestamp}`);
    console.log(`  Total Voting Power: ${event.header.totalVotingPower.toString()}`);
    console.log(`  Validators SSZ Root: ${event.header.validatorsSszMRoot}`);
    if (event.blockNumber !== null) {
      console.log(`  Block Number: ${event.blockNumber.toString()}`);
    }
    if (event.blockHash) {
      console.log(`  Block Hash: ${event.blockHash}`);
    }
    if (event.transactionHash) {
      console.log(`  Tx Hash: ${event.transactionHash}`);
    }
    displayValSetExtraData(event.extraData);
  }

  function displayValSetExtraData(entries: ValSetExtraData[]) {
    if (!entries || entries.length === 0) {
      console.log('  Extra Data: none');
      return;
    }
    console.log('  Extra Data Entries:');
    entries.forEach((entry, index) => {
      console.log(`    ${index + 1}. key=${entry.key} value=${entry.value}`);
    });
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
