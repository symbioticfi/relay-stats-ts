# Relay Stats Example

This example shows how to derive validator-set statistics with the `@symbioticfi/relay-stats-ts` library. It consumes the local workspace build (via `file:..`), so a small amount of setup is required before running it.

## Prerequisites

- Node.js 18 or 20 LTS (Node 21+ works when using the compiled output route described below)
- Access to Symbiotic driver contracts and matching RPC endpoints
- (Optional) A running [`symbiotic-super-sum`](https://github.com/symbioticfi/symbiotic-super-sum) devnet, which exposes RPCs on `http://localhost:8545` and `http://localhost:8546`

## Step 1 – Build the library once

Run these commands from the repository root:

```bash
pnpm install
pnpm run build
```

The example depends on the build artifacts in `dist/`, so repeat this step whenever you change the root library code.

## Step 2 – Install example dependencies

Now move into the example workspace:

```bash
cd examples
pnpm install
```

This installs the example's local dependencies, including the freshly built package from the parent directory.

## Step 3 – Point the example at your environment

Edit `examples/example.ts` and replace the placeholders with values that match your setup:

- Update `rpcUrls` with the JSON-RPC endpoints that expose the driver and settlement chains
- Set `driverAddress.chainId` to the network ID that hosts the driver contract
- Replace `driverAddress.address` with the actual deployed driver contract address

If your RPC provider requires API keys, inject them via environment variables (e.g., `process.env.MAINNET_RPC`) instead of committing secrets.

Prefer not to edit the file? Export the environment variables instead:

```bash
export RELAY_STATS_RPC_URLS='["http://localhost:8545","http://localhost:8546"]'
export RELAY_STATS_DRIVER_CHAIN_ID=31337
export RELAY_STATS_DRIVER_ADDRESS=0xE1A1629C2a0447eA1e787527329805B234ac605C
```

`RELAY_STATS_RPC_URLS` accepts comma-, newline-, or JSON array-separated values. Leaving the variables unset falls back to the same local devnet defaults shown above.

You can also control which epochs are displayed:

```bash
# Option A: explicit range
export RELAY_STATS_EPOCH_RANGE=5..8

# Option B: explicit from/to
export RELAY_STATS_EPOCH_FROM=5
export RELAY_STATS_EPOCH_TO=8
```

If none are provided, the example uses the current epoch only.

## Step 4 – Run the script

Choose one of the following approaches:

- **Direct TypeScript execution (recommended on Node 18/20):**

    ```bash
    pnpm start
    ```

    This uses `ts-node`'s ESM loader to run `example.ts` without a build step.

- **Compiled output (works on any recent Node version, including 21+):**
    ```bash
    pnpm run build
    node dist/example.js
    ```
    This path avoids loader warnings and matches what will be published to npm.

### What to expect

On a healthy setup you will see logs for:

1. Current network configuration and driver parameters
2. Network extra data (NETWORK/SUBNETWORK and settlement EIP-712 domain)
3. Historical validator set (epoch 1)
4. Current validator set, including voting power stats
5. Validator set status and integrity indicators
6. Top operators by voting power with their vaults and keys
7. Aggregator extra data entries for both simple and zk modes

If the RPC endpoints are unreachable or misconfigured you will see an `HTTP request failed` message. Double-check that the RPC URLs are correct, the driver contract exists at the specified address, and the devnet (if used) is fully booted.

The example always queries finalized data (`finalized: true`). If an epoch is still pending, the validator-set event section will report that no committed event is available yet. To read latest data instead, update the example code to pass `finalized: false` explicitly where needed.

## Additional scripts

- `examples/check-epoch-range.mjs` validates event log ranges for a single epoch. See `examples/README-range.md` for usage.

## FAQ

**How do I start the local devnet referenced in the defaults?**  
Clone and follow the quick-start instructions in [`symbiotic-super-sum`](https://github.com/symbioticfi/symbiotic-super-sum). Once its services expose RPCs on ports 8545 and 8546, the bundled configuration will work out of the box.

**Do I need to rebuild the library every time?**  
Only when you change code in the repository root. The example consumes the prebuilt `dist/` folder; if nothing changed, you can skip the root build step.

**Can I run this against hosted RPC providers?**  
Yes. Replace the `rpcUrls` with your provider endpoints (Alchemy, Infura, custom infrastructure, etc.). Ensure the driver chain is included and that any required headers or API keys are supplied.

**Why do I still see connection errors after updating URLs?**  
The most common causes are: the driver contract is not deployed at the address you provided, the RPC is behind authentication, or the chain ID does not match the driver deployment. Confirm each detail and retry.

**What Node.js version should I use?**  
Node 18 or 20 LTS are the most battle-tested with `ts-node`. If you are on Node 21 or newer, prefer the compiled `node dist/example.js` workflow to avoid loader deprecation warnings.
