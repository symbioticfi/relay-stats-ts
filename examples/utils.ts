import { type Address } from 'viem';

export const DEFAULT_RPC_URLS = ['http://localhost:8545', 'http://localhost:8546'];
export const DEFAULT_DRIVER_ADDRESS: Address = '0x43C27243F96591892976FFf886511807B65a33d5';
export const DEFAULT_DRIVER_CHAIN_ID = 31337;

const COLORS = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    gray: '\x1b[90m',
};

export const ui = {
    heading: (text: string) => console.log(`${COLORS.bold}${COLORS.cyan}${text}${COLORS.reset}`),
    section: (title: string) =>
        console.log(`\n${COLORS.bold}${COLORS.magenta}=== ${title} ===${COLORS.reset}`),
    info: (label: string, value: unknown) =>
        console.log(`${COLORS.bold}${label}:${COLORS.reset} ${value}`),
    success: (message: string) => console.log(`${COLORS.green}+ ${message}${COLORS.reset}`),
    warn: (message: string) => console.log(`${COLORS.yellow}! ${message}${COLORS.reset}`),
    error: (message: string) => console.log(`${COLORS.red}x ${message}${COLORS.reset}`),
    bullet: (text: string) => console.log(`  ${COLORS.gray}-${COLORS.reset} ${text}`),
    numbered: (index: number, text: string) =>
        console.log(`  ${COLORS.gray}${index}.${COLORS.reset} ${text}`),
    blank: () => console.log(),
};

export function parseRpcUrls(raw: string | undefined): string[] {
    if (!raw) return DEFAULT_RPC_URLS;
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            const urls = parsed.map(v => String(v).trim()).filter(Boolean);
            if (urls.length > 0) return urls;
        }
    } catch {
        // fall through
    }
    const split = raw
        .split(/[\n,]/)
        .map(v => v.trim())
        .filter(Boolean);
    return split.length > 0 ? split : DEFAULT_RPC_URLS;
}

export function parseChainId(raw: string | undefined): number {
    if (!raw) return DEFAULT_DRIVER_CHAIN_ID;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? DEFAULT_DRIVER_CHAIN_ID : parsed;
}

export function parseDriverAddress(raw: string | undefined): Address {
    if (!raw) return DEFAULT_DRIVER_ADDRESS;
    const trimmed = raw.trim();
    return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? (trimmed as Address) : DEFAULT_DRIVER_ADDRESS;
}

export function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
