export const KEY_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'getKeysOperatorsAt',
    inputs: [{ name: 'timestamp', type: 'uint48', internalType: 'uint48' }],
    outputs: [{ name: '', type: 'address[]', internalType: 'address[]' }],
    stateMutability: 'view',
  },
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
  {
    type: 'function',
    name: 'getKeysAt',
    inputs: [
      { name: 'operator', type: 'address', internalType: 'address' },
      { name: 'timestamp', type: 'uint48', internalType: 'uint48' },
    ],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        internalType: 'struct IKeyRegistry.Key[]',
        components: [
          { name: 'tag', type: 'uint8', internalType: 'uint8' },
          { name: 'payload', type: 'bytes', internalType: 'bytes' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;
