// ported from prism-service src/services/mcp/McpSecretBox.ts
import crypto from "crypto";
import { MCP_OAUTH_ENCRYPTION_KEY } from "../../../config.ts";

/**
 * AES-256-GCM for MCP OAuth secrets at rest (access and refresh tokens,
 * client registrations, the PKCE verifier). The key comes from the vault
 * (`MCP_OAUTH_ENCRYPTION_KEY`, 32 bytes as base64 or hex); without it
 * nothing is stored and OAuth servers can't be connected.
 */

export interface SealedValue {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export class McpOAuthKeyMissingError extends Error {
  constructor() {
    super(
      "MCP OAuth is not configured: MCP_OAUTH_ENCRYPTION_KEY (32 bytes, base64 or hex) is missing, so tokens can't be stored.",
    );
    this.name = "McpOAuthKeyMissingError";
  }
}

let cachedKey: Buffer | null | undefined;

function decodeKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const candidates = [
    /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : null,
    Buffer.from(trimmed, "base64"),
  ];
  return candidates.find((candidate) => candidate?.length === 32) ?? null;
}

function key(): Buffer {
  if (cachedKey === undefined) cachedKey = decodeKey(MCP_OAUTH_ENCRYPTION_KEY);
  if (!cachedKey) throw new McpOAuthKeyMissingError();
  return cachedKey;
}

export function isMcpOAuthConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function seal(value: unknown): SealedValue {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export function open<T>(sealed: SealedValue | null | undefined): T | undefined {
  if (!sealed || sealed.v !== 1) return undefined;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(sealed.data, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString("utf8")) as T;
}

/** Test seam: re-read the key. */
export function resetSecretBoxKey(): void {
  cachedKey = undefined;
}
