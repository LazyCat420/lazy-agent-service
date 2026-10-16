// ported from prism-service src/services/mcp/McpOAuth.ts (adapted to @modelcontextprotocol/sdk 1.29's OAuthClientProvider; keyed by serverId + username, no profiles, no issuer binding)
import crypto from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import logger from "../../utils/logger.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME, LAZY_AGENT_SERVICE_PUBLIC_URL } from "../../../config.ts";
import { COLLECTIONS } from "../../constants.ts";
import { open, seal, type SealedValue } from "./McpSecretBox.ts";

/**
 * MCP OAuth — OAuth 2.1 with PKCE for remote MCP servers, through the SDK's
 * `OAuthClientProvider`.
 *
 * The SDK discovers the authorization server and registers the client
 * dynamically (RFC 7591); this module stores the credentials per server.
 * Tokens, client registrations and the PKCE verifier are encrypted at rest
 * (McpSecretBox) in COLLECTIONS.MCP_OAUTH and are never logged or returned by
 * any route (`getMcpOAuthStatus` reports state only). Discovery state is
 * public authorization-server metadata and stays plain.
 *
 * The flow:
 *   1. A connect finds no tokens. The SDK registers and calls
 *      `redirectToAuthorization(url)`; the connect fails with
 *      McpAuthorizationRequiredError carrying that URL.
 *   2. The client opens the URL in a popup.
 *   3. The authorization server redirects to `/mcp/oauth/callback?code&state`.
 *      The route finds the flow by its `state`, has the SDK exchange the code
 *      (with the stored PKCE verifier), and connects the server.
 *   4. Access tokens are refreshed by the SDK on a 401 with the stored
 *      refresh token.
 */

export const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";
const OAUTH_STATE_TTL_MILLISECONDS = 15 * 60_000;

export interface McpOAuthIdentity {
  serverId: string;
  username: string;
}

export type McpOAuthStatus = "none" | "pending" | "authorized" | "failed";

interface McpOAuthRecord {
  serverId: string;
  username: string;
  status: McpOAuthStatus;
  redirectUrl?: string;
  scope?: string | null;
  tokens?: SealedValue;
  tokensExpiresAt?: string | null;
  clientInformation?: SealedValue;
  codeVerifier?: SealedValue;
  discoveryState?: OAuthDiscoveryState;
  state?: string;
  stateExpiresAt?: string;
  error?: string | null;
  updatedAt: string;
}

export class McpAuthorizationRequiredError extends Error {
  readonly authorizationUrl: string;
  constructor(serverName: string, authorizationUrl: string) {
    super(`MCP server "${serverName}" needs authorization: open ${authorizationUrl}`);
    this.name = "McpAuthorizationRequiredError";
    this.authorizationUrl = authorizationUrl;
  }
}

// ── Store ──────────────────────────────────────────────────────────────

/** Without a database (unit tests, a failed connect) records live here. */
const memoryRecords = new Map<string, McpOAuthRecord>();

function collection() {
  try {
    return MongoWrapper.getDb(MONGO_DB_NAME)?.collection<McpOAuthRecord>(COLLECTIONS.MCP_OAUTH) ?? null;
  } catch {
    return null;
  }
}

async function loadRecord(identity: McpOAuthIdentity): Promise<McpOAuthRecord | null> {
  const store = collection();
  if (!store) return memoryRecords.get(identity.serverId) ?? null;
  return store.findOne({ serverId: identity.serverId });
}

async function updateRecord(
  identity: McpOAuthIdentity,
  set: Partial<McpOAuthRecord>,
  unset: Array<keyof McpOAuthRecord> = [],
): Promise<void> {
  const updatedAt = new Date().toISOString();
  const store = collection();
  if (!store) {
    const current: McpOAuthRecord = memoryRecords.get(identity.serverId) ?? {
      serverId: identity.serverId,
      username: identity.username,
      status: "none",
      updatedAt,
    };
    const next: McpOAuthRecord = { ...current, ...set, updatedAt };
    for (const field of unset) delete next[field];
    memoryRecords.set(identity.serverId, next);
    return;
  }
  await store.updateOne(
    { serverId: identity.serverId },
    {
      $set: { ...set, updatedAt },
      $setOnInsert: { username: identity.username, ...(set.status ? {} : { status: "none" as const }) },
      ...(unset.length > 0 && {
        $unset: Object.fromEntries(unset.map((field) => [field, ""])),
      }),
    },
    { upsert: true },
  );
}

async function findRecordByState(state: string): Promise<McpOAuthRecord | null> {
  const store = collection();
  if (!store) {
    return [...memoryRecords.values()].find((record) => record.state === state) ?? null;
  }
  return store.findOne({ state });
}

/** What the API shows about a server's authorization — never a secret. */
export async function getMcpOAuthStatus(identity: McpOAuthIdentity) {
  const record = await loadRecord(identity);
  return {
    status: record?.status ?? "none",
    authorized: Boolean(record?.tokens),
    expiresAt: record?.tokensExpiresAt ?? null,
    error: record?.error ?? null,
    updatedAt: record?.updatedAt ?? null,
  };
}

/** Forget a server's tokens and registration (sign out). */
export async function forgetMcpOAuth(identity: McpOAuthIdentity): Promise<void> {
  await updateRecord(identity, { status: "none", error: null }, [
    "tokens",
    "tokensExpiresAt",
    "clientInformation",
    "codeVerifier",
    "discoveryState",
    "state",
    "stateExpiresAt",
  ]);
}

/** Test seam. */
export function resetMcpOAuthMemory(): void {
  memoryRecords.clear();
}

// ── Redirect ───────────────────────────────────────────────────────────

/** The redirect URI: the configured public origin when there is one, else the origin the flow was started from. */
export function resolveOAuthRedirectUrl(requestOrigin?: string | null): string {
  const origin = (LAZY_AGENT_SERVICE_PUBLIC_URL || requestOrigin || "").replace(/\/+$/, "");
  if (!origin) {
    throw new Error("No origin for the MCP OAuth redirect: set LAZY_AGENT_SERVICE_PUBLIC_URL.");
  }
  return `${origin}${MCP_OAUTH_CALLBACK_PATH}`;
}

/**
 * The redirect for a server's provider: the configured or request origin,
 * else the redirect its last flow used (a reconnect after the callback, or a
 * boot with no public origin).
 */
export async function resolveProviderRedirectUrl(
  identity: McpOAuthIdentity,
  requestOrigin?: string | null,
): Promise<string> {
  if (LAZY_AGENT_SERVICE_PUBLIC_URL || requestOrigin) return resolveOAuthRedirectUrl(requestOrigin);
  const stored = (await loadRecord(identity))?.redirectUrl;
  return stored ?? resolveOAuthRedirectUrl();
}

// ── Provider ───────────────────────────────────────────────────────────

export class McpOAuthProvider implements OAuthClientProvider {
  /** Set when the SDK sends the user to the authorization server. */
  authorizationUrl: string | null = null;
  private readonly identity: McpOAuthIdentity;
  private readonly redirect: string;
  private readonly scope: string | null;

  constructor(identity: McpOAuthIdentity, redirect: string, scope: string | null = null) {
    this.identity = identity;
    this.redirect = redirect;
    this.scope = scope;
  }

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "lazy-agent-service",
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  async state(): Promise<string> {
    const state = crypto.randomBytes(24).toString("base64url");
    await updateRecord(this.identity, {
      state,
      stateExpiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MILLISECONDS).toISOString(),
      redirectUrl: this.redirect,
      scope: this.scope,
    });
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const record = await loadRecord(this.identity);
    return open<OAuthClientInformationMixed>(record?.clientInformation);
  }

  async saveClientInformation(information: OAuthClientInformationMixed): Promise<void> {
    await updateRecord(this.identity, { clientInformation: seal(information) });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const record = await loadRecord(this.identity);
    return open<OAuthTokens>(record?.tokens);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const expiresAt =
      typeof tokens.expires_in === "number"
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null;
    await updateRecord(
      this.identity,
      { tokens: seal(tokens), tokensExpiresAt: expiresAt, status: "authorized", error: null },
      ["codeVerifier", "state", "stateExpiresAt"],
    );
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.authorizationUrl = authorizationUrl.toString();
    await updateRecord(this.identity, { status: "pending", error: null });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await updateRecord(this.identity, { codeVerifier: seal(codeVerifier) });
  }

  async codeVerifier(): Promise<string> {
    const verifier = open<string>((await loadRecord(this.identity))?.codeVerifier);
    if (!verifier) throw new Error("No PKCE code verifier for this authorization");
    return verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await updateRecord(this.identity, { discoveryState: state });
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await loadRecord(this.identity))?.discoveryState ?? undefined;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const fields: Record<typeof scope, Array<keyof McpOAuthRecord>> = {
      all: ["tokens", "tokensExpiresAt", "clientInformation", "codeVerifier", "discoveryState"],
      client: ["clientInformation"],
      tokens: ["tokens", "tokensExpiresAt"],
      verifier: ["codeVerifier"],
      discovery: ["discoveryState"],
    };
    await updateRecord(this.identity, {}, fields[scope]);
  }
}

// ── Callback ───────────────────────────────────────────────────────────

export interface McpOAuthCallbackFlow {
  identity: McpOAuthIdentity;
  provider: McpOAuthProvider;
}

/**
 * Find the flow a callback belongs to. The `state` is the only key: it is
 * unguessable, single-use (cleared when tokens are saved) and expires.
 */
export async function resolveOAuthCallback(state: string | null): Promise<McpOAuthCallbackFlow | null> {
  if (!state) return null;
  const record = await findRecordByState(state);
  if (!record?.redirectUrl) return null;
  if (!record.stateExpiresAt || Date.parse(record.stateExpiresAt) < Date.now()) return null;
  const identity = { serverId: record.serverId, username: record.username };
  return { identity, provider: new McpOAuthProvider(identity, record.redirectUrl, record.scope ?? null) };
}

export async function markOAuthFailed(identity: McpOAuthIdentity, error: unknown): Promise<void> {
  const message = getErrorMessage(error);
  logger.warn(`[MCP OAuth] Authorization failed for server ${identity.serverId}: ${message}`);
  await updateRecord(identity, { status: "failed", error: message }, ["state", "stateExpiresAt", "codeVerifier"]);
}
