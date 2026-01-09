import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import type {
    NetworkConfig,
    OperatorVotingPower,
    OperatorWithKeys,
    Validator,
    ValidatorSet,
    ValidatorSetHeader,
} from './types/index.js';
import { SSZ_MAX_VALIDATORS, SSZ_MAX_VAULTS } from './constants.js';
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
