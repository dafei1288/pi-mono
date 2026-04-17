import { describe, expect, it } from "vitest";
import { AuthManager } from "../src/auth.js";

describe("AuthManager", () => {
	it("should not require auth when no password is configured", () => {
		const auth = new AuthManager();
		expect(auth.requiresAuth).toBe(false);
	});

	it("should require auth when password is configured", () => {
		const auth = new AuthManager({ password: "secret" });
		expect(auth.requiresAuth).toBe(true);
	});

	describe("password auth", () => {
		it("should accept correct password", () => {
			const auth = new AuthManager({ password: "secret" });
			expect(auth.verifyPassword("secret")).toBe(true);
		});

		it("should reject incorrect password", () => {
			const auth = new AuthManager({ password: "secret" });
			expect(auth.verifyPassword("wrong")).toBe(false);
		});

		it("should accept any password when no auth is configured", () => {
			const auth = new AuthManager();
			expect(auth.verifyPassword("anything")).toBe(true);
		});
	});

	describe("token auth", () => {
		it("should issue and verify tokens", () => {
			const auth = new AuthManager({ password: "secret", tokenTtlMs: 60000 });
			const issued = auth.issueToken();

			expect(issued.token).toBeTruthy();
			expect(issued.expiresAtMs).toBeGreaterThan(0);
			expect(auth.verifyToken(issued.token)).toBe(true);
		});

		it("should reject invalid tokens", () => {
			const auth = new AuthManager({ password: "secret" });
			expect(auth.verifyToken("invalid-token")).toBe(false);
			expect(auth.verifyToken("")).toBe(false);
		});

		it("should reject expired tokens", () => {
			const auth = new AuthManager({ password: "secret", tokenTtlMs: 1 });
			const issued = auth.issueToken();

			// Wait for expiry
			return new Promise<void>((resolve) => {
				setTimeout(() => {
					expect(auth.verifyToken(issued.token)).toBe(false);
					resolve();
				}, 10);
			});
		});

		it("should revoke tokens", () => {
			const auth = new AuthManager({ password: "secret", tokenTtlMs: 60000 });
			const issued = auth.issueToken();

			expect(auth.verifyToken(issued.token)).toBe(true);
			auth.revokeToken(issued.token);
			expect(auth.verifyToken(issued.token)).toBe(false);
		});

		it("should cleanup expired tokens", () => {
			const auth = new AuthManager({ password: "secret", tokenTtlMs: 1 });
			auth.issueToken();

			return new Promise<void>((resolve) => {
				setTimeout(() => {
					auth.cleanup();
					resolve();
				}, 10);
			});
		});
	});
});
