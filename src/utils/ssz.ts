import {
    BooleanType,
    ByteVectorType,
    ContainerType,
    ListCompositeType,
    UintNumberType,
} from '@chainsafe/ssz';
import { type Hex, keccak256 } from 'viem';
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

/** @notice Convert 20-byte hex address to bytes. */
export const addressToBytes = (address: string): Uint8Array => {
    const hex = address.startsWith('0x') ? address.slice(2) : address;
    if (hex.length !== 40) {
        throw new Error('Invalid address length');
    }
    return new Uint8Array(Buffer.from(hex.padStart(40, '0'), 'hex'));
};

/** @notice Convert address bytes back to hex string. */
export const bytesToAddress = (bytes: Uint8Array): string => {
    if (bytes.length !== 20) {
        throw new Error('Invalid address bytes length');
    }
    return '0x' + Buffer.from(bytes).toString('hex');
};

/** @notice Convert bigint to fixed-length byte array. */
export const bigIntToBytes = (value: bigint, size: number): Uint8Array => {
    const hex = value.toString(16).padStart(size * 2, '0');
    return Uint8Array.from(Buffer.from(hex, 'hex'));
};

/** @notice Convert bigint to 32-byte array. */
export const bigIntToBytes32 = (value: bigint): Uint8Array => bigIntToBytes(value, 32);

/** @notice Convert 32-byte big-endian array to bigint. */
export const bytes32ToBigInt = (bytes: Uint8Array): bigint => {
    if (bytes.length !== 32) {
        throw new Error('Invalid bytes32 length');
    }
    return BigInt('0x' + Buffer.from(bytes).toString('hex'));
};

/** @notice Convert hex string to bytes. */
export const hexToBytes = (hex: string): Uint8Array => {
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (cleanHex.length % 2 !== 0) {
        throw new Error('Invalid hex string length');
    }
    return new Uint8Array(Buffer.from(cleanHex, 'hex'));
};

/** @notice Convert bytes to hex string with 0x prefix. */
export const bytesToHex = (bytes: Uint8Array): string => '0x' + Buffer.from(bytes).toString('hex');

/** @notice SSZ serialize a validator set. */
export const serializeValidatorSet = (validatorSet: ISszValidatorSet): Uint8Array =>
    SszValidatorSet.serialize(validatorSet);

/** @notice SSZ deserialize a validator set. */
export const deserializeValidatorSet = (bytes: Uint8Array): ISszValidatorSet =>
    SszValidatorSet.deserialize(bytes);

/** @notice Compute SSZ tree root for a validator set. */
export const getValidatorSetRoot = (validatorSet: ISszValidatorSet): Uint8Array =>
    SszValidatorSet.hashTreeRoot(validatorSet);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
/* eslint-disable @typescript-eslint/no-unused-vars */
/** @notice Placeholder: SSZ Merkle proof not implemented for current version. */
export const proveValidator = (
    _validatorSet: ISszValidatorSet,
    _validatorIndex: number
): Uint8Array[] => {
    throw new Error('proveValidator not implemented for current SSZ version');
};
/* eslint-enable @typescript-eslint/no-unused-vars */

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
                Operator: addressToBytes(validator.operator),
                VotingPower: bigIntToBytes32(validator.votingPower),
                IsActive: validator.isActive,
                Keys: keysOrdered.map(k => ({
                    Tag: k.tag,
                    PayloadHash: keyPayloadHash(k),
                })),
                Vaults: vaultsSorted.map(vault => ({
                    ChainId: vault.chainId,
                    Vault: addressToBytes(vault.vault),
                    VotingPower: bigIntToBytes32(vault.votingPower),
                })),
            };
        }),
    };
};

/** @notice SSZ tree root as hex string for a validator set. */
export const sszTreeRoot = (v: ValidatorSet): Hex => {
    const sszType = validatorSetToSszValidators(v);
    const root = SszValidatorSet.hashTreeRoot(sszType);
    return bytesToHex(root) as Hex;
};
