export const VOTING_POWER_PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getOperatorsAt',
    inputs: [{ name: 'timestamp', type: 'uint48', internalType: 'uint48' }],
    outputs: [{ name: '', type: 'address[]', internalType: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getOperatorVotingPowersAt',
    inputs: [
      { name: 'operator', type: 'address', internalType: 'address' },
      { name: 'extraData', type: 'bytes', internalType: 'bytes' },
      { name: 'timestamp', type: 'uint48', internalType: 'uint48' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        internalType: 'struct IVotingPowerProvider.VaultValue[]',
        components: [
          { name: 'vault', type: 'address', internalType: 'address' },
          { name: 'value', type: 'uint256', internalType: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
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
