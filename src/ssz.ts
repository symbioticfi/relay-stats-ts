import {
  BooleanType,
  ByteVectorType,
  ContainerType,
  ListCompositeType,
  UintNumberType,
} from '@chainsafe/ssz';
import { type Hex, keccak256 } from 'viem';
import type { ValidatorKey, ValidatorSet } from './types.js';

// Basic SSZ types
const UInt8 = new UintNumberType(1);
const UInt64 = new UintNumberType(8);
const Boolean = new BooleanType();
const Bytes20 = new ByteVectorType(20); // Address type
const Bytes32 = new ByteVectorType(32); // Hash type

// SSZ Key type (matches Go implementation - only Tag and PayloadHash)
const SszKey = new ContainerType({
  Tag: UInt8,
  PayloadHash: Bytes32,
});

// SSZ Vault type
const SszVault = new ContainerType({
  ChainId: UInt64,
  Vault: Bytes20,
  VotingPower: Bytes32,
});

// SSZ Validator type
const SszValidator = new ContainerType({
  Operator: Bytes20,
  VotingPower: Bytes32,
  IsActive: Boolean,
  Keys: new ListCompositeType(SszKey, 128), // max 128 keys
  Vaults: new ListCompositeType(SszVault, 1024), // max 1024 vaults
});

// SSZ ValidatorSet type (only Validators are part of SSZ root; Version is NOT included)
const SszValidatorSet = new ContainerType({
  Validators: new ListCompositeType(SszValidator, 1048576), // max 1048576 validators
});

// Export types and their TypeScript interfaces
export { SszKey, SszVault, SszValidator, SszValidatorSet };

// TypeScript interfaces for type safety
export interface ISszKey {
  Tag: number;
  PayloadHash: Uint8Array; // 32 bytes
}

export interface ISszVault {
  ChainId: number;
  Vault: Uint8Array; // 20 bytes (Ethereum address)
  VotingPower: Uint8Array; // 32 bytes (big.Int representation)
}

export interface ISszValidator {
  Operator: Uint8Array; // 20 bytes (Ethereum address)
  VotingPower: Uint8Array; // 32 bytes (big.Int representation)
  IsActive: boolean;
  Keys: ISszKey[];
  Vaults: ISszVault[];
}

export interface ISszValidatorSet {
  Validators: ISszValidator[];
}

// Utility functions for working with addresses and big integers

/**
 * Convert hex string address to Uint8Array
 */
export function addressToBytes(address: string): Uint8Array {
  const hex = address.startsWith('0x') ? address.slice(2) : address;
  if (hex.length !== 40) {
    throw new Error('Invalid address length');
  }
  return new Uint8Array(Buffer.from(hex.padStart(40, '0'), 'hex'));
}

/**
 * Convert Uint8Array to hex string address
 */
export function bytesToAddress(bytes: Uint8Array): string {
  if (bytes.length !== 20) {
    throw new Error('Invalid address bytes length');
  }
  return '0x' + Buffer.from(bytes).toString('hex');
}

/**
 * Convert BigInt to 32-byte Uint8Array (big-endian)
 */
export function bigIntToBytes32(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array(32);
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  const minimal = new Uint8Array(Buffer.from(hex, 'hex'));
  if (minimal.length > 32) throw new Error('bigint too large to fit in 32 bytes');
  const out = new Uint8Array(32);
  out.set(minimal, 0); // right-pad with zeros to 32
  return out;
}

/**
 * Convert 32-byte Uint8Array to BigInt
 */
export function bytes32ToBigInt(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) {
    throw new Error('Invalid bytes32 length');
  }
  return BigInt('0x' + Buffer.from(bytes).toString('hex'));
}

/**
 * Convert hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (cleanHex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  return new Uint8Array(Buffer.from(cleanHex, 'hex'));
}

/**
 * Convert Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex');
}

// Serialization functions

/**
 * Serialize a validator set to SSZ bytes
 */
export function serializeValidatorSet(validatorSet: ISszValidatorSet): Uint8Array {
  return SszValidatorSet.serialize(validatorSet);
}

/**
 * Deserialize SSZ bytes to a validator set
 */
export function deserializeValidatorSet(bytes: Uint8Array): ISszValidatorSet {
  return SszValidatorSet.deserialize(bytes);
}

/**
 * Get the hash tree root of a validator set
 */
export function getValidatorSetRoot(validatorSet: ISszValidatorSet): Uint8Array {
  return SszValidatorSet.hashTreeRoot(validatorSet);
}

/**
 * Create a Merkle proof for a specific validator
 */
export function proveValidator(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _validatorSet: ISszValidatorSet,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _validatorIndex: number,
): Uint8Array[] {
  // Proof generation requires SSZ Merkle tree internals that are not stable across versions.
  // Leaving as a placeholder to avoid build errors; implement as needed with the
  // selected @chainsafe/ssz version's Merkle API.
  throw new Error('proveValidator not implemented for current SSZ version');
}

// Conversion functions (equivalent to your Go functions)

/**
 * Calculate key payload hash using Keccak256 (matches Go implementation)
 * Go equivalent: crypto.Keccak256Hash(k.Payload)
 */
export function keyPayloadHash(key: ValidatorKey): Uint8Array {
  const hash = keccak256(key.payload);
  // Remove '0x' prefix and convert to Uint8Array
  return hexToBytes(hash);
}

/**
 * Convert ValidatorSet to SszValidatorSet (equivalent to validatorSetToSszValidators)
 */
export function validatorSetToSszValidators(v: ValidatorSet): ISszValidatorSet {
  // Use input order for validators; sort vaults by address to match Go
  const validatorsSorted = v.validators;
  return {
    Validators: validatorsSorted.map((validator) => {
      const keysOrdered = validator.keys; // preserve given order
      const vaultsSorted = [...validator.vaults].sort((a, b) =>
        a.vault.toLowerCase().localeCompare(b.vault.toLowerCase()),
      );
      return {
        Operator: addressToBytes(validator.operator),
        VotingPower: bigIntToBytes32(validator.votingPower),
        IsActive: validator.isActive,
        Keys: keysOrdered.map((k) => ({
          Tag: k.tag,
          PayloadHash: keyPayloadHash(k),
        })),
        Vaults: vaultsSorted.map((vault) => ({
          ChainId: vault.chainId,
          Vault: addressToBytes(vault.vault),
          VotingPower: bigIntToBytes32(vault.votingPower),
        })),
      };
    }),
  };
}

/**
 * Calculate SSZ tree root and return as hex string (equivalent to sszTreeRoot)
 */
export function sszTreeRoot(v: ValidatorSet): Hex {
  const sszType = validatorSetToSszValidators(v);
  const root = SszValidatorSet.hashTreeRoot(sszType);
  return bytesToHex(root) as Hex;
}
