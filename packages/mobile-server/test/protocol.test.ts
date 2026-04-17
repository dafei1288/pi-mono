import { describe, expect, it } from "vitest";
import { type EventFrame, METHODS, type RequestFrame, type ResponseFrame } from "../src/protocol.js";

describe("protocol", () => {
	it("should define all expected methods", () => {
		expect(METHODS.CONNECT).toBe("connect");
		expect(METHODS.PROMPT).toBe("prompt");
		expect(METHODS.ABORT).toBe("abort");
		expect(METHODS.GET_MESSAGES).toBe("get_messages");
		expect(METHODS.GET_STATE).toBe("get_state");
		expect(METHODS.GET_MODELS).toBe("get_models");
		expect(METHODS.SET_MODEL).toBe("set_model");
		expect(METHODS.NEW_SESSION).toBe("new_session");
		expect(METHODS.COMPACT).toBe("compact");
		expect(METHODS.BASH).toBe("bash");
	});

	it("should produce valid request frames", () => {
		const frame: RequestFrame = {
			type: "req",
			id: "test-1",
			method: METHODS.PROMPT,
			params: { message: "Hello" },
		};

		expect(frame.type).toBe("req");
		expect(frame.id).toBe("test-1");
		expect(frame.method).toBe("prompt");
		expect(frame.params).toEqual({ message: "Hello" });
	});

	it("should produce valid response frames", () => {
		const success: ResponseFrame = {
			type: "res",
			id: "test-1",
			ok: true,
			payload: { acknowledged: true },
		};

		expect(success.type).toBe("res");
		expect(success.ok).toBe(true);

		const error: ResponseFrame = {
			type: "res",
			id: "test-2",
			ok: false,
			error: { code: "unauthorized", message: "Auth required" },
		};

		expect(error.ok).toBe(false);
		expect(error.error?.code).toBe("unauthorized");
	});

	it("should produce valid event frames", () => {
		const frame: EventFrame = {
			type: "event",
			event: "text_delta",
			payload: { delta: "Hello" },
			seq: 1,
		};

		expect(frame.type).toBe("event");
		expect(frame.event).toBe("text_delta");
		expect(frame.seq).toBe(1);
	});
});
