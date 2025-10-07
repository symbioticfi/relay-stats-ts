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
npm install            # builds the library via the prepare hook
```

You can now import from the `src/` or `dist/` folders locally, or run the example script (see [`examples/README.md`](examples/README.md)).

### From npm

```bash
npm install @symbioticfi/relay-stats-ts
# or
yarn add @symbioticfi/relay-stats-ts
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

## Caching

`ValidatorSetDeriver` accepts any cache that conforms to the `CacheInterface` and only persists finalized data. Implement the interface to integrate Redis, in-memory caches, or other stores:

```ts
import type { CacheInterface } from '@symbioticfi/relay-stats-ts';

class MapCache implements CacheInterface {
  private map = new Map<string, unknown>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: unknown) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async clear() {
    this.map.clear();
  }
}

const deriver = await ValidatorSetDeriver.create({
  rpcUrls: ["..."],
  driverAddress: {...},
  cache: new MapCache(),
});
```

## API Highlights

- `ValidatorSetDeriver.create(config)` – initialize clients and validate required chains.
- `getValidatorSet(epoch?, finalized = true)` – fetches validator sets with settlement status.
- `getNetworkConfig(epoch?, finalized = true)` – retrieves driver configuration for an epoch.
- `getNetworkData(settlement?, finalized = true)` – loads the EIP-712 domain from a settlement contract.
- `buildSimpleExtraData` / `buildZkExtraData` – standalone helpers for constructing aggregator payloads.
- SSZ helpers (`serializeValidatorSet`, `getValidatorSetRoot`, etc.) exported via `index.ts`.

Refer to `src/types.ts` for full type definitions.

## Example script

See [`examples/README.md`](examples/README.md) for step-by-step instructions on running the demonstration script against your own RPC endpoints.

## Development

```bash
npm install
npm run lint
npm run format:check
npm run build
```

Use `npm run ci` locally to execute the same build + lint + formatting checks that run in CI.

## License

MIT
