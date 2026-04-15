# Relay Stats Example

Minimal example showing how to use `@symbioticfi/relay-stats-ts` — initialize the deriver, fetch epoch data with scheduler info, and display key metrics.

## Setup

```bash
# 1. Build the library (from repo root)
pnpm install && pnpm run build

# 2. Install example dependencies
cd examples && pnpm install
```

## Configuration

Via environment variables (all optional — defaults point to a local devnet):

```bash
export RELAY_STATS_RPC_URLS='["http://localhost:8545","http://localhost:8546"]'
export RELAY_STATS_DRIVER_CHAIN_ID=31337
export RELAY_STATS_DRIVER_ADDRESS=0xE1A1629C2a0447eA1e787527329805B234ac605C
```

`RELAY_STATS_RPC_URLS` accepts comma-, newline-, or JSON array-separated values.

## Run

```bash
pnpm start
```

Or compile and run:

```bash
pnpm run build && node dist/example.js
```

## What it shows

1. Network configuration (providers, settlements, scheduler params)
2. Current epoch validator set (validators, voting power, quorum, status)
3. Top operators by voting power
4. Scheduler: aggregator/committer assignments and active committer
5. Settlement status and network metadata
6. Epoch range summary

## Files

| File | Purpose |
|------|---------|
| `example.ts` | Main example — deriver init, epoch snapshot, scheduler |
| `utils.ts` | Shared helpers: env parsing, console UI |

## FAQ

**How do I start the local devnet?**
Follow the quick-start in [`symbiotic-super-sum`](https://github.com/symbioticfi/symbiotic-super-sum). Once RPCs are up on ports 8545/8546, the defaults work out of the box.

**Do I need to rebuild the library every time?**
Only when you change code in the root `src/`. The example consumes the prebuilt `dist/` folder.

**Can I use hosted RPC providers?**
Yes — set `RELAY_STATS_RPC_URLS` to your Alchemy/Infura/etc endpoints. Ensure the driver chain is included.
