# pi Mobile — 启动指南

## 架构（一个端口搞定）

```
浏览器/模拟器/手机
    │
    │  http://IP:18790  (Web UI + WebSocket + API)
    ▼
┌──────────────────┐    stdin/stdout    ┌────────────────┐
│  mobile-server   │◄──────────────────►│  pi agent      │
│  (Node.js)       │   JSONL RPC        │  (coding-agent)│
│  port 18790      │                    │  GLM-5.1       │
└──────────────────┘                    └────────────────┘
```

mobile-server 同时提供：
- **前端页面**（React app，SPA）
- **WebSocket**（实时通信）
- **HTTP API**（/api/*）
- **QR 码**（终端显示）

## 启动（一条命令）

```bash
cd F:/study/agent/pi-mono

# 启动 server（自动检测前端 dist 目录）
npx tsx packages/mobile-server/src/cli.ts --cwd F:/study/agent/pi-mono
```

启动后终端显示：

```
  ┌──────────────────────────────────────────┐
  │  pi-mobile-server                        │
  │  Address:  192.168.x.x:18790             │
  │  Web UI:   http://192.168.x.x:18790      │
  │  Auth:     none                           │
  │  Project:  pi-mono                        │
  │                                          │
  │  Open browser or scan QR code:           │
  └──────────────────────────────────────────┘
  [QR CODE]
```

然后：

| 方式 | 打开地址 |
|------|----------|
| **本机浏览器** | http://localhost:18790 |
| **模拟器** | http://10.0.2.2:18790 |
| **真机** | http://192.168.x.x:18790（终端显示的 IP） |
| **扫描 QR 码** | 用手机摄像头扫终端里的 QR 码 |

## 模拟器（可选，需要原生测试时）

```bash
# 启动模拟器（已有的 AVD）
$LOCALAPPDATA/Android/Sdk/emulator/emulator.exe -avd Pixel_3a_API_34_extension_level_7_x86_64 &

# 模拟器内直接用浏览器打开 http://10.0.2.2:18790 即可
# 或者用 adb 端口转发后用 localhost:
$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe reverse tcp:18790 tcp:18790
```

## 开发流程

### 改前端 UI

```bash
# 1. 构建 frontend
cd packages/mobile-app && npm run build

# 2. 重启 server（自动用新的 dist）
# Ctrl+C 停掉 server，再重新运行启动命令
```

### 改前端 UI（热更新开发）

```bash
# 终端1: Vite dev server
cd packages/mobile-app && npx vite --port 19023 --host

# 浏览器打开 http://localhost:19023
# 连接地址填 10.0.2.2:18790（模拟器）或 localhost:18790（本机）
# 改代码秒级刷新
```

### 改 server 代码

```bash
# Ctrl+C 停掉 server，修改后重新运行启动命令
```

### 打 APK（需要测试原生功能时）

```bash
cd packages/mobile-app
npm run build && npx cap sync android
export JAVA_HOME="D:/envs/sdks/jdk-17.0.10+7"
cd android && ./gradlew assembleDebug --no-daemon && cd ..

# 安装到模拟器
$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe install -r \
  android/app/build/outputs/apk/debug/app-debug.apk
```

## 前置条件

| 项目 | 检查 | 说明 |
|------|------|------|
| Node.js 20+ | `node -v` | |
| API Key | `cat ~/.pi/agent/models.json` | 已配 GLM-5.1 |
| coding-agent | `ls packages/coding-agent/dist/cli.js` | monorepo 里已构建 |
| 前端 dist | `ls packages/mobile-app/dist/index.html` | `npm run build` 生成 |

## 常见问题

**Q: Web UI 显示 "not built"**
```bash
cd packages/mobile-app && npm run build
# 然后重启 server
```

**Q: 模拟器打不开页面**
- 用 `10.0.2.2:18790` 而非 `localhost`
- 或 `adb reverse tcp:18790 tcp:18790`

**Q: 真机连不上**
- 确保手机和电脑在同一 WiFi
- 用终端显示的 IP（如 `192.168.1.x:18790`）
- 检查防火墙是否放行 18790 端口
