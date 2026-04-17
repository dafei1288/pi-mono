import React, { useState, useCallback, useRef, useEffect } from "react";
import {
	View,
	Text,
	TextInput,
	TouchableOpacity,
	StyleSheet,
	ScrollView,
	ActivityIndicator,
} from "./react-native";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

type Screen = "connect" | "projects" | "chat";

interface Project {
	name: string;
	path: string;
	description?: string;
}

interface DirEntry {
	name: string;
	path: string;
	isGit?: boolean;
}

interface ChatMsg {
	id: string;
	role: "user" | "assistant" | "system" | "tool";
	text: string;
	toolName?: string;
	thinking?: string;
}

// -------------------------------------------------------------------------
// Persisted server history (localStorage on web)
// -------------------------------------------------------------------------

interface SavedServer {
	url: string;
	lastUsed: number;
}

const STORAGE_KEY = "pi_saved_servers";

function loadServers(): SavedServer[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? JSON.parse(raw) : [];
	} catch {
		return [];
	}
}

function persistServers(servers: SavedServer[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
	} catch {}
}

function addServer(url: string): void {
	const servers = loadServers();
	const idx = servers.findIndex((s) => s.url === url);
	const entry: SavedServer = { url, lastUsed: Date.now() };
	if (idx >= 0) servers[idx] = entry;
	else servers.push(entry);
	servers.sort((a, b) => b.lastUsed - a.lastUsed);
	persistServers(servers.slice(0, 10));
}

function removeServer(url: string): void {
	persistServers(loadServers().filter((s) => s.url !== url));
}

// -------------------------------------------------------------------------
// Network discovery — scan local subnet for pi-mobile-servers
// -------------------------------------------------------------------------

interface DiscoveredServer {
	ip: string;
	port: number;
	name: string;
	version: string;
	authRequired: boolean;
	activeProject: string | null;
}

async function probeHost(ip: string, port: number, timeoutMs = 800): Promise<DiscoveredServer | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const res = await fetch(`http://${ip}:${port}/health`, { signal: controller.signal });
		clearTimeout(timer);
		if (!res.ok) return null;
		const data = await res.json();
		if (data.name !== "pi-mobile-server") return null;
		return { ip, port, name: data.name, version: data.version, authRequired: data.authRequired, activeProject: data.activeProject };
	} catch {
		return null;
	}
}

async function scanSubnet(port: number, onFound: (srv: DiscoveredServer) => void): Promise<void> {
	// Try to guess our subnet from WebRTC or common patterns
	const subnets = ["192.168.1", "192.168.0", "10.0.0", "192.168.31", "192.168.2"];

	// Probe all subnets in parallel (each IP gets 800ms timeout, 20 concurrent)
	const allIPs = subnets.flatMap((sub) =>
		Array.from({ length: 255 }, (_, i) => `${sub}.${i + 1}`),
	);

	// Batch in groups of 30 for reasonable concurrency
	for (let i = 0; i < allIPs.length; i += 30) {
		const batch = allIPs.slice(i, i + 30);
		const results = await Promise.allSettled(
			batch.map((ip) => probeHost(ip, port)),
		);
		for (const r of results) {
			if (r.status === "fulfilled" && r.value) {
				onFound(r.value);
			}
		}
	}
}

// -------------------------------------------------------------------------
// Push notifications (Web Notification API)
// -------------------------------------------------------------------------

let notificationPermission = "default";

async function requestNotificationPermission(): Promise<void> {
	if (typeof Notification === "undefined") return;
	if (Notification.permission === "granted") {
		notificationPermission = "granted";
		return;
	}
	if (Notification.permission !== "denied") {
		const result = await Notification.requestPermission();
		notificationPermission = result;
	}
}

function notifyAgentComplete(project: string, lastMessage: string): void {
	if (typeof Notification === "undefined") return;
	if (notificationPermission !== "granted") return;
	if (!document.hidden) return; // only notify when tab is in background

	const body = lastMessage.length > 80 ? lastMessage.slice(0, 80) + "..." : lastMessage;
	const notification = new Notification(`pi — Agent finished (${project})`, {
		body: body || "Task complete",
		icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🤖</text></svg>",
		tag: "pi-agent-complete",
	});
	notification.onclick = () => {
		window.focus();
		notification.close();
	};
}

// -------------------------------------------------------------------------
// Markdown styles (injected once into <head> for web)
// -------------------------------------------------------------------------

// PWA: inject all native-like meta + CSS on startup (web only)
// Since Expo ignores web/index.html, we inject everything dynamically.

let pwaReady = false;
function initPWA() {
	if (pwaReady || typeof document === "undefined") return;
	pwaReady = true;

	// Manifest
	const manifest = document.createElement("link");
	manifest.rel = "manifest";
	manifest.href = "/manifest.json";
	document.head.appendChild(manifest);

	// Theme color
	const theme = document.createElement("meta");
	theme.name = "theme-color";
	theme.content = "#0a0a0a";
	document.head.appendChild(theme);

	// iOS standalone
	const appleCapable = document.createElement("meta");
	appleCapable.name = "apple-mobile-web-app-capable";
	appleCapable.content = "yes";
	document.head.appendChild(appleCapable);

	const appleBar = document.createElement("meta");
	appleBar.name = "apple-mobile-web-app-status-bar-style";
	appleBar.content = "black-translucent";
	document.head.appendChild(appleBar);

	const appleTitle = document.createElement("meta");
	appleTitle.name = "apple-mobile-web-app-title";
	appleTitle.content = "pi";
	document.head.appendChild(appleTitle);

	const appleIcon = document.createElement("link");
	appleIcon.rel = "apple-touch-icon";
	appleIcon.href = "/icon.svg";
	document.head.appendChild(appleIcon);

	// Fix viewport: prevent zoom, cover safe areas
	const existingViewport = document.querySelector('meta[name="viewport"]');
	if (existingViewport) {
		existingViewport.setAttribute("content",
			"width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover, maximum-scale=1, user-scalable=no");
	}

	// Global native-like CSS
	const style = document.createElement("style");
	style.textContent = `
		html, body {
			overscroll-behavior: none;
			-webkit-user-select: none;
			user-select: none;
			-webkit-tap-highlight-color: transparent;
			-webkit-touch-callout: none;
		}
		.md-body {
			-webkit-user-select: text;
			user-select: text;
		}
		#root {
			padding-top: env(safe-area-inset-top);
			padding-bottom: env(safe-area-inset-bottom);
		}
		* { scrollbar-width: none; -ms-overflow-style: none; }
		*::-webkit-scrollbar { display: none; }
		input, textarea {
			-webkit-user-select: text;
			user-select: text;
			outline: none;
			-webkit-appearance: none;
			appearance: none;
			border-radius: 0;
		}
		@supports (-webkit-touch-callout: none) {
			input, textarea { font-size: 16px !important; }
		}
	`;
	document.head.appendChild(style);

	// Service worker
	if ("serviceWorker" in navigator) {
		navigator.serviceWorker.register("/sw.js").catch(() => {});
	}
}

let stylesInjected = false;

function injectHighlightStyles() {
	if (stylesInjected || typeof document === "undefined") return;
	stylesInjected = true;

	// highlight.js theme
	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css";
	link.crossOrigin = "anonymous";
	document.head.appendChild(link);

	// Scoped styles for markdown inside .md-body
	const style = document.createElement("style");
	style.textContent = `
		.md-body { font-size: 14px; line-height: 1.6; color: #d4d4d4; }
		.md-body p { margin: 0 0 8px 0; }
		.md-body p:last-child { margin-bottom: 0; }
		.md-body h1, .md-body h2, .md-body h3 { margin: 12px 0 6px 0; color: #fff; font-weight: 700; }
		.md-body h1 { font-size: 20px; }
		.md-body h2 { font-size: 17px; }
		.md-body h3 { font-size: 15px; }
		.md-body code {
			font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
			font-size: 13px;
		}
		.md-body :not(pre) > code {
			background: #2a2a2a;
			padding: 2px 6px;
			border-radius: 4px;
			color: #ff79c6;
		}
		.md-body pre {
			background: #161b22 !important;
			border: 1px solid #30363d;
			border-radius: 8px;
			padding: 12px;
			margin: 8px 0;
			overflow-x: auto;
		}
		.md-body pre code {
			background: none !important;
			padding: 0 !important;
			color: #e6edf3 !important;
		}
		.md-body pre code span { color: inherit; }
		.md-body ul, .md-body ol { margin: 4px 0; padding-left: 20px; }
		.md-body li { margin: 2px 0; }
		.md-body blockquote {
			border-left: 3px solid #4a9eff;
			margin: 8px 0;
			padding: 4px 12px;
			color: #999;
		}
		.md-body a { color: #4a9eff; text-decoration: none; }
		.md-body a:hover { text-decoration: underline; }
		.md-body table { border-collapse: collapse; margin: 8px 0; }
		.md-body th, .md-body td { border: 1px solid #333; padding: 6px 10px; }
		.md-body th { background: #1e1e1e; font-weight: 600; }
		.md-body hr { border: none; border-top: 1px solid #333; margin: 12px 0; }
		.md-body img { max-width: 100%; border-radius: 8px; }
		.md-body strong { color: #fff; }
		.md-body em { color: #bbb; }
	`;
	document.head.appendChild(style);
}

// -------------------------------------------------------------------------
// Markdown renderer
// -------------------------------------------------------------------------

const mdComponents = {} as any;

// -------------------------------------------------------------------------
// Message Bubble Component
// -------------------------------------------------------------------------

function MessageBubble({ msg }: { msg: ChatMsg }) {
	const [showThinking, setShowThinking] = useState(false);

	if (msg.role === "tool") {
		return (
			<View style={s.toolBubble}>
				<View style={s.toolHeader}>
					<Text style={s.toolIcon}>🔧</Text>
					<Text style={s.toolName} numberOfLines={1}>{msg.toolName || "tool"}</Text>
				</View>
				{msg.text ? (
					<View style={s.toolResult}>
						<div className="md-body">
							<Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{msg.text}</Markdown>
						</div>
					</View>
				) : null}
			</View>
		);
	}

	if (msg.role === "system") {
		return (
			<View style={[s.bubble, s.bubbleSystem]}>
				<Text style={s.systemText}>{msg.text}</Text>
			</View>
		);
	}

	const isUser = msg.role === "user";

	return (
		<View style={[s.msgRow, isUser ? s.msgRowUser : s.msgRowAsst]}>
			{msg.thinking ? (
				<TouchableOpacity style={s.thinkingBlock} onPress={() => setShowThinking((v) => !v)}>
					<Text style={s.thinkingToggle}>{showThinking ? "▼" : "▶"} Thinking...</Text>
					{showThinking && (
						<View style={s.thinkingContent}>
							<div className="md-body">
								<Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{msg.thinking}</Markdown>
							</div>
						</View>
					)}
				</TouchableOpacity>
			) : null}

			<View style={[s.bubble, isUser ? s.bubbleUser : s.bubbleAsst]}>
				{isUser ? (
					<Text style={s.userText}>{msg.text}</Text>
				) : (
					<div className="md-body">
						<Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>{msg.text}</Markdown>
					</div>
				)}
			</View>
		</View>
	);
}

// -------------------------------------------------------------------------
// Streaming Bubble
// -------------------------------------------------------------------------

function StreamingBubble({ text }: { text: string }) {
	if (!text) return null;
	return (
		<View style={s.msgRowAsst}>
			<View style={[s.bubble, s.bubbleAsst]}>
				<div className="md-body">
					<Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>{text}</Markdown>
				</div>
				<Text style={s.cursor}>▌</Text>
			</View>
		</View>
	);
}

// -------------------------------------------------------------------------
// QR Scanner Component (web only, uses html5-qrcode)
// -------------------------------------------------------------------------

function QRScannerOverlay({ onScan, onClose }: { onScan: (url: string) => void; onClose: () => void }) {
	const scannerRef = useRef<any>(null);
	const [scanning, setScanning] = useState(false);
	const [qrError, setQrError] = useState("");

	useEffect(() => {
		let mounted = true;

		async function startScanner() {
			try {
				const { Html5Qrcode } = await import("html5-qrcode");
				const scanner = new Html5Qrcode("pi-qr-reader");
				scannerRef.current = scanner;
				await scanner.start(
					{ facingMode: "environment" },
					{ fps: 10, qrbox: { width: 250, height: 250 } },
					(decodedText: string) => {
						if (mounted) {
							scanner.stop().catch(() => {});
							onScan(decodedText);
						}
					},
					() => {}, // ignore scan failures (no match frame)
				);
				if (mounted) setScanning(true);
			} catch (err) {
				if (mounted) setQrError(String(err));
			}
		}

		startScanner();

		return () => {
			mounted = false;
			scannerRef.current?.stop().catch(() => {});
		};
	}, [onScan]);

	return (
		<View style={s.qrOverlay}>
			<View style={s.qrPanel}>
				<View style={s.qrHeader}>
					<Text style={s.qrTitle}>Scan QR Code</Text>
					<TouchableOpacity onPress={onClose}>
						<Text style={s.qrClose}>✕</Text>
					</TouchableOpacity>
				</View>
				<View style={s.qrBody}>
					{qrError ? (
						<Text style={s.qrError}>Camera unavailable: {qrError}</Text>
					) : !scanning ? (
						<ActivityIndicator color="#4a9eff" size="large" />
					) : null}
					<div id="pi-qr-reader" style={{ width: "100%" }} />
				</View>
				<Text style={s.qrHint}>Point camera at the QR code on the server terminal</Text>
			</View>
		</View>
	);
}

// -------------------------------------------------------------------------
// Discovery Results Component
// -------------------------------------------------------------------------

function DiscoveryOverlay({
	servers,
	scanning,
	onSelect,
	onClose,
}: {
	servers: DiscoveredServer[];
	scanning: boolean;
	onSelect: (srv: DiscoveredServer) => void;
	onClose: () => void;
}) {
	return (
		<View style={s.discOverlay}>
			<View style={s.discPanel}>
				<View style={s.discHeader}>
					<Text style={s.discTitle}>
						{scanning ? "Scanning network..." : "Found Servers"}
					</Text>
					<TouchableOpacity onPress={onClose}>
						<Text style={s.discClose}>✕</Text>
					</TouchableOpacity>
				</View>
				<ScrollView style={s.discList}>
					{servers.length === 0 && !scanning && (
						<Text style={s.discEmpty}>No servers found on local network</Text>
					)}
					{servers.map((srv) => (
						<TouchableOpacity
							key={`${srv.ip}:${srv.port}`}
							style={s.discItem}
							onPress={() => onSelect(srv)}
						>
							<View style={s.discItemInfo}>
								<Text style={s.discItemName}>pi-mobile-server</Text>
								<Text style={s.discItemAddr}>{srv.ip}:{srv.port}</Text>
							</View>
							<View style={s.discItemMeta}>
								{srv.activeProject ? (
									<Text style={s.discItemProject}>🌿 {srv.activeProject}</Text>
								) : (
									<Text style={s.discItemNoProject}>No project</Text>
								)}
								{srv.authRequired && <Text style={s.discItemAuth}>🔒 Auth</Text>}
							</View>
						</TouchableOpacity>
					))}
					{scanning && (
						<View style={s.discLoading}>
							<ActivityIndicator color="#4a9eff" size="small" />
							<Text style={s.discLoadingText}>Scanning subnet...</Text>
						</View>
					)}
				</ScrollView>
			</View>
		</View>
	);
}

// -------------------------------------------------------------------------
// App
// -------------------------------------------------------------------------

export default function App() {
	const [screen, setScreen] = useState<Screen>("connect");
	const [serverUrl, setServerUrl] = useState("");
	const [projects, setProjects] = useState<Project[]>([]);
	const [activeProject, setActiveProject] = useState("");
	const [activeCwd, setActiveCwd] = useState("");
	const [messages, setMessages] = useState<ChatMsg[]>([]);
	const [input, setInput] = useState("");
	const [streamingText, setStreamingText] = useState("");
	const [streamingThinking, setStreamingThinking] = useState("");
	const [loading, setLoading] = useState("");
	const [error, setError] = useState("");
	const [dirEntries, setDirEntries] = useState<DirEntry[]>([]);
	const [currentDir, setCurrentDir] = useState("");
	const [showBrowser, setShowBrowser] = useState(false);
	const [showMenu, setShowMenu] = useState(false);
	const [savedServers, setSavedServers] = useState<SavedServer[]>([]);
	const [isStreaming, setIsStreaming] = useState(false);
	const [sessions, setSessions] = useState<Array<{ path: string; name: string; modified: string; messageCount: number; firstMessage: string }>>([]);
	const [showSessions, setShowSessions] = useState(false);
	const [currentSessionId, setCurrentSessionId] = useState("");

	// QR scanner
	const [showQR, setShowQR] = useState(false);

	// Network discovery
	const [showDiscovery, setShowDiscovery] = useState(false);
	const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>([]);
	const [scanningNetwork, setScanningNetwork] = useState(false);

	useEffect(() => {
		setSavedServers(loadServers());
		injectHighlightStyles();
		requestNotificationPermission();
		initPWA();
	}, []);

	const wsRef = useRef<WebSocket | null>(null);
	const pendingRef = useRef<Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>>(new Map());
	const seqRef = useRef(0);
	const scrollRef = useRef<any>(null);
	const lastUserMsgRef = useRef("");

	const rpc = useCallback((method: string, params?: Record<string, unknown>): Promise<any> => {
		return new Promise((resolve, reject) => {
			const ws = wsRef.current;
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				reject(new Error("Not connected"));
				return;
			}
			const id = `r_${++seqRef.current}`;
			pendingRef.current.set(id, { resolve, reject });
			ws.send(JSON.stringify({ type: "req", id, method, params }));
		});
	}, []);

	const handleWsMessage = useCallback((raw: string) => {
		try {
			const frame = JSON.parse(raw);
			if (frame.type === "res") {
				const pending = pendingRef.current.get(frame.id);
				if (pending) {
					pendingRef.current.delete(frame.id);
					if (frame.ok) pending.resolve(frame.payload);
					else pending.reject(new Error(frame.error?.message ?? "RPC error"));
				}
			} else if (frame.type === "event") {
				const payload = frame.payload as Record<string, unknown> | undefined;
				if (!payload) return;
				const eventType = payload.type as string;
				switch (eventType) {
					case "agent_start":
						setStreamingText("");
						setStreamingThinking("");
						setIsStreaming(true);
						break;
					case "agent_end":
						setIsStreaming(false);
						setStreamingThinking((think) => {
							setStreamingText((text) => {
								if (text || think) {
									const finalText = text || "";
									setMessages((msgs) => {
										const newMsgs = [...msgs, {
											id: `m_${Date.now()}`,
											role: "assistant" as const,
											text: finalText,
											thinking: think || undefined,
										}];
										// Push notification: agent completed in background
										notifyAgentComplete(
											activeProject || "project",
											lastUserMsgRef.current,
										);
										return newMsgs;
									});
								}
								return "";
							});
							return "";
						});
						break;
					case "message_update": {
						const msgEvent = payload.assistantMessageEvent as Record<string, unknown> | undefined;
						if (!msgEvent) break;
						const innerType = msgEvent.type as string;
						if (innerType === "text_delta") {
							setStreamingText((prev) => prev + ((msgEvent as any)?.delta ?? ""));
						} else if (innerType === "thinking_delta") {
							setStreamingThinking((prev) => prev + ((msgEvent as any)?.delta ?? ""));
						}
						break;
					}
					case "project_changed":
						setActiveProject((payload as any)?.project ?? "");
						setActiveCwd((payload as any)?.cwd ?? "");
						break;
				}
			}
		} catch {}
	}, [activeProject]);

	const connect = useCallback(async (overrideUrl?: string) => {
		const url = overrideUrl ?? serverUrl;
		if (!url.trim()) return;
		setServerUrl(url);
		setError("");
		setLoading("Connecting...");
		try {
			const wsUrl = url.startsWith("ws") ? url : `ws://${url}`;
			const ws = new WebSocket(wsUrl);
			ws.onopen = async () => {
				wsRef.current = ws;
				try {
					await rpc("connect", { client: { name: "pi-mobile", version: "1", platform: "web", mode: "mobile" } });
					const res = await rpc("list_projects");
					setProjects(res.projects ?? []);
					setActiveProject(res.activeProject ?? "");
					setActiveCwd(res.activeCwd ?? "");
					setLoading("");
					addServer(url);
					setSavedServers(loadServers());
					if (res.activeProject && res.agentRunning) {
						setScreen("chat");
					} else {
						setScreen("projects");
					}
				} catch (err) {
					setError(String(err));
					setLoading("");
				}
			};
			ws.onmessage = (e) => handleWsMessage(typeof e.data === "string" ? e.data : "");
			ws.onerror = () => { setError("Connection failed"); setLoading(""); };
			ws.onclose = () => { wsRef.current = null; setScreen("connect"); setLoading(""); };
		} catch (err) {
			setError(String(err));
			setLoading("");
		}
	}, [serverUrl, rpc, handleWsMessage]);

	const handleQRScan = useCallback((url: string) => {
		// QR code may contain just "host:port" or "ws://host:port"
		const cleaned = url.replace(/^ws:\/\//, "").replace(/^http:\/\//, "").replace(/\/$/, "");
		setShowQR(false);
		connect(cleaned);
	}, [connect]);

	const startDiscovery = useCallback(async () => {
		setShowDiscovery(true);
		setDiscoveredServers([]);
		setScanningNetwork(true);
		await scanSubnet(18790, (srv) => {
			setDiscoveredServers((prev) => {
				// Deduplicate
				if (prev.some((s) => s.ip === srv.ip && s.port === srv.port)) return prev;
				return [...prev, srv];
			});
		});
		setScanningNetwork(false);
	}, []);

	const handleDiscoverySelect = useCallback((srv: DiscoveredServer) => {
		setShowDiscovery(false);
		connect(`${srv.ip}:${srv.port}`);
	}, [connect]);

	const selectProject = useCallback(async (path: string) => {
		setError("");
		setLoading("Starting agent...");
		try {
			const res = await rpc("select_project", { path });
			setActiveProject(res.project ?? "");
			setActiveCwd(res.cwd ?? "");
			setMessages([]);
			setStreamingText("");
			setScreen("chat");
		} catch (err) {
			setError(String(err));
		}
		setLoading("");
	}, [rpc]);

	const browse = useCallback(async (path?: string) => {
		setLoading("Loading...");
		try {
			const res = await rpc("browse_directory", { path });
			setDirEntries(res.entries ?? []);
			setCurrentDir(res.path ?? "");
			setShowBrowser(true);
		} catch (err) {
			setError(String(err));
		}
		setLoading("");
	}, [rpc]);

	const sendMessage = useCallback(async () => {
		const text = input.trim();
		if (!text) return;
		setInput("");
		setShowMenu(false);
		await sendMessageDirect(text);
	}, [input]);

	const sendMessageDirect = useCallback(async (text: string) => {
		const trimmed = text.trim();
		if (trimmed === "/resume" || trimmed === "/sessions") {
			try {
				const res = await rpc("list_sessions");
				setSessions(res.sessions ?? []);
				setCurrentSessionId(res.currentSessionId ?? "");
				setShowSessions(true);
			} catch (err) {
				setMessages((prev) => [...prev, { id: `e_${Date.now()}`, role: "system", text: `Error: ${err}` }]);
			}
			return;
		}
		lastUserMsgRef.current = trimmed;
		setMessages((prev) => [...prev, { id: `u_${Date.now()}`, role: "user", text: trimmed }]);
		setStreamingText("");
		setIsStreaming(true);
		try {
			await rpc("prompt", { message: trimmed });
		} catch (err) {
			setIsStreaming(false);
			setMessages((prev) => [...prev, { id: `e_${Date.now()}`, role: "system", text: `Error: ${err}` }]);
		}
	}, [rpc]);

	const switchSession = useCallback(async (sessionPath: string) => {
		setShowSessions(false);
		setMessages([{ id: `s_${Date.now()}`, role: "system", text: "Switching session..." }]);
		try {
			const res = await rpc("switch_session", { sessionPath });
			if (res?.cancelled) {
				setMessages([{ id: `s_${Date.now()}`, role: "system", text: "Switch cancelled" }]);
				return;
			}
			try {
				const msgRes = await rpc("get_messages");
				const msgs = (msgRes?.messages ?? []).flatMap((m: any) => {
					if (m.role === "user") return [{ id: `ls_${Date.now()}_${Math.random()}`, role: "user" as const, text: typeof m.content === "string" ? m.content : "" }];
					if (m.role === "assistant" && m.content) {
						const texts = Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") : String(m.content);
						return texts ? [{ id: `ls_${Date.now()}_${Math.random()}`, role: "assistant" as const, text: texts }] : [];
					}
					return [];
				});
				setMessages(msgs);
			} catch {
				setMessages([]);
			}
			setStreamingText("");
		} catch (err) {
			setMessages([{ id: `e_${Date.now()}`, role: "system", text: `Switch failed: ${err}` }]);
		}
	}, [rpc]);

	const abort = useCallback(async () => {
		try { await rpc("abort"); } catch {}
		setIsStreaming(false);
	}, [rpc]);

	const disconnect = useCallback(() => {
		wsRef.current?.close();
		wsRef.current = null;
		setScreen("connect");
		setMessages([]);
		setStreamingText("");
		setProjects([]);
		setActiveProject("");
		setIsStreaming(false);
	}, []);

	useEffect(() => {
		setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 100);
	}, [messages, streamingText]);

	useEffect(() => {
		if (!showMenu) return;
		const timer = setTimeout(() => setShowMenu(false), 5000);
		return () => clearTimeout(timer);
	}, [showMenu]);

	// =====================================================================
	// SCREEN: Connect
	// =====================================================================
	if (screen === "connect") {
		return (
			<View style={s.root}>
				<View style={s.center}>
					<Text style={s.logo}>pi</Text>
					<Text style={s.tagline}>remote coding agent</Text>
					{!!error && <Text style={s.error}>{error}</Text>}

					{/* Action buttons row: QR scan + Discovery */}
					<View style={s.connectActions}>
						<TouchableOpacity style={s.actionBtn} onPress={() => setShowQR(true)}>
							<Text style={s.actionBtnIcon}>📷</Text>
							<Text style={s.actionBtnLabel}>Scan QR</Text>
						</TouchableOpacity>
						<TouchableOpacity style={s.actionBtn} onPress={startDiscovery}>
							<Text style={s.actionBtnIcon}>📡</Text>
							<Text style={s.actionBtnLabel}>Discover</Text>
						</TouchableOpacity>
					</View>

					<TextInput
						style={s.input}
						value={serverUrl}
						onChangeText={setServerUrl}
						placeholder="Server address (e.g. 192.168.1.100:18790)"
						placeholderTextColor="#555"
						autoCapitalize="none"
						autoCorrect={false}
						editable={!loading}
						onSubmitEditing={() => connect()}
					/>
					<TouchableOpacity style={s.btnPrimary} onPress={() => connect()} disabled={!!loading}>
						{loading ? <ActivityIndicator color="#0a0a0a" /> : <Text style={s.btnPrimaryText}>Connect</Text>}
					</TouchableOpacity>
					{savedServers.length > 0 && (
						<View style={s.serverList}>
							<Text style={s.serverListTitle}>Recent Servers</Text>
							{savedServers.map((srv) => (
								<View key={srv.url} style={s.serverRow}>
									<TouchableOpacity style={s.serverRowInfo} onPress={() => connect(srv.url)}>
										<Text style={s.serverUrl}>{srv.url}</Text>
										<Text style={s.serverTime}>{new Date(srv.lastUsed).toLocaleDateString()}</Text>
									</TouchableOpacity>
									<TouchableOpacity onPress={() => { removeServer(srv.url); setSavedServers(loadServers()); }}>
										<Text style={s.serverRemove}>×</Text>
									</TouchableOpacity>
								</View>
							))}
						</View>
					)}
				</View>

				{/* QR Scanner overlay */}
				{showQR && (
					<QRScannerOverlay
						onScan={handleQRScan}
						onClose={() => setShowQR(false)}
					/>
				)}

				{/* Discovery overlay */}
				{showDiscovery && (
					<DiscoveryOverlay
						servers={discoveredServers}
						scanning={scanningNetwork}
						onSelect={handleDiscoverySelect}
						onClose={() => setShowDiscovery(false)}
					/>
				)}
			</View>
		);
	}

	// =====================================================================
	// SCREEN: Project Selection
	// =====================================================================
	if (screen === "projects") {
		return (
			<View style={s.root}>
				<View style={s.header}>
					<TouchableOpacity onPress={() => setScreen("connect")}>
						<Text style={s.backBtn}>← Server</Text>
					</TouchableOpacity>
					<Text style={s.headerTitle}>Select Project</Text>
					<TouchableOpacity onPress={disconnect}>
						<Text style={s.disconnectBtn}>Disconnect</Text>
					</TouchableOpacity>
				</View>
				{!!error && <Text style={s.errorBanner}>{error}</Text>}
				<ScrollView style={s.flex}>
					{activeProject && (
						<TouchableOpacity style={s.activeCard} onPress={() => setScreen("chat")}>
							<View style={s.activeDot} />
							<View style={s.flex}>
								<Text style={s.activeName}>{activeProject}</Text>
								<Text style={s.activePath} numberOfLines={1}>{activeCwd}</Text>
							</View>
							<Text style={s.goChat}>Chat →</Text>
						</TouchableOpacity>
					)}
					{showBrowser ? (
						<View style={s.section}>
							<Text style={s.sectionTitle}>{currentDir}</Text>
							<TouchableOpacity style={s.dirRow} onPress={() => browse("..")}>
								<Text style={s.dirUp}>📁 ..</Text>
							</TouchableOpacity>
							{dirEntries.map((e) => (
								<TouchableOpacity key={e.path} style={s.dirRow} onPress={() => selectProject(e.path)}>
									<Text style={s.dirName}>{e.isGit ? "🌿" : "📁"} {e.name}</Text>
									<Text style={s.dirSelect}>Select</Text>
								</TouchableOpacity>
							))}
							<TouchableOpacity style={s.dirRow} onPress={() => setShowBrowser(false)}>
								<Text style={s.dirClose}>Close browser</Text>
							</TouchableOpacity>
						</View>
					) : (
						<TouchableOpacity style={s.browseBtn} onPress={() => browse()}>
							<Text style={s.browseBtnText}>📂 Browse directories...</Text>
						</TouchableOpacity>
					)}
					{projects.length > 0 && (
						<View style={s.section}>
							<Text style={s.sectionTitle}>Saved Projects</Text>
							{projects.map((p) => (
								<TouchableOpacity key={p.path} style={s.projectCard} onPress={() => selectProject(p.path)}>
									<Text style={s.projectName}>🌿 {p.name}</Text>
									<Text style={s.projectPath} numberOfLines={1}>{p.path}</Text>
								</TouchableOpacity>
							))}
						</View>
					)}
				</ScrollView>
			</View>
		);
	}

	// =====================================================================
	// SCREEN: Chat
	// =====================================================================
	return (
		<View style={s.root}>
			<View style={s.header}>
				<TouchableOpacity style={s.projectSwitch} onPress={() => setScreen("projects")}>
					<View style={s.activeDot} />
					<Text style={s.projectLabel} numberOfLines={1}>{activeProject || "No project"}</Text>
				</TouchableOpacity>
				<TouchableOpacity style={s.menuBtn} onPress={() => setShowMenu((v) => !v)}>
					<Text style={s.menuBtnText}>⋮</Text>
				</TouchableOpacity>
			</View>

			{showMenu && (
				<TouchableOpacity style={s.menuOverlay} onPress={() => setShowMenu(false)} activeOpacity={1}>
					<View style={s.menu} onStartShouldSetResponder={() => true}>
						<TouchableOpacity style={s.menuItem} onPress={() => { setShowMenu(false); setScreen("projects"); }}>
							<Text style={s.menuItemText}>🔄 Switch project</Text>
						</TouchableOpacity>
						<TouchableOpacity style={s.menuItem} onPress={() => { setShowMenu(false); sendMessageDirect("/compact"); }}>
							<Text style={s.menuItemText}>📦 Compact context</Text>
						</TouchableOpacity>
						<TouchableOpacity style={s.menuItem} onPress={() => { setShowMenu(false); sendMessageDirect("/new"); }}>
							<Text style={s.menuItemText}>✨ New session</Text>
						</TouchableOpacity>
						<TouchableOpacity style={s.menuItem} onPress={() => { setShowMenu(false); sendMessageDirect("/sessions"); }}>
							<Text style={s.menuItemText}>📋 Resume session</Text>
						</TouchableOpacity>
						<TouchableOpacity style={s.menuItem} onPress={() => { setShowMenu(false); sendMessageDirect("/model"); }}>
							<Text style={s.menuItemText}>🤖 Switch model</Text>
						</TouchableOpacity>
						<TouchableOpacity style={s.menuItem} onPress={() => { setShowMenu(false); sendMessageDirect("/session"); }}>
							<Text style={s.menuItemText}>📊 Session info</Text>
						</TouchableOpacity>
						<View style={s.menuDivider} />
						<TouchableOpacity style={s.menuItem} onPress={() => { setShowMenu(false); disconnect(); }}>
							<Text style={s.menuItemTextDanger}>Disconnect</Text>
						</TouchableOpacity>
					</View>
				</TouchableOpacity>
			)}

			{showSessions && (
				<TouchableOpacity style={s.sessionOverlay} activeOpacity={1} onPress={() => setShowSessions(false)}>
					<View style={s.sessionPanel}>
						<View style={s.sessionHeader}>
							<Text style={s.sessionTitle}>Resume Session</Text>
							<TouchableOpacity onPress={() => setShowSessions(false)}>
								<Text style={s.sessionClose}>✕</Text>
							</TouchableOpacity>
						</View>
						<ScrollView style={s.sessionList}>
							{sessions.length === 0 && (
								<Text style={s.sessionEmpty}>No sessions found</Text>
							)}
							{sessions.map((sess) => (
								<TouchableOpacity
									key={sess.path}
									style={[s.sessionItem, sess.path.includes(currentSessionId) ? s.sessionItemActive : null]}
									onPress={() => switchSession(sess.path)}
								>
									<View style={s.sessionItemInfo}>
										<Text style={s.sessionItemName} numberOfLines={1}>{sess.name}</Text>
										<Text style={s.sessionItemMsg} numberOfLines={1}>{sess.firstMessage || "(empty)"}</Text>
									</View>
									<View style={s.sessionItemMeta}>
										{sess.path.includes(currentSessionId) && <Text style={s.sessionItemCurrent}>CURRENT</Text>}
										<Text style={s.sessionItemCount}>{sess.messageCount} msgs</Text>
										<Text style={s.sessionItemDate}>{new Date(sess.modified).toLocaleDateString()}</Text>
									</View>
								</TouchableOpacity>
							))}
						</ScrollView>
					</View>
				</TouchableOpacity>
			)}

			<ScrollView ref={scrollRef} style={s.msgList} contentContainerStyle={s.msgListContent}>
				{messages.length === 0 && !streamingText && (
					<View style={s.emptyChat}>
						<Text style={s.emptyTitle}>pi</Text>
						<Text style={s.emptySub}>Ready to code. Type a message below.</Text>
					</View>
				)}
				{messages.map((m) => (
					<MessageBubble key={m.id} msg={m} />
				))}
				{streamingThinking && (
					<View style={s.thinkingStream}>
						<Text style={s.thinkingStreamText}>🧠 Thinking...</Text>
					</View>
				)}
				{streamingText && <StreamingBubble text={streamingText} />}
				{isStreaming && !streamingText && !streamingThinking && (
					<View style={s.typingIndicator}>
						<ActivityIndicator color="#4a9eff" size="small" />
					</View>
				)}
			</ScrollView>

			<View style={s.inputRow}>
				<TextInput
					style={s.chatInput}
					value={input}
					onChangeText={setInput}
					placeholder={isStreaming ? "Agent is responding..." : "Message or /command..."}
					placeholderTextColor="#555"
					onSubmitEditing={isStreaming ? undefined : sendMessage}
					editable={!isStreaming}
				/>
				{isStreaming ? (
					<TouchableOpacity style={[s.sendBtn, s.abortBtn]} onPress={abort}>
						<Text style={s.abortBtnText}>■</Text>
					</TouchableOpacity>
				) : (
					<TouchableOpacity style={s.sendBtn} onPress={sendMessage} disabled={!input.trim()}>
						<Text style={s.sendBtnText}>↑</Text>
					</TouchableOpacity>
				)}
			</View>
		</View>
	);
}

// -------------------------------------------------------------------------
// Styles
// -------------------------------------------------------------------------

const s = StyleSheet.create({
	root: { flex: 1, backgroundColor: "#0a0a0a", paddingTop: 0, paddingBottom: 0, display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" },
	flex: { flex: 1 },
	center: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 30, gap: 12 },

	logo: { fontSize: 56, fontWeight: "800", color: "#4a9eff", letterSpacing: -3 },
	tagline: { fontSize: 14, color: "#666", marginBottom: 20 },
	error: { color: "#ff5555", fontSize: 13, textAlign: "center" },
	errorBanner: { color: "#ff5555", fontSize: 13, textAlign: "center", padding: 8, backgroundColor: "#2a1a1a" },

	// Connect screen actions
	connectActions: {
		flexDirection: "row", gap: 16, marginBottom: 16,
	},
	actionBtn: {
		backgroundColor: "#1a1a1a", borderColor: "#2a2a2a", borderWidth: 1,
		borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12, alignItems: "center", gap: 4,
	},
	actionBtnIcon: { fontSize: 24 },
	actionBtnLabel: { color: "#888", fontSize: 12 },

	input: {
		width: "100%", backgroundColor: "#1a1a1a", borderColor: "#2a2a2a", borderWidth: 1,
		borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15, color: "#e0e0e0",
	},
	btnPrimary: {
		width: "100%", backgroundColor: "#4a9eff", borderRadius: 10, paddingVertical: 14, alignItems: "center",
	},
	btnPrimaryText: { fontSize: 16, fontWeight: "700", color: "#0a0a0a" },

	serverList: { width: "100%", marginTop: 20 },
	serverListTitle: { color: "#555", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 },
	serverRow: { flexDirection: "row", alignItems: "center", backgroundColor: "#141414", borderRadius: 10, marginBottom: 6, paddingVertical: 2 },
	serverRowInfo: { flex: 1, paddingHorizontal: 14, paddingVertical: 10 },
	serverUrl: { color: "#e0e0e0", fontSize: 14 },
	serverTime: { color: "#555", fontSize: 11, marginTop: 2 },
	serverRemove: { color: "#555", fontSize: 20, paddingHorizontal: 14, paddingVertical: 6 },

	// QR scanner overlay
	qrOverlay: {
		position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
		backgroundColor: "rgba(0,0,0,0.85)", zIndex: 200,
		justifyContent: "center", alignItems: "center",
	},
	qrPanel: {
		width: "90%", maxWidth: 400, backgroundColor: "#1a1a1a",
		borderRadius: 16, overflow: "hidden",
	},
	qrHeader: {
		flexDirection: "row", justifyContent: "space-between", alignItems: "center",
		paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#2a2a2a",
	},
	qrTitle: { color: "#e0e0e0", fontSize: 16, fontWeight: "600" },
	qrClose: { color: "#888", fontSize: 18, paddingHorizontal: 8 },
	qrBody: {
		padding: 16, minHeight: 280, justifyContent: "center", alignItems: "center",
	},
	qrError: { color: "#ff5555", fontSize: 13, textAlign: "center" },
	qrHint: { color: "#666", fontSize: 12, textAlign: "center", paddingVertical: 12 },

	// Discovery overlay
	discOverlay: {
		position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
		backgroundColor: "rgba(0,0,0,0.85)", zIndex: 200,
		justifyContent: "center", alignItems: "center",
	},
	discPanel: {
		width: "90%", maxWidth: 400, backgroundColor: "#1a1a1a",
		borderRadius: 16, overflow: "hidden", maxHeight: "70%",
	},
	discHeader: {
		flexDirection: "row", justifyContent: "space-between", alignItems: "center",
		paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#2a2a2a",
	},
	discTitle: { color: "#e0e0e0", fontSize: 16, fontWeight: "600" },
	discClose: { color: "#888", fontSize: 18, paddingHorizontal: 8 },
	discList: { padding: 8 },
	discEmpty: { color: "#888", textAlign: "center", paddingVertical: 20, fontSize: 14 },
	discItem: {
		flexDirection: "row", justifyContent: "space-between", alignItems: "center",
		backgroundColor: "#222", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
		marginBottom: 6,
	},
	discItemInfo: { flex: 1 },
	discItemName: { color: "#e0e0e0", fontSize: 14, fontWeight: "600" },
	discItemAddr: { color: "#888", fontSize: 12, marginTop: 2, fontFamily: "monospace" },
	discItemMeta: { alignItems: "flex-end" },
	discItemProject: { color: "#4caf50", fontSize: 12 },
	discItemNoProject: { color: "#555", fontSize: 12 },
	discItemAuth: { color: "#ffa726", fontSize: 11, marginTop: 2 },
	discLoading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 16 },
	discLoadingText: { color: "#888", fontSize: 13 },

	header: { flexShrink: 0, flexDirection: "row", justifyContent: "space-between", alignItems: "center",
		paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#1e1e1e",
		backgroundColor: "#0a0a0a" },
	backBtn: { color: "#4a9eff", fontSize: 14 },
	headerTitle: { color: "#e0e0e0", fontSize: 16, fontWeight: "600" },
	disconnectBtn: { color: "#ff5555", fontSize: 13 },

	projectSwitch: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1, paddingVertical: 4 },
	activeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#4caf50" },
	projectLabel: { color: "#e0e0e0", fontSize: 15, fontWeight: "600", flex: 1 },

	menuBtn: { paddingHorizontal: 12, paddingVertical: 6 },
	menuBtnText: { color: "#888", fontSize: 22, fontWeight: "700" },
	menuOverlay: {
		position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)", zIndex: 99,
	},
	menu: {
		position: "absolute", top: 48, right: 12, backgroundColor: "#1e1e1e", borderColor: "#333", borderWidth: 1,
		borderRadius: 10, paddingVertical: 4, minWidth: 200, zIndex: 100,
		shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8,
	},
	menuItem: { paddingHorizontal: 16, paddingVertical: 12 },
	menuItemText: { color: "#e0e0e0", fontSize: 14 },
	menuItemTextDanger: { color: "#ff5555", fontSize: 14 },
	menuDivider: { height: 1, backgroundColor: "#333", marginVertical: 4 },

	activeCard: {
		flexDirection: "row", alignItems: "center", gap: 10,
		backgroundColor: "#1a2a1a", borderColor: "#2a4a2a", borderWidth: 1,
		borderRadius: 10, padding: 14, margin: 12,
	},
	activeName: { color: "#4caf50", fontSize: 16, fontWeight: "600" },
	activePath: { color: "#666", fontSize: 12 },
	goChat: { color: "#4a9eff", fontSize: 14, fontWeight: "600" },

	browseBtn: {
		backgroundColor: "#1a1a1a", borderColor: "#2a2a2a", borderWidth: 1,
		borderRadius: 10, padding: 14, marginHorizontal: 12, marginTop: 12, alignItems: "center",
	},
	browseBtnText: { color: "#4a9eff", fontSize: 15 },

	section: { padding: 12 },
	sectionTitle: { color: "#666", fontSize: 12, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 },
	dirRow: {
		flexDirection: "row", justifyContent: "space-between", alignItems: "center",
		paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: "#1a1a1a",
	},
	dirUp: { color: "#888", fontSize: 14 },
	dirName: { color: "#e0e0e0", fontSize: 14 },
	dirSelect: { color: "#4a9eff", fontSize: 13 },
	dirClose: { color: "#888", fontSize: 13, textAlign: "center", paddingVertical: 8 },

	projectCard: { backgroundColor: "#1a1a1a", borderRadius: 10, padding: 14, marginBottom: 8 },
	projectName: { color: "#e0e0e0", fontSize: 15, fontWeight: "600" },
	projectPath: { color: "#555", fontSize: 12, marginTop: 2 },

	emptyChat: { flex: 1, justifyContent: "center", alignItems: "center", paddingTop: 100 },
	emptyTitle: { fontSize: 36, fontWeight: "800", color: "#1e1e1e", letterSpacing: -2 },
	emptySub: { color: "#444", fontSize: 14, marginTop: 8 },

	msgList: { flex: 1, minHeight: 0, overflowY: "auto" },
	msgListContent: { padding: 12, paddingBottom: 20, gap: 4 },

	msgRow: { marginBottom: 6 },
	msgRowUser: { alignItems: "flex-end" },
	msgRowAsst: { alignItems: "flex-start" },

	bubble: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, maxWidth: "92%" },
	bubbleUser: { backgroundColor: "#1a3a1a", borderBottomRightRadius: 4 },
	bubbleAsst: { backgroundColor: "transparent", paddingHorizontal: 4, paddingVertical: 4 },
	bubbleSystem: { backgroundColor: "#2a1a1a", alignSelf: "center" },

	userText: { color: "#e0e0e0", fontSize: 14, lineHeight: 20 },
	systemText: { color: "#ff5555", fontSize: 13, textAlign: "center" },

	thinkingBlock: { marginBottom: 4, paddingHorizontal: 8 },
	thinkingToggle: { color: "#666", fontSize: 12, paddingVertical: 4 },
	thinkingContent: { borderLeftWidth: 2, borderLeftColor: "#333", paddingLeft: 10, marginTop: 4, maxHeight: 200, overflow: "hidden" },
	thinkingStream: { paddingHorizontal: 8, paddingVertical: 4, marginBottom: 4 },
	thinkingStreamText: { color: "#555", fontSize: 12, fontStyle: "italic" },

	toolBubble: {
		backgroundColor: "#141418", borderColor: "#30363d", borderWidth: 1,
		borderRadius: 8, padding: 8, marginBottom: 6, maxWidth: "92%",
	},
	toolHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
	toolIcon: { fontSize: 12 },
	toolName: { color: "#4a9eff", fontSize: 12, fontFamily: "monospace" },
	toolResult: {},

	typingIndicator: { paddingVertical: 8, paddingHorizontal: 16 },
	cursor: { color: "#4a9eff", fontSize: 14 },

	inputRow: { flexShrink: 0, flexDirection: "row", paddingHorizontal: 12, paddingBottom: 12, paddingTop: 8, gap: 8 },
	chatInput: {
		flex: 1, backgroundColor: "#1a1a1a", borderColor: "#2a2a2a", borderWidth: 1,
		borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: "#e0e0e0",
	},
	sendBtn: { backgroundColor: "#4a9eff", borderRadius: 10, width: 44, alignItems: "center", justifyContent: "center" },
	sendBtnText: { color: "#fff", fontWeight: "700", fontSize: 18 },
	abortBtn: { backgroundColor: "#ff5555" },
	abortBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },

	// Session picker
	sessionOverlay: {
		position: "absolute", top: 48, left: 0, right: 0, bottom: 0,
		backgroundColor: "rgba(0,0,0,0.6)", zIndex: 80,
		justifyContent: "flex-start", alignItems: "center", paddingTop: 20,
	},
	sessionPanel: {
		width: "90%", maxHeight: "70%",
		backgroundColor: "#222", borderColor: "#4a9eff", borderWidth: 1,
		borderRadius: 14, overflow: "hidden",
		shadowColor: "#000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.5, shadowRadius: 16,
	},
	sessionHeader: {
		flexDirection: "row", justifyContent: "space-between", alignItems: "center",
		paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#2a2a2a",
	},
	sessionTitle: { color: "#e0e0e0", fontSize: 16, fontWeight: "600" },
	sessionClose: { color: "#888", fontSize: 18, paddingHorizontal: 8 },
	sessionList: { padding: 8 },
	sessionEmpty: { color: "#888", textAlign: "center", paddingVertical: 20, fontSize: 14 },
	sessionItem: {
		flexDirection: "row", justifyContent: "space-between", alignItems: "center",
		paddingHorizontal: 12, paddingVertical: 12, borderRadius: 8, marginBottom: 4,
		backgroundColor: "#2a2a2a",
	},
	sessionItemActive: { backgroundColor: "#1a2a3a", borderColor: "#4a9eff", borderWidth: 2, borderRadius: 8 },
	sessionItemInfo: { flex: 1, marginRight: 8 },
	sessionItemName: { color: "#e0e0e0", fontSize: 14, fontWeight: "500" },
	sessionItemMsg: { color: "#888", fontSize: 12, marginTop: 2 },
	sessionItemMeta: { alignItems: "flex-end" },
	sessionItemCurrent: { color: "#4a9eff", fontSize: 10, fontWeight: "700", letterSpacing: 0.5, marginBottom: 2 },
	sessionItemCount: { color: "#888", fontSize: 11 },
	sessionItemDate: { color: "#777", fontSize: 11, marginTop: 2 },
});
