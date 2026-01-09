import {
    createPublicClient,
    getContract,
    http,
    type Abi,
    type Address,
    type GetContractReturnType,
    type Hex,
    type PublicClient,
} from 'viem';
import {
    KEY_REGISTRY_ABI,
    SETTLEMENT_ABI,
    VALSET_DRIVER_ABI,
    VOTING_POWER_PROVIDER_ABI,
} from './abis/index.js';
import {
    MULTICALL3_ADDRESS,
    MULTICALL_TARGET_GAS,
    MULTICALL_KEYS_CALL_GAS,
    MULTICALL_VOTING_CALL_GAS,
} from './constants.js';
import type { CrossChainAddress, OperatorVotingPower, OperatorWithKeys } from './types/index.js';
import type { BlockTagPreference } from './utils/core.js';

const getReadContract = <const TAbi extends Abi | readonly unknown[]>(
    client: PublicClient,
    address: Address,
    abi: TAbi
): GetContractReturnType<TAbi, PublicClient, Address> =>
    getContract({
        address,
        abi,
        client,
    });

/** @notice Single multicall request entry. */
export type MulticallRequest = {
    address: Address;
    abi: Abi;
    functionName: string;
    args: readonly unknown[];
    estimatedGas?: bigint;
};

type DriverReadMethod =
    | 'getCurrentEpoch'
    | 'getCurrentEpochDuration'
    | 'getCurrentEpochStart'
    | 'getNextEpoch'
    | 'getNextEpochDuration'
    | 'getNextEpochStart'
    | 'getEpochStart'
    | 'getEpochDuration'
    | 'getEpochIndex';

type DriverReadArgsMap = {
    getCurrentEpoch: [];
    getCurrentEpochDuration: [];
    getCurrentEpochStart: [];
    getNextEpoch: [];
    getNextEpochDuration: [];
    getNextEpochStart: [];
    getEpochStart: [number];
    getEpochDuration: [number];
    getEpochIndex: [number];
};

export const DRIVER_METHOD = {
    CURRENT_EPOCH: 'getCurrentEpoch',
    CURRENT_EPOCH_DURATION: 'getCurrentEpochDuration',
    CURRENT_EPOCH_START: 'getCurrentEpochStart',
    NEXT_EPOCH: 'getNextEpoch',
    NEXT_EPOCH_DURATION: 'getNextEpochDuration',
    NEXT_EPOCH_START: 'getNextEpochStart',
    EPOCH_START: 'getEpochStart',
    EPOCH_DURATION: 'getEpochDuration',
    EPOCH_INDEX: 'getEpochIndex',
} as const;

/** @notice Build a map of PublicClient instances keyed by chainId from RPC URLs. */
export const buildClientMap = async (
    rpcUrls: readonly string[]
): Promise<Map<number, PublicClient>> => {
    const clients = new Map<number, PublicClient>();

    await Promise.all(
        rpcUrls.map(async url => {
            const client = createPublicClient({
                transport: http(url),
            });

            const chainId = await client.getChainId();
            clients.set(chainId, client);
        })
    );

    return clients;
};

/** @notice Retrieve a client by chainId or throw if it is missing. */
export const getClientOrThrow = (
    clients: Map<number, PublicClient>,
    chainId: number
): PublicClient => {
    const client = clients.get(chainId);
    if (!client) {
        throw new Error(`No client for chain ID ${chainId}`);
    }
    return client;
};

export const multicallExists = async (
    client: PublicClient,
    blockTag: BlockTagPreference
): Promise<boolean> => {
    const tagsToTry: BlockTagPreference[] = [blockTag];
    if (blockTag === 'finalized') {
        tagsToTry.push('latest');
    }

    for (const tag of tagsToTry) {
        try {
            const bytecode = await client.getBytecode({
                address: MULTICALL3_ADDRESS as Address,
                blockTag: tag,
            });
            if (bytecode && bytecode !== '0x') {
                return true;
            }
            if (bytecode !== null) {
                return false;
            }
        } catch {
            continue;
        }
    }

    return false;
};

const getDriverContract = (
    client: PublicClient,
    driver: CrossChainAddress
): GetContractReturnType<typeof VALSET_DRIVER_ABI, PublicClient, Address> =>
    getReadContract(client, driver.address, VALSET_DRIVER_ABI);

export const readDriverNumber = async <M extends DriverReadMethod>({
    client,
    driver,
    method,
    blockTag,
    args,
}: {
    client: PublicClient;
    driver: CrossChainAddress;
    method: M;
    blockTag: BlockTagPreference;
    args?: DriverReadArgsMap[M];
}): Promise<number> => {
    const driverContract = getDriverContract(client, driver);
    const reader = (
        driverContract.read as unknown as Record<
            DriverReadMethod,
            (...params: unknown[]) => Promise<bigint | number>
        >
    )[method];
    const result =
        args && args.length > 0 ? await reader(args, { blockTag }) : await reader({ blockTag });
    return Number(result);
};

export const readDriverConfigAt = async (
    client: PublicClient,
    driver: CrossChainAddress,
    epochStart: number,
    blockTag: BlockTagPreference
): Promise<unknown> => {
    const driverContract = getDriverContract(client, driver);
    return driverContract.read.getConfigAt([epochStart], {
        blockTag,
    });
};

/** @notice Execute multicall requests in gas-bounded chunks. */
export const executeChunkedMulticall = async <T>({
    client,
    requests,
    blockTag,
    allowFailure = false,
}: {
    client: PublicClient;
    requests: readonly MulticallRequest[];
    blockTag: BlockTagPreference;
    allowFailure?: boolean;
}): Promise<T[]> => {
    if (requests.length === 0) return [];

    const chunks: MulticallRequest[][] = [];
    let currentChunk: MulticallRequest[] = [];
    let currentGas: bigint = 0n;

    for (const request of requests) {
        const gasEstimate = request.estimatedGas ?? 0n;

        if (currentChunk.length > 0 && currentGas + gasEstimate > MULTICALL_TARGET_GAS) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentGas = 0n;
        }

        currentChunk.push(request);
        currentGas += gasEstimate;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    const results: T[] = [];

    for (const chunk of chunks) {
        let rawResult: readonly unknown[];
        try {
            rawResult = (await client.multicall({
                allowFailure,
                blockTag,
                multicallAddress: MULTICALL3_ADDRESS as Address,
                contracts: chunk.map(item => ({
                    address: item.address,
                    abi: item.abi,
                    functionName: item.functionName as never,
                    args: item.args,
                })),
            })) as readonly { status: 'success' | 'failure'; result: unknown }[];
        } catch (error) {
            const first = chunk[0];
            const label = first ? `${first.functionName} @ ${first.address}` : 'multicall';
            const message = error instanceof Error ? error.message : String(error);
            // eslint-disable-next-line no-console
            console.warn(`Multicall failed for ${label} (chunk size ${chunk.length}): ${message}`);
            throw error;
        }

        if (allowFailure) {
            const typed = rawResult as readonly {
                status: 'success' | 'failure';
                result: unknown;
            }[];
            const chunkResult = typed.map(entry => {
                if (entry.status === 'success') {
                    return entry.result as T;
                }
                return null as T;
            });
            results.push(...chunkResult);
        } else {
            results.push(...(rawResult as unknown as T[]));
        }
    }

    return results;
};

export const fetchNetworkIdentifiers = async ({
    client,
    driver,
    blockTag,
    useMulticall,
}: {
    client: PublicClient;
    driver: CrossChainAddress;
    blockTag: BlockTagPreference;
    useMulticall: boolean;
}): Promise<{ network: Address; subnetwork: Hex }> => {
    if (useMulticall) {
        const results = await client.multicall({
            allowFailure: false,
            blockTag,
            multicallAddress: MULTICALL3_ADDRESS as Address,
            contracts: [
                {
                    address: driver.address,
                    abi: VALSET_DRIVER_ABI,
                    functionName: 'NETWORK',
                },
                {
                    address: driver.address,
                    abi: VALSET_DRIVER_ABI,
                    functionName: 'SUBNETWORK',
                },
            ],
        });

        return {
            network: results[0] as Address,
            subnetwork: results[1] as Hex,
        };
    }

    const driverContract = getDriverContract(client, driver);
    const values = await Promise.all([
        driverContract.read.NETWORK({ blockTag }),
        driverContract.read.SUBNETWORK({ blockTag }),
    ]);

    return {
        network: values[0] as Address,
        subnetwork: values[1] as Hex,
    };
};

export const fetchSettlementDomain = async ({
    client,
    settlement,
    blockTag,
}: {
    client: PublicClient;
    settlement: CrossChainAddress;
    blockTag: BlockTagPreference;
}): Promise<{
    fields: string;
    name: string;
    version: string;
    chainId: bigint;
    verifyingContract: Address;
    salt: Hex;
    extensions: bigint[];
}> => {
    const settlementContract = getReadContract(client, settlement.address, SETTLEMENT_ABI);

    const domainTuple = await settlementContract.read.eip712Domain({ blockTag });

    const [fields, name, version, chainId, verifyingContract, salt, extensions] =
        domainTuple as readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]];

    return {
        fields: fields as string,
        name,
        version,
        chainId,
        verifyingContract,
        salt,
        extensions: [...extensions] as bigint[],
    };
};

export const fetchVotingPowers = async ({
    client,
    provider,
    blockTag,
    timestamp,
    useMulticall,
}: {
    client: PublicClient;
    provider: CrossChainAddress;
    blockTag: BlockTagPreference;
    timestamp: bigint;
    useMulticall: boolean;
}): Promise<OperatorVotingPower[]> => {
    const timestampSeconds = BigInt(timestamp);
    const providerContract = getReadContract(client, provider.address, VOTING_POWER_PROVIDER_ABI);

    if (useMulticall) {
        const operators = await providerContract.read.getOperatorsAt(
            [timestampSeconds] as unknown as Parameters<
                typeof providerContract.read.getOperatorsAt
            >[0],
            {
                blockTag,
            }
        );

        if (operators.length === 0) return [];

        const operatorList = Array.from(operators, operator => operator as Address);
        const results = await executeChunkedMulticall<readonly { vault: Address; value: bigint }[]>(
            {
                client,
                requests: operatorList.map(operator => ({
                    address: provider.address,
                    abi: VOTING_POWER_PROVIDER_ABI,
                    functionName: 'getOperatorVotingPowersAt',
                    args: [operator, '0x' as Hex, timestampSeconds] as unknown as Parameters<
                        typeof providerContract.read.getOperatorVotingPowersAt
                    >[0],
                    estimatedGas: MULTICALL_VOTING_CALL_GAS,
                })),
                blockTag,
            }
        );

        if (results.length !== operatorList.length) {
            throw new Error(
                `Multicall result length mismatch for voting powers: expected ${operatorList.length}, got ${results.length}`
            );
        }

        return operatorList.map((operator, index) => {
            const vaults = (results[index] ?? []) as readonly { vault: Address; value: bigint }[];
            return {
                operator,
                vaults: Array.from(vaults, v => ({
                    vault: v.vault as Address,
                    votingPower: v.value,
                })),
            };
        });
    }

    const votingPowers = (await providerContract.read.getVotingPowersAt(
        [[], timestampSeconds] as unknown as Parameters<
            typeof providerContract.read.getVotingPowersAt
        >[0],
        {
            blockTag,
        }
    )) as readonly { operator: Address; vaults: readonly { vault: Address; value: bigint }[] }[];

    return votingPowers.map(vp => ({
        operator: vp.operator,
        vaults: vp.vaults.map(v => ({
            vault: v.vault,
            votingPower: v.value,
        })),
    }));
};

export const fetchKeysAt = async ({
    client,
    provider,
    blockTag,
    timestamp,
    useMulticall,
}: {
    client: PublicClient;
    provider: CrossChainAddress;
    blockTag: BlockTagPreference;
    timestamp: bigint;
    useMulticall: boolean;
}): Promise<OperatorWithKeys[]> => {
    const timestampSeconds = BigInt(timestamp);
    const keyRegistry = getReadContract(client, provider.address, KEY_REGISTRY_ABI);

    if (useMulticall) {
        const operators = await keyRegistry.read.getKeysOperatorsAt(
            [timestampSeconds] as unknown as Parameters<
                typeof keyRegistry.read.getKeysOperatorsAt
            >[0],
            {
                blockTag,
            }
        );

        if (operators.length === 0) return [];

        const operatorList = Array.from(operators, operator => operator as Address);
        const results = await executeChunkedMulticall<
            readonly { tag: number | bigint; payload: Hex }[]
        >({
            client,
            requests: operatorList.map(operator => ({
                address: provider.address,
                abi: KEY_REGISTRY_ABI,
                functionName: 'getKeysAt',
                args: [operator, timestampSeconds] as unknown as Parameters<
                    typeof keyRegistry.read.getKeysAt
                >[0],
                estimatedGas: MULTICALL_KEYS_CALL_GAS,
            })),
            blockTag,
        });

        if (results.length !== operatorList.length) {
            throw new Error(
                `Multicall result length mismatch for keys: expected ${operatorList.length}, got ${results.length}`
            );
        }

        return operatorList.map((operator, index) => {
            const operatorKeys = (results[index] ?? []) as readonly {
                tag: number | bigint;
                payload: Hex;
            }[];
            return {
                operator,
                keys: Array.from(operatorKeys, key => ({
                    tag: typeof key.tag === 'bigint' ? Number(key.tag) : key.tag,
                    payload: key.payload as Hex,
                })),
            };
        });
    }

    const keys = (await client.readContract({
        address: provider.address,
        abi: KEY_REGISTRY_ABI,
        functionName: 'getKeysAt',
        args: [timestampSeconds] as unknown as readonly [number],
        blockTag,
    })) as readonly {
        operator: Address;
        keys: readonly { tag: number | bigint; payload: Hex }[];
    }[];

    return keys.map(k => ({
        operator: k.operator,
        keys: Array.from(k.keys, key => ({
            tag: typeof key.tag === 'bigint' ? Number(key.tag) : key.tag,
            payload: key.payload,
        })),
    }));
};

export type { DriverReadArgsMap, DriverReadMethod };
