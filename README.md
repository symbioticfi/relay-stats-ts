# @symbioticfi/relay-stats-ts

[![npm version](https://badge.fury.io/js/%40symbioticfi%2Frelay-stats-ts.svg)](https://badge.fury.io/js/%40symbioticfi%2Frelay-stats-ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/@symbioticfi/relay-stats-ts)](https://nodejs.org/)

TypeScript library for deriving validator sets from Symbiotic network contracts.

## Installation

```bash
npm install @symbioticfi/relay-stats-ts
# or
yarn add @symbioticfi/relay-stats-ts
```

## Quick Start

```typescript
import { ValidatorSetDeriver } from '@symbioticfi/relay-stats-ts';

const deriver = await ValidatorSetDeriver.create({
  rpcUrls: ['http://localhost:8545'],
  driverAddress: {
    chainId: 31337,
    address: '0x...',
  },
});

// Get current validator set
const validatorSet = await deriver.getCurrentValidatorSet();
console.log(`Active validators: ${validatorSet.validators.filter(v => v.isActive).length}`);
console.log(`Settlement status: ${validatorSet.status}`);
console.log(`Integrity status: ${validatorSet.integrity}`);
```

## Usage

```typescript
import { ValidatorSetDeriver, MemoryCache } from '@symbioticfi/relay-stats-ts';

// Initialize without cache
const deriver = new ValidatorSetDeriver({
  rpcUrls: [
    'https://eth-mainnet.alchemyapi.io/v2/YOUR_KEY',
    'https://polygon-rpc.com'
  ],
  driverAddress: { 
    chainId: 1, 
    address: '0x...' 
  }
});

// Initialize with cache
const deriverWithCache = new ValidatorSetDeriver({
  rpcUrls: ["..."],
  driverAddress: { chainId: 1, address: '0x...' },
  cache: new MemoryCache(),
  maxSavedEpochs: 100
});

// Get current network config
const config = await deriver.getNetworkConfig();

// Get validator set for specific epoch
const validatorSet = await deriver.getValidatorSet(42);

// Get network data for settlement
const networkData = await deriver.getNetworkData({
  chainId: 1,
  address: '0xSettlementAddress'
});
```

## Features

- **Validator Set Derivation**: Derive validator sets from on-chain data
- **Multi-chain Support**: Handle cross-chain addresses and providers
- **Settlement Status Tracking**: Monitor commitment status across settlements
- **Flexible Caching**: Optional caching with pluggable cache interface

## API

### ValidatorSetDeriver

Main class for deriving validator sets.

#### Constructor Options

```typescript
interface ValidatorSetDeriverConfig {
  rpcUrls: string[];              // RPC endpoints for required chains
  driverAddress: CrossChainAddress; // Driver contract address
  cache?: CacheInterface | null;   // Optional cache implementation
  maxSavedEpochs?: number;         // Max epochs to cache (default: 100)
}
```

#### Methods

- `getCurrentEpoch(): Promise<number>` - Get current epoch number
- `getNetworkConfig(epoch?: number): Promise<NetworkConfig>` - Get network configuration
- `getValidatorSet(epoch?: number): Promise<ValidatorSet>` - Get validator set with settlement statuses

#### Simplified Interfaces (Current Epoch Only)

- `getCurrentNetworkConfig(): Promise<NetworkConfig>` - Get current epoch network configuration
- `getCurrentValidatorSet(): Promise<ValidatorSet>` - Get current epoch validator set

### Cache Interface

Implement this interface for custom cache solutions:

```typescript
interface CacheInterface {
  get(key: string): Promise<any | null>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}
```

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build

# Lint
npm run lint

# Format
npm run format
```

## License

MIT