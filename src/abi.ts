export const VALSET_DRIVER_ABI = [
  {
    type: 'function',
    name: 'getConfigAt',
    inputs: [
      {
        name: 'timestamp',
        type: 'uint48',
        internalType: 'uint48',
      },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple',
        internalType: 'struct IValSetDriver.Config',
        components: [
          { name: 'numAggregators', type: 'uint208', internalType: 'uint208' },
          { name: 'numCommitters', type: 'uint208', internalType: 'uint208' },
          {
            name: 'votingPowerProviders',
            type: 'tuple[]',
            internalType: 'struct IValSetDriver.CrossChainAddress[]',
            components: [
              { name: 'chainId', type: 'uint64', internalType: 'uint64' },
              { name: 'addr', type: 'address', internalType: 'address' },
            ],
          },
          {
            name: 'keysProvider',
            type: 'tuple',
            internalType: 'struct IValSetDriver.CrossChainAddress',
            components: [
              { name: 'chainId', type: 'uint64', internalType: 'uint64' },
              { name: 'addr', type: 'address', internalType: 'address' },
            ],
          },
          {
            name: 'settlements',
            type: 'tuple[]',
            internalType: 'struct IValSetDriver.CrossChainAddress[]',
            components: [
              { name: 'chainId', type: 'uint64', internalType: 'uint64' },
              { name: 'addr', type: 'address', internalType: 'address' },
            ],
          },
          { name: 'maxVotingPower', type: 'uint256', internalType: 'uint256' },
          { name: 'minInclusionVotingPower', type: 'uint256', internalType: 'uint256' },
          { name: 'maxValidatorsCount', type: 'uint208', internalType: 'uint208' },
          { name: 'requiredKeyTags', type: 'uint8[]', internalType: 'uint8[]' },
          {
            name: 'quorumThresholds',
            type: 'tuple[]',
            internalType: 'struct IValSetDriver.QuorumThreshold[]',
            components: [
              { name: 'keyTag', type: 'uint8', internalType: 'uint8' },
              { name: 'quorumThreshold', type: 'uint248', internalType: 'uint248' },
            ],
          },
          { name: 'requiredHeaderKeyTag', type: 'uint8', internalType: 'uint8' },
          { name: 'verificationType', type: 'uint32', internalType: 'uint32' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    inputs: [],
    name: 'getCurrentEpoch',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getCurrentEpochDuration',
    outputs: [{ name: '', type: 'uint48', internalType: 'uint48' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getCurrentEpochStart',
    outputs: [{ name: '', type: 'uint48', internalType: 'uint48' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getNextEpoch',
    outputs: [{ name: '', type: 'uint48', internalType: 'uint48' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getNextEpochDuration',
    outputs: [{ name: '', type: 'uint48', internalType: 'uint48' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getNextEpochStart',
    outputs: [{ name: '', type: 'uint48', internalType: 'uint48' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    type: 'function',
    name: 'getEpochStart',
    inputs: [{ name: 'epoch', type: 'uint48', internalType: 'uint48' }],
    outputs: [{ name: '', type: 'uint48', internalType: 'uint48' }],
    stateMutability: 'view',
  },
  {
    inputs: [{ name: 'timestamp', type: 'uint48', internalType: 'uint48' }],
    name: 'getEpochIndex',
    outputs: [{ name: '', type: 'uint48', internalType: 'uint48' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'epoch', type: 'uint48', internalType: 'uint48' }],
    name: 'getEpochDuration',
    outputs: [{ name: '', type: 'uint48', internalType: 'uint48' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'SUBNETWORK',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'NETWORK',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const SETTLEMENT_ABI = [
  {
    type: 'function',
    name: 'isValSetHeaderCommittedAt',
    inputs: [{ name: 'epoch', type: 'uint48', internalType: 'uint48' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getValSetHeaderHashAt',
    inputs: [{ name: 'epoch', type: 'uint48', internalType: 'uint48' }],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getLastCommittedHeaderEpoch',
    inputs: [],
    outputs: [{ name: '', type: 'uint48', internalType: 'uint48' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'eip712Domain',
    inputs: [],
    outputs: [
      { name: 'fields', type: 'bytes1', internalType: 'bytes1' },
      { name: 'name', type: 'string', internalType: 'string' },
      { name: 'version', type: 'string', internalType: 'string' },
      { name: 'chainId', type: 'uint256', internalType: 'uint256' },
      { name: 'verifyingContract', type: 'address', internalType: 'address' },
      { name: 'salt', type: 'bytes32', internalType: 'bytes32' },
      { name: 'extensions', type: 'uint256[]', internalType: 'uint256[]' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'SetGenesis',
    inputs: [
      {
        name: 'valSetHeader',
        type: 'tuple',
        internalType: 'struct ISettlement.ValSetHeader',
        components: [
          { name: 'version', type: 'uint8', internalType: 'uint8' },
          { name: 'requiredKeyTag', type: 'uint8', internalType: 'uint8' },
          { name: 'epoch', type: 'uint48', internalType: 'uint48' },
          { name: 'captureTimestamp', type: 'uint48', internalType: 'uint48' },
          { name: 'quorumThreshold', type: 'uint256', internalType: 'uint256' },
          { name: 'totalVotingPower', type: 'uint256', internalType: 'uint256' },
          {
            name: 'validatorsSszMRoot',
            type: 'bytes32',
            internalType: 'bytes32',
          },
        ],
      },
      {
        name: 'extraData',
        type: 'tuple[]',
        internalType: 'struct ISettlement.ExtraData[]',
        components: [
          { name: 'key', type: 'bytes32', internalType: 'bytes32' },
          { name: 'value', type: 'bytes32', internalType: 'bytes32' },
        ],
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'CommitValSetHeader',
    inputs: [
      {
        name: 'valSetHeader',
        type: 'tuple',
        internalType: 'struct ISettlement.ValSetHeader',
        components: [
          { name: 'version', type: 'uint8', internalType: 'uint8' },
          { name: 'requiredKeyTag', type: 'uint8', internalType: 'uint8' },
          { name: 'epoch', type: 'uint48', internalType: 'uint48' },
          { name: 'captureTimestamp', type: 'uint48', internalType: 'uint48' },
          { name: 'quorumThreshold', type: 'uint256', internalType: 'uint256' },
          { name: 'totalVotingPower', type: 'uint256', internalType: 'uint256' },
          {
            name: 'validatorsSszMRoot',
            type: 'bytes32',
            internalType: 'bytes32',
          },
        ],
      },
      {
        name: 'extraData',
        type: 'tuple[]',
        internalType: 'struct ISettlement.ExtraData[]',
        components: [
          { name: 'key', type: 'bytes32', internalType: 'bytes32' },
          { name: 'value', type: 'bytes32', internalType: 'bytes32' },
        ],
      },
    ],
    anonymous: false,
  },
] as const;

export const VOTING_POWER_PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getVotingPowersAt',
    inputs: [
      { name: 'extraData', type: 'bytes[]', internalType: 'bytes[]' },
      { name: 'timestamp', type: 'uint48', internalType: 'uint48' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        internalType: 'struct IVotingPowerProvider.OperatorVotingPower[]',
        components: [
          { name: 'operator', type: 'address', internalType: 'address' },
          {
            name: 'vaults',
            type: 'tuple[]',
            internalType: 'struct IVotingPowerProvider.VaultValue[]',
            components: [
              { name: 'vault', type: 'address', internalType: 'address' },
              { name: 'value', type: 'uint256', internalType: 'uint256' },
            ],
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;

export const KEY_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'getKeysAt',
    inputs: [{ name: 'timestamp', type: 'uint48', internalType: 'uint48' }],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        internalType: 'struct IKeyRegistry.OperatorWithKeys[]',
        components: [
          { name: 'operator', type: 'address', internalType: 'address' },
          {
            name: 'keys',
            type: 'tuple[]',
            internalType: 'struct IKeyRegistry.Key[]',
            components: [
              { name: 'tag', type: 'uint8', internalType: 'uint8' },
              { name: 'payload', type: 'bytes', internalType: 'bytes' },
            ],
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;
