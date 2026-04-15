# @symbioticfi/relay-stats-ts

[![npm version](https://badge.fury.io/js/%40symbioticfi%2Frelay-stats-ts.svg)](https://badge.fury.io/js/%40symbioticfi%2Frelay-stats-ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/@symbioticfi/relay-stats-ts)](https://nodejs.org/)

TypeScript utilities for deriving Symbiotic validator-set data from on-chain contracts. The library mirrors the Go reference implementation and exposes helpers for SSZ encoding, MiMC hashing, aggregator extra data generation, and deterministic scheduler role assignment.

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
console.log(`Validators: ${validatorSet.validators.length}`);
console.log(`Settlement status: ${validatorSet.status}`);
console.log(`Integrity: ${validatorSet.integrity}`);
```

### Single-call epoch snapshot

`getEpochData` pulls the validator set, scheduler info, network metadata, settlement statuses, log events, and aggregator extras in one request:

```ts
const snapshot = await deriver.getEpochData({
    epoch,
    finalized: true,
    includeNetworkData: true,
    includeValSetEvent: true,
});

const { validatorSet, schedulerInfo, config } = snapshot;
console.log(validatorSet.status, validatorSet.validators.length);
console.log('aggregators:', schedulerInfo.aggregatorIndices);
console.log('committers:', schedulerInfo.committerIndices);
```

### Batch epoch snapshots

`getEpochsData` returns the same snapshot shape for an epoch range (results in ascending order):

```ts
const snapshots = await deriver.getEpochsData({
    epochRange: { from: 1, to: 3 },
    finalized: true,
});

snapshots.forEach(s => {
    console.log(s.epoch, s.validatorSet.status, s.schedulerInfo.aggregatorIndices);
});
```

Batch helpers use multicall to minimize RPCs when available.

### Scheduler (aggregator & committer roles)

Each epoch deterministically assigns aggregator and committer roles to active validators. The scheduler info is included in every `EpochData` snapshot. It is also available standalone:

```ts
import { getActiveCommitter } from '@symbioticfi/relay-stats-ts';

const schedulerInfo = await deriver.getSchedulerInfo({ epoch: currentEpoch });

// indices into validatorSet.validators
const aggregators = schedulerInfo.aggregatorIndices.map(i => validatorSet.validators[i]);
const committers = schedulerInfo.committerIndices.map(i => validatorSet.validators[i]);

// who is the active committer right now (round-robin time slots)
const active = getActiveCommitter({
    committerIndices: schedulerInfo.committerIndices,
    captureTimestamp: validatorSet.captureTimestamp,
    currentTime: Math.floor(Date.now() / 1000),
    committerSlotDuration: config.committerSlotDuration,
});

if (active) {
    const validator = validatorSet.validators[active.validatorIndex];
    console.log(`Active committer: ${validator.operator}`);
    console.log(`Slot: ${active.slotStart} – ${active.slotEnd}`);
}
```

`getActiveCommitter` is a pure function — no RPC calls. Special cases:
- `committerSlotDuration === 0` or single committer → always active
- `currentTime < captureTimestamp` → returns `null`
- Optional `graceSeconds` parameter for early next-slot activation

### Aggregator extra data

```ts
const extraData = await deriver.getAggregatorsExtraData('zk');
extraData.forEach(({ key, value }) => console.log(key, value));
```

Pass `'simple'` for simple mode or provide custom `keyTags` when you need non-default key selection. Aggregator extra data returned by `getEpochData` automatically uses the network configuration's `verificationType`.

### Range helpers

For range-style reads (status, settlement logs, timings), use the batch APIs:

```ts
const epochRange = { from: 10, to: 12 };

const statuses = await deriver.getValSetStatuses(epochRange, true);
statuses.forEach(({ epoch, status }) => {
    console.log(epoch, status.status, status.integrity);
});

const logEvents = await deriver.getValSetLogEventsForEpochs({
    epochRange,
    finalized: true,
});
logEvents.forEach(({ epoch, logs }) => {
    console.log(epoch, logs.map(log => log.committed));
});

const [starts, durations] = await Promise.all([
    deriver.getEpochStarts(epochRange, true),
    deriver.getEpochDurations(epochRange, true),
]);
console.log(starts, durations);
```

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

## Caching

`ValidatorSetDeriver` accepts any cache that conforms to the `CacheInterface` and only persists finalized data. Cache entries are namespaced by epoch and a string key, allowing multiple values per epoch. The deriver keeps a FIFO list of cached epochs and evicts them with `cache.clear(epoch)` once `maxSavedEpochs` is exceeded; non-epoch data (like network metadata) is stored under a persistent epoch sentinel.

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
- `getEpochData({ epoch?, finalized?, ... })` – single snapshot with validator set, scheduler info, optional network metadata, aggregator extras, settlement statuses, and per-settlement log events.
- `getEpochsData({ epochRange?, finalized?, ... })` – batch snapshot (array) in ascending order with the same shape as `getEpochData`.
- `getValidatorSet(epoch?, finalized?)` / `getNetworkConfig(epoch?, finalized?)` / `getNetworkData(settlement?, finalized?)` – granular primitives, plus batch variants `getValidatorSets(epochRange?)` and `getNetworkConfigs(epochRange?)`.
- `getSchedulerInfo({ epoch?, finalized? })` / `getSchedulerInfoForEpochs({ epochRange?, finalized? })` – deterministic aggregator/committer role assignments.
- `getActiveCommitter(params)` – pure helper returning the currently active committer with slot boundaries.
- `getEpochStart(epoch)` / `getEpochDuration(epoch)` – driver timing helpers, plus batch variants.
- `getValSetStatus(epoch)` / `getValSetSettlementStatuses(...)` / `getValSetLogEvents(...)` – settlement state and events, plus batch variants.
- `getAggregatorsExtraData(mode, ...)` / `getAggregatorsExtraDataForEpochs(...)` – simple/zk aggregator payloads.
- Utilities: `getTotalActiveVotingPower`, `getValidatorSetHeader`, `abiEncodeValidatorSetHeader`, `hashValidatorSetHeader`, `getValidatorSetHeaderHash`.
- Low-level re-exports: `buildSimpleExtraData`, `buildZkExtraData`, `getSchedulerInfo`, SSZ utilities (`serializeValidatorSet`, `getValidatorSetRoot`, etc.).

Refer to `src/types/` for full type definitions.

## Example

See [`examples/`](examples/) for a working demo. Quick start:

```bash
cd examples && pnpm install && pnpm start
```

## Development

```bash
pnpm install
pnpm run check
```

## License

MIT
