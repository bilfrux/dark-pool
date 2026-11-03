import { getAddress, verifyMessage } from "viem";

export type KybAction = "submit" | "demo-approve";

const MAX_SIGNATURE_AGE_MS = 10 * 60 * 1000;

/** Message the user signs with their wallet to prove they own the address. Shared by client and server. */
export function buildKybMessage(action: KybAction, wallet: string, timestamp: number): string {
  return ["Dark Pool KYB", `Action: ${action}`, `Wallet: ${getAddress(wallet)}`, `Timestamp: ${timestamp}`].join("\n");
}

/** Returns an error message, or null if the signature proves ownership of `wallet`. */
export async function verifyKybSignature(
  action: KybAction,
  wallet: string,
  timestamp: unknown,
  signature: unknown,
): Promise<string | null> {
  if (typeof timestamp !== "number" || typeof signature !== "string" || !signature.startsWith("0x")) {
    return "Wallet signature required";
  }
  if (Math.abs(Date.now() - timestamp) > MAX_SIGNATURE_AGE_MS) {
    return "Signature expired, please sign again";
  }
  try {
    const valid = await verifyMessage({
      address: getAddress(wallet),
      message: buildKybMessage(action, wallet, timestamp),
      signature: signature as `0x${string}`,
    });
    return valid ? null : "Invalid wallet signature";
  } catch {
    return "Invalid wallet signature";
  }
}
