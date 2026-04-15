import { encodePacked, keccak256 } from 'viem';
import type {
    ActiveCommitterInfo,
    NetworkConfig,
    ValidatorRoles,
    ValidatorSet,
} from './types/index.js';
import { hashValidatorSet } from './validator_set.js';

const ROLE_AGGREGATOR = 'AGGREGATOR';
const ROLE_COMMITTER = 'COMMITTER';

/**
 * Deterministically assign aggregator and committer roles for an epoch.
 *
 * For each role slot the algorithm hashes ("ROLE"|headerHash|i), derives a
 * start index into the validator list, then performs a linear probe to find
 * the first unoccupied validator (wrap-around).
 *
 * All returned indices reference `validatorSet.validators`.
 */
export const getValidatorRoles = (
    validatorSet: ValidatorSet,
    config: NetworkConfig
): ValidatorRoles => {
    const headerHash = hashValidatorSet(validatorSet);
    const validatorCount = validatorSet.validators.length;

    const assignRoles = (role: string, count: number): number[] => {
        if (validatorCount === 0 || count === 0) return [];

        const assigned: number[] = [];
        const occupied = new Set<number>();
        const validatorCountBig = BigInt(validatorCount);

        for (let i = 1; i <= count; i++) {
            const hash = keccak256(
                encodePacked(['string', 'bytes32', 'uint256'], [role, headerHash, BigInt(i)])
            );
            const startIndex = Number(BigInt(hash) % validatorCountBig);

            let found = false;
            for (let offset = 0; offset < validatorCount; offset++) {
                const probeIndex = (startIndex + offset) % validatorCount;
                if (!occupied.has(probeIndex)) {
                    occupied.add(probeIndex);
                    assigned.push(probeIndex);
                    found = true;
                    break;
                }
            }

            if (!found) {
                assigned.push(startIndex);
            }
        }

        return assigned;
    };

    return {
        aggregatorIndices: assignRoles(ROLE_AGGREGATOR, config.numAggregators),
        committerIndices: assignRoles(ROLE_COMMITTER, config.numCommitters),
    };
};

/**
 * Determine the currently active committer based on round-robin time slots.
 *
 * Pure function — no RPC calls. All returned indices reference
 * `validatorSet.validators`.
 *
 * @returns `null` when `currentTime < captureTimestamp` (epoch not started).
 */
export const getActiveCommitter = (params: {
    committerIndices: number[];
    captureTimestamp: number;
    currentTime: number;
    committerSlotDuration: number;
    graceSeconds?: number;
}): ActiveCommitterInfo | null => {
    const { committerIndices, captureTimestamp, currentTime, committerSlotDuration, graceSeconds } =
        params;

    if (committerIndices.length === 0 || currentTime < captureTimestamp) return null;

    if (committerIndices.length === 1 || committerSlotDuration === 0) {
        return {
            validatorIndex: committerIndices[0],
            slotStart: captureTimestamp,
            slotEnd: Number.MAX_SAFE_INTEGER,
        };
    }

    const elapsed = currentTime - captureTimestamp;
    const slot = Math.floor(elapsed / committerSlotDuration);
    const slotStart = captureTimestamp + slot * committerSlotDuration;
    const slotEnd = slotStart + committerSlotDuration;

    if (graceSeconds != null && graceSeconds > 0 && slotEnd - currentTime <= graceSeconds) {
        const nextIdx = (slot + 1) % committerIndices.length;
        return {
            validatorIndex: committerIndices[nextIdx],
            slotStart: slotEnd,
            slotEnd: slotEnd + committerSlotDuration,
        };
    }

    return {
        validatorIndex: committerIndices[slot % committerIndices.length],
        slotStart,
        slotEnd,
    };
};
