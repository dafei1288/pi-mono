/**
 * Bridge to a pi coding agent running in RPC mode.
 *
 * Spawns `pi --mode rpc` as a child process and exposes a typed API
 * that returns responses and streams events.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// We inline the RPC command/response types because pi-coding-agent does not
// export them from its main entry point. These types mirror the ones in
// packages/coding-agent/src/modes/rpc/rpc-types.ts.

type RpcCommand =
	| { id?: string; type: "prompt"; message: string; images?: unknown[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: unknown[] }
	| { id?: string; type: "follow_up"; message: string; images?: unknown[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "set_thinking_level"; level: string }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_commands" };

interface RpcResponse {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

type PendingRequest = {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
};

export type AgentEventListener = (event: object) => void;

export interface BridgeOptions {
	/** Path to pi CLI entry. Defaults to auto-detect. */
	cliPath?: string;
	/** Working directory for the agent. */
	cwd?: string;
	/** Extra environment variables. */
	env?: Record<string, string>;
	/** Provider override. */
	provider?: string;
	/** Model override. */
	model?: string;
	/** Extra CLI arguments. */
	args?: string[];
}

/**
 * Manages a pi agent subprocess in RPC mode and provides
 * a request/response + event streaming API.
 */
export class RpcBridge {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private pendingRequests = new Map<string, PendingRequest>();
	private eventListeners: AgentEventListener[] = [];
	private seq = 0;
	private stderr = "";

	constructor(private options: BridgeOptions = {}) {}

	/** Start the pi agent subprocess. */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Bridge already started");
		}

		const cliPath = this.options.cliPath ?? this.resolveCliPath();
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		this.process = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.process.stderr?.on("data", (data: Buffer) => {
			this.stderr += data.toString();
		});

		this.stopReadingStdout = attachJsonlLineReader(this.process.stdout!, (line) => {
			this.handleLine(line);
		});

		// Wait for process to be alive
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (this.process?.exitCode === null || this.process?.exitCode === undefined) {
					resolve();
				} else {
					reject(new Error(`Agent exited with code ${this.process?.exitCode}. Stderr: ${this.stderr}`));
				}
			}, 200);

			this.process!.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});

			this.process!.on("exit", (code) => {
				clearTimeout(timeout);
				if (code !== null && code !== 0) {
					reject(new Error(`Agent exited with code ${code}. Stderr: ${this.stderr}`));
				}
			});
		});
	}

	/** Stop the pi agent subprocess. */
	async stop(): Promise<void> {
		if (!this.process) return;

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;

		const proc = this.process;
		this.process = null;

		proc.kill("SIGTERM");

		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				proc.kill("SIGKILL");
				resolve();
			}, 3000);

			proc.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		for (const pending of this.pendingRequests.values()) {
			pending.reject(new Error("Bridge stopped"));
		}
		this.pendingRequests.clear();
	}

	/** Get collected stderr (debugging). */
	getStderr(): string {
		return this.stderr;
	}

	/** Subscribe to agent events. Returns unsubscribe function. */
	onEvent(listener: AgentEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const idx = this.eventListeners.indexOf(listener);
			if (idx !== -1) this.eventListeners.splice(idx, 1);
		};
	}

	/** Check if the bridge is running. */
	get isRunning(): boolean {
		return this.process !== null && this.process.exitCode === null;
	}

	/** Get the process PID. */
	get pid(): number | undefined {
		return this.process?.pid;
	}

	// -------------------------------------------------------------------------
	// Command methods (thin wrappers — return the raw RpcResponse)
	// -------------------------------------------------------------------------

	async send(command: Omit<RpcCommand, "id">): Promise<RpcResponse> {
		return this.sendCommand(command as RpcCommand);
	}

	/** Send a prompt. Events will stream. */
	async prompt(message: string, images?: unknown[], streamingBehavior?: "steer" | "followUp"): Promise<RpcResponse> {
		return this.sendCommand({ type: "prompt", message, images, streamingBehavior } as RpcCommand);
	}

	/** Steer mid-run. */
	async steer(message: string, images?: unknown[]): Promise<RpcResponse> {
		return this.sendCommand({ type: "steer", message, images } as RpcCommand);
	}

	/** Follow-up after run. */
	async followUp(message: string, images?: unknown[]): Promise<RpcResponse> {
		return this.sendCommand({ type: "follow_up", message, images } as RpcCommand);
	}

	/** Abort current run. */
	async abort(): Promise<RpcResponse> {
		return this.sendCommand({ type: "abort" });
	}

	/** Get session state. */
	async getState(): Promise<RpcResponse> {
		return this.sendCommand({ type: "get_state" });
	}

	/** Get messages. */
	async getMessages(): Promise<RpcResponse> {
		return this.sendCommand({ type: "get_messages" });
	}

	/** Get available models. */
	async getAvailableModels(): Promise<RpcResponse> {
		return this.sendCommand({ type: "get_available_models" });
	}

	/** Set model. */
	async setModel(provider: string, modelId: string): Promise<RpcResponse> {
		return this.sendCommand({ type: "set_model", provider, modelId });
	}

	/** Cycle model. */
	async cycleModel(): Promise<RpcResponse> {
		return this.sendCommand({ type: "cycle_model" });
	}

	/** Set thinking level. */
	async setThinkingLevel(level: string): Promise<RpcResponse> {
		return this.sendCommand({ type: "set_thinking_level", level: level as any });
	}

	/** Cycle thinking level. */
	async cycleThinkingLevel(): Promise<RpcResponse> {
		return this.sendCommand({ type: "cycle_thinking_level" });
	}

	/** New session. */
	async newSession(parentSession?: string): Promise<RpcResponse> {
		return this.sendCommand({ type: "new_session", parentSession });
	}

	/** Switch session. */
	async switchSession(sessionPath: string): Promise<RpcResponse> {
		return this.sendCommand({ type: "switch_session", sessionPath });
	}

	/** Get session stats. */
	async getSessionStats(): Promise<RpcResponse> {
		return this.sendCommand({ type: "get_session_stats" });
	}

	/** Set session name. */
	async setSessionName(name: string): Promise<RpcResponse> {
		return this.sendCommand({ type: "set_session_name", name });
	}

	/** Compact context. */
	async compact(customInstructions?: string): Promise<RpcResponse> {
		return this.sendCommand({ type: "compact", customInstructions });
	}

	/** Execute bash. */
	async bash(command: string): Promise<RpcResponse> {
		return this.sendCommand({ type: "bash", command });
	}

	/** Fork from a message. */
	async fork(entryId: string): Promise<RpcResponse> {
		return this.sendCommand({ type: "fork", entryId });
	}

	/** Get fork messages. */
	async getForkMessages(): Promise<RpcResponse> {
		return this.sendCommand({ type: "get_fork_messages" });
	}

	/** Get commands. */
	async getCommands(): Promise<RpcResponse> {
		return this.sendCommand({ type: "get_commands" });
	}

	/** Send an extension UI response back to the agent. */
	async sendExtensionUIResponse(response: {
		type: "extension_ui_response";
		id: string;
		value?: string;
		confirmed?: boolean;
		cancelled?: true;
	}): Promise<void> {
		if (!this.process?.stdin) {
			throw new Error("Bridge not started");
		}
		this.process.stdin.write(serializeJsonLine(response));
	}

	// -------------------------------------------------------------------------
	// Internal
	// -------------------------------------------------------------------------

	private sendCommand(command: RpcCommand): Promise<RpcResponse> {
		if (!this.process?.stdin) {
			throw new Error("Bridge not started");
		}

		const id = `m_${++this.seq}`;
		const fullCommand = { ...command, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}`));
			}, 60_000);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			this.process!.stdin!.write(serializeJsonLine(fullCommand));
		});
	}

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			// Response to a pending request
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}

			// Extension UI request (fire-and-forget from agent, client should respond)
			if (data.type === "extension_ui_request") {
				for (const listener of this.eventListeners) {
					listener(data);
				}
				return;
			}

			// Agent event
			for (const listener of this.eventListeners) {
				listener(data);
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	private resolveCliPath(): string {
		// In the monorepo, pi-coding-agent is a workspace sibling.
		// Its dist/cli.js lives at a known relative path from this package.
		const candidates = [
			// Workspace: packages/mobile-server -> packages/coding-agent
			resolveMonorepoCliPath(),
			// Standalone install via node_modules symlink
			tryResolve("@mariozechner/pi-coding-agent/dist/cli.js"),
		];
		for (const c of candidates) {
			if (c) return c;
		}
		return "dist/cli.js";
	}
}

// -------------------------------------------------------------------------
// CLI path helpers
// -------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function resolveMonorepoCliPath(): string | null {
	try {
		// When running via tsx: this file is packages/mobile-server/src/bridge.ts
		// pi CLI is at packages/coding-agent/dist/cli.js
		const thisDir = dirname(fileURLToPath(import.meta.url));
		const cliPath = resolve(thisDir, "../../coding-agent/dist/cli.js");
		if (existsSync(cliPath)) return cliPath;
	} catch {
		// import.meta.url may not be available
	}
	return null;
}

function tryResolve(specifier: string): string | null {
	try {
		return require.resolve(specifier);
	} catch {
		return null;
	}
}
// JSONL utilities (inlined from pi-coding-agent to avoid deep import paths)
// -------------------------------------------------------------------------

/** Serialize a value as a strict JSONL record (LF-only framing). */
function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/** Attach an LF-only JSONL line reader to a stream. */
function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			emitLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
		}
	};

	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			emitLine(buffer);
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
