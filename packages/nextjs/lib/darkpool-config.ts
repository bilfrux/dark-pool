// ─── Contract addresses ───────────────────────────────────────────────────────
// Primary: NEXT_PUBLIC_FACTORY_ADDRESS env var (set in .env after deploy).
// Fallback: hardcoded address from the last deployment — avoids a circular
// import that would occur if we imported deployedContracts.ts here
// (deployedContracts → contract.ts → deployedContracts again).
function normalizeEnvAddress(value: string | undefined, fallback: string): `0x${string}` {
  let v = value ?? "";
  v = v
    .replace(/^\s*["']?/, "")
    .replace(/["']?\s*$/, "")
    .trim();
  if (!v) return fallback as `0x${string}`;
  if (!v.startsWith("0x")) v = `0x${v}`;
  return v as `0x${string}`;
}

export const FACTORY_ADDRESS = normalizeEnvAddress(
  process.env.NEXT_PUBLIC_FACTORY_ADDRESS,
  "0xEeeF70011E37EAe0Ec00B70a85Fc7218DF685d3b",
);

// DDSC: UAE Central Bank-licensed dirham stablecoin on ADI Chain.
// Settlement is always DDSC — ADI (native) is used only for gas fees and bid deposits.
// https://adifoundation.ai/ddsc
export const DDSC_ADDRESS = normalizeEnvAddress(
  process.env.NEXT_PUBLIC_DDSC_ADDRESS,
  "0x0000000000000000000000000000000000000000",
);

// Optional ERC-20 token addresses for the wallet balance widget.
// Set these in .env once the tokens are deployed on ADI testnet.
export const ADI_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_ADI_TOKEN_ADDRESS || undefined;
export const DDSC_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_DDSC_ADDRESS || undefined;

// Settlement is always DDSC on this platform.
// ADI (native) is used only for gas fees and bid security deposits — never for settlement.
export const SETTLEMENT_TOKENS: Record<string, { label: string; address: `0x${string}` }> = {
  DDSC: { label: "DDSC (AED Stablecoin)", address: DDSC_ADDRESS },
};

// ─── Zero address ─────────────────────────────────────────────────────────────
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;
