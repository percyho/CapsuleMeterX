# CapsuleMeterX

Windows 桌面用量胶囊，使用 React、TypeScript、Rust 和 Tauri 2 构建。界面由固定 120 × 32 的悬浮胶囊、悬停详情和系统托盘环形图标组成。

用量由本机 Codex App Server 提供。启动前需要安装 Codex CLI，并确保 `codex` 可以从 `PATH` 启动；也可以通过 `CODEX_CLI_PATH` 指定可执行文件路径。应用不会自行估算或模拟配额。

## 开发

需要 Node.js、pnpm、Rust、Windows WebView2，以及 Tauri 所需的 Windows C++ 构建工具。

```powershell
pnpm install
pnpm tauri:dev
```

`pnpm build` 会检查 TypeScript 并生成前端资源。`pnpm tauri build` 可构建桌面安装包。
