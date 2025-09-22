
  # Relay Stats Example
  
  This example demonstrates how to use the @symbioticfi/relay-stats-ts library
  
  ## Setup
  
  1. Install the library:
  ```bash
  npm install
  ```
  
  2. Update the RPC URLs and driver address in the example with your actual values.
  
  3. Run the example:
  ```bash
  npm start
  ```
  
  ## Key Concepts
  
  ### Epochs
  - Epoch 1: The first epoch after genesis
  - Current Epoch: The latest epoch on the network
  
  ### Settlement Status
  - **Committed**: All settlements are successfully committed on-chain
  - **Pending**: Some settlements are still pending (expected for current epoch)
  - **Missing**: Some settlements are missing - indicates an issue
  
  ### Integrity Status
  - **Valid**: All committed settlements have matching header hashes
  - **Invalid**: Header hashes don't match across settlements (critical issue)
  
  ### Validator States
  - **Active**: Meeting minimum voting power requirements and has registered keys
  - **Inactive**: Not meeting requirements or missing keys
  
  ## Output
  
  The example will show:
  1. Current network configuration
  2. Validator set details for epoch 1 and current epoch
  3. Comparison between epochs showing network evolution
  4. Global settlement status and integrity check
  5. Top validators by voting power
  
  ## Troubleshooting
  
  If you see errors:
  - Ensure RPC URLs are correct and accessible
  - Verify the driver contract address is correct
  - Check that all required chains are included in the RPC URLs
  - Ensure you have proper API keys for RPC providers
  