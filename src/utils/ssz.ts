import {
    BooleanType,
    ByteVectorType,
    ContainerType,
    ListCompositeType,
    UintNumberType,
} from '@chainsafe/ssz';
import { bytesToHex, hexToBytes, keccak256, toBytes, type Hex } from 'viem';
import type { ValidatorKey, ValidatorSet } from '../types/index.js';

const UInt8 = new UintNumberType(1);
const UInt64 = new UintNumberType(8);
const Boolean = new BooleanType();
const Bytes20 = new ByteVectorType(20);
const Bytes32 = new ByteVectorType(32);

export const SszKey = new ContainerType({
    Tag: UInt8,
    PayloadHash: Bytes32,
});

export const SszVault = new ContainerType({
    ChainId: UInt64,
    Vault: Bytes20,
    VotingPower: Bytes32,
});

export const SszValidator = new ContainerType({
    Operator: Bytes20,
    VotingPower: Bytes32,
    IsActive: Boolean,
    Keys: new ListCompositeType(SszKey, 128),
    Vaults: new ListCompositeType(SszVault, 1024),
});

export const SszValidatorSet = new ContainerType({
    Validators: new ListCompositeType(SszValidator, 1048576),
});

export interface ISszKey {
    Tag: number;
    PayloadHash: Uint8Array;
}

export interface ISszVault {
    ChainId: number;
    Vault: Uint8Array;
    VotingPower: Uint8Array;
}

export interface ISszValidator {
    Operator: Uint8Array;
    VotingPower: Uint8Array;
    IsActive: boolean;
    Keys: ISszKey[];
    Vaults: ISszVault[];
}

export interface ISszValidatorSet {
    Validators: ISszValidator[];
}

/** @notice SSZ serialize a validator set. */
export const serializeValidatorSet = (validatorSet: ISszValidatorSet): Uint8Array =>
    SszValidatorSet.serialize(validatorSet);

/** @notice SSZ deserialize a validator set. */
export const deserializeValidatorSet = (bytes: Uint8Array): ISszValidatorSet =>
    SszValidatorSet.deserialize(bytes);

/** @notice Compute SSZ tree root for a validator set. */
export const getValidatorSetRoot = (validatorSet: ISszValidatorSet): Uint8Array =>
    SszValidatorSet.hashTreeRoot(validatorSet);

/** @notice Placeholder: SSZ Merkle proof not implemented for current version. */
export const proveValidator = (
    _validatorSet: ISszValidatorSet,
    _validatorIndex: number
): Uint8Array[] => {
    throw new Error('proveValidator not implemented for current SSZ version');
};

/** @notice Keccak hash of validator key payload. */
export const keyPayloadHash = (key: ValidatorKey): Uint8Array => {
    const hash = keccak256(key.payload);
    return hexToBytes(hash);
};

/** @notice Convert TS validator set into SSZ-friendly shape. */
export const validatorSetToSszValidators = (v: ValidatorSet): ISszValidatorSet => {
    return {
        Validators: v.validators.map(validator => {
            const keysOrdered = validator.keys;
            const vaultsSorted = [...validator.vaults].sort((a, b) =>
                a.vault.toLowerCase().localeCompare(b.vault.toLowerCase())
            );
            return {
                Operator: hexToBytes(validator.operator, { size: 20 }),
                VotingPower: toBytes(validator.votingPower, { size: 32 }),
                IsActive: validator.isActive,
                Keys: keysOrdered.map(k => ({
                    Tag: k.tag,
                    PayloadHash: keyPayloadHash(k),
                })),
                Vaults: vaultsSorted.map(vault => ({
                    ChainId: vault.chainId,
                    Vault: hexToBytes(vault.vault, { size: 20 }),
                    VotingPower: toBytes(vault.votingPower, { size: 32 }),
                })),
            };
        }),
    };
};

/** @notice SSZ tree root as hex string for a validator set. */
export const sszTreeRoot = (v: ValidatorSet): Hex => {
    const sszType = validatorSetToSszValidators(v);
    const root = SszValidatorSet.hashTreeRoot(sszType);
    return bytesToHex(root);
};
