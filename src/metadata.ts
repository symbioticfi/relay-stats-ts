import { hexToString, type Address, type Hex, type PublicClient } from 'viem';
import { ERC20_METADATA_ABI, VAULT_ABI } from './abis/index.js';
import {
  MULTICALL_ERC20_METADATA_CALL_GAS,
  MULTICALL_VAULT_COLLATERAL_CALL_GAS,
} from './constants.js';
import { blockTagFromFinality, type BlockTagPreference } from './utils/core.js';
import { executeChunkedMulticall, type MulticallRequest } from './client.js';
import type { Validator } from './types/index.js';
import type { NetworkConfig } from './types/index.js';

export type TokenMetadata = {
  address: Address;
  symbol?: string;
  name?: string;
};

export type ChainCollateralMetadata = {
  vaultCollaterals: Map<string, Address>;
  tokenMetadata: Map<string, TokenMetadata>;
};

type ResolveCollateralsParams = {
  client: PublicClient;
  vaults: readonly Address[];
  blockTag: BlockTagPreference;
  allowMulticall: boolean;
};

type ResolveTokenMetadataParams = {
  client: PublicClient;
  tokens: readonly Address[];
  blockTag: BlockTagPreference;
  allowMulticall: boolean;
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const dedupeAddresses = (addresses: readonly Address[]): Address[] => {
  const seen = new Set<string>();
  const unique: Address[] = [];
  for (const address of addresses) {
    const lower = address.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    unique.push(address);
  }
  return unique;
};

const normalizeTokenMetadataValue = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  if (value.startsWith('0x')) {
    if (value === '0x') {
      return null;
    }
    try {
      const size = value.length === 66 ? 32 : undefined;
      const decoded = hexToString(value as Hex, size ? { size } : undefined);
      const trimmed = decoded.replace(/\u0000+$/g, '');
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  return value;
};

export const resolveVaultCollaterals = async ({
  client,
  vaults,
  blockTag,
  allowMulticall,
}: ResolveCollateralsParams): Promise<Map<string, Address>> => {
  const uniqueVaults = dedupeAddresses(vaults);
  const collaterals = new Map<string, Address>();
  if (uniqueVaults.length === 0) return collaterals;

  let collateralResults: (Address | null)[] = [];

  if (allowMulticall) {
    const requests: MulticallRequest[] = uniqueVaults.map((address) => ({
      address,
      abi: VAULT_ABI,
      functionName: 'collateral',
      args: [],
      estimatedGas: MULTICALL_VAULT_COLLATERAL_CALL_GAS,
    }));

    collateralResults = await executeChunkedMulticall<Address | null>({
      client,
      requests,
      blockTag,
      allowFailure: true,
    });
  }

  if (collateralResults.length === 0) {
    collateralResults = Array(uniqueVaults.length).fill(null);
  }

  for (let i = 0; i < uniqueVaults.length; i++) {
    if (!collateralResults[i]) {
      try {
        const fallback = (await client.readContract({
          address: uniqueVaults[i],
          abi: VAULT_ABI,
          functionName: 'collateral',
          args: [],
          blockTag,
        })) as Address;
        collateralResults[i] = fallback;
      } catch {
        collateralResults[i] = null;
      }
    }

    const collateral = collateralResults[i];
    if (!collateral || collateral.toLowerCase() === ZERO_ADDRESS) continue;
    collaterals.set(uniqueVaults[i].toLowerCase(), collateral as Address);
  }

  return collaterals;
};

export const resolveTokenMetadata = async ({
  client,
  tokens,
  blockTag,
  allowMulticall,
}: ResolveTokenMetadataParams): Promise<Map<string, TokenMetadata>> => {
  const uniqueTokens = dedupeAddresses(tokens);
  const metadata = new Map<string, TokenMetadata>();
  if (uniqueTokens.length === 0) return metadata;

  const requests: MulticallRequest[] = [];
  const callMap: { token: Address; field: 'symbol' | 'name' }[] = [];

  for (const token of uniqueTokens) {
    requests.push({
      address: token,
      abi: ERC20_METADATA_ABI,
      functionName: 'symbol',
      args: [],
      estimatedGas: MULTICALL_ERC20_METADATA_CALL_GAS,
    });
    callMap.push({ token, field: 'symbol' });

    requests.push({
      address: token,
      abi: ERC20_METADATA_ABI,
      functionName: 'name',
      args: [],
      estimatedGas: MULTICALL_ERC20_METADATA_CALL_GAS,
    });
    callMap.push({ token, field: 'name' });
  }

  let results: (string | null)[] = [];

  if (allowMulticall) {
    results = await executeChunkedMulticall<string | null>({
      client,
      requests,
      blockTag,
      allowFailure: true,
    });
  } else {
    results = Array(requests.length).fill(null);
  }

  const fallbackRequests = new Map<Address, Set<'symbol' | 'name'>>();

  for (let i = 0; i < callMap.length; i++) {
    const { token, field } = callMap[i];
    const rawValue = results[i];
    const normalized = normalizeTokenMetadataValue(rawValue);
    if (normalized !== null) {
      const key = token.toLowerCase();
      const existing = metadata.get(key) ?? { address: token };
      if (field === 'symbol') {
        existing.symbol = normalized;
      } else {
        existing.name = normalized;
      }
      metadata.set(key, existing);
    } else {
      const current = fallbackRequests.get(token) ?? new Set<'symbol' | 'name'>();
      current.add(field);
      fallbackRequests.set(token, current);
    }
  }

  if (fallbackRequests.size > 0) {
    for (const [token, fields] of fallbackRequests) {
      for (const field of fields) {
        try {
          const value = await client.readContract({
            address: token,
            abi: ERC20_METADATA_ABI,
            functionName: field,
            args: [],
            blockTag,
          });
          const normalized = normalizeTokenMetadataValue(value);
          if (normalized === null) continue;
          const key = token.toLowerCase();
          const existing = metadata.get(key) ?? { address: token };
          if (field === 'symbol') {
            existing.symbol = normalized;
          } else {
            existing.name = normalized;
          }
          metadata.set(key, existing);
        } catch {
          continue;
        }
      }
    }
  }

  return metadata;
};

export const applyCollateralMetadata = async ({
  validators,
  finalized,
  getClient,
  hasMulticall,
}: {
  validators: Validator[];
  finalized: boolean;
  getClient: (chainId: number) => PublicClient;
  hasMulticall: (chainId: number, blockTag: BlockTagPreference) => Promise<boolean>;
}): Promise<void> => {
  const vaultsByChain = new Map<number, Address[]>();

  for (const validator of validators) {
    for (const vault of validator.vaults) {
      let list = vaultsByChain.get(vault.chainId);
      if (!list) {
        list = [];
        vaultsByChain.set(vault.chainId, list);
      }
      list.push(vault.vault);
    }
  }

  if (vaultsByChain.size === 0) return;

  const metadataByChain = await loadCollateralMetadata({
    vaultsByChain,
    getClient,
    hasMulticall,
    finalized,
  });

  for (const validator of validators) {
    for (const vault of validator.vaults) {
      const chainMetadata = metadataByChain.get(vault.chainId);
      if (!chainMetadata) continue;

      const vaultKey = vault.vault.toLowerCase();
      const collateral = chainMetadata.vaultCollaterals.get(vaultKey);
      if (!collateral) continue;

      vault.collateral = collateral;
      const tokenMeta = chainMetadata.tokenMetadata.get(collateral.toLowerCase());
      if (tokenMeta?.symbol) {
        vault.collateralSymbol = tokenMeta.symbol;
      }
      if (tokenMeta?.name) {
        vault.collateralName = tokenMeta.name;
      }
    }
  }
};

/** @notice Load collateral addresses and token metadata for vaults grouped by chain. */
export const loadCollateralMetadata = async (params: {
  vaultsByChain: Map<number, Address[]>;
  getClient: (chainId: number) => PublicClient;
  hasMulticall: (chainId: number, blockTag: BlockTagPreference) => Promise<boolean>;
  finalized: boolean;
}): Promise<Map<number, ChainCollateralMetadata>> => {
  const { vaultsByChain, getClient, hasMulticall, finalized } = params;
  const blockTag = blockTagFromFinality(finalized);
  const result = new Map<number, ChainCollateralMetadata>();

  for (const [chainId, vaults] of vaultsByChain) {
    if (!vaults || vaults.length === 0) continue;
    const client = getClient(chainId);
    const allowMulticall = await hasMulticall(chainId, blockTag);

    const vaultCollaterals = await resolveVaultCollaterals({
      client,
      vaults,
      blockTag,
      allowMulticall,
    });

    if (vaultCollaterals.size === 0) continue;

    const tokens = Array.from(vaultCollaterals.values());
    const tokenMetadata = await resolveTokenMetadata({
      client,
      tokens,
      blockTag,
      allowMulticall,
    });

    result.set(chainId, {
      vaultCollaterals,
      tokenMetadata,
    });
  }

  return result;
};
