import { encodeAbiParameters, keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { buildSimpleExtraData, buildZkExtraData } from './extra-data/index.js';
import { applyCollateralMetadata } from './metadata.js';
import type {
    AggregatorExtraDataEntry,
    CrossChainAddress,
    NetworkConfig,
    OperatorVotingPower,
    OperatorWithKeys,
    Validator,
    ValidatorSet,
    ValidatorSetHeader,
} from './types/index.js';
import { SSZ_MAX_VALIDATORS, SSZ_MAX_VAULTS, VALSET_VERSION } from './constants.js';
import { sszTreeRoot } from './utils/ssz.js';

/** @notice Sum voting power of active validators only. */
export const totalActiveVotingPower = (validatorSet: ValidatorSet): bigint => {
    let total = 0n;
    for (const validator of validatorSet.validators) {
        if (validator.isActive) {
            total += validator.votingPower;
        }
    }
    return total;
};

/** @notice Build a validator-set header from a full set. */
export const createValidatorSetHeader = (validatorSet: ValidatorSet): ValidatorSetHeader => ({
    version: validatorSet.version,
    requiredKeyTag: validatorSet.requiredKeyTag,
    epoch: validatorSet.epoch,
    captureTimestamp: validatorSet.captureTimestamp,
    quorumThreshold: validatorSet.quorumThreshold,
    totalVotingPower: totalActiveVotingPower(validatorSet),
    validatorsSszMRoot: sszTreeRoot(validatorSet),
});

/** @notice ABI encode a validator-set header (matching settlement contract tuple). */
export const encodeValidatorSetHeader = (header: ValidatorSetHeader): Hex =>
    encodeAbiParameters(
        [
            { name: 'version', type: 'uint8' },
            { name: 'requiredKeyTag', type: 'uint8' },
            { name: 'epoch', type: 'uint48' },
            { name: 'captureTimestamp', type: 'uint48' },
            { name: 'quorumThreshold', type: 'uint256' },
            { name: 'totalVotingPower', type: 'uint256' },
            { name: 'validatorsSszMRoot', type: 'bytes32' },
        ],
        [
            header.version,
            header.requiredKeyTag,
            header.epoch,
            header.captureTimestamp,
            header.quorumThreshold,
            header.totalVotingPower,
            header.validatorsSszMRoot,
        ]
    ) as Hex;

/** @notice Keccak256 hash of the encoded validator-set header. */
export const hashValidatorSetHeader = (header: ValidatorSetHeader): Hex =>
    keccak256(encodeValidatorSetHeader(header));

/** @notice Hash of a full validator set (header derived from content). */
export const hashValidatorSet = (validatorSet: ValidatorSet): Hex =>
    hashValidatorSetHeader(createValidatorSetHeader(validatorSet));

type ChainVotingPowers = {
    readonly chainId: number;
    readonly votingPowers: readonly OperatorVotingPower[];
};

const limitAndSortVaults = (validator: Validator): void => {
    if (validator.vaults.length <= SSZ_MAX_VAULTS) {
        validator.vaults.sort((a, b) => a.vault.toLowerCase().localeCompare(b.vault.toLowerCase()));
        return;
    }

    validator.vaults.sort((left, right) => {
        const diff = right.votingPower - left.votingPower;
        if (diff !== 0n) {
            if (diff > 0n) {
                return 1;
            }
            return -1;
        }
        return left.vault.toLowerCase().localeCompare(right.vault.toLowerCase());
    });

    validator.vaults = validator.vaults.slice(0, SSZ_MAX_VAULTS);
    validator.votingPower = validator.vaults.reduce((sum, vault) => sum + vault.votingPower, 0n);
    validator.vaults.sort((a, b) => a.vault.toLowerCase().localeCompare(b.vault.toLowerCase()));
};

const applyValidatorKeys = (
    validators: Map<string, Validator>,
    keys: readonly OperatorWithKeys[]
): void => {
    for (const keyRecord of keys) {
        const operatorAddr = keyRecord.operator.toLowerCase() as Address;
        const validator = validators.get(operatorAddr);
        if (validator) {
            validator.keys = keyRecord.keys;
        }
    }
};

const markValidatorsActive = (config: NetworkConfig, validators: Validator[]): void => {
    let totalActive = 0;

    for (const validator of validators) {
        if (validator.votingPower < config.minInclusionVotingPower) {
            break;
        }

        if (validator.keys.length === 0) {
            continue;
        }

        totalActive++;
        validator.isActive = true;

        if (config.maxVotingPower !== 0n && validator.votingPower > config.maxVotingPower) {
            validator.votingPower = config.maxVotingPower;
        }

        if (config.maxValidatorsCount !== 0n && totalActive >= Number(config.maxValidatorsCount)) {
            break;
        }
    }
};

export const composeValidators = (
    config: NetworkConfig,
    votingPowers: readonly ChainVotingPowers[],
    operatorKeys: readonly OperatorWithKeys[]
): Validator[] => {
    const validators = new Map<string, Validator>();

    for (const chainVotingPower of votingPowers) {
        for (const votingPower of chainVotingPower.votingPowers) {
            const operatorAddr = votingPower.operator.toLowerCase() as Address;
            if (!validators.has(operatorAddr)) {
                validators.set(operatorAddr, {
                    operator: votingPower.operator,
                    votingPower: 0n,
                    isActive: false,
                    keys: [],
                    vaults: [],
                });
            }

            const validator = validators.get(operatorAddr)!;
            for (const vault of votingPower.vaults) {
                validator.votingPower += vault.votingPower;
                validator.vaults.push({
                    vault: vault.vault,
                    votingPower: vault.votingPower,
                    chainId: chainVotingPower.chainId,
                });
            }
        }
    }

    for (const validator of validators.values()) {
        limitAndSortVaults(validator);
    }

    applyValidatorKeys(validators, operatorKeys);

    let mappedValidators = Array.from(validators.values());

    mappedValidators.sort((left, right) => {
        const diff = right.votingPower - left.votingPower;
        if (diff !== 0n) {
            if (diff > 0n) {
                return 1;
            }
            return -1;
        }
        return left.operator.toLowerCase().localeCompare(right.operator.toLowerCase());
    });

    if (mappedValidators.length > SSZ_MAX_VALIDATORS) {
        mappedValidators = mappedValidators.slice(0, SSZ_MAX_VALIDATORS);
    }

    markValidatorsActive(config, mappedValidators);

    mappedValidators.sort((left, right) =>
        left.operator.toLowerCase().localeCompare(right.operator.toLowerCase())
    );

    return mappedValidators;
};

export const calculateQuorumThreshold = (
    config: NetworkConfig,
    totalVotingPower: bigint
): bigint => {
    const threshold = config.quorumThresholds.find(
        entry => entry.keyTag === config.requiredHeaderKeyTag
    );

    if (!threshold) {
        throw new Error(`No quorum threshold for key tag ${config.requiredHeaderKeyTag}`);
    }

    if (threshold.quorumThreshold === 0n) {
        throw new Error(`Quorum threshold for key tag ${config.requiredHeaderKeyTag} is zero`);
    }

    const maxThreshold = 1_000_000_000_000_000_000n;
    const multiplied = totalVotingPower * threshold.quorumThreshold;
    const divided = multiplied / maxThreshold;
    return divided + 1n;
};

type ValidatorSetBuildContext = {
    getClient: (chainId: number) => PublicClient;
};

export const buildValidatorSetFromData = async (
    params: {
        targetEpoch: number;
        finalized: boolean;
        epochStart: number;
        config: NetworkConfig;
        includeCollateralMetadata: boolean;
        allVotingPowers: { chainId: number; votingPowers: OperatorVotingPower[] }[];
        keys: OperatorWithKeys[];
    } & ValidatorSetBuildContext
): Promise<ValidatorSet> => {
    const {
        targetEpoch,
        finalized,
        epochStart,
        config,
        includeCollateralMetadata,
        allVotingPowers,
        keys,
        getClient,
    } = params;

    const timestampNumber = Number(epochStart);

    const validators = composeValidators(config, allVotingPowers, keys);
    if (includeCollateralMetadata) {
        await applyCollateralMetadata({
            validators,
            finalized,
            getClient,
        });
    }

    const totalVotingPower = validators
        .filter(validator => validator.isActive)
        .reduce((sum, validator) => sum + validator.votingPower, 0n);
    const quorumThreshold = calculateQuorumThreshold(config, totalVotingPower);
    const sortedRequiredTags = [...config.requiredKeyTags].sort((a, b) => a - b);

    const baseValset: ValidatorSet = {
        version: VALSET_VERSION,
        requiredKeyTag: config.requiredHeaderKeyTag,
        epoch: targetEpoch,
        captureTimestamp: timestampNumber,
        quorumThreshold,
        validators,
        totalVotingPower,
        status: 'pending',
        integrity: 'valid',
        extraData: [],
    };

    const simpleExtra = buildSimpleExtraData(baseValset, sortedRequiredTags);
    const zkExtra = await buildZkExtraData(baseValset, sortedRequiredTags);

    const combinedEntries = [...simpleExtra, ...zkExtra];
    const deduped = new Map<string, AggregatorExtraDataEntry>();
    for (const entry of combinedEntries) {
        deduped.set(entry.key.toLowerCase(), entry);
    }
    const extraData = Array.from(deduped.values()).sort((left, right) =>
        left.key.toLowerCase().localeCompare(right.key.toLowerCase())
    );

    return {
        ...baseValset,
        extraData,
    };
};

export const buildValidatorSet = async (
    params: {
        targetEpoch: number;
        finalized: boolean;
        epochStart: number;
        config: NetworkConfig;
        includeCollateralMetadata: boolean;
        getVotingPowers: (
            provider: CrossChainAddress,
            timestamp: number,
            finalized: boolean
        ) => Promise<OperatorVotingPower[]>;
        getKeys: (
            provider: CrossChainAddress,
            timestamp: number,
            finalized: boolean
        ) => Promise<OperatorWithKeys[]>;
    } & ValidatorSetBuildContext
): Promise<ValidatorSet> => {
    const {
        targetEpoch,
        finalized,
        epochStart,
        config,
        includeCollateralMetadata,
        getVotingPowers,
        getKeys,
        getClient,
    } = params;

    const timestampNumber = Number(epochStart);

    const allVotingPowers: { chainId: number; votingPowers: OperatorVotingPower[] }[] = [];
    for (const provider of config.votingPowerProviders) {
        const votingPowers = await getVotingPowers(provider, timestampNumber, finalized);
        allVotingPowers.push({
            chainId: provider.chainId,
            votingPowers,
        });
    }

    const keys = await getKeys(config.keysProvider, timestampNumber, finalized);

    return buildValidatorSetFromData({
        targetEpoch,
        finalized,
        epochStart,
        config,
        includeCollateralMetadata,
        allVotingPowers,
        keys,
        getClient,
    });
};

export const buildValidatorSetsBatch = async (
    params: {
        targetEpochs: readonly number[];
        finalized: boolean;
        includeCollateralMetadata: boolean;
        configEntries: Map<number, { config: NetworkConfig; epochStart: number }>;
        getVotingPowersBatch: (
            provider: CrossChainAddress,
            timestamps: readonly number[],
            finalized: boolean
        ) => Promise<OperatorVotingPower[][]>;
        getKeysBatch: (
            provider: CrossChainAddress,
            timestamps: readonly number[],
            finalized: boolean
        ) => Promise<OperatorWithKeys[][]>;
    } & ValidatorSetBuildContext
): Promise<Map<number, ValidatorSet>> => {
    const {
        targetEpochs,
        finalized,
        includeCollateralMetadata,
        configEntries,
        getVotingPowersBatch,
        getKeysBatch,
        getClient,
    } = params;

    const epochInputs = targetEpochs.map(targetEpoch => {
        const entry = configEntries.get(targetEpoch);
        if (!entry) {
            throw new Error(`Missing network config for epoch ${targetEpoch}`);
        }
        return { epoch: targetEpoch, config: entry.config, epochStart: entry.epochStart };
    });

    const votingRequests = new Map<
        string,
        { provider: CrossChainAddress; items: { epoch: number; timestamp: number }[] }
    >();
    const keysRequests = new Map<
        string,
        { provider: CrossChainAddress; items: { epoch: number; timestamp: number }[] }
    >();

    for (const input of epochInputs) {
        const timestampNumber = Number(input.epochStart);

        for (const provider of input.config.votingPowerProviders) {
            const key = `${provider.chainId}:${provider.address.toLowerCase()}`;
            const entry = votingRequests.get(key) ?? { provider, items: [] };
            entry.items.push({ epoch: input.epoch, timestamp: timestampNumber });
            votingRequests.set(key, entry);
        }

        const keysProvider = input.config.keysProvider;
        const keysKey = `${keysProvider.chainId}:${keysProvider.address.toLowerCase()}`;
        const keysEntry = keysRequests.get(keysKey) ?? { provider: keysProvider, items: [] };
        keysEntry.items.push({ epoch: input.epoch, timestamp: timestampNumber });
        keysRequests.set(keysKey, keysEntry);
    }

    const votingPowersByEpoch = new Map<
        number,
        { chainId: number; votingPowers: OperatorVotingPower[] }[]
    >();
    for (const { provider, items } of votingRequests.values()) {
        const timestamps = items.map(item => item.timestamp);
        const results = await getVotingPowersBatch(provider, timestamps, finalized);
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const perEpoch = votingPowersByEpoch.get(item.epoch);
            if (!perEpoch) {
                votingPowersByEpoch.set(item.epoch, [
                    { chainId: provider.chainId, votingPowers: results[i] ?? [] },
                ]);
            } else {
                perEpoch.push({
                    chainId: provider.chainId,
                    votingPowers: results[i] ?? [],
                });
            }
        }
    }

    const keysByEpoch = new Map<number, OperatorWithKeys[]>();
    for (const { provider, items } of keysRequests.values()) {
        const timestamps = items.map(item => item.timestamp);
        const results = await getKeysBatch(provider, timestamps, finalized);
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            keysByEpoch.set(item.epoch, results[i] ?? []);
        }
    }

    const results = new Map<number, ValidatorSet>();
    for (const input of epochInputs) {
        const allVotingPowers = votingPowersByEpoch.get(input.epoch) ?? [];
        const keys = keysByEpoch.get(input.epoch) ?? [];
        const validatorSet = await buildValidatorSetFromData({
            targetEpoch: input.epoch,
            finalized,
            epochStart: input.epochStart,
            config: input.config,
            includeCollateralMetadata,
            allVotingPowers,
            keys,
            getClient,
        });
        results.set(input.epoch, validatorSet);
    }

    return results;
};
