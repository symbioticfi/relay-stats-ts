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
                batch: { multicall: { deployless: true } },
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

export const readDriverNumbersBatch = async <M extends DriverReadMethod>({
    client,
    driver,
    method,
    blockTag,
    argsList,
}: {
    client: PublicClient;
    driver: CrossChainAddress;
    method: M;
    blockTag: BlockTagPreference;
    argsList: readonly DriverReadArgsMap[M][];
}): Promise<number[]> => {
    if (argsList.length === 0) return [];

    const requests: MulticallRequest[] = argsList.map(args => ({
        address: driver.address,
        abi: VALSET_DRIVER_ABI,
        functionName: method,
        args: (args ?? []) as readonly unknown[],
    }));

    const results = await executeChunkedMulticall<bigint | number>({
        client,
        requests,
        blockTag,
    });
    return results.map(result => Number(result));
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

export const readDriverConfigAtBatch = async (
    client: PublicClient,
    driver: CrossChainAddress,
    epochStarts: readonly number[],
    blockTag: BlockTagPreference
): Promise<unknown[]> => {
    if (epochStarts.length === 0) return [];

    const requests: MulticallRequest[] = epochStarts.map(epochStart => ({
        address: driver.address,
        abi: VALSET_DRIVER_ABI,
        functionName: 'getConfigAt',
        args: [epochStart],
    }));

    return await executeChunkedMulticall<unknown>({
        client,
        requests,
        blockTag,
    });
};

/** @notice Execute multicall requests using viem batching defaults. */
export const executeChunkedMulticall = async <T>({
    client,
    requests,
    blockTag,
}: {
    client: PublicClient;
    requests: readonly MulticallRequest[];
    blockTag: BlockTagPreference;
}): Promise<T[]> => {
    if (requests.length === 0) return [];

    let rawResult: readonly unknown[];
    try {
        rawResult = (await client.multicall({
            allowFailure: false,
            blockTag,
            contracts: requests.map(item => ({
                address: item.address,
                abi: item.abi,
                functionName: item.functionName as never,
                args: item.args,
            })),
        })) as readonly unknown[];
    } catch (error) {
        const first = requests[0];
        const label = first ? `${first.functionName} @ ${first.address}` : 'multicall';
        const message = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.warn(`Multicall failed for ${label} (requests ${requests.length}): ${message}`);
        throw error;
    }

    return rawResult as unknown as T[];
};

export const fetchNetworkIdentifiers = async ({
    client,
    driver,
    blockTag,
}: {
    client: PublicClient;
    driver: CrossChainAddress;
    blockTag: BlockTagPreference;
}): Promise<{ network: Address; subnetwork: Hex }> => {
    const results = await client.multicall({
        allowFailure: false,
        blockTag,
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
        const results = await Promise.all(
            operatorList.map(operator =>
                providerContract.read.getOperatorVotingPowersAt(
                    [operator, '0x' as Hex, timestampSeconds] as unknown as Parameters<
                        typeof providerContract.read.getOperatorVotingPowersAt
                    >[0],
                    {
                        blockTag,
                    }
                )
            )
        );

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

export const fetchVotingPowersBatch = async ({
    client,
    provider,
    blockTag,
    timestamps,
    useMulticall,
}: {
    client: PublicClient;
    provider: CrossChainAddress;
    blockTag: BlockTagPreference;
    timestamps: readonly bigint[];
    useMulticall: boolean;
}): Promise<OperatorVotingPower[][]> => {
    if (timestamps.length === 0) return [];

    const providerContract = getReadContract(client, provider.address, VOTING_POWER_PROVIDER_ABI);

    if (!useMulticall) {
        const values = await Promise.all(
            timestamps.map(timestampSeconds =>
                providerContract.read.getVotingPowersAt(
                    [[], timestampSeconds] as unknown as Parameters<
                        typeof providerContract.read.getVotingPowersAt
                    >[0],
                    {
                        blockTag,
                    }
                )
            )
        );

        return values.map(votingPowers =>
            (
                votingPowers as readonly {
                    operator: Address;
                    vaults: readonly { vault: Address; value: bigint }[];
                }[]
            ).map(vp => ({
                operator: vp.operator,
                vaults: vp.vaults.map(v => ({
                    vault: v.vault,
                    votingPower: v.value,
                })),
            }))
        );
    }

    const operatorResults = await executeChunkedMulticall<readonly Address[]>({
        client,
        requests: timestamps.map(timestampSeconds => ({
            address: provider.address,
            abi: VOTING_POWER_PROVIDER_ABI,
            functionName: 'getOperatorsAt',
            args: [timestampSeconds],
        })),
        blockTag,
    });

    const operatorLists = operatorResults.map(operators =>
        Array.from(operators ?? [], operator => operator as Address)
    );

    const requests: MulticallRequest[] = [];
    const operatorCounts: number[] = [];

    if (operatorLists.length === 0) {
        return operatorCounts.map(() => []);
    }

    for (let i = 0; i < operatorLists.length; i++) {
        const operators = operatorLists[i];
        operatorCounts.push(operators.length);
        for (const operator of operators) {
            requests.push({
                address: provider.address,
                abi: VOTING_POWER_PROVIDER_ABI,
                functionName: 'getOperatorVotingPowersAt',
                args: [operator, '0x' as Hex, timestamps[i]],
            });
        }
    }

    const results = await executeChunkedMulticall<readonly { vault: Address; value: bigint }[]>({
        client,
        requests,
        blockTag,
    });

    const output: OperatorVotingPower[][] = [];
    let offset = 0;

    for (let i = 0; i < operatorCounts.length; i++) {
        const operators = operatorLists[i];
        const votingPowers: OperatorVotingPower[] = [];

        for (const operator of operators) {
            const vaults = results[offset++] ?? [];
            votingPowers.push({
                operator,
                vaults: Array.from(vaults, v => ({
                    vault: v.vault as Address,
                    votingPower: v.value,
                })),
            });
        }

        output.push(votingPowers);
    }

    return output;
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
    const timestampNumber = Number(timestamp);
    const keyRegistry = getReadContract(client, provider.address, KEY_REGISTRY_ABI);

    if (useMulticall) {
        const operators = await keyRegistry.read.getKeysOperatorsAt([timestampNumber] as const, {
            blockTag,
        });

        if (operators.length === 0) return [];

        const operatorList = Array.from(operators, operator => operator as Address);
        const results = await Promise.all(
            operatorList.map(operator =>
                client.readContract({
                    address: provider.address,
                    abi: KEY_REGISTRY_ABI,
                    functionName: 'getKeysAt',
                    args: [operator, timestampNumber] as const,
                    blockTag,
                })
            )
        );

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
        args: [timestampNumber] as const,
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

export const fetchKeysAtBatch = async ({
    client,
    provider,
    blockTag,
    timestamps,
    useMulticall,
}: {
    client: PublicClient;
    provider: CrossChainAddress;
    blockTag: BlockTagPreference;
    timestamps: readonly bigint[];
    useMulticall: boolean;
}): Promise<OperatorWithKeys[][]> => {
    if (timestamps.length === 0) return [];

    const timestampNumbers = timestamps.map(timestamp => Number(timestamp));

    const fetchDirect = async (): Promise<OperatorWithKeys[][]> => {
        const results = await Promise.all(
            timestampNumbers.map(timestampNumber =>
                client.readContract({
                    address: provider.address,
                    abi: KEY_REGISTRY_ABI,
                    functionName: 'getKeysAt',
                    args: [timestampNumber] as const,
                    blockTag,
                })
            )
        );

        return results.map(entries =>
            (
                entries as readonly {
                    operator: Address;
                    keys: readonly { tag: number | bigint; payload: Hex }[];
                }[]
            ).map(k => ({
                operator: k.operator,
                keys: Array.from(k.keys, key => ({
                    tag: typeof key.tag === 'bigint' ? Number(key.tag) : key.tag,
                    payload: key.payload,
                })),
            }))
        );
    };

    if (!useMulticall) {
        return fetchDirect();
    }

    const operatorResults = await executeChunkedMulticall<readonly Address[]>({
        client,
        requests: timestampNumbers.map(timestampNumber => ({
            address: provider.address,
            abi: KEY_REGISTRY_ABI,
            functionName: 'getKeysOperatorsAt',
            args: [timestampNumber],
        })),
        blockTag,
    });

    const operatorLists = operatorResults.map(operators =>
        Array.from(operators ?? [], operator => operator as Address)
    );

    const requests: MulticallRequest[] = [];
    const operatorCounts: number[] = [];

    for (let i = 0; i < operatorLists.length; i++) {
        const operators = operatorLists[i];
        operatorCounts.push(operators.length);
        for (const operator of operators) {
            requests.push({
                address: provider.address,
                abi: KEY_REGISTRY_ABI,
                functionName: 'getKeysAt',
                args: [operator, timestampNumbers[i]],
            });
        }
    }

    if (requests.length === 0) {
        return operatorCounts.map(() => []);
    }

    const results = await executeChunkedMulticall<
        readonly { tag: number | bigint; payload: Hex }[]
    >({
        client,
        requests,
        blockTag,
    });

    const output: OperatorWithKeys[][] = [];
    let offset = 0;

    for (let i = 0; i < operatorCounts.length; i++) {
        const operators = operatorLists[i];
        const operatorKeys: OperatorWithKeys[] = [];

        for (const operator of operators) {
            const rawKeys = results[offset++] ?? [];
            operatorKeys.push({
                operator,
                keys: Array.from(rawKeys, key => ({
                    tag: typeof key.tag === 'bigint' ? Number(key.tag) : key.tag,
                    payload: key.payload as Hex,
                })),
            });
        }

        output.push(operatorKeys);
    }

    return output;
};

export type { DriverReadArgsMap, DriverReadMethod };
