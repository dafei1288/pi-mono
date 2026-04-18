#!/usr/bin/env node

/**
 * pi-mobile-server CLI
 *
 * Starts a WebSocket + HTTP server that bridges mobile clients
 * to pi coding agent running in RPC mode.
 *
 * Features:
 *   - QR code in terminal for quick mobile connection
 *   - mDNS auto-discovery on the local network
 *   - Lazy agent startup with project management
 *
 * Usage:
 *   pi-mobile-server [--port 18790] [--password secret]
 *                    [--provider anthropic] [--model claude-sonnet-4-20250514]
 *                    [--cwd /path/to/project]
 */

import { networkInterfaces } from "node:os";
import { parseArgs } from "node:util";
import { MobileServer } from "./server.js";

function getLocalIP(): string {
	const interfaces = networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		for (const iface of interfaces[name] ?? []) {
			if (iface.family === "IPv4" && !iface.internal) {
				return iface.address;
			}
		}
	}
	return "127.0.0.1";
}

const { values } = parseArgs({
	options: {
		port: { type: "string", short: "p", default: "18790" },
		host: { type: "string", short: "h", default: "0.0.0.0" },
		password: { type: "string", short: "P" },
		provider: { type: "string" },
		model: { type: "string", short: "m" },
		cwd: { type: "string" },
		"projects-file": { type: "string" },
		"no-mdns": { type: "boolean", default: false },
		help: { type: "boolean", short: "?", default: false },
	},
	strict: true,
});

if (values.help) {
	console.log(`pi-mobile-server — Network bridge for pi coding agent

Usage:
  pi-mobile-server [options]

Features:
  - QR code in terminal for quick mobile connection
  - mDNS auto-discovery on the local network
  - Lazy agent startup with project management

Options:
  -p, --port <port>       TCP port (default: 18790)
  -h, --host <host>       Bind host (default: 0.0.0.0)
  -P, --password <pw>     Require password authentication
  --provider <provider>   LLM provider (e.g. anthropic, openai)
  -m, --model <model>     Model ID
  --cwd <path>            Default project directory (agent starts immediately)
  --projects-file <path>  JSON file listing project paths (array of strings or objects)
  --no-mdns               Disable mDNS auto-discovery
  -?, --help              Show this help

Environment variables:
  ANTHROPIC_API_KEY       Anthropic API key
  OPENAI_API_KEY          OpenAI API key
  GLM_API_KEY             GLM API key

Examples:
  # No auth, client picks project
  pi-mobile-server

  # Start with a default project
  pi-mobile-server --cwd ~/my-project

  # With password and model
  pi-mobile-server --password mysecret --model claude-sonnet-4-20250514
`);
	process.exit(0);
}

const port = Number(values.port);
const localIP = getLocalIP();

const server = new MobileServer({
	port,
	host: values.host,
	auth: values.password ? { password: values.password } : undefined,
	defaultCwd: values.cwd,
	projectsFile: values["projects-file"],
	agent: {
		provider: values.provider,
		model: values.model,
	},
	mdns: !values["no-mdns"],
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		console.log(`\n[pi-mobile-server] Received ${signal}, shutting down...`);
		await server.stop();
		process.exit(0);
	});
}

async function printQRCode(url: string): Promise<void> {
	try {
		const qrcode: typeof import("qrcode-terminal") =
			(await import("qrcode-terminal")).default ?? (await import("qrcode-terminal"));
		qrcode.generate(url, { small: true }, (output: string) => {
			console.log(output);
		});
	} catch {
		console.log(`[pi-mobile-server] (install qrcode-terminal for QR code display)`);
	}
}

server
	.start()
	.then(async () => {
		const wsUrl = `${localIP}:${port}`;
		const webStatus = server.status.hasWebUI ? `http://${wsUrl}` : "not built";

		console.log("");
		console.log("  ┌──────────────────────────────────────────┐");
		console.log("  │  pi-mobile-server                        │");
		console.log("  │                                          │");
		console.log(`  │  Address:  ${wsUrl.padEnd(30)}│`);
		console.log(`  │  Web UI:   ${webStatus.padEnd(30)}│`);
		console.log(`  │  Auth:     ${(server.status.authRequired ? "password" : "none").padEnd(30)}│`);
		console.log(`  │  Project:  ${(server.status.activeCwd ?? "none").padEnd(30)}│`);
		console.log("  │                                          │");
		console.log("  │  Open browser or scan QR code:           │");
		console.log("  └──────────────────────────────────────────┘");
		console.log("");

		await printQRCode(wsUrl);
		console.log(`\n[pi-mobile-server] Waiting for connections...\n`);
	})
	.catch((err) => {
		console.error("[pi-mobile-server] Failed to start:", err);
		process.exit(1);
	});
