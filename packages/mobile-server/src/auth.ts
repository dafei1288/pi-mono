/**
 * Simple authentication for mobile server connections.
 *
 * Supports:
 * - Password auth: server configured with --password, client sends it once
 * - Token auth: password exchange returns a bearer token for subsequent connections
 * - No auth: if no password is configured, all connections are accepted
 */

import { createHmac, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;
const TOKEN_HMAC_ALGO = "sha256";

export interface AuthConfig {
	/** Plaintext password (or undefined to disable auth). */
	password?: string;
	/** HMAC key for signing tokens. Auto-generated if not set. */
	tokenSecret?: string;
	/** Token validity in ms. Default: 7 days. */
	tokenTtlMs?: number;
}

export interface IssuedToken {
	/** The bearer token string. */
	token: string;
	/** Absolute expiry timestamp (ms since epoch). 0 = never expires. */
	expiresAtMs: number;
}

interface TokenPayload {
	/** Random identifier. */
	id: string;
	/** Issued at (ms since epoch). */
	iat: number;
	/** HMAC signature. */
	sig: string;
}

export class AuthManager {
	private readonly tokenSecret: string;
	private readonly tokenTtlMs: number;
	private readonly validTokens = new Map<string, { expiresAtMs: number }>();

	constructor(private config: AuthConfig = {}) {
		this.tokenSecret = config.tokenSecret ?? randomBytes(32).toString("hex");
		this.tokenTtlMs = config.tokenTtlMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
	}

	/** Whether auth is required (password is configured). */
	get requiresAuth(): boolean {
		return !!this.config.password;
	}

	/** Verify a password. Returns true if valid. */
	verifyPassword(password: string): boolean {
		if (!this.config.password) return true;
		return password === this.config.password;
	}

	/** Issue a new token. */
	issueToken(): IssuedToken {
		const id = randomBytes(TOKEN_BYTES).toString("base64url");
		const iat = Date.now();
		const sig = this.sign(id, iat);
		const expiresAtMs = this.tokenTtlMs > 0 ? iat + this.tokenTtlMs : 0;

		const token = Buffer.from(JSON.stringify({ id, iat, sig })).toString("base64url");
		this.validTokens.set(id, { expiresAtMs });

		return { token, expiresAtMs };
	}

	/** Verify a bearer token. Returns true if valid and not expired. */
	verifyToken(token: string): boolean {
		try {
			const payload: TokenPayload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));

			// Check signature
			const expectedSig = this.sign(payload.id, payload.iat);
			if (payload.sig !== expectedSig) return false;

			// Check expiry
			const entry = this.validTokens.get(payload.id);
			if (!entry) return false;
			if (entry.expiresAtMs > 0 && Date.now() > entry.expiresAtMs) {
				this.validTokens.delete(payload.id);
				return false;
			}

			return true;
		} catch {
			return false;
		}
	}

	/** Revoke a token. */
	revokeToken(token: string): void {
		try {
			const payload: TokenPayload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
			this.validTokens.delete(payload.id);
		} catch {
			// ignore
		}
	}

	/** Clean up expired tokens. */
	cleanup(): void {
		const now = Date.now();
		for (const [id, entry] of this.validTokens) {
			if (entry.expiresAtMs > 0 && now > entry.expiresAtMs) {
				this.validTokens.delete(id);
			}
		}
	}

	private sign(id: string, iat: number): string {
		return createHmac(TOKEN_HMAC_ALGO, this.tokenSecret).update(`${id}.${iat}`).digest("base64url");
	}
}
