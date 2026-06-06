import {
    BooleanType,
    ByteVectorType,
    ContainerType,
    ListCompositeType,
    UintNumberType,
} from '@chainsafe/ssz';
import { bytesToHex, hexToBytes, keccak256, sha256, toBytes, type Hex } from 'viem';
import type { ValidatorKey, ValidatorSet } from '../types/index.js';

const UInt8 = new UintNumberType(1);
const UInt64 = new UintNumberType(8);
const Boolean = new BooleanType();
const Bytes20 = new ByteVectorType(20);
const Bytes32 = new ByteVectorType(32);
const SSZ_KEY_LIMIT = 128;
const SSZ_VAULT_LIMIT = 1024;
const SSZ_VALIDATOR_LIMIT = 1048576;
const ZERO_CHUNK = new Uint8Array(32);

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
    Keys: new ListCompositeType(SszKey, SSZ_KEY_LIMIT),
    Vaults: new ListCompositeType(SszVault, SSZ_VAULT_LIMIT),
});

export const SszValidatorSet = new ContainerType({
    Validators: new ListCompositeType(SszValidator, SSZ_VALIDATOR_LIMIT),
});

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
};

const zeroHashes = (() => {
    const hashes: Uint8Array[] = [ZERO_CHUNK];
    for (let i = 0; i < 64; i++) {
        hashes.push(hexToBytes(sha256(concatBytes([hashes[i], hashes[i]]))));
    }
    return hashes;
})();

const appendBytes32 = (chunks: Uint8Array[], bytes: Uint8Array): void => {
    if (bytes.length === 0) return;
    if (bytes.length > 32) {
        throw new Error(`Expected at most 32 bytes, received ${bytes.length}`);
    }
    const chunk = new Uint8Array(32);
    chunk.set(bytes);
    chunks.push(chunk);
};

const uint8Chunk = (value: number): Uint8Array => Uint8Array.of(value & 0xff);

const uint64Chunk = (value: number): Uint8Array => {
    const chunk = new Uint8Array(8);
    const view = new DataView(chunk.buffer);
    view.setBigUint64(0, BigInt(value), true);
    return chunk;
};

const boolChunk = (value: boolean): Uint8Array => {
    const chunk = new Uint8Array(32);
    if (value) chunk[0] = 1;
    return chunk;
};

const votingPowerBytes = (value: bigint): Uint8Array => {
    if (value === 0n) return new Uint8Array();
    let hex = value.toString(16);
    if (hex.length % 2 !== 0) hex = `0${hex}`;
    return hexToBytes(`0x${hex}`);
};

const trimLeadingZeroBytes = (bytes: Uint8Array): Uint8Array => {
    let offset = 0;
    while (offset < bytes.length && bytes[offset] === 0) {
        offset++;
    }
    return bytes.slice(offset);
};

const getDepth = (limit: number): number => {
    if (limit <= 1) return 0;
    return Math.ceil(Math.log2(limit));
};

const merkleize = (inputChunks: readonly Uint8Array[], limit = 0): Uint8Array => {
    let input = concatBytes(inputChunks);
    const count = Math.ceil(input.length / 32);
    const effectiveLimit = limit === 0 ? count : limit;

    if (count > effectiveLimit) {
        throw new Error(`SSZ chunk count ${count} exceeds limit ${effectiveLimit}`);
    }

    if (effectiveLimit === 0) return ZERO_CHUNK;
    if (effectiveLimit === 1) {
        return count === 1 ? input.slice(0, 32) : ZERO_CHUNK;
    }

    const depth = getDepth(effectiveLimit);
    if (input.length === 0) return zeroHashes[depth];

    for (let level = 0; level < depth; level++) {
        let layerLen = Math.floor(input.length / 32);
        if (layerLen % 2 === 1) {
            input = concatBytes([input, zeroHashes[level]]);
            layerLen++;
        }

        const output = new Uint8Array((layerLen / 2) * 32);
        for (let offset = 0; offset < input.length; offset += 64) {
            const parent = hexToBytes(sha256(input.slice(offset, offset + 64)));
            output.set(parent, (offset / 64) * 32);
        }
        input = output;
    }

    return input;
};

const mixInLength = (root: Uint8Array, length: number): Uint8Array => {
    const lengthChunk = new Uint8Array(32);
    new DataView(lengthChunk.buffer).setBigUint64(0, BigInt(length), true);
    return hexToBytes(sha256(concatBytes([root, lengthChunk])));
};

const merkleizeList = (roots: readonly Uint8Array[], length: number, limit: number): Uint8Array =>
    mixInLength(merkleize(roots, limit), length);

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

const sszKeyRootFromSsz = (key: ISszKey): Uint8Array => {
    const chunks: Uint8Array[] = [];
    appendBytes32(chunks, uint8Chunk(key.Tag));
    appendBytes32(chunks, key.PayloadHash);
    return merkleize(chunks);
};

const sszVaultRootFromSsz = (vault: ISszVault): Uint8Array => {
    const chunks: Uint8Array[] = [];
    appendBytes32(chunks, uint64Chunk(vault.ChainId));
    appendBytes32(chunks, vault.Vault);
    appendBytes32(chunks, trimLeadingZeroBytes(vault.VotingPower));
    return merkleize(chunks);
};

const sszValidatorRootFromSsz = (validator: ISszValidator): Uint8Array => {
    const chunks: Uint8Array[] = [];
    appendBytes32(chunks, validator.Operator);
    appendBytes32(chunks, trimLeadingZeroBytes(validator.VotingPower));
    chunks.push(boolChunk(validator.IsActive));
    chunks.push(
        merkleizeList(validator.Keys.map(sszKeyRootFromSsz), validator.Keys.length, SSZ_KEY_LIMIT)
    );
    chunks.push(
        merkleizeList(
            validator.Vaults.map(sszVaultRootFromSsz),
            validator.Vaults.length,
            SSZ_VAULT_LIMIT
        )
    );
    return merkleize(chunks);
};

/**
 * @notice Compute Relay-compatible SSZ tree root for a validator set.
 *
 * Relay's generated fastssz hash tree root hashes big.Int voting power with
 * VotingPower.Bytes(), so leading zero bytes must be stripped before hashing.
 */
export const getValidatorSetRoot = (validatorSet: ISszValidatorSet): Uint8Array =>
    merkleizeList(
        validatorSet.Validators.map(sszValidatorRootFromSsz),
        validatorSet.Validators.length,
        SSZ_VALIDATOR_LIMIT
    );

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

const sszKeyRoot = (key: ValidatorKey): Uint8Array => {
    const chunks: Uint8Array[] = [];
    appendBytes32(chunks, uint8Chunk(key.tag));
    appendBytes32(chunks, keyPayloadHash(key));
    return merkleize(chunks);
};

const sszVaultRoot = (vault: { chainId: number; vault: Hex; votingPower: bigint }): Uint8Array => {
    const chunks: Uint8Array[] = [];
    appendBytes32(chunks, uint64Chunk(vault.chainId));
    appendBytes32(chunks, hexToBytes(vault.vault));
    appendBytes32(chunks, votingPowerBytes(vault.votingPower));
    return merkleize(chunks);
};

const sszValidatorRoot = (validator: ValidatorSet['validators'][number]): Uint8Array => {
    const chunks: Uint8Array[] = [];
    appendBytes32(chunks, hexToBytes(validator.operator));
    appendBytes32(chunks, votingPowerBytes(validator.votingPower));
    chunks.push(boolChunk(validator.isActive));
    chunks.push(
        merkleizeList(validator.keys.map(sszKeyRoot), validator.keys.length, SSZ_KEY_LIMIT)
    );
    chunks.push(
        merkleizeList(validator.vaults.map(sszVaultRoot), validator.vaults.length, SSZ_VAULT_LIMIT)
    );
    return merkleize(chunks);
};

/** @notice Convert TS validator set into SSZ-friendly shape. */
export const validatorSetToSszValidators = (v: ValidatorSet): ISszValidatorSet => {
    const validators = v.allValidators ?? v.validators;
    return {
        Validators: validators.map(validator => {
            const keysOrdered = validator.keys;
            return {
                Operator: hexToBytes(validator.operator, { size: 20 }),
                VotingPower: toBytes(validator.votingPower, { size: 32 }),
                IsActive: validator.isActive,
                Keys: keysOrdered.map(k => ({
                    Tag: k.tag,
                    PayloadHash: keyPayloadHash(k),
                })),
                Vaults: validator.vaults.map(vault => ({
                    ChainId: vault.chainId,
                    Vault: hexToBytes(vault.vault, { size: 20 }),
                    VotingPower: toBytes(vault.votingPower, { size: 32 }),
                })),
            };
        }),
    };
};

/** @notice Relay-compatible SSZ tree root as hex string for a validator set. */
export const sszTreeRoot = (v: ValidatorSet): Hex => {
    const validators = v.allValidators ?? v.validators;
    const root = merkleizeList(
        validators.map(sszValidatorRoot),
        validators.length,
        SSZ_VALIDATOR_LIMIT
    );
    return bytesToHex(root);
};
