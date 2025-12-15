# @symbioticfi/relay-stats-ts

[![npm version](https://badge.fury.io/js/%40symbioticfi%2Frelay-stats-ts.svg)](https://badge.fury.io/js/%40symbioticfi%2Frelay-stats-ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/@symbioticfi/relay-stats-ts)](https://nodejs.org/)

TypeScript utilities for deriving Symbiotic validator-set data from on-chain contracts. The library mirrors the Go reference implementation and exposes helpers for SSZ encoding, MiMC hashing, and aggregator extra data generation.

## Installation

### Local installation

```bash
git clone https://github.com/symbioticfi/relay-stats-ts.git
cd relay-stats-ts
pnpm install            # install dependencies
pnpm run build          # compile TypeScript to dist/
```

You can now import from the `src/` or freshly built `dist/` folders locally, or run the example script (see [`examples/README.md`](examples/README.md)).

### From npm

```bash
pnpm add @symbioticfi/relay-stats-ts
```

Requires Node.js 18 or newer.

## Quick Start

Create a deriver that talks to the ValSet driver and fetch the current validator set:

```ts
import { ValidatorSetDeriver } from '@symbioticfi/relay-stats-ts';

const deriver = await ValidatorSetDeriver.create({
  rpcUrls: ['https://ethereum.publicnode.com'],
  driverAddress: {
    chainId: 1,
    address: '0xDriverAddress',
  },
});

const validatorSet = await deriver.getCurrentValidatorSet();
console.log(`Epoch: ${validatorSet.epoch}`);
console.log(`Active validators: ${validatorSet.validators.filter(v => v.isActive).length}`);
console.log(`Settlement status: ${validatorSet.status}`);
console.log(`Integrity: ${validatorSet.integrity}`);
```

### Aggregator extra data

```ts
const extraData = await deriver.getAggregatorsExtraData('zk');
extraData.forEach(({ key, value }) => console.log(key, value));
```

Pass `'simple'` for simple mode or provide custom `keyTags` when you need non-default key selection.

### Single-call epoch snapshot

`getEpochData` pulls the validator set, network metadata, optional log event, and aggregator extras in one request:

```ts
const snapshot = await deriver.getEpochData({
  epoch,
  finalized: true,
  includeNetworkData: true,
  includeValSetEvent: true,
});

console.log(snapshot.validatorSet.status);
console.log(snapshot.networkData?.address);
console.log(snapshot.aggregatorsExtraData?.length ?? 0);
console.log(snapshot.settlementStatuses?.map((s) => ({
  chainId: s.settlement.chainId,
  committed: s.committed,
})));
console.log(snapshot.valSetEvents?.map((entry) => ({
  chainId: entry.settlement.chainId,
  hasEvent: Boolean(entry.event),
})));
```

Aggregator extra data returned by `getEpochData` automatically uses the network configuration's `verificationType` (simple vs zk). Provide `aggregatorKeyTags` only when you need to override the defaults coming from the config.

See `displayEpochSnapshot` in [`examples/example.ts`](examples/example.ts) for a full walkthrough that prints the combined response.

### Validator set events

Validator-set commitment events expose on-chain metadata (block number, block timestamp, transaction hash) together with the parsed header. The deriver only attempts to load the event once the validator set status is `committed`, so pending epochs return `null` without additional RPC calls:

```ts
const events = await deriver.getValSetLogEvents({ epoch, finalized: true });

events.forEach(({ settlement, committed, event }) => {
  console.log(`Settlement ${settlement.address} committed=${committed}`);
  if (event) {
    console.log('  kind:', event.kind);
    console.log('  blockTimestamp:', event.blockTimestamp);
    console.log('  txHash:', event.transactionHash);
  }
});
```

When you only need status data without retrieving logs, call:

```ts
const settlements = await deriver.getValSetSettlementStatuses({ epoch });
settlements.forEach(({ settlement, committed }) => {
  console.log(`Settlement ${settlement.address} committed=${committed}`);
});
```

`getEpochData` now mirrors this behaviour: when `includeValSetEvent` is `true`, the response includes `settlementStatuses` alongside `valSetEvents`, containing entries for every settlement and returning logs only for those that are already committed.

Internally the library batches settlement reads with `Multicall3` when available and caches finalized results to avoid redundant log scans.

## Caching

`ValidatorSetDeriver` accepts any cache that conforms to the `CacheInterface` and only persists finalized data. Cache entries are namespaced by epoch and a string key, allowing multiple values per epoch. Implement the interface to integrate Redis, in-memory caches, or other stores:

```ts
import type { CacheInterface } from '@symbioticfi/relay-stats-ts';

class MapCache implements CacheInterface {
  private buckets = new Map<number, Map<string, unknown>>();

  async get(epoch: number, key: string) {
    return this.buckets.get(epoch)?.get(key) ?? null;
  }

  async set(epoch: number, key: string, value: unknown) {
    let bucket = this.buckets.get(epoch);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(epoch, bucket);
    }
    bucket.set(key, value);
  }

  async delete(epoch: number, key: string) {
    const bucket = this.buckets.get(epoch);
    if (!bucket) return;
    bucket.delete(key);
    if (bucket.size === 0) {
      this.buckets.delete(epoch);
    }
  }

  async clear(epoch: number) {
    this.buckets.delete(epoch);
  }
}

const deriver = await ValidatorSetDeriver.create({
  rpcUrls: ["..."],
  driverAddress: {...},
  cache: new MapCache(),
});
```

## API Highlights

All exports live under `@symbioticfi/relay-stats-ts`. Key entry points:

- `ValidatorSetDeriver.create(config)` – initialize clients (one per chain) and validate required RPC coverage.
- `getEpochData({ epoch?, finalized?, includeNetworkData?, includeValSetEvent?, aggregatorKeyTags? })` – single snapshot with validator set, optional network metadata, aggregator extras, settlement statuses, and per-settlement log events.
- `getValidatorSet(epoch?, finalized?)` / `getNetworkConfig(epoch?, finalized?)` / `getNetworkData(settlement?, finalized?)` – granular primitives backing the combined call.
- `getValSetSettlementStatuses({ epoch?, settlements?, finalized? })` – commitment + header-hash status per settlement.
- `getValSetLogEvents({ epoch?, settlements?, finalized? })` – settlement-indexed log results (only fetches logs for committed settlements).
- `getAggregatorsExtraData(mode, keyTags?, finalized?, epoch?)` – manual access to simple/zk aggregator payloads when you need custom modes or tags.
- Utilities for downstream consumers: `getTotalActiveVotingPower`, `getValidatorSetHeader`, `abiEncodeValidatorSetHeader`, `hashValidatorSetHeader`, `getValidatorSetHeaderHash`.
- Low-level helpers are re-exported: `buildSimpleExtraData`, `buildZkExtraData`, and the SSZ encoding utilities (`serializeValidatorSet`, `getValidatorSetRoot`, etc.).

Refer to `src/types.ts` for full type definitions.

## Example script

See [`examples/README.md`](examples/README.md) for step-by-step instructions on running the demonstration script against your own RPC endpoints.

## Development

```bash
pnpm install
pnpm run lint
pnpm run format:check
pnpm run build
```

## License

MIT
