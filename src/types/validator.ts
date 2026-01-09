import type { Address, Hex } from 'viem';

/** @notice Validator signing key with its tag. */
export class ValidatorKey {
    constructor(
        public tag: number,
        public payload: Hex
    ) {}
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
export class ValidatorVault {
    collateral?: Address;
    collateralSymbol?: string;
    collateralName?: string;

    constructor(
        public vault: Address,
        public votingPower: bigint,
        public chainId: number,
        collateral?: Address
    ) {
        this.collateral = collateral;
    }
}

/** @notice Aggregated validator record used in validator sets. */
export class Validator {
    constructor(
        public operator: Address,
        public votingPower: bigint,
        public isActive: boolean,
        public keys: ValidatorKey[],
        public vaults: ValidatorVault[]
    ) {}
}

/** @notice Voting power per vault for an operator. */
export class VaultVotingPower {
    constructor(
        public vault: Address,
        public votingPower: bigint
    ) {}
}

/** @notice Operator voting power grouped by vaults. */
export class OperatorVotingPower {
    constructor(
        public operator: Address,
        public vaults: VaultVotingPower[]
    ) {}
}

/** @notice Operator keys snapshot returned by the key registry. */
export class OperatorWithKeys {
    constructor(
        public operator: Address,
        public keys: ValidatorKey[]
    ) {}
}
