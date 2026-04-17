# @mariozechner/pi-mobile-app

React Native + Expo mobile client for pi coding agent. Connects directly to `pi-mobile-server` for remote vibe coding on the go.

## Architecture

```
┌──────────────┐         ┌──────────────────┐         ┌──────────────┐
│  pi-mobile   │◄──WS──►│ pi-mobile-server │◄─JSONL─►│   pi agent   │
│  (this app)  │         │  (Node.js)       │         │  (--mode rpc)│
└──────────────┘         └──────────────────┘         └──────────────┘
    Phone                    Dev machine                  Same machine
```

## Getting Started

### Prerequisites

- Node.js 20+
- Expo CLI: `npm install -g expo-cli`
- iOS Simulator or Android Emulator (for development)

### Install

```bash
cd packages/mobile-app
npm install
```

### Run

```bash
# Start Expo dev server
npx expo start

# Run on iOS
npx expo start --ios

# Run on Android
npx expo start --android
```

### Connect to pi-mobile-server

1. Start pi-mobile-server on your dev machine:
   ```bash
   cd packages/mobile-server
   npx pi-mobile-server --password mysecret
   ```

2. Open the app and enter your machine's IP + port (e.g. `192.168.1.100:18790`)

3. Enter the password if configured

4. Start coding

## Screens

### Connect
- Enter server URL and optional password
- Quick-connect to previously saved servers
- Auto-reconnect with saved tokens

### Chat
- Send prompts to the pi coding agent
- Stream real-time responses with text deltas
- View thinking output (toggle in settings)
- See tool calls with expand/collapse
- Abort running generations

### Sessions
- List all agent sessions
- Switch between sessions
- Create new sessions

### Settings
- Switch LLM model
- Cycle thinking level
- Compact context
- Toggle thinking visibility
- Disconnect

## Development

### File Structure

```
src/
├── App.tsx                    # Entry point with tab navigation
├── lib/
│   ├── protocol.ts            # Wire protocol types (matches server)
│   ├── client.ts              # WebSocket client with auto-reconnect
│   ├── store.ts               # Zustand state management + event dispatch
│   ├── storage.ts             # Secure token/server persistence
│   └── theme.ts               # Dark theme constants
├── screens/
│   ├── ConnectScreen.tsx      # Connection form
│   ├── ChatScreen.tsx         # Main coding interface
│   ├── SessionsScreen.tsx     # Session management
│   └── SettingsScreen.tsx     # Model, thinking, connection settings
└── hooks/
    └── useStore.ts            # React hook for zustand store
```

### State Management

Uses zustand for lightweight state management:

- **Connection state**: status, server URL, token
- **Session state**: ID, name, model, thinking level
- **Messages**: user/assistant messages with streaming support
- **Agent state**: running flag, event processing

The `attachClientEvents()` function wires WebSocket events to store actions automatically.

### Protocol

The client uses the same wire protocol as pi-mobile-server:

```typescript
// Request
{ type: "req", id: "1", method: "prompt", params: { message: "Hello" } }

// Response
{ type: "res", id: "1", ok: true, payload: { acknowledged: true } }

// Event (streamed)
{ type: "event", event: "text_delta", payload: { delta: "Hello" }, seq: 1 }
```

## Building for Production

```bash
# iOS
eas build --platform ios

# Android
eas build --platform android
```

## Security Notes

- Tokens are stored in device keychain via expo-secure-store
- All communication is over WebSocket (use wss:// for TLS)
- Password is sent once during connect, then bearer tokens are used
- No data is stored on any server beyond the pi-mobile-server process
