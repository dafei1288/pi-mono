/**
 * Mobile server: WebSocket + HTTP bridge to pi coding agent(s).
 *
 * Architecture:
 *   Mobile Client ◄──WebSocket──► MobileServer ◄──stdin/stdout JSONL──► pi agent (RPC mode)
 *
 * Key design:
 *   - Server starts without an active agent
 *   - Client connects → gets project list → selects a project
 *   - Server spawns pi agent for that project's cwd
 *   - Client can switch projects (kills old agent, spawns new one)
 *   - One active agent at a time, multiple clients can watch
 */

import { randomUUID } from "node:crypto";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer, type WebSocket as WsType } from "ws";
import { AuthManager } from "./auth.js";
import { RpcBridge } from "./bridge.js";
import {
	type ClientInfo,
	type ConnectParams,
	type ErrorShape,
	type EventFrame,
	METHODS,
	type RequestFrame,
	type ResponseFrame,
} from "./protocol.js";

type Frame = RequestFrame | ResponseFrame | EventFrame;

export interface ProjectEntry {
	name: string;
	path: string;
	description?: string;
}

export interface MobileServerOptions {
	/** TCP port. Default: 18790 */
	port?: number;
	/** Bind host. Default: "0.0.0.0" */
	host?: string;
	/** Auth configuration. */
	auth?: { password?: string; tokenSecret?: string; tokenTtlMs?: number };
	/** Default project cwd (if set, agent starts immediately). */
	defaultCwd?: string;
	/** Extra agent options. */
	agent?: {
		cliPath?: string;
		env?: Record<string, string>;
		provider?: string;
		model?: string;
		args?: string[];
	};
	/** Enable mDNS discovery. Default: true */
	mdns?: boolean;
	/** Directory containing static web files to serve (e.g. mobile-app dist). */
	webDir?: string;
	/** JSON file listing project paths. */
	projectsFile?: string;
}

interface ClientConnection {
	ws: WsType;
	id: string;
	clientInfo?: ClientInfo;
	authenticated: boolean;
	eventUnsubscribe?: () => void;
}

/** Config file path for saved projects. */
function getConfigDir(): string {
	return join(homedir(), ".pi-mobile-server");
}

function getProjectsConfigPath(): string {
	return join(getConfigDir(), "projects.json");
}

export class MobileServer {
	private httpServer: Server;
	private wss: WebSocketServer;
	private bridge: RpcBridge | null = null;
	private activeProject: string | null = null;
	private activeCwd: string | null = null;
	private agentStreaming = false;
	private sessionWatcher: FSWatcher | null = null;
	private lastBroadcastHash = "";
	private watchDebounce: ReturnType<typeof setTimeout> | null = null;
	private watchedSessionDir: string | null = null;
	private authManager: AuthManager;
	private connections = new Map<string, ClientConnection>();
	private seq = 0;
	private options: Required<Pick<MobileServerOptions, "port" | "host">> & Omit<MobileServerOptions, "port" | "host">;
	private agentDefaults: NonNullable<MobileServerOptions["agent"]>;
	private mdnsService: any = null;
	private webDir: string | null;

	constructor(options: MobileServerOptions = {}) {
		this.options = {
			port: options.port ?? 18790,
			host: options.host ?? "0.0.0.0",
			auth: options.auth,
			defaultCwd: options.defaultCwd,
			agent: options.agent,
			mdns: options.mdns,
			projectsFile: options.projectsFile,
		};

		this.agentDefaults = options.agent ?? {};
		this.authManager = new AuthManager(this.options.auth ?? {});

		// Resolve webDir
		if (options.webDir) {
			this.webDir = resolve(options.webDir);
		} else {
			// Auto-detect: try multiple strategies
			const candidates = [
				// 1. Relative to this source file (packages/mobile-server/src/)
				() => {
					try {
						return resolve(dirname(fileURLToPath(import.meta.url)), "../../mobile-app/dist");
					} catch {
						return null;
					}
				},
				// 2. Relative to cwd
				() => resolve(process.cwd(), "packages/mobile-app/dist"),
				// 3. Sibling of this package
				() => resolve(process.cwd(), "../mobile-app/dist"),
			];
			this.webDir = null;
			for (const fn of candidates) {
				try {
					const dir = fn();
					if (dir && existsSync(dir)) {
						this.webDir = dir;
						break;
					}
				} catch {}
			}
		}

		// HTTP server
		this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res));

		// WebSocket server
		this.wss = new WebSocketServer({ server: this.httpServer });
		this.wss.on("connection", (ws) => this.handleConnection(ws));
	}

	/** Start the server (does NOT start an agent yet). */
	async start(): Promise<void> {
		// Ensure config dir exists
		await mkdir(getConfigDir(), { recursive: true });

		// If defaultCwd is set, start agent immediately
		if (this.options.defaultCwd) {
			await this.startAgent(this.options.defaultCwd);
		}

		// Start HTTP + WebSocket server
		await new Promise<void>((resolve) => {
			this.httpServer.listen(this.options.port, this.options.host, () => resolve());
		});

		console.log(
			`[pi-mobile-server] Listening on ws://${this.options.host}:${this.options.port}` +
				(this.authManager.requiresAuth ? " (auth required)" : " (no auth)") +
				(this.activeCwd ? ` — project: ${this.activeCwd}` : " — no project selected"),
		);

		// Start mDNS discovery
		if (this.options.mdns !== false) {
			this.startMdns();
		}

		// Periodic token cleanup
		setInterval(() => this.authManager.cleanup(), 60_000);
	}

	/** Stop everything. */
	async stop(): Promise<void> {
		this.broadcastEvent("server.shutdown", {});

		for (const conn of this.connections.values()) {
			conn.eventUnsubscribe?.();
			conn.ws.close(1001, "server shutdown");
		}
		this.connections.clear();

		this.wss.close();
		await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));

		this.stopMdns();

		if (this.bridge) {
			this.stopSessionWatcher();
			await this.bridge.stop();
			this.bridge = null;
		}
		console.log("[pi-mobile-server] Stopped");
	}

	get status(): {
		running: boolean;
		connections: number;
		agentRunning: boolean;
		agentPid: number | undefined;
		activeProject: string | null;
		activeCwd: string | null;
		authRequired: boolean;
		port: number;
		hasWebUI: boolean;
	} {
		return {
			running: this.httpServer.listening,
			connections: this.connections.size,
			agentRunning: this.bridge?.isRunning ?? false,
			agentPid: this.bridge?.pid,
			activeProject: this.activeProject,
			activeCwd: this.activeCwd,
			authRequired: this.authManager.requiresAuth,
			port: this.options.port,
			hasWebUI: this.webDir !== null,
		};
	}

	// -----------------------------------------------------------------------
	// Agent lifecycle
	// -----------------------------------------------------------------------

	private async startAgent(cwd: string): Promise<void> {
		// Stop existing agent if any
		if (this.bridge) {
			console.log(`[pi-mobile-server] Stopping current agent (was: ${this.activeCwd})`);
			this.stopSessionWatcher();
			await this.bridge.stop();
			this.bridge = null;

			// Unsubscribe all clients from old agent events
			for (const conn of this.connections.values()) {
				conn.eventUnsubscribe?.();
				conn.eventUnsubscribe = undefined;
			}
		}

		const resolvedCwd = resolve(cwd);
		this.activeCwd = resolvedCwd;
		this.activeProject = basename(resolvedCwd);

		console.log(`[pi-mobile-server] Starting agent for: ${resolvedCwd}`);

		this.bridge = new RpcBridge({
			...this.agentDefaults,
			cwd: resolvedCwd,
		});

		await this.bridge.start();

		// Subscribe all existing clients to the new agent's events
		for (const conn of this.connections.values()) {
			if (conn.authenticated) {
				this.subscribeClientToAgent(conn);
			}
		}

		// Notify all clients about the project switch
		this.broadcastEvent("project_changed", {
			project: this.activeProject,
			cwd: this.activeCwd,
		});

		// Watch session file for external changes (e.g. CLI chatting in same project)
		this.startSessionWatcher();
	}

	// -----------------------------------------------------------------------
	// Session file watcher — syncs messages from CLI / external processes
	// -----------------------------------------------------------------------

	private stopSessionWatcher(): void {
		if (this.watchDebounce) {
			clearTimeout(this.watchDebounce);
			this.watchDebounce = null;
		}
		if (this.sessionWatcher) {
			this.sessionWatcher.close();
			this.sessionWatcher = null;
		}
		this.watchedSessionDir = null;
		this.lastBroadcastHash = "";
	}

	private async startSessionWatcher(): Promise<void> {
		this.stopSessionWatcher();
		if (!this.bridge?.isRunning) return;

		// Get session file path from agent state
		let sessionFile: string | undefined;
		try {
			const stateResp = await this.bridge.getState();
			if (stateResp.success && stateResp.data) {
				const state = stateResp.data as Record<string, unknown>;
				sessionFile = state.sessionFile as string | undefined;
			}
		} catch {
			return;
		}
		if (!sessionFile) return;

		// Store the session file path for direct file reading
		this.watchedSessionDir = dirname(sessionFile);

		try {
			// Watch the directory — session file gets replaced on rotation
			this.sessionWatcher = watch(this.watchedSessionDir, (_eventType, filename) => {
				if (filename?.endsWith(".jsonl")) {
					this.onSessionFileChange();
				}
			});
			this.sessionWatcher.on("error", () => {});
			console.log(`[pi-mobile-server] Watching session dir: ${this.watchedSessionDir}`);
		} catch {
			/* watcher not available */
		}
	}

	private onSessionFileChange(): void {
		// Debounce: coalesce rapid writes into one broadcast
		if (this.watchDebounce) return;
		this.watchDebounce = setTimeout(() => {
			this.watchDebounce = null;
			this.broadcastMessageSync();
		}, 500);
	}

	private async broadcastMessageSync(): Promise<void> {
		if (!this.watchedSessionDir) return;
		// Skip if our own agent is actively streaming — avoid clobbering real-time events
		if (this.agentStreaming) return;
		try {
			// Read the session files directly — this picks up changes from CLI or other agents
			const msgs = await this.readSessionMessages(this.watchedSessionDir);
			if (msgs.length === 0) return;

			// Hash to avoid redundant broadcasts
			const hash = `${msgs.length}:${msgs[msgs.length - 1]?.content?.slice?.(0, 20) ?? msgs.length}`;
			if (hash === this.lastBroadcastHash) return;
			this.lastBroadcastHash = hash;

			this.broadcastEvent("message_history", { messages: msgs });
			console.log(`[pi-mobile-server] Session file changed, synced ${msgs.length} messages`);
		} catch {
			/* ignore */
		}
	}

	/** Read all user/assistant messages from session jsonl files in a directory. */
	private async readSessionMessages(dir: string): Promise<Array<{ role: string; content: string }>> {
		const entries = await readdir(dir);
		const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl")).sort();
		if (jsonlFiles.length === 0) return [];

		// Read the most recent session file
		const latest = jsonlFiles[jsonlFiles.length - 1];
		const content = await readFile(join(dir, latest), "utf8");
		const lines = content.split("\n").filter((l) => l.trim());

		const messages: Array<{ role: string; content: string }> = [];
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.role === "user") {
					const text =
						typeof entry.content === "string"
							? entry.content
							: Array.isArray(entry.content)
								? entry.content
										.filter((c: any) => c.type === "text")
										.map((c: any) => c.text)
										.join("")
								: "";
					if (text) messages.push({ role: "user", content: text });
				} else if (entry.role === "assistant") {
					const text =
						typeof entry.content === "string"
							? entry.content
							: Array.isArray(entry.content)
								? entry.content
										.filter((c: any) => c.type === "text")
										.map((c: any) => c.text)
										.join("")
								: "";
					if (text) messages.push({ role: "assistant", content: text });
				}
			} catch {}
		}
		return messages;
	}

	private subscribeClientToAgent(conn: ClientConnection): void {
		conn.eventUnsubscribe?.();
		if (this.bridge) {
			conn.eventUnsubscribe = this.bridge.onEvent((event) => {
				this.sendEvent(conn, (event as { type?: string })?.type ?? "agent_event", event);
			});
		}
	}

	// -----------------------------------------------------------------------
	// mDNS discovery
	// -----------------------------------------------------------------------

	private startMdns(): void {
		try {
			// Dynamic import since bonjour-service is optional
			import("bonjour-service")
				.then((mod) => {
					const Bonjour = (mod as any).default ?? mod.Bonjour ?? mod;
					const bonjour = new Bonjour();
					this.mdnsService = bonjour.publish({
						name: `pi-mobile-server`,
						type: "pi-mobile",
						port: this.options.port,
						txt: {
							version: "0.2.0",
							auth: this.authManager.requiresAuth ? "1" : "0",
							project: this.activeProject ?? "",
						},
					});
					console.log(`[pi-mobile-server] mDNS: advertising as pi-mobile._tcp on port ${this.options.port}`);
					(this.mdnsService as any)._bonjour = bonjour;
				})
				.catch(() => {
					console.log(`[pi-mobile-server] mDNS: bonjour-service not available, skipping`);
				});
		} catch {
			console.log(`[pi-mobile-server] mDNS: bonjour-service not available, skipping`);
		}
	}

	private stopMdns(): void {
		if (this.mdnsService) {
			try {
				const bonjour = (this.mdnsService as any)?._bonjour;
				this.mdnsService.stop();
				bonjour?.destroy();
			} catch {}
			this.mdnsService = null;
		}
	}

	// -----------------------------------------------------------------------
	// Projects
	// -----------------------------------------------------------------------

	async listProjects(): Promise<ProjectEntry[]> {
		const configPath = getProjectsConfigPath();
		let saved: ProjectEntry[] = [];
		try {
			const data = await readFile(configPath, "utf8");
			saved = JSON.parse(data) as ProjectEntry[];
		} catch {
			// No config yet
		}

		// Merge projects from --projects-file
		if (this.options.projectsFile) {
			try {
				const raw = await readFile(this.options.projectsFile, "utf8");
				const entries = JSON.parse(raw);
				if (!Array.isArray(entries)) return saved;
				for (const entry of entries) {
					const p =
						typeof entry === "string"
							? { name: basename(resolve(entry)), path: resolve(entry) }
							: {
									name: entry.name || basename(resolve(entry.path)),
									path: resolve(entry.path),
									description: entry.description,
								};
					if (!saved.some((s) => resolve(s.path) === p.path)) {
						saved.push(p);
					}
				}
			} catch (err) {
				console.error(`[pi-mobile-server] Failed to load projects file: ${err}`);
			}
		}

		return saved;
	}

	async addProject(name: string, path: string, description?: string): Promise<void> {
		const projects = await this.listProjects();
		const entry: ProjectEntry = { name, path: resolve(path), description };
		const idx = projects.findIndex((p) => p.path === entry.path);
		if (idx >= 0) {
			projects[idx] = entry;
		} else {
			projects.push(entry);
		}
		await mkdir(getConfigDir(), { recursive: true });
		await writeFile(getProjectsConfigPath(), JSON.stringify(projects, null, 2));
	}

	async removeProject(path: string): Promise<void> {
		const projects = await this.listProjects();
		const filtered = projects.filter((p) => p.path !== resolve(path));
		await writeFile(getProjectsConfigPath(), JSON.stringify(filtered, null, 2));
	}

	// -----------------------------------------------------------------------
	// WebSocket handling
	// -----------------------------------------------------------------------

	private handleConnection(ws: WsType): void {
		const id = randomUUID();
		const conn: ClientConnection = {
			ws,
			id,
			authenticated: !this.authManager.requiresAuth,
		};
		this.connections.set(id, conn);
		console.log(`[pi-mobile-server] Client connected: ${id} (total: ${this.connections.size})`);

		ws.on("message", (data: Buffer) => {
			try {
				const frame = JSON.parse(data.toString()) as RequestFrame;
				this.handleFrame(conn, frame).catch((err) => {
					this.sendError(conn, frame.id, "internal", String(err));
				});
			} catch (err) {
				this.sendError(conn, "unknown", "parse", `Invalid JSON: ${String(err)}`);
			}
		});

		ws.on("close", () => {
			conn.eventUnsubscribe?.();
			this.connections.delete(id);
			console.log(`[pi-mobile-server] Client disconnected: ${id} (total: ${this.connections.size})`);
		});

		ws.on("error", (err) => {
			console.error(`[pi-mobile-server] WebSocket error (${id}): ${err.message}`);
		});
	}

	private async handleFrame(conn: ClientConnection, frame: RequestFrame): Promise<void> {
		const { method, params, id } = frame;

		// Auth required for all methods except connect
		if (!conn.authenticated && method !== METHODS.CONNECT) {
			this.sendError(conn, id, "unauthorized", "Authentication required. Send a connect frame first.");
			return;
		}

		// Project management methods (don't need an active agent)
		if (method === "list_projects") {
			return this.handleListProjects(conn, id);
		}
		if (method === "add_project") {
			return this.handleAddProject(conn, id, params);
		}
		if (method === "remove_project") {
			return this.handleRemoveProject(conn, id, params);
		}
		if (method === "select_project") {
			return this.handleSelectProject(conn, id, params);
		}
		if (method === "list_sessions") {
			return this.handleListSessions(conn, id, params);
		}
		if (method === "browse_directory") {
			return this.handleBrowseDirectory(conn, id, params);
		}

		// Agent methods — require an active agent
		if (!this.bridge || !this.bridge.isRunning) {
			this.sendError(conn, id, "no_project", "No project selected. Use select_project first.");
			return;
		}

		switch (method) {
			case METHODS.CONNECT:
				return this.handleConnect(conn, id, params as ConnectParams | undefined);
			case METHODS.PROMPT:
				return this.handlePrompt(conn, id, params);
			case METHODS.ABORT:
				return this.handleAbort(conn, id);
			case METHODS.STEER:
				return this.handleSteer(conn, id, params);
			case METHODS.FOLLOW_UP:
				return this.handleFollowUp(conn, id, params);
			case METHODS.GET_MESSAGES:
				return this.handleGetMessages(conn, id);
			case METHODS.GET_STATE:
				return this.handleGetState(conn, id);
			case METHODS.GET_MODELS:
				return this.handleGetModels(conn, id);
			case METHODS.SET_MODEL:
				return this.handleSetModel(conn, id, params);
			case METHODS.CYCLE_MODEL:
				return this.handleCycleModel(conn, id);
			case METHODS.NEW_SESSION:
				return this.handleNewSession(conn, id, params);
			case METHODS.SWITCH_SESSION:
				return this.handleSwitchSession(conn, id, params);
			case METHODS.GET_SESSION_STATS:
				return this.handleGetSessionStats(conn, id);
			case METHODS.SET_SESSION_NAME:
				return this.handleSetSessionName(conn, id, params);
			case METHODS.COMPACT:
				return this.handleCompact(conn, id, params);
			case METHODS.BASH:
				return this.handleBash(conn, id, params);
			case METHODS.SET_THINKING_LEVEL:
				return this.handleSetThinkingLevel(conn, id, params);
			case METHODS.CYCLE_THINKING_LEVEL:
				return this.handleCycleThinkingLevel(conn, id);
			case METHODS.FORK:
				return this.handleFork(conn, id, params);
			case METHODS.GET_FORK_MESSAGES:
				return this.handleGetForkMessages(conn, id);
			case METHODS.GET_COMMANDS:
				return this.handleGetCommands(conn, id);
			default:
				this.sendError(conn, id, "unknown_method", `Unknown method: ${method}`);
		}
	}

	// -----------------------------------------------------------------------
	// Project management handlers
	// -----------------------------------------------------------------------

	private async handleListProjects(conn: ClientConnection, id: string): Promise<void> {
		try {
			const projects = await this.listProjects();
			this.sendResponse(conn, id, true, {
				projects,
				activeProject: this.activeProject,
				activeCwd: this.activeCwd,
				agentRunning: this.bridge?.isRunning ?? false,
			});
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleAddProject(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as { name?: string; path?: string; description?: string } | undefined;
		if (!p?.path) {
			this.sendError(conn, id, "invalid_params", "path is required");
			return;
		}
		try {
			// Verify path exists and is a directory
			const resolved = resolve(p.path);
			const s = await stat(resolved);
			if (!s.isDirectory()) {
				this.sendError(conn, id, "invalid_params", `Not a directory: ${resolved}`);
				return;
			}
			await this.addProject(p.name || basename(resolved), resolved, p.description);
			const projects = await this.listProjects();
			this.sendResponse(conn, id, true, { projects });
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleRemoveProject(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as { path?: string } | undefined;
		if (!p?.path) {
			this.sendError(conn, id, "invalid_params", "path is required");
			return;
		}
		try {
			await this.removeProject(p.path);
			const projects = await this.listProjects();
			this.sendResponse(conn, id, true, { projects });
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleSelectProject(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as { path?: string } | undefined;
		if (!p?.path) {
			this.sendError(conn, id, "invalid_params", "path is required");
			return;
		}
		try {
			const resolved = resolve(p.path);
			const s = await stat(resolved);
			if (!s.isDirectory()) {
				this.sendError(conn, id, "invalid_params", `Not a directory: ${resolved}`);
				return;
			}

			await this.startAgent(resolved);

			// Get session state from new agent
			let sessionInfo = {};
			try {
				const stateResp = await this.bridge!.getState();
				if (stateResp.success && stateResp.data) {
					const state = stateResp.data as Record<string, unknown>;
					sessionInfo = {
						sessionId: state.sessionId ?? "",
						sessionName: state.sessionName ?? "",
						model: state.model ?? null,
						thinkingLevel: state.thinkingLevel ?? "off",
					};
				}
			} catch {}

			this.sendResponse(conn, id, true, {
				project: this.activeProject,
				cwd: this.activeCwd,
				agentRunning: true,
				...sessionInfo,
			});
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	// -----------------------------------------------------------------------
	// Session listing
	// -----------------------------------------------------------------------

	private async handleListSessions(conn: ClientConnection, id: string, _params?: unknown): Promise<void> {
		// If agent is running, ask it for session stats (includes session dir)
		if (this.bridge?.isRunning) {
			try {
				// Get session dir from agent's cwd — sessions are under ~/.pi/agent/sessions/{cwd-hash}/
				const stateResp = await this.bridge.getState();
				if (stateResp.success && stateResp.data) {
					const state = stateResp.data as Record<string, unknown>;
					const sessionFile = state.sessionFile as string | undefined;
					if (sessionFile) {
						// Sessions live in the same directory as the current session file
						const sessionDir = join(sessionFile, "..");
						const resolvedDir = resolve(sessionDir);
						const sessions = await this.scanSessionDir(resolvedDir);
						this.sendResponse(conn, id, true, {
							sessions,
							currentSessionFile: sessionFile,
							currentSessionId: state.sessionId ?? "",
							currentSessionName: state.sessionName ?? "",
						});
						return;
					}
				}
			} catch {}
		}
		this.sendError(conn, id, "no_agent", "No active session. Select a project first.");
	}

	private async scanSessionDir(dir: string): Promise<
		Array<{
			path: string;
			name: string;
			modified: string;
			size: number;
			messageCount: number;
			firstMessage: string;
		}>
	> {
		try {
			const entries = await readdir(dir);
			const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
			const sessions = await Promise.all(
				jsonlFiles.map(async (f) => {
					const filePath = join(dir, f);
					try {
						const s = await stat(filePath);
						// Read first few lines to get session info
						const content = await readFile(filePath, "utf8");
						const lines = content.split("\n").filter((l) => l.trim());
						let firstMessage = "";
						let messageCount = 0;
						let sessionName = "";
						for (const line of lines) {
							try {
								const entry = JSON.parse(line);
								if (entry.type === "session_info" && entry.name) sessionName = entry.name;
								if (entry.role === "user" && !firstMessage) {
									firstMessage = typeof entry.content === "string" ? entry.content.slice(0, 80) : "";
								}
								if (entry.role === "user" || entry.role === "assistant") messageCount++;
							} catch {}
						}
						return {
							path: filePath,
							name: sessionName || f.replace(".jsonl", ""),
							modified: s.mtime.toISOString(),
							size: s.size,
							messageCount,
							firstMessage,
						};
					} catch {
						return null;
					}
				}),
			);
			// Filter nulls, sort by modified desc
			return sessions
				.filter((s): s is NonNullable<typeof s> => s !== null)
				.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
		} catch {
			return [];
		}
	}

	// -----------------------------------------------------------------------
	// Directory browsing handler
	// -----------------------------------------------------------------------

	private async handleBrowseDirectory(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as { path?: string } | undefined;
		const dirPath = p?.path || homedir();
		try {
			const resolved = resolve(dirPath);
			const entries = await readdir(resolved, { withFileTypes: true });
			const dirs = entries
				.filter((e) => e.isDirectory() && !e.name.startsWith("."))
				.map((e) => {
					// Check if it's a git repo
					const subPath = join(resolved, e.name);
					const isGit = existsSync(join(subPath, ".git"));
					return { name: e.name, path: subPath, isGit };
				});
			this.sendResponse(conn, id, true, {
				path: resolved,
				parent: resolved === resolve("/") ? resolved : join(resolved, ".."),
				entries: dirs,
			});
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleConnect(conn: ClientConnection, id: string, params?: ConnectParams): Promise<void> {
		// Auth check
		if (this.authManager.requiresAuth) {
			const auth = params?.auth;
			if (auth?.password) {
				if (!this.authManager.verifyPassword(auth.password)) {
					this.sendError(conn, id, "auth_failed", "Invalid password");
					return;
				}
				const issued = this.authManager.issueToken();
				conn.authenticated = true;

				const result = this.buildConnectResult(
					issued.token,
					this.options.auth?.tokenTtlMs ?? 7 * 24 * 60 * 60 * 1000,
				);
				this.sendResponse(conn, id, true, result);
			} else if (auth?.token) {
				if (!this.authManager.verifyToken(auth.token)) {
					this.sendError(conn, id, "auth_failed", "Invalid or expired token");
					return;
				}
				conn.authenticated = true;

				const result = this.buildConnectResult();
				this.sendResponse(conn, id, true, result);
			} else {
				this.sendError(conn, id, "auth_required", "Password or token required");
				return;
			}
		} else {
			conn.authenticated = true;
			const result = this.buildConnectResult();
			this.sendResponse(conn, id, true, result);
		}

		// Store client info
		if (params?.client) {
			conn.clientInfo = params.client;
		}

		// Subscribe to agent events
		this.subscribeClientToAgent(conn);
	}

	private buildConnectResult(token?: string, expiresInMs?: number): Record<string, unknown> {
		const result: Record<string, unknown> = {
			serverVersion: "0.2.0",
			agentRunning: this.bridge?.isRunning ?? false,
			activeProject: this.activeProject,
			activeCwd: this.activeCwd,
		};
		if (token) {
			result.token = token;
			result.expiresInMs = expiresInMs;
		}
		return result;
	}

	// -----------------------------------------------------------------------
	// Agent method handlers (same as before, but use this.bridge!)
	// -----------------------------------------------------------------------

	private async handlePrompt(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as
			| { message?: string; images?: unknown[]; streamingBehavior?: "steer" | "followUp" }
			| undefined;
		if (!p?.message) {
			this.sendError(conn, id, "invalid_params", "message is required");
			return;
		}
		try {
			this.agentStreaming = true;
			const resp = await this.bridge!.prompt(p.message, p.images, p.streamingBehavior);
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		} finally {
			// Keep streaming flag on for a bit — agent_end event may arrive after prompt response
			setTimeout(() => {
				this.agentStreaming = false;
			}, 2000);
		}
	}

	private async handleAbort(conn: ClientConnection, id: string): Promise<void> {
		try {
			const resp = await this.bridge!.abort();
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleSteer(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as { message?: string; images?: unknown[] } | undefined;
		if (!p?.message) {
			this.sendError(conn, id, "invalid_params", "message is required");
			return;
		}
		try {
			const resp = await this.bridge!.steer(p.message, p.images);
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleFollowUp(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as { message?: string; images?: unknown[] } | undefined;
		if (!p?.message) {
			this.sendError(conn, id, "invalid_params", "message is required");
			return;
		}
		try {
			const resp = await this.bridge!.followUp(p.message, p.images);
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleGetMessages(conn: ClientConnection, id: string): Promise<void> {
		try {
			const resp = await this.bridge!.getMessages();
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleGetState(conn: ClientConnection, id: string): Promise<void> {
		try {
			const resp = await this.bridge!.getState();
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleGetModels(conn: ClientConnection, id: string): Promise<void> {
		try {
			const resp = await this.bridge!.getAvailableModels();
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleSetModel(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as { provider?: string; modelId?: string } | undefined;
		if (!p?.provider || !p?.modelId) {
			this.sendError(conn, id, "invalid_params", "provider and modelId are required");
			return;
		}
		try {
			const resp = await this.bridge!.setModel(p.provider, p.modelId);
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleCycleModel(conn: ClientConnection, id: string): Promise<void> {
		try {
			const resp = await this.bridge!.cycleModel();
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleNewSession(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as { parentSession?: string } | undefined;
		try {
			const resp = await this.bridge!.newSession(p?.parentSession);
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleSwitchSession(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as { sessionPath?: string } | undefined;
		if (!p?.sessionPath) {
			this.sendError(conn, id, "invalid_params", "sessionPath is required");
			return;
		}
		try {
			const resp = await this.bridge!.switchSession(p.sessionPath);
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleGetSessionStats(conn: ClientConnection, id: string): Promise<void> {
		try {
			const resp = await this.bridge!.getSessionStats();
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleSetSessionName(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as { name?: string } | undefined;
		if (!p?.name) {
			this.sendError(conn, id, "invalid_params", "name is required");
			return;
		}
		try {
			const resp = await this.bridge!.setSessionName(p.name);
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleCompact(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as { customInstructions?: string } | undefined;
		try {
			const resp = await this.bridge!.compact(p?.customInstructions);
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleBash(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as { command?: string } | undefined;
		if (!p?.command) {
			this.sendError(conn, id, "invalid_params", "command is required");
			return;
		}
		try {
			const resp = await this.bridge!.bash(p.command);
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleSetThinkingLevel(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as { level?: string } | undefined;
		if (!p?.level) {
			this.sendError(conn, id, "invalid_params", "level is required");
			return;
		}
		try {
			const resp = await this.bridge!.setThinkingLevel(p.level);
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleCycleThinkingLevel(conn: ClientConnection, id: string): Promise<void> {
		try {
			const resp = await this.bridge!.cycleThinkingLevel();
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleFork(conn: ClientConnection, id: string, params?: unknown): Promise<void> {
		const p = params as { entryId?: string } | undefined;
		if (!p?.entryId) {
			this.sendError(conn, id, "invalid_params", "entryId is required");
			return;
		}
		try {
			const resp = await this.bridge!.fork(p.entryId);
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleGetForkMessages(conn: ClientConnection, id: string): Promise<void> {
		try {
			const resp = await this.bridge!.getForkMessages();
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	private async handleGetCommands(conn: ClientConnection, id: string): Promise<void> {
		try {
			const resp = await this.bridge!.getCommands();
			this.forwardRpcResponse(conn, id, resp);
		} catch (err) {
			this.sendError(conn, id, "internal", String(err));
		}
	}

	// -----------------------------------------------------------------------
	// HTTP API handling
	// -----------------------------------------------------------------------

	private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const path = url.pathname;

		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		if (path === "/health" && req.method === "GET") {
			const st = this.status;
			this.sendJson(res, 200, {
				...st,
				name: "pi-mobile-server",
				version: "0.2.0",
			});
			return;
		}

		if (path === "/api/projects" && req.method === "GET") {
			const projects = await this.listProjects();
			this.sendJson(res, 200, { projects, activeProject: this.activeProject, activeCwd: this.activeCwd });
			return;
		}

		// Auth check for remaining endpoints
		if (this.authManager.requiresAuth) {
			const authHeader = req.headers.authorization;
			if (!authHeader?.startsWith("Bearer ") || !this.authManager.verifyToken(authHeader.slice(7))) {
				this.sendJson(res, 401, { error: "Invalid auth" });
				return;
			}
		}

		try {
			if (path === "/api/projects" && req.method === "POST") {
				const body = JSON.parse(await this.readBody(req));
				await this.addProject(body.name, body.path, body.description);
				this.sendJson(res, 200, { projects: await this.listProjects() });
			} else if (path === "/api/select-project" && req.method === "POST") {
				const body = JSON.parse(await this.readBody(req));
				await this.startAgent(body.path);
				this.sendJson(res, 200, { project: this.activeProject, cwd: this.activeCwd });
			} else if (path === "/api/browse" && req.method === "GET") {
				const dirPath = url.searchParams.get("path") || homedir();
				const resolved = resolve(dirPath);
				const entries = await readdir(resolved, { withFileTypes: true });
				const dirs = entries
					.filter((e) => e.isDirectory() && !e.name.startsWith("."))
					.map((e) => ({ name: e.name, path: join(resolved, e.name) }));
				this.sendJson(res, 200, { path: resolved, parent: join(resolved, ".."), entries: dirs });
			} else if (!this.bridge) {
				this.sendJson(res, 400, { error: "No project selected" });
			} else if (path === "/api/state" && req.method === "GET") {
				this.sendRpcAsHttp(res, await this.bridge.getState());
			} else if (path === "/api/messages" && req.method === "GET") {
				this.sendRpcAsHttp(res, await this.bridge.getMessages());
			} else if (path === "/api/models" && req.method === "GET") {
				this.sendRpcAsHttp(res, await this.bridge.getAvailableModels());
			} else if (path === "/api/prompt" && req.method === "POST") {
				const body = JSON.parse(await this.readBody(req));
				this.sendRpcAsHttp(res, await this.bridge.prompt(body.message, body.images, body.streamingBehavior));
			} else if (path === "/api/abort" && req.method === "POST") {
				this.sendRpcAsHttp(res, await this.bridge.abort());
			} else {
				// Fallback: serve static web files or 404
				await this.serveStatic(req, res, path);
			}
		} catch (err) {
			this.sendJson(res, 500, { error: String(err) });
		}
	}

	// -----------------------------------------------------------------------
	// Frame helpers
	// -----------------------------------------------------------------------

	private sendResponse(conn: ClientConnection, id: string, ok: boolean, payload?: unknown, error?: ErrorShape): void {
		this.send(conn, { type: "res", id, ok, payload, error });
	}

	private sendError(conn: ClientConnection, id: string, code: string, message: string): void {
		this.sendResponse(conn, id, false, undefined, { code, message });
	}

	private sendEvent(conn: ClientConnection, event: string, payload?: unknown): void {
		this.send(conn, { type: "event", event, payload, seq: ++this.seq });
	}

	private broadcastEvent(event: string, payload?: unknown): void {
		for (const conn of this.connections.values()) {
			if (conn.authenticated) this.sendEvent(conn, event, payload);
		}
	}

	private forwardRpcResponse(
		conn: ClientConnection,
		id: string,
		resp: { success: boolean; data?: unknown; error?: string },
	): void {
		if (resp.success) this.sendResponse(conn, id, true, resp.data);
		else this.sendError(conn, id, "agent_error", resp.error ?? "Unknown agent error");
	}

	private send(conn: ClientConnection, frame: Frame): void {
		if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(frame));
	}

	private sendJson(res: ServerResponse, status: number, data: unknown): void {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data));
	}

	private sendRpcAsHttp(res: ServerResponse, rpc: { success: boolean; data?: unknown; error?: string }): void {
		this.sendJson(res, rpc.success ? 200 : 400, rpc.success ? (rpc.data ?? { ok: true }) : { error: rpc.error });
	}

	private readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			req.on("error", reject);
		});
	}

	// -----------------------------------------------------------------------
	// Static file serving (SPA)
	// -----------------------------------------------------------------------

	private mimeTypes: Record<string, string> = {
		".html": "text/html",
		".js": "application/javascript",
		".mjs": "application/javascript",
		".css": "text/css",
		".json": "application/json",
		".png": "image/png",
		".jpg": "image/jpeg",
		".svg": "image/svg+xml",
		".ico": "image/x-icon",
		".woff": "font/woff",
		".woff2": "font/woff2",
		".webmanifest": "application/manifest+json",
	};

	private async serveStatic(_req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<void> {
		if (!this.webDir) {
			this.sendJson(res, 404, { error: "Not found" });
			return;
		}

		// Map URL path to file path. SPA: non-file paths serve index.html
		let filePath: string;
		if (urlPath === "/" || !extname(urlPath)) {
			filePath = join(this.webDir, "index.html");
		} else {
			filePath = join(this.webDir, urlPath);
		}

		// Security: ensure path doesn't escape webDir
		if (!filePath.startsWith(this.webDir)) {
			this.sendJson(res, 403, { error: "Forbidden" });
			return;
		}

		try {
			if (!existsSync(filePath)) {
				// SPA fallback for unknown files
				filePath = join(this.webDir, "index.html");
			}
			const data = await readFile(filePath);
			const mime = this.mimeTypes[extname(filePath)] || "application/octet-stream";
			res.writeHead(200, { "Content-Type": mime });
			res.end(data);
		} catch {
			this.sendJson(res, 404, { error: "Not found" });
		}
	}
}
