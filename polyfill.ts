import { Buffer } from "buffer";

declare global {
  // Augment globalThis so TypeScript allows Buffer assignment in browser context

  interface Global {
    Buffer: typeof Buffer;
  }
  interface Window {
    Buffer: typeof Buffer;
  }
}

const globalWithBuffer = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer;
};

if (!globalWithBuffer.Buffer) {
  globalWithBuffer.Buffer = Buffer;
}
