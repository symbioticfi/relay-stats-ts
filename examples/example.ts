// example/example.ts
import { ValidatorSetDeriver, AGGREGATOR_MODE } from '@symbioticfi/relay-stats-ts';
import type { ValidatorSet, NetworkData, AggregatorExtraDataEntry } from '@symbioticfi/relay-stats-ts';
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
      try {
        const config = await deriver.getCurrentNetworkConfig();
        console.log(`Voting Power Providers: ${config.votingPowerProviders.length}`);
        console.log(`Keys Provider: Chain ${config.keysProvider.chainId}, ${config.keysProvider.address}`);
        console.log(`Settlements: ${config.settlements.length}`);
        console.log(`Max Voting Power: ${config.maxVotingPower.toString()}`);
        console.log(`Min Inclusion Voting Power: ${config.minInclusionVotingPower.toString()}`);
        console.log(`Max Validators Count: ${config.maxValidatorsCount.toString()}`);
        console.log(`Required Header Key Tag: ${config.requiredHeaderKeyTag}`);
        console.log(`Number of Committers: ${config.numCommitters}`);
        console.log(`Number of Aggregators: ${config.numAggregators}\n`);
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
      try {
        currentValset = await deriver.getCurrentValidatorSet();
        displayValidatorSet(currentValset, currentEpoch);
      } catch {
        console.log('❌ Could not get validator set for current epoch');
        console.log('   This indicates missing contract methods or insufficient data');
        currentValset = null;
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

  // Run the example (ESM-friendly main check)
  const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  if (isMainModule) {
    main().catch(console.error);
  }
  
  export { main };
