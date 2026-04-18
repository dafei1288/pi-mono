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
// Types & Constants
// -------------------------------------------------------------------------

interface Project { name: string; path: string; description?: string; }
interface DirEntry { name: string; path: string; isGit?: boolean; }
interface ChatMsg { id: string; role: "user" | "assistant" | "system" | "tool"; text: string; toolName?: string; thinking?: string; }
interface SavedServer { url: string; lastUsed: number; }

const STORAGE_KEY = "pi_saved_servers";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

// -------------------------------------------------------------------------
// Persistence
// -------------------------------------------------------------------------

function loadServers(): SavedServer[] {
	try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function persistServers(servers: SavedServer[]): void {
	try { localStorage.setItem(STORAGE_KEY, JSON.stringify(servers)); } catch {}
}
function addServer(url: string): void {
	const servers = loadServers();
	const idx = servers.findIndex((s) => s.url === url);
	const entry: SavedServer = { url, lastUsed: Date.now() };
	if (idx >= 0) servers[idx] = entry; else servers.push(entry);
	servers.sort((a, b) => b.lastUsed - a.lastUsed);
	persistServers(servers.slice(0, 10));
}
function removeServer(url: string): void {
	persistServers(loadServers().filter((s) => s.url !== url));
}

// -------------------------------------------------------------------------
// Network discovery
// -------------------------------------------------------------------------

interface DiscoveredServer { ip: string; port: number; name: string; version: string; authRequired: boolean; activeProject: string | null; }

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
	} catch { return null; }
}

async function scanSubnet(port: number, onFound: (srv: DiscoveredServer) => void): Promise<void> {
	const subnets = ["192.168.1", "192.168.0", "10.0.0", "192.168.31", "192.168.2"];
	const allIPs = subnets.flatMap((sub) => Array.from({ length: 255 }, (_, i) => `${sub}.${i + 1}`));
	for (let i = 0; i < allIPs.length; i += 30) {
		const batch = allIPs.slice(i, i + 30);
		const results = await Promise.allSettled(batch.map((ip) => probeHost(ip, port)));
		for (const r of results) { if (r.status === "fulfilled" && r.value) onFound(r.value); }
	}
}

// -------------------------------------------------------------------------
// Completion notification (toast + vibration + sound)
// -------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;
function playCompletionSound(): void {
	try {
		if (!audioCtx) { const AC = (window as any).AudioContext ?? (window as any).webkitAudioContext; if (AC) audioCtx = new AC(); }
		if (!audioCtx) return;
		const osc = audioCtx.createOscillator();
		const gain = audioCtx.createGain();
		osc.connect(gain); gain.connect(audioCtx.destination);
		osc.type = "sine"; osc.frequency.setValueAtTime(880, audioCtx.currentTime);
		gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
		osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime + 0.3);
		// Second beep
		const osc2 = audioCtx.createOscillator();
		const gain2 = audioCtx.createGain();
		osc2.connect(gain2); gain2.connect(audioCtx.destination);
		osc2.type = "sine"; osc2.frequency.setValueAtTime(1100, audioCtx.currentTime + 0.15);
		gain2.gain.setValueAtTime(0.12, audioCtx.currentTime + 0.15);
		gain2.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.45);
		osc2.start(audioCtx.currentTime + 0.15); osc2.stop(audioCtx.currentTime + 0.45);
	} catch {}
}
function vibrateCompletion(): void {
	try { navigator.vibrate?.([100, 50, 100]); } catch {}
}

// -------------------------------------------------------------------------
// PWA + highlight.js injection
// -------------------------------------------------------------------------

let pwaReady = false;
function initPWA() {
	if (pwaReady || typeof document === "undefined") return;
	pwaReady = true;
	const m = document.createElement("link"); m.rel = "manifest"; m.href = "/manifest.json"; document.head.appendChild(m);
	const t = document.createElement("meta"); t.name = "theme-color"; t.content = "#0a0a0a"; document.head.appendChild(t);
	["apple-mobile-web-app-capable", "apple-mobile-web-app-status-bar-style", "apple-mobile-web-app-title"].forEach((n, i) => {
		const e = document.createElement("meta"); e.name = n; e.content = ["yes", "black-translucent", "pi"][i]; document.head.appendChild(e);
	});
	const v = document.querySelector('meta[name="viewport"]');
	if (v) v.setAttribute("content", "width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover, maximum-scale=1, user-scalable=no");
	const st = document.createElement("style");
	st.textContent = `
		html,body{overscroll-behavior:none;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none}
		.md-body{-webkit-user-select:text;user-select:text}
		#root{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
		*{scrollbar-width:none;-ms-overflow-style:none}*::-webkit-scrollbar{display:none}
		input,textarea{-webkit-user-select:text;user-select:text;outline:none;-webkit-appearance:none;appearance:none;border-radius:0}
		@supports(-webkit-touch-callout:none){input,textarea{font-size:16px!important}}
	`;
	document.head.appendChild(st);
	if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

let stylesInjected = false;
function injectHighlightStyles() {
	if (stylesInjected || typeof document === "undefined") return;
	stylesInjected = true;
	const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css"; link.crossOrigin = "anonymous"; document.head.appendChild(link);
	const st = document.createElement("style");
	st.textContent = `
		.md-body{font-size:14px;line-height:1.6;color:#d4d4d4;word-break:break-word;overflow-wrap:break-word}
		.md-body p{margin:0 0 8px 0}.md-body p:last-child{margin-bottom:0}
		.md-body h1,.md-body h2,.md-body h3{margin:12px 0 6px 0;color:#fff;font-weight:700}
		.md-body h1{font-size:20px}.md-body h2{font-size:17px}.md-body h3{font-size:15px}
		.md-body code{font-family:'SF Mono','Fira Code','Consolas',monospace;font-size:13px}
		.md-body :not(pre)>code{background:#2a2a2a;padding:2px 6px;border-radius:4px;color:#ff79c6}
		.md-body pre{background:#161b22!important;border:1px solid #30363d;border-radius:8px;padding:12px;margin:8px 0;overflow-x:auto}
		.md-body pre code{background:none!important;padding:0!important;color:#e6edf3!important}
		.md-body pre code span{color:inherit}
		.md-body ul,.md-body ol{margin:4px 0;padding-left:20px}.md-body li{margin:2px 0}
		.md-body blockquote{border-left:3px solid #4a9eff;margin:8px 0;padding:4px 12px;color:#999}
		.md-body a{color:#4a9eff;text-decoration:none}.md-body a:hover{text-decoration:underline}
		.md-body table{border-collapse:collapse;margin:8px 0}.md-body th,.md-body td{border:1px solid #333;padding:6px 10px}
		.md-body th{background:#1e1e1e;font-weight:600}
		.md-body hr{border:none;border-top:1px solid #333;margin:12px 0}
		.md-body img{max-width:100%;border-radius:8px}
		.md-body strong{color:#fff}.md-body em{color:#bbb}
	`;
	document.head.appendChild(st);
}

const mdComponents = {} as any;

// -------------------------------------------------------------------------
// Sub-components
// -------------------------------------------------------------------------

function MessageBubble({ msg }: { msg: ChatMsg }) {
	const [showThinking, setShowThinking] = useState(false);
	if (msg.role === "tool") return (
		<View style={s.toolBubble}>
			<View style={s.toolHeader}><Text style={s.toolIcon}>🔧</Text><Text style={s.toolName} numberOfLines={1}>{msg.toolName || "tool"}</Text></View>
			{msg.text ? <View style={s.toolResult}><div className="md-body"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{msg.text}</Markdown></div></View> : null}
		</View>
	);
	if (msg.role === "system") return <View style={[s.bubble, s.bubbleSystem]}><Text style={s.systemText}>{msg.text}</Text></View>;
	const isUser = msg.role === "user";
	return (
		<View style={[s.msgRow, isUser ? s.msgRowUser : s.msgRowAsst]}>
			{msg.thinking ? (
				<TouchableOpacity style={s.thinkingBlock} onPress={() => setShowThinking((v) => !v)}>
					<Text style={s.thinkingToggle}>{showThinking ? "▼" : "▶"} Thinking...</Text>
					{showThinking && <View style={s.thinkingContent}><div className="md-body"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>{msg.thinking}</Markdown></div></View>}
				</TouchableOpacity>
			) : null}
			<View style={[s.bubble, isUser ? s.bubbleUser : s.bubbleAsst]}>
				{isUser ? <Text style={s.userText}>{msg.text}</Text> : <div className="md-body"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>{msg.text}</Markdown></div>}
			</View>
		</View>
	);
}

function StreamingBubble({ text }: { text: string }) {
	if (!text) return null;
	return (
		<View style={s.msgRowAsst}>
			<View style={[s.bubble, s.bubbleAsst]}>
				<div className="md-body"><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>{text}</Markdown></div>
				<Text style={s.cursor}>▌</Text>
			</View>
		</View>
	);
}

function QRScannerOverlay({ onScan, onClose }: { onScan: (url: string) => void; onClose: () => void }) {
	const scannerRef = useRef<any>(null);
	const [scanning, setScanning] = useState(false);
	const [qrError, setQrError] = useState("");
	useEffect(() => {
		let mounted = true;
		(async () => {
			try {
				const { Html5Qrcode } = await import("html5-qrcode");
				const scanner = new Html5Qrcode("pi-qr-reader");
				scannerRef.current = scanner;
				await scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 250, height: 250 } }, (d: string) => { if (mounted) { scanner.stop().catch(() => {}); onScan(d); } }, () => {});
				if (mounted) setScanning(true);
			} catch (err) { if (mounted) setQrError(String(err)); }
		})();
		return () => { mounted = false; scannerRef.current?.stop().catch(() => {}); };
	}, [onScan]);
	return (
		<View style={s.overlay}>
			<View style={s.overlayPanel}>
				<View style={s.overlayHeader}><Text style={s.overlayTitle}>Scan QR Code</Text><TouchableOpacity onPress={onClose}><Text style={s.overlayClose}>✕</Text></TouchableOpacity></View>
				<View style={{ padding: 16, minHeight: 280, justifyContent: "center", alignItems: "center" }}>
					{qrError ? <Text style={s.qrError}>{qrError}</Text> : !scanning ? <ActivityIndicator color="#4a9eff" size="large" /> : null}
					<div id="pi-qr-reader" style={{ width: "100%" }} />
				</View>
				<Text style={s.qrHint}>Point camera at the QR code on the server terminal</Text>
			</View>
		</View>
	);
}

// -------------------------------------------------------------------------
// App
// -------------------------------------------------------------------------

export default function App() {
	// State
	const [connected, setConnected] = useState(false);
	const [serverUrl, setServerUrl] = useState("");
	const [projects, setProjects] = useState<Project[]>([]);
	const [activeProject, setActiveProject] = useState("");
	const [activeCwd, setActiveCwd] = useState("");
	const [messages, setMessages] = useState<ChatMsg[]>([]);
	const [input, setInput] = useState("");
	const [streamingText, setStreamingText] = useState("");
	const [streamingThinking, setStreamingThinking] = useState("");
	const toolPhaseRef = useRef(false);
	const [loading, setLoading] = useState("");
	const [error, setError] = useState("");
	const [isStreaming, setIsStreaming] = useState(false);
	const [completionToast, setCompletionToast] = useState("");
	const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Overlays
	const [showMenu, setShowMenu] = useState(false);
	const [showProjectPicker, setShowProjectPicker] = useState(false);
	const [showBrowser, setShowBrowser] = useState(false);
	const [showSessions, setShowSessions] = useState(false);
	const [showQR, setShowQR] = useState(false);
	const [showDiscovery, setShowDiscovery] = useState(false);

	// Browse state
	const [dirEntries, setDirEntries] = useState<DirEntry[]>([]);
	const [currentDir, setCurrentDir] = useState("");

	// Sessions
	const [sessions, setSessions] = useState<Array<{ path: string; name: string; modified: string; messageCount: number; firstMessage: string }>>([]);
	const [currentSessionId, setCurrentSessionId] = useState("");

	// Servers
	const [savedServers, setSavedServers] = useState<SavedServer[]>([]);
	const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>([]);
	const [scanningNetwork, setScanningNetwork] = useState(false);

	// Reconnect
	const wsRef = useRef<WebSocket | null>(null);
	const pendingRef = useRef<Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>>(new Map());
	const seqRef = useRef(0);
	const scrollRef = useRef<any>(null);
	const lastUserMsgRef = useRef("");
	const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const reconnectAttemptsRef = useRef(0);
	const intentionalDisconnectRef = useRef(false);

	// Same-origin auto-detect
	const sameOrigin = typeof window !== "undefined" && !window.location.protocol.startsWith("file") && window.location.port !== "19023" && window.location.hostname !== "";
	const defaultUrl = sameOrigin ? `${window.location.hostname}:${window.location.port}` : "";

	// Init
	useEffect(() => {
		setSavedServers(loadServers());
		injectHighlightStyles();
		initPWA();
		const autoUrl = defaultUrl || (loadServers()[0]?.url ?? "");
		if (autoUrl) { setServerUrl(autoUrl); setTimeout(() => connect(autoUrl), 100); }
	}, []);

	// Auto-scroll
	useEffect(() => { setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 100); }, [messages, streamingText]);

	// Auto-hide menu
	useEffect(() => { if (!showMenu) return; const t = setTimeout(() => setShowMenu(false), 5000); return () => clearTimeout(t); }, [showMenu]);

	// ---- RPC ----
	const rpc = useCallback((method: string, params?: Record<string, unknown>): Promise<any> => {
		return new Promise((resolve, reject) => {
			const ws = wsRef.current;
			if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error("Not connected")); return; }
			const id = `r_${++seqRef.current}`;
			pendingRef.current.set(id, { resolve, reject });
			ws.send(JSON.stringify({ type: "req", id, method, params }));
		});
	}, []);

	// ---- WebSocket message handler ----
	const handleWsMessage = useCallback((raw: string) => {
		try {
			const frame = JSON.parse(raw);
			if (frame.type === "res") {
				const pending = pendingRef.current.get(frame.id);
				if (pending) { pendingRef.current.delete(frame.id); frame.ok ? pending.resolve(frame.payload) : pending.reject(new Error(frame.error?.message ?? "RPC error")); }
			} else if (frame.type === "event") {
				// Event name can be in frame.event (broadcast) or frame.payload.type (agent events)
				const eventName = (frame as any).event as string | undefined;
				const payload = frame.payload as Record<string, unknown> | undefined;
				if (eventName === "message_history") {
					// External sync: only accept when not streaming (server guards this, but double-check)
					if (isStreaming) return;
					const rawMsgs = (payload as any)?.messages;
					if (Array.isArray(rawMsgs)) {
						const synced: ChatMsg[] = [];
						for (const m of rawMsgs) {
							if (m.role === "user") {
								const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") : "";
								synced.push({ id: `s_${Date.now()}_${Math.random()}`, role: "user", text });
							} else if (m.role === "assistant" && m.content) {
								const t = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") : String(m.content);
								if (t) synced.push({ id: `s_${Date.now()}_${Math.random()}`, role: "assistant", text: t });
							}
						}
						setMessages(synced);
						setStreamingText("");
						setIsStreaming(false);
						setStreamingThinking("");
						}
					return;
					}
				if (eventName === "project_changed") { setActiveProject((payload as any)?.project ?? ""); setActiveCwd((payload as any)?.cwd ?? ""); return; }
				if (!payload) return;
				switch (payload.type as string) {
					case "agent_start": setStreamingText(""); setStreamingThinking(""); setIsStreaming(true); toolPhaseRef.current = false; break;
					case "agent_end":
						setIsStreaming(false);
						setStreamingThinking((think) => {
							setStreamingText((text) => {
								if (text || think) {
									const finalText = text || "";
									setMessages((msgs) => [...msgs, { id: `m_${Date.now()}`, role: "assistant" as const, text: finalText, thinking: think || undefined }]);
									// Completion notification
								const preview = (text || "").replace(/[#*`_~]/g, "").trim().slice(0, 80) || lastUserMsgRef.current;
								setCompletionToast(preview || "Task complete");
								playCompletionSound();
								vibrateCompletion();
								if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
								toastTimerRef.current = setTimeout(() => setCompletionToast(""), 4000);
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
						if (innerType === "text_delta") setStreamingText((prev) => { if (toolPhaseRef.current) { toolPhaseRef.current = false; return (msgEvent as any)?.delta ?? ""; } return prev + ((msgEvent as any)?.delta ?? ""); });
						else if (innerType === "thinking_delta") setStreamingThinking((prev) => prev + ((msgEvent as any)?.delta ?? ""));
						break;
					}
					case "tool_execution_update": {
						toolPhaseRef.current = true;
						const toolName = (payload as any)?.toolName as string | undefined;
						const args = (payload as any)?.args as Record<string, unknown> | undefined;
						const toolLabel = toolName === "bash" && args?.command ? `$ ${(args.command as string).substring(0, 60)}` : toolName ? `🔧 ${toolName}(...)` : "Working...";
						setStreamingText((prev) => {
							const lastLine = prev.split("\n").pop() || "";
							if (lastLine === toolLabel) return prev;
							if (lastLine.startsWith("$") || lastLine.startsWith("🔧")) { const lines = prev.split("\n"); return lines.slice(0, -1).join("\n") + "\n" + toolLabel; }
							return prev ? prev + "\n" + toolLabel : toolLabel;
						});
						break;
					}
				}
			}
		} catch {}
	}, [activeProject]);

	// ---- Connect ----
	const connect = useCallback(async (overrideUrl?: string) => {
		const url = overrideUrl ?? serverUrl;
		if (!url.trim()) return;
		setServerUrl(url); setError(""); setLoading("Connecting..."); intentionalDisconnectRef.current = false;
		if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null; }
		try {
			const ws = new WebSocket(url.startsWith("ws") ? url : `ws://${url}`);
			ws.onopen = async () => {
				wsRef.current = ws; reconnectAttemptsRef.current = 0;
				try {
					await rpc("connect", { client: { name: "pi-mobile", version: "1", platform: "web", mode: "mobile" } });
					const res = await rpc("list_projects");
					setProjects(res.projects ?? []); setActiveProject(res.activeProject ?? ""); setActiveCwd(res.activeCwd ?? "");
					setLoading(""); addServer(url); setSavedServers(loadServers()); setConnected(true);
				} catch (err) { setError(String(err)); setLoading(""); }
			};
			ws.onmessage = (e) => handleWsMessage(typeof e.data === "string" ? e.data : "");
			ws.onerror = () => { setError("Connection failed"); setLoading(""); };
			ws.onclose = () => {
				wsRef.current = null; setLoading(""); setIsStreaming(false);
				if (!intentionalDisconnectRef.current) {
					const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttemptsRef.current), RECONNECT_MAX_MS);
					reconnectAttemptsRef.current++;
					setError(`Disconnected. Reconnecting in ${Math.round(delay / 1000)}s...`);
					reconnectRef.current = setTimeout(() => connect(url), delay);
				} else { setConnected(false); }
			};
		} catch (err) { setError(String(err)); setLoading(""); }
	}, [serverUrl, rpc, handleWsMessage]);

	// ---- Actions ----
	const selectProject = useCallback(async (path: string) => {
		setError(""); setLoading("Starting agent..."); setShowProjectPicker(false); setShowBrowser(false);
		try {
			const res = await rpc("select_project", { path });
			setActiveProject(res.project ?? ""); setActiveCwd(res.cwd ?? ""); setMessages([]); setStreamingText(""); setConnected(true);
		} catch (err) { setError(String(err)); }
		setLoading("");
	}, [rpc]);

	const browse = useCallback(async (path?: string) => {
		setLoading("Loading...");
		try { const res = await rpc("browse_directory", { path }); setDirEntries(res.entries ?? []); setCurrentDir(res.path ?? ""); setShowBrowser(true); } catch (err) { setError(String(err)); }
		setLoading("");
	}, [rpc]);

	const sendMessage = useCallback(async () => { const text = input.trim(); if (!text) return; setInput(""); setShowMenu(false); await sendMessageDirect(text); }, [input]);
	const sendMessageDirect = useCallback(async (text: string) => {
		const trimmed = text.trim();
		if (trimmed === "/resume" || trimmed === "/sessions") {
			try { const res = await rpc("list_sessions"); setSessions(res.sessions ?? []); setCurrentSessionId(res.currentSessionId ?? ""); setShowSessions(true); } catch (err) { setMessages((prev) => [...prev, { id: `e_${Date.now()}`, role: "system", text: `Error: ${err}` }]); }
			return;
		}
		lastUserMsgRef.current = trimmed;
		setMessages((prev) => [...prev, { id: `u_${Date.now()}`, role: "user", text: trimmed }]);
		setStreamingText(""); setIsStreaming(true);
		try { await rpc("prompt", { message: trimmed }); } catch (err) { setIsStreaming(false); setMessages((prev) => [...prev, { id: `e_${Date.now()}`, role: "system", text: `Error: ${err}` }]); }
	}, [rpc]);

	const switchSession = useCallback(async (sessionPath: string) => {
		setShowSessions(false); setMessages([{ id: `s_${Date.now()}`, role: "system", text: "Switching session..." }]);
		try {
			const res = await rpc("switch_session", { sessionPath });
			if (res?.cancelled) { setMessages([{ id: `s_${Date.now()}`, role: "system", text: "Switch cancelled" }]); return; }
			try {
				const msgRes = await rpc("get_messages");
				const msgs = (msgRes?.messages ?? []).flatMap((m: any) => {
					if (m.role === "user") return [{ id: `ls_${Date.now()}_${Math.random()}`, role: "user" as const, text: typeof m.content === "string" ? m.content : "" }];
					if (m.role === "assistant" && m.content) { const t = Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") : String(m.content); return t ? [{ id: `ls_${Date.now()}_${Math.random()}`, role: "assistant" as const, text: t }] : []; }
					return [];
				});
				setMessages(msgs);
			} catch { setMessages([]); }
			setStreamingText("");
		} catch (err) { setMessages([{ id: `e_${Date.now()}`, role: "system", text: `Switch failed: ${err}` }]); }
	}, [rpc]);

	const abort = useCallback(async () => { try { await rpc("abort"); } catch {} setIsStreaming(false); }, [rpc]);
	const disconnect = useCallback(() => {
		intentionalDisconnectRef.current = true;
		if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null; }
		wsRef.current?.close(); wsRef.current = null;
		setConnected(false); setMessages([]); setStreamingText(""); setProjects([]); setActiveProject(""); setIsStreaming(false); setError("");
	}, []);

	// =====================================================================
	// SCREEN: Connect
	// =====================================================================
	if (!connected) {
		return (
			<View style={s.root}>
				<View style={s.center}>
					<Text style={s.logo}>pi</Text>
					<Text style={s.tagline}>remote coding agent</Text>
					{!!loading && <ActivityIndicator color="#4a9eff" size="large" style={{ marginBottom: 12 }} />}
					{!!error && <Text style={s.error}>{error}</Text>}
					{!!error && !loading && reconnectAttemptsRef.current > 0 && (
						<TouchableOpacity style={s.btnSecondary} onPress={() => connect()}><Text style={s.btnSecondaryText}>Retry Now</Text></TouchableOpacity>
					)}
					<View style={s.connectActions}>
						<TouchableOpacity style={s.actionBtn} onPress={() => setShowQR(true)}><Text style={s.actionBtnIcon}>📷</Text><Text style={s.actionBtnLabel}>Scan QR</Text></TouchableOpacity>
						<TouchableOpacity style={s.actionBtn} onPress={async () => { setShowDiscovery(true); setDiscoveredServers([]); setScanningNetwork(true); await scanSubnet(18790, (srv) => setDiscoveredServers((p) => p.some((s) => s.ip === srv.ip && s.port === srv.port) ? p : [...p, srv])); setScanningNetwork(false); }}><Text style={s.actionBtnIcon}>📡</Text><Text style={s.actionBtnLabel}>Discover</Text></TouchableOpacity>
					</View>
					<TextInput style={s.input} value={serverUrl} onChangeText={setServerUrl} placeholder="Server address (e.g. 192.168.1.100:18790)" placeholderTextColor="#555" autoCapitalize="none" autoCorrect={false} editable={!loading} onSubmitEditing={() => connect()} />
					<TouchableOpacity style={s.btnPrimary} onPress={() => connect()} disabled={!!loading}>
						{loading ? <ActivityIndicator color="#0a0a0a" /> : <Text style={s.btnPrimaryText}>Connect</Text>}
					</TouchableOpacity>
					{savedServers.length > 0 && (
						<View style={s.serverList}>
							<Text style={s.serverListTitle}>Recent Servers</Text>
							{savedServers.map((srv) => (
								<View key={srv.url} style={s.serverRow}>
									<TouchableOpacity style={{ flex: 1 }} onPress={() => connect(srv.url)}><Text style={s.serverUrl}>{srv.url}</Text></TouchableOpacity>
									<TouchableOpacity onPress={() => { removeServer(srv.url); setSavedServers(loadServers()); }}><Text style={s.serverRemove}>×</Text></TouchableOpacity>
								</View>
							))}
						</View>
					)}
				</View>
				{showQR && <QRScannerOverlay onScan={(u) => { setShowQR(false); connect(u.replace(/^ws:\/\//, "").replace(/^http:\/\//, "").replace(/\/$/, "")); }} onClose={() => setShowQR(false)} />}
				{showDiscovery && (
					<View style={s.overlay}>
						<View style={s.overlayPanel}>
							<View style={s.overlayHeader}><Text style={s.overlayTitle}>{scanningNetwork ? "Scanning..." : "Found Servers"}</Text><TouchableOpacity onPress={() => setShowDiscovery(false)}><Text style={s.overlayClose}>✕</Text></TouchableOpacity></View>
							<ScrollView style={{ padding: 8 }}>
								{discoveredServers.length === 0 && !scanningNetwork && <Text style={{ color: "#888", textAlign: "center", paddingVertical: 20 }}>No servers found</Text>}
								{discoveredServers.map((srv) => (
									<TouchableOpacity key={`${srv.ip}:${srv.port}`} style={s.discItem} onPress={() => { setShowDiscovery(false); connect(`${srv.ip}:${srv.port}`); }}>
										<View style={{ flex: 1 }}><Text style={{ color: "#e0e0e0", fontSize: 14, fontWeight: "600" }}>pi-mobile-server</Text><Text style={{ color: "#888", fontSize: 12, marginTop: 2 }}>{srv.ip}:{srv.port}</Text></View>
										<Text style={{ color: srv.activeProject ? "#4caf50" : "#555", fontSize: 12 }}>{srv.activeProject || "No project"}</Text>
									</TouchableOpacity>
								))}
								{scanningNetwork && <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 16 }}><ActivityIndicator color="#4a9eff" size="small" /><Text style={{ color: "#888" }}>Scanning...</Text></View>}
							</ScrollView>
						</View>
					</View>
				)}
			</View>
		);
	}

	// =====================================================================
	// SCREEN: Chat (main screen)
	// =====================================================================
	return (
		<View style={s.root}>
			{/* Header */}
			<View style={s.header}>
				<TouchableOpacity style={s.projectSwitch} onPress={() => { setShowProjectPicker((v) => !v); setShowMenu(false); }}>
					<View style={[s.activeDot, !activeProject && { backgroundColor: "#666" }]} />
					<Text style={s.projectLabel} numberOfLines={1}>{activeProject || "Select project"}</Text>
					<Text style={s.projectChevron}>▾</Text>
				</TouchableOpacity>
				<TouchableOpacity style={s.menuBtn} onPress={() => { setShowMenu((v) => !v); setShowProjectPicker(false); }}>
					<Text style={s.menuBtnText}>⋮</Text>
				</TouchableOpacity>
			</View>

			{/* Loading banner */}
			{!!loading && <View style={s.loadingBanner}><ActivityIndicator color="#4a9eff" size="small" /><Text style={s.loadingText}>{loading}</Text></View>}
			{!!completionToast && (
				<TouchableOpacity style={s.toast} onPress={() => setCompletionToast("")} activeOpacity={0.8}>
					<Text style={s.toastIcon}>✅</Text>
					<View style={{ flex: 1 }}>
						<Text style={s.toastTitle}>Agent finished</Text>
						<Text style={s.toastBody} numberOfLines={2}>{completionToast}</Text>
					</View>
					<Text style={s.toastClose}>✕</Text>
				</TouchableOpacity>
			)}
			{!!error && !loading && <TouchableOpacity onPress={() => setError("")}><Text style={s.errorBanner}>{error}</Text></TouchableOpacity>}

			{/* Project Picker Overlay */}
			{showProjectPicker && (
				<TouchableOpacity style={s.overlayBg} activeOpacity={1} onPress={() => { setShowProjectPicker(false); setShowBrowser(false); }}>
					<View style={s.projectPanel} onStartShouldSetResponder={() => true}>
						<Text style={s.projectPanelTitle}>Switch Project</Text>
						{/* Current project */}
						{activeProject && (
							<View style={s.projectCurrent}>
								<View style={s.activeDot} />
								<View style={{ flex: 1 }}>
									<Text style={{ color: "#4caf50", fontSize: 14, fontWeight: "600" }} numberOfLines={1}>{activeProject}</Text>
									<Text style={{ color: "#555", fontSize: 11, marginTop: 1 }} numberOfLines={1}>{activeCwd}</Text>
								</View>
								<Text style={{ color: "#4caf50", fontSize: 11 }}>CURRENT</Text>
							</View>
						)}
						{/* Browse */}
						{showBrowser ? (
							<View style={{ maxHeight: 250 }}>
								<View style={s.browserPath}><Text style={{ color: "#888", fontSize: 12 }} numberOfLines={1}>{currentDir}</Text></View>
								<ScrollView style={{ maxHeight: 200 }}>
									<TouchableOpacity style={s.projectItem} onPress={() => browse("..")}><Text style={{ color: "#888" }}>📁 ..</Text></TouchableOpacity>
									{dirEntries.map((e) => (
										<TouchableOpacity key={e.path} style={s.projectItem} onPress={() => selectProject(e.path)}>
											<Text style={{ color: "#e0e0e0", flex: 1 }} numberOfLines={1}>{e.isGit ? "🌿" : "📁"} {e.name}</Text>
											<Text style={{ color: "#4a9eff", fontSize: 12 }}>Select</Text>
										</TouchableOpacity>
									))}
								</ScrollView>
								<TouchableOpacity style={s.projectItem} onPress={() => setShowBrowser(false)}><Text style={{ color: "#888", textAlign: "center" }}>Close</Text></TouchableOpacity>
							</View>
						) : (
							<TouchableOpacity style={s.browseBtn} onPress={() => browse()}>
								<Text style={s.browseBtnText}>📂 Browse directories...</Text>
							</TouchableOpacity>
						)}
						{/* Project list */}
						{projects.length > 0 && (
							<ScrollView style={{ maxHeight: 300 }}>
								<Text style={s.projectSectionTitle}>Projects</Text>
								{projects.map((p) => (
									<TouchableOpacity key={p.path} style={[s.projectItem, activeProject === p.name && s.projectItemActive]} onPress={() => selectProject(p.path)}>
										<View style={{ flex: 1 }}>
											<Text style={{ color: "#e0e0e0", fontSize: 14, fontWeight: "500" }} numberOfLines={1}>🌿 {p.name}</Text>
											<Text style={{ color: "#555", fontSize: 11, marginTop: 1 }} numberOfLines={1}>{p.path}</Text>
										</View>
										{activeProject === p.name && <Text style={{ color: "#4caf50", fontSize: 11 }}>✓</Text>}
									</TouchableOpacity>
								))}
							</ScrollView>
						)}
					</View>
				</TouchableOpacity>
			)}

			{/* Menu Overlay */}
			{showMenu && (
				<TouchableOpacity style={s.overlayBg} activeOpacity={1} onPress={() => setShowMenu(false)}>
					<View style={s.menu} onStartShouldSetResponder={() => true}>
						<TouchableOpacity style={s.menuItem} onPress={() => { setShowMenu(false); sendMessageDirect("/compact"); }}><Text style={s.menuItemText}>📦 Compact context</Text></TouchableOpacity>
						<TouchableOpacity style={s.menuItem} onPress={() => { setShowMenu(false); sendMessageDirect("/new"); }}><Text style={s.menuItemText}>✨ New session</Text></TouchableOpacity>
						<TouchableOpacity style={s.menuItem} onPress={() => { setShowMenu(false); sendMessageDirect("/sessions"); }}><Text style={s.menuItemText}>📋 Resume session</Text></TouchableOpacity>
						<TouchableOpacity style={s.menuItem} onPress={() => { setShowMenu(false); sendMessageDirect("/model"); }}><Text style={s.menuItemText}>🤖 Switch model</Text></TouchableOpacity>
						<TouchableOpacity style={s.menuItem} onPress={() => { setShowMenu(false); sendMessageDirect("/session"); }}><Text style={s.menuItemText}>📊 Session info</Text></TouchableOpacity>
						<View style={s.menuDivider} />
						<TouchableOpacity style={s.menuItem} onPress={() => { setShowMenu(false); disconnect(); }}><Text style={s.menuItemTextDanger}>Disconnect</Text></TouchableOpacity>
					</View>
				</TouchableOpacity>
			)}

			{/* Session Overlay */}
			{showSessions && (
				<TouchableOpacity style={s.overlayBg} activeOpacity={1} onPress={() => setShowSessions(false)}>
					<View style={s.overlayPanel} onStartShouldSetResponder={() => true}>
						<View style={s.overlayHeader}><Text style={s.overlayTitle}>Resume Session</Text><TouchableOpacity onPress={() => setShowSessions(false)}><Text style={s.overlayClose}>✕</Text></TouchableOpacity></View>
						<ScrollView style={{ padding: 8, maxHeight: "70%" }}>
							{sessions.length === 0 && <Text style={{ color: "#888", textAlign: "center", paddingVertical: 20 }}>No sessions found</Text>}
							{sessions.map((sess) => (
								<TouchableOpacity key={sess.path} style={[s.sessionItem, sess.path.includes(currentSessionId) && s.sessionItemActive]} onPress={() => switchSession(sess.path)}>
									<View style={{ flex: 1, marginRight: 8 }}>
										<Text style={{ color: "#e0e0e0", fontSize: 14, fontWeight: "500" }} numberOfLines={2}>{sess.firstMessage || sess.name || "(empty)"}</Text>
										<Text style={{ color: "#555", fontSize: 11, marginTop: 3 }} numberOfLines={1}>{sess.messageCount} msgs · {new Date(sess.modified).toLocaleDateString()} {new Date(sess.modified).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
									</View>
									{sess.path.includes(currentSessionId) && <Text style={{ color: "#4a9eff", fontSize: 10, fontWeight: "700" }}>●</Text>}
								</TouchableOpacity>
							))}
						</ScrollView>
					</View>
				</TouchableOpacity>
			)}

			{/* Message List */}
			<ScrollView ref={scrollRef} style={s.msgList} contentContainerStyle={s.msgListContent}>
				{messages.length === 0 && !streamingText && !activeProject && (
					<View style={s.emptyChat}><Text style={s.emptyTitle}>pi</Text><Text style={s.emptySub}>Tap project name above to select</Text></View>
				)}
				{messages.length === 0 && !streamingText && activeProject && (
					<View style={s.emptyChat}><Text style={s.emptyTitle}>pi</Text><Text style={s.emptySub}>Ready. Type a message below.</Text></View>
				)}
				{messages.map((m) => <MessageBubble key={m.id} msg={m} />)}
				{streamingThinking && <View style={s.thinkingStream}><Text style={s.thinkingStreamText}>🧠 Thinking...</Text></View>}
				{streamingText && <StreamingBubble text={streamingText} />}
				{isStreaming && !streamingText && !streamingThinking && <View style={s.typingIndicator}><ActivityIndicator color="#4a9eff" size="small" /></View>}
			</ScrollView>

			{/* Input */}
			<View style={s.inputRow}>
				<TextInput style={s.chatInput} value={input} onChangeText={setInput} placeholder={isStreaming ? "Agent is responding..." : "Message or /command..."} placeholderTextColor="#555" onSubmitEditing={isStreaming ? undefined : sendMessage} editable={!isStreaming} />
				{isStreaming ? (
					<TouchableOpacity style={[s.sendBtn, { backgroundColor: "#ff5555" }]} onPress={abort}><Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>■</Text></TouchableOpacity>
				) : (
					<TouchableOpacity style={s.sendBtn} onPress={sendMessage} disabled={!input.trim()}><Text style={{ color: "#fff", fontWeight: "700", fontSize: 18 }}>↑</Text></TouchableOpacity>
				)}
			</View>
		</View>
	);
}

// -------------------------------------------------------------------------
// Styles
// -------------------------------------------------------------------------

const s = StyleSheet.create({
	root: { flex: 1, backgroundColor: "#0a0a0a", display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" },
	center: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 24, gap: 10 },

	logo: { fontSize: 48, fontWeight: "800", color: "#4a9eff", letterSpacing: -3 },
	tagline: { fontSize: 13, color: "#666", marginBottom: 16 },
	error: { color: "#ff5555", fontSize: 13, textAlign: "center" },
	errorBanner: { color: "#ff5555", fontSize: 12, textAlign: "center", padding: 6, backgroundColor: "#2a1a1a" },
	loadingBanner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 6, backgroundColor: "#0f1a2a" },
	loadingText: { color: "#4a9eff", fontSize: 12 },

	// Completion toast
	toast: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 10, marginVertical: 6, backgroundColor: "#1a2a1a", borderColor: "#2a4a2a", borderWidth: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14 },
	toastIcon: { fontSize: 18, flexShrink: 0 },
	toastTitle: { color: "#4caf50", fontSize: 13, fontWeight: "700" },
	toastBody: { color: "#aaa", fontSize: 12, marginTop: 2, lineHeight: 16 },
	toastClose: { color: "#555", fontSize: 14, flexShrink: 0, paddingHorizontal: 4 },

	// Connect
	connectActions: { flexDirection: "row", gap: 12, marginBottom: 12 },
	actionBtn: { backgroundColor: "#1a1a1a", borderColor: "#2a2a2a", borderWidth: 1, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10, alignItems: "center", gap: 4 },
	actionBtnIcon: { fontSize: 20 },
	actionBtnLabel: { color: "#888", fontSize: 11 },
	input: { width: "100%", backgroundColor: "#1a1a1a", borderColor: "#2a2a2a", borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: "#e0e0e0" },
	btnPrimary: { width: "100%", backgroundColor: "#4a9eff", borderRadius: 10, paddingVertical: 12, alignItems: "center" },
	btnPrimaryText: { fontSize: 15, fontWeight: "700", color: "#0a0a0a" },
	btnSecondary: { backgroundColor: "transparent", borderColor: "#4a9eff", borderWidth: 1, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 8, alignItems: "center", marginBottom: 8 },
	btnSecondaryText: { color: "#4a9eff", fontSize: 13, fontWeight: "600" },
	serverList: { width: "100%", marginTop: 16 },
	serverListTitle: { color: "#555", fontSize: 10, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 },
	serverRow: { flexDirection: "row", alignItems: "center", backgroundColor: "#141414", borderRadius: 8, marginBottom: 4 },
	serverUrl: { color: "#e0e0e0", fontSize: 13, paddingHorizontal: 12, paddingVertical: 8 },
	serverRemove: { color: "#555", fontSize: 18, paddingHorizontal: 12 },

	// Overlay shared
	overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.85)", zIndex: 200, justifyContent: "center", alignItems: "center" },
	overlayPanel: { width: "92%", maxWidth: 420, backgroundColor: "#1a1a1a", borderRadius: 14, overflow: "hidden", maxHeight: "75%" },
	overlayHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#2a2a2a" },
	overlayTitle: { color: "#e0e0e0", fontSize: 15, fontWeight: "600" },
	overlayClose: { color: "#888", fontSize: 16, paddingHorizontal: 8 },
	qrError: { color: "#ff5555", fontSize: 13, textAlign: "center" },
	qrHint: { color: "#666", fontSize: 11, textAlign: "center", paddingVertical: 10 },
	overlayBg: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)", zIndex: 90 },

	// Header
	header: { flexShrink: 0, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#1e1e1e", backgroundColor: "#0a0a0a" },
	projectSwitch: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1, paddingVertical: 2 },
	activeDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#4caf50", flexShrink: 0 },
	projectLabel: { color: "#e0e0e0", fontSize: 14, fontWeight: "600", flex: 1, overflow: "hidden" },
	projectChevron: { color: "#888", fontSize: 12, flexShrink: 0 },
	menuBtn: { paddingHorizontal: 8, paddingVertical: 4 },
	menuBtnText: { color: "#888", fontSize: 20, fontWeight: "700" },

	// Project picker panel
	projectPanel: { position: "absolute", top: 44, left: 8, right: 8, backgroundColor: "#1a1a1a", borderColor: "#333", borderWidth: 1, borderRadius: 12, paddingVertical: 8, zIndex: 100, maxHeight: "75%", shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 8 },
	projectPanelTitle: { color: "#666", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, paddingHorizontal: 12, paddingVertical: 6 },
	projectCurrent: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#1a2a1a", marginHorizontal: 8, borderRadius: 8, marginBottom: 4 },
	projectItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#1e1e1e" },
	projectItemActive: { backgroundColor: "#1a2a1a" },
	projectSectionTitle: { color: "#555", fontSize: 10, textTransform: "uppercase", letterSpacing: 1, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
	browseBtn: { marginHorizontal: 8, marginVertical: 4, backgroundColor: "#222", borderRadius: 8, paddingVertical: 10, alignItems: "center" },
	browseBtnText: { color: "#4a9eff", fontSize: 13 },
	browserPath: { paddingHorizontal: 12, paddingVertical: 4, backgroundColor: "#111", borderBottomWidth: 1, borderBottomColor: "#1e1e1e" },

	// Menu
	menu: { position: "absolute", top: 44, right: 8, backgroundColor: "#1e1e1e", borderColor: "#333", borderWidth: 1, borderRadius: 10, paddingVertical: 2, minWidth: 180, zIndex: 100, shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8 },
	menuItem: { paddingHorizontal: 14, paddingVertical: 10 },
	menuItemText: { color: "#e0e0e0", fontSize: 13 },
	menuItemTextDanger: { color: "#ff5555", fontSize: 13 },
	menuDivider: { height: 1, backgroundColor: "#333", marginVertical: 2 },

	// Chat
	emptyChat: { flex: 1, justifyContent: "center", alignItems: "center", paddingTop: 80 },
	emptyTitle: { fontSize: 32, fontWeight: "800", color: "#1e1e1e", letterSpacing: -2 },
	emptySub: { color: "#444", fontSize: 13, marginTop: 6 },
	msgList: { flex: 1, minHeight: 0, overflowY: "auto" },
	msgListContent: { padding: 10, paddingBottom: 16, gap: 2 },
	msgRow: { marginBottom: 4 },
	msgRowUser: { alignItems: "flex-end" },
	msgRowAsst: { alignItems: "flex-start" },
	bubble: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, maxWidth: "100%", overflow: "hidden" },
	bubbleUser: { backgroundColor: "#1a3a1a", borderBottomRightRadius: 4, maxWidth: "88%" },
	bubbleAsst: { backgroundColor: "transparent", paddingHorizontal: 2, paddingVertical: 2 },
	bubbleSystem: { backgroundColor: "#2a1a1a", alignSelf: "center" },
	userText: { color: "#e0e0e0", fontSize: 14, lineHeight: 20, wordBreak: "break-word" },
	systemText: { color: "#ff5555", fontSize: 12, textAlign: "center" },
	thinkingBlock: { marginBottom: 2, paddingHorizontal: 6 },
	thinkingToggle: { color: "#666", fontSize: 11, paddingVertical: 2 },
	thinkingContent: { borderLeftWidth: 2, borderLeftColor: "#333", paddingLeft: 8, marginTop: 2, maxHeight: 180, overflow: "hidden" },
	thinkingStream: { paddingHorizontal: 6, paddingVertical: 2, marginBottom: 2 },
	thinkingStreamText: { color: "#555", fontSize: 11, fontStyle: "italic" },
	toolBubble: { backgroundColor: "#141418", borderColor: "#30363d", borderWidth: 1, borderRadius: 6, padding: 6, marginBottom: 4, maxWidth: "92%" },
	toolHeader: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 2 },
	toolIcon: { fontSize: 10 },
	toolName: { color: "#4a9eff", fontSize: 11 },
	toolResult: {},
	typingIndicator: { paddingVertical: 6, paddingHorizontal: 14 },
	cursor: { color: "#4a9eff", fontSize: 13 },
	inputRow: { flexShrink: 0, flexDirection: "row", paddingHorizontal: 10, paddingBottom: 10, paddingTop: 6, gap: 6 },
	chatInput: { flex: 1, backgroundColor: "#1a1a1a", borderColor: "#2a2a2a", borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 14, color: "#e0e0e0" },
	sendBtn: { backgroundColor: "#4a9eff", borderRadius: 8, width: 40, alignItems: "center", justifyContent: "center", flexShrink: 0 },

	// Discovery
	discItem: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "#222", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 4 },

	// Session
	sessionItem: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 10, paddingVertical: 10, borderRadius: 8, marginBottom: 4, backgroundColor: "#2a2a2a" },
	sessionItemActive: { backgroundColor: "#1a2a3a", borderWidth: 2, borderColor: "#4a9eff" },
});
