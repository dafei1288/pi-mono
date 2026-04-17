import { describe, expect, it } from "vitest";

// bridge.ts and server.ts import node:child_process and ws which cause
// vite-node resolution issues. They are tested via integration tests.
// Unit tests cover auth, protocol, and module exports that don't pull in node:stream.

describe("Exports (unit)", () => {
	it("AuthManager is importable and functional", async () => {
		const { AuthManager } = await import("../src/auth.js");
		expect(typeof AuthManager).toBe("function");

		const auth = new AuthManager({ password: "test" });
		expect(auth.requiresAuth).toBe(true);
		expect(auth.verifyPassword("test")).toBe(true);
		expect(auth.verifyPassword("wrong")).toBe(false);

		const token = auth.issueToken();
		expect(token.token).toBeTruthy();
		expect(auth.verifyToken(token.token)).toBe(true);
	});

	it("protocol types are importable", async () => {
		const mod = await import("../src/protocol.js");
		expect(mod.METHODS).toBeDefined();
		expect(mod.METHODS.PROMPT).toBe("prompt");
		expect(mod.METHODS.CONNECT).toBe("connect");
		expect(mod.METHODS.ABORT).toBe("abort");
		expect(mod.METHODS.GET_STATE).toBe("get_state");
		expect(mod.METHODS.GET_MODELS).toBe("get_models");
		expect(mod.METHODS.SET_MODEL).toBe("set_model");
		expect(mod.METHODS.NEW_SESSION).toBe("new_session");
		expect(mod.METHODS.COMPACT).toBe("compact");
		expect(mod.METHODS.BASH).toBe("bash");
	});
});
