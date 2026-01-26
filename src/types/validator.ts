import type { Address, Hex } from 'viem';

/** @notice Validator signing key with its tag. */
export interface ValidatorKey {
    tag: number;
    payload: Hex;
}

export enum KeyType {
    KeyTypeBlsBn254 = 0,
    KeyTypeEcdsaSecp256k1 = 1,
    KeyTypeInvalid = 255,
}

export type KeyTag = number;

/** @notice Resolve the key type from a serialized key tag nibble. */
export function getKeyType(tag: KeyTag): KeyType {
    switch (tag >> 4) {
        case 0:
            return KeyType.KeyTypeBlsBn254;
        case 1:
            return KeyType.KeyTypeEcdsaSecp256k1;
        default:
            return KeyType.KeyTypeInvalid;
    }
}

/** @notice Validator vault entry with optional collateral metadata. */
export interface ValidatorVault {
    vault: Address;
    votingPower: bigint;
    chainId: number;
    collateral?: Address;
    collateralSymbol?: string;
    collateralName?: string;
}

/** @notice Aggregated validator record used in validator sets. */
export interface Validator {
    operator: Address;
    votingPower: bigint;
    isActive: boolean;
    keys: ValidatorKey[];
    vaults: ValidatorVault[];
}

/** @notice Voting power per vault for an operator. */
export interface VaultVotingPower {
    vault: Address;
    votingPower: bigint;
}

/** @notice Operator voting power grouped by vaults. */
export interface OperatorVotingPower {
    operator: Address;
    vaults: VaultVotingPower[];
}

/** @notice Operator keys snapshot returned by the key registry. */
export interface OperatorWithKeys {
    operator: Address;
    keys: ValidatorKey[];
}
