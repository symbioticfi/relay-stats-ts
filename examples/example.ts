// example/example.ts
import { 
    ValidatorSetDeriver,
    ValidatorSet
  } from '@symbioticfi/relay-stats-ts';
  
  /**
   * Main example demonstrating validator set derivation
   */
  async function main() {
    console.log('🚀 Initializing relay-stats-ts deriver...')
    
    try {
      // Initialize the deriver without cache
      const deriver = await ValidatorSetDeriver.create({
          rpcUrls: [
            'http://localhost:8545', // got from symbiotic-super-sum
            'http://localhost:8546',
          ],
          driverAddress: {
            chainId: 31337,
            address: '0xE1A1629C2a0447eA1e787527329805B234ac605C',
          },
          cache: null,
        });

      console.log('✅ Deriver initialized successfully!\n');
  
      // Get the current epoch number
      let currentEpoch;
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
      let config;
      try {
        config = await deriver.getCurrentNetworkConfig();
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
  
      // Get validator set for epoch 1
      console.log('=== Validator Set for Epoch 1 ===');
      let epoch1Valset;
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
      let currentValset;
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
  
      // Display settlement status from validator set
      if (currentValset) {
        console.log('\n=== Settlement Status (Current Epoch) ===');
        console.log(`Settlement Status: ${getStatusEmoji(currentValset.settlementStatus)} ${currentValset.settlementStatus}`);
        console.log(`Integrity Status: ${currentValset.integrityStatus === 'valid' ? '✅' : '❌'} ${currentValset.integrityStatus}`);
        
        if (currentValset.settlementStatus === 'committed' && currentValset.integrityStatus === 'valid') {
          console.log('✅ All settlements are committed and in sync');
        } else {
          if (currentValset.settlementStatus === 'pending') {
            console.log('⏳ Some settlements are still pending (expected for current epoch)');
          } else if (currentValset.settlementStatus === 'missing') {
            console.log('⚠️  Some settlements are missing - this indicates an issue');
          }
          if (currentValset.integrityStatus === 'invalid') {
            console.log('❌ Settlement integrity check failed - hashes do not match!');
          }
        }
      } else {
        console.log('\n=== Settlement Status (Current Epoch) ===');
        console.log('⚠️  Cannot check settlement status - validator set not available');
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
            console.log(`     ${keyIndex + 1}. Tag ${key.tag}: ${key.payload.slice(0, 10)}...`);
          });
        });
      } else {
        console.log('\n=== Top 10 Operators (Current Epoch) ===');
        console.log('⚠️  Cannot show operators - validator set not available');
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
  
  // Run the example
  if (require.main === module) {
    main().catch(console.error);
  }
  
  export { main };