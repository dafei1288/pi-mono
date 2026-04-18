/**
 * Mobile server protocol types.
 *
 * Wire format between mobile clients and the pi mobile server.
 * Uses JSON frames over WebSocket (and JSON bodies over HTTP).
 *
 * Frame types:
 * - RequestFrame:  client → server (method call)
 * - ResponseFrame: server → client (method result)
 * - EventFrame:    server → client (streamed agent events)
 */

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export interface RequestFrame {
	type: "req";
	id: string;
	method: string;
	params?: unknown;
}

export interface ResponseFrame {
	type: "res";
	id: string;
	ok: boolean;
	payload?: unknown;
	error?: ErrorShape;
}

export interface EventFrame {
	type: "event";
	event: string;
	payload?: unknown;
	seq: number;
}

export type Frame = RequestFrame | ResponseFrame | EventFrame;

export interface ErrorShape {
	code: string;
	message: string;
	retryable?: boolean;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthParams {
	/** Password auth (server configured with --password) */
	password?: string;
	/** Token auth (issued after device pairing or password login) */
	token?: string;
}

export interface AuthResult {
	/** Bearer token for subsequent connections */
	token: string;
	/** Token expiry in ms from now (0 = never expires) */
	expiresInMs: number;
}

// ---------------------------------------------------------------------------
// Client info (sent during connect)
// ---------------------------------------------------------------------------

export interface ClientInfo {
	id: string;
	displayName?: string;
	version: string;
	platform: string;
	deviceFamily?: string;
	modelIdentifier?: string;
}

// ---------------------------------------------------------------------------
// Connect handshake
// ---------------------------------------------------------------------------

export interface ConnectParams {
	auth?: AuthParams;
	client?: ClientInfo;
}

export interface ConnectResult {
	serverVersion: string;
	pid: number;
	sessionId: string;
	sessionName?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export interface PromptParams {
	message: string;
	images?: Array<{ mediaType: string; data: string }>;
	streamingBehavior?: "steer" | "followUp";
}

export interface PromptResult {
	/** Acknowledged — events will follow as EventFrames */
	acknowledged: true;
}

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

export interface AbortParams {}

export interface AbortResult {
	aborted: boolean;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface GetMessagesParams {
	/** Limit number of messages (default 200) */
	limit?: number;
}

export interface GetMessagesResult {
	messages: unknown[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface GetStateParams {}

export interface GetStateResult {
	model?: { provider: string; id: string; contextWindow?: number };
	thinkingLevel: string;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	messageCount: number;
	pendingMessageCount: number;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface GetModelsParams {}

export interface GetModelsResult {
	models: Array<{ provider: string; id: string; contextWindow?: number; reasoning?: boolean }>;
}

export interface SetModelParams {
	provider: string;
	modelId: string;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface NewSessionParams {
	parentSession?: string;
}

export interface SwitchSessionParams {
	sessionPath: string;
}

export interface GetSessionStatsParams {}

export interface SessionStats {
	sessionFile: string;
	sessionId: string;
	sessionName?: string;
	totalMessages: number;
	userMessages: number;
	assistantMessages: number;
	toolMessages: number;
	totalTokens: number;
	totalCost: number;
	createdAt?: string;
	lastActivityAt?: string;
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

export interface CompactParams {
	customInstructions?: string;
}

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

export interface BashParams {
	command: string;
}

// ---------------------------------------------------------------------------
// Thinking
// ---------------------------------------------------------------------------

export interface SetThinkingLevelParams {
	level: string;
}

// ---------------------------------------------------------------------------
// Events (server → client, pushed as EventFrame)
// ---------------------------------------------------------------------------

/**
 * All agent events from pi are forwarded as event frames.
 * The `payload` field contains the original AgentEvent from pi-agent-core.
 *
 * Key event types in payload:
 * - agent_start / agent_end
 * - turn_start / turn_end
 * - message_start / message_update / message_end
 * - tool_execution_start / tool_execution_update / tool_execution_end
 *
 * Additionally, the server emits:
 * - "server.shutdown" before shutting down
 */

// ---------------------------------------------------------------------------
// Method names (for reference)
// ---------------------------------------------------------------------------

export const METHODS = {
	// Auth
	CONNECT: "connect",
	// Prompting
	PROMPT: "prompt",
	ABORT: "abort",
	STEER: "steer",
	FOLLOW_UP: "follow_up",
	// Messages
	GET_MESSAGES: "get_messages",
	// State
	GET_STATE: "get_state",
	// Models
	GET_MODELS: "get_models",
	SET_MODEL: "set_model",
	CYCLE_MODEL: "cycle_model",
	// Session
	NEW_SESSION: "new_session",
	SWITCH_SESSION: "switch_session",
	GET_SESSION_STATS: "get_session_stats",
	SET_SESSION_NAME: "set_session_name",
	// Compaction
	COMPACT: "compact",
	// Bash
	BASH: "bash",
	// Thinking
	SET_THINKING_LEVEL: "set_thinking_level",
	CYCLE_THINKING_LEVEL: "cycle_thinking_level",
	// Fork
	FORK: "fork",
	GET_FORK_MESSAGES: "get_fork_messages",
	// Commands
	GET_COMMANDS: "get_commands",
	// Directory browsing
	BROWSE_DIRECTORY: "browse_directory",
} as const;

export type MethodName = (typeof METHODS)[keyof typeof METHODS];
