/**
 * Storage — pure localStorage (web/Capacitor)
 */

const KEY_SERVER_URL = "pi_server_url";
const KEY_TOKEN = "pi_token";
const KEY_SERVERS = "pi_servers";

export interface SavedServer {
	url: string;
	label: string;
	lastConnected: number;
}

function get(key: string): string | null {
	return localStorage.getItem(key);
}

function set(key: string, value: string): void {
	localStorage.setItem(key, value);
}

function del(key: string): void {
	localStorage.removeItem(key);
}

export async function saveToken(serverUrl: string, token: string): Promise<void> {
	set(KEY_SERVER_URL, serverUrl);
	set(KEY_TOKEN, token);
}

export async function loadToken(): Promise<{ serverUrl: string; token: string } | null> {
	const serverUrl = get(KEY_SERVER_URL);
	const token = get(KEY_TOKEN);
	if (serverUrl && token) return { serverUrl, token };
	return null;
}

export async function clearToken(): Promise<void> {
	del(KEY_SERVER_URL);
	del(KEY_TOKEN);
}

export async function saveServerList(servers: SavedServer[]): Promise<void> {
	set(KEY_SERVERS, JSON.stringify(servers));
}

export async function loadServerList(): Promise<SavedServer[]> {
	const data = get(KEY_SERVERS);
	if (data) {
		try {
			return JSON.parse(data) as SavedServer[];
		} catch {
			return [];
		}
	}
	return [];
}

export async function addSavedServer(server: SavedServer): Promise<void> {
	const servers = await loadServerList();
	const idx = servers.findIndex((s) => s.url === server.url);
	if (idx >= 0) servers[idx] = server;
	else servers.push(server);
	await saveServerList(servers);
}

export async function removeSavedServer(url: string): Promise<void> {
	const servers = await loadServerList().then((s) => s.filter((sv) => sv.url !== url));
	await saveServerList(servers);
}
