#!/usr/bin/env node
/**
 * Mint a short-lived scoped runtime session bearer for a trusted client.
 *
 * Usage (inside the container or on the host with the secret in env):
 *   node scripts/mint-runtime-session.mjs \
 *     --app obsidian --username lazycat \
 *     --session obsidian-vault --profile obsidian-vault-agent-v1 \
 *     [--hours 23]
 *
 * The secret is read from RUNTIME_API_TOKEN / RUNTIME_AUTH_SECRET /
 * INTERNAL_EXECUTE_TOKEN — the same resolution order as RuntimeAuth.
 * The printed bearer is scoped: it authorizes exactly one app_id +
 * session_id + profile_id, and expires. The signing secret itself is
 * never printed.
 *
 * Client usage:
 *   curl -H "Authorization: Bearer <bearer>" http://<host>:5591/v1/runs ...
 */
import crypto from "node:crypto";

function arg(flag, fallback) {
	const i = process.argv.indexOf(flag);
	return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const secret =
	process.env.RUNTIME_API_TOKEN ||
	process.env.RUNTIME_AUTH_SECRET ||
	process.env.INTERNAL_EXECUTE_TOKEN;
if (!secret) {
	console.error("error: no runtime secret in env (RUNTIME_API_TOKEN / RUNTIME_AUTH_SECRET / INTERNAL_EXECUTE_TOKEN)");
	process.exit(1);
}

const app = arg("--app");
const session = arg("--session");
const profile = arg("--profile");
if (!app || !session || !profile) {
	console.error("error: --app, --session and --profile are required");
	process.exit(1);
}
const username = arg("--username", "lazycat");
const hours = Math.min(Number(arg("--hours", "23")) || 23, 24);

const scope = {
	app_id: app,
	username,
	session_id: session,
	profile_id: profile,
	expires_at: Date.now() + hours * 3600000,
	nonce: crypto.randomUUID(),
};
// Mirrors RuntimeAuth.issueRuntimeSession: payload.b64url(HMAC("runtime-session.v1:" + payload))
const payload = Buffer.from(JSON.stringify(scope)).toString("base64url");
const signature = crypto
	.createHmac("sha256", secret)
	.update(`runtime-session.v1:${payload}`)
	.digest("base64url");

console.log(`${payload}.${signature}`);
console.error(`scope: app=${app} session=${session} profile=${profile} user=${username} expires=${new Date(scope.expires_at).toISOString()}`);
