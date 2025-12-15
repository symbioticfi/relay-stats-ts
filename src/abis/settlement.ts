export const SETTLEMENT_ABI = [
  {
    type: 'function',
    name: 'commitValSetHeader',
    inputs: [
      {
        name: 'header',
        type: 'tuple',
        internalType: 'struct ISettlement.ValSetHeader',
        components: [
          { name: 'version', type: 'uint8', internalType: 'uint8' },
          { name: 'requiredKeyTag', type: 'uint8', internalType: 'uint8' },
          { name: 'epoch', type: 'uint48', internalType: 'uint48' },
          { name: 'captureTimestamp', type: 'uint48', internalType: 'uint48' },
          { name: 'quorumThreshold', type: 'uint256', internalType: 'uint256' },
          { name: 'totalVotingPower', type: 'uint256', internalType: 'uint256' },
          { name: 'validatorsSszMRoot', type: 'bytes32', internalType: 'bytes32' },
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
      { name: 'proof', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
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
