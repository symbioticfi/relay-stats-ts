import {
  ValidatorSetDeriver,
  ValidatorSetDeriverConfig,
} from "@symbioticfi/relay-stats-ts";

function parseEnvArray(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readEnvConfig(): ValidatorSetDeriverConfig {
  const rpcUrls = parseEnvArray(import.meta.env.VITE_RELAY_RPC_URLS);
  const driverAddress = import.meta.env.VITE_RELAY_DRIVER_ADDRESS;
  const driverChainId = import.meta.env.VITE_RELAY_DRIVER_CHAIN_ID;

  const parsedChainId = driverChainId ? Number(driverChainId) : NaN;

  const fallbackDriverAddress = "0xE1A1629C2a0447eA1e787527329805B234ac605C";
  const fallbackChainId = 31337;
  const resolvedRpcUrls =
    rpcUrls.length > 0
      ? rpcUrls
      : ["http://127.0.0.1:8545", "http://127.0.0.1:8546"];
  const resolvedDriverAddress = driverAddress ?? fallbackDriverAddress;
  const resolvedChainId = Number.isNaN(parsedChainId)
    ? fallbackChainId
    : parsedChainId;

  return {
    rpcUrls: resolvedRpcUrls,
    driverAddress: {
      chainId: resolvedChainId,
      address: resolvedDriverAddress,
    },
    maxSavedEpochs: 200,
  };
}

class RelayStatsClient {
  private deriverPromise: Promise<ValidatorSetDeriver> | null = null;
  private readonly config: ValidatorSetDeriverConfig;

  constructor() {
    this.config = readEnvConfig();
  }

  private async getDeriver(): Promise<ValidatorSetDeriver> {
    if (!this.deriverPromise) {
      this.deriverPromise = ValidatorSetDeriver.create(this.config)
        .then((instance) => {
          const originalGetCurrentEpoch =
            instance.getCurrentEpoch.bind(instance);
          type EpochMemoEntry = {
            value?: number;
            timestamp: number;
            pending?: Promise<number>;
          };
          const epochCache = new Map<string, EpochMemoEntry>();

          instance.getCurrentEpoch = async (
            finalized = true
          ): Promise<number> => {
            const key = finalized ? "finalized" : "latest";
            const ttl = finalized ? 5_000 : 1_000;
            const now = Date.now();
            const entry = epochCache.get(key);

            if (entry?.value !== undefined && now - entry.timestamp < ttl) {
              return entry.value;
            }

            if (entry?.pending) {
              return entry.pending;
            }

            const pending = originalGetCurrentEpoch(finalized)
              .then((value) => {
                epochCache.set(key, { value, timestamp: Date.now() });
                return value;
              })
              .catch((error) => {
                epochCache.delete(key);
                throw error;
              });

            epochCache.set(key, { pending, timestamp: now });
            return pending;
          };

          return instance;
        })
        .catch((error) => {
          this.deriverPromise = null;
          throw error;
        });
    }
    return this.deriverPromise;
  }

  async getCurrentEpoch(finalized = true): Promise<number> {
    const deriver = await this.getDeriver();
    return await deriver.getCurrentEpoch(finalized);
  }

  async getEpochData(epoch?: number) {
    console.log("getEpochData", epoch);
    const finalized = true;

    const deriver = await this.getDeriver();
    let targetEpoch: number;

    if (epoch === undefined) {
      targetEpoch = await deriver.getCurrentEpoch(finalized);
    } else {
      targetEpoch = epoch;
    }

    console.log({ epoch: targetEpoch });
    const epochData = await deriver.getEpochData({
      epoch: targetEpoch,
      finalized,
      includeNetworkData: true,
      includeValSetEvent: true,
    });
    console.log({ epochData });
  }
}

let client: RelayStatsClient | null = null;

export function getRelayStatsClient(): RelayStatsClient {
  if (!client) {
    client = new RelayStatsClient();
  }
  return client;
}
