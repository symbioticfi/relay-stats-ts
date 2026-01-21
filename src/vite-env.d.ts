/// <reference types="vite/client" />

// Extend Vite's ImportMetaEnv interface with our custom environment variables
interface ImportMetaEnv {
  readonly VITE_RELAY_RPC_URLS?: string;
  readonly VITE_RELAY_DRIVER_ADDRESS?: string;
  readonly VITE_RELAY_DRIVER_CHAIN_ID?: string;
}
