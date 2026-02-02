import { hexToString, type Address, type Hex, type PublicClient } from 'viem';
import { ERC20_METADATA_ABI, VAULT_ABI } from './abis/index.js';
import { executeChunkedMulticall, type MulticallRequest } from './client.js';
import type { Validator } from './types/index.js';
import { blockTagFromFinality, type BlockTagPreference } from './utils/core.js';

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
};

type ResolveTokenMetadataParams = {
    client: PublicClient;
    tokens: readonly Address[];
    blockTag: BlockTagPreference;
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
            /* eslint-disable-next-line no-control-regex */
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
}: ResolveCollateralsParams): Promise<Map<string, Address>> => {
    const uniqueVaults = dedupeAddresses(vaults);
    const collaterals = new Map<string, Address>();
    if (uniqueVaults.length === 0) return collaterals;

    const requests: MulticallRequest[] = uniqueVaults.map(address => ({
        address,
        abi: VAULT_ABI,
        functionName: 'collateral',
        args: [],
    }));

    const collateralResults = await executeChunkedMulticall<Address | null>({
        client,
        requests,
        blockTag,
    });

    for (let i = 0; i < uniqueVaults.length; i++) {
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
        });
        callMap.push({ token, field: 'symbol' });

        requests.push({
            address: token,
            abi: ERC20_METADATA_ABI,
            functionName: 'name',
            args: [],
        });
        callMap.push({ token, field: 'name' });
    }

    const results = await executeChunkedMulticall<string | null>({
        client,
        requests,
        blockTag,
    });

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
        }
    }

    return metadata;
};

export const applyCollateralMetadata = async ({
    validators,
    finalized,
    getClient,
}: {
    validators: Validator[];
    finalized: boolean;
    getClient: (chainId: number) => PublicClient;
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
    finalized: boolean;
}): Promise<Map<number, ChainCollateralMetadata>> => {
    const { vaultsByChain, getClient, finalized } = params;
    const blockTag = blockTagFromFinality(finalized);
    const result = new Map<number, ChainCollateralMetadata>();

    for (const [chainId, vaults] of vaultsByChain) {
        if (!vaults || vaults.length === 0) continue;
        const client = getClient(chainId);

        const vaultCollaterals = await resolveVaultCollaterals({
            client,
            vaults,
            blockTag,
        });

        if (vaultCollaterals.size === 0) continue;

        const tokens = Array.from(vaultCollaterals.values());
        const tokenMetadata = await resolveTokenMetadata({
            client,
            tokens,
            blockTag,
        });

        result.set(chainId, {
            vaultCollaterals,
            tokenMetadata,
        });
    }

    return result;
};
