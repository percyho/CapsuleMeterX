# CapsuleMeterX

[简体中文](README.md) | [English](README.en.md)

CapsuleMeterX 是一个使用 React、TypeScript、Rust 和 Tauri 2 构建的 Windows 桌面用量工具。它在桌面显示一个可拖拽、可吸附的紧凑胶囊，并在系统托盘提供五小时用量环和完整详情面板。

## 功能

- **悬浮胶囊：** 高 32px，宽度随内容调整（64–280px）；可拖动并吸附到显示器工作区边缘，位置会在重启后恢复。
- **用量信息：** 显示五小时和本周剩余百分比。胶囊左右两半边框分别表示五小时和本周的消耗速度状态，不表示剩余量。
- **快速模式：** 在 Codex App Server 能提供该配置状态时，用闪电图标显示快速模式是否开启。
- **托盘用量环：** 32×32px 透明图标，中心留空，只用五小时剩余额度绘制圆环；用量未知或连接离线时显示灰环。
- **悬停详情：** 悬停托盘图标或胶囊可打开完整详情，包括五小时和本周重置时间、重置卡数量与有效期。
- **重置卡交互：** 使用前需要确认；只有服务端确认成功后才显示成功并刷新用量。卡片数据或标识不完整时不可操作。
- **托盘菜单：** 支持手动刷新用量和退出应用。

托盘圆环颜色按五小时剩余量切换：

| 剩余量 | 颜色 | 状态 |
| --- | --- | --- |
| ≥ 60% | `#19E6B5` | 充足 |
| 30–59% | `#FFD449` | 预警 |
| 10–29% | `#FF923F` | 偏低 |
| < 10% | `#FF4D68` | 严重不足 |

## 数据来源

五小时、周额度和 Token 历史都通过本机 Codex 登录凭据读取：应用从 `CODEX_HOME` 下的 `auth.json`（未设置时为 `%USERPROFILE%\.codex\auth.json`）取出访问令牌和账户 ID，再请求对应的 ChatGPT 用量接口。Token 历史直接请求每日账户 Token 用量接口，因此不依赖 Codex App Server。快速模式和重置卡信息及操作仍通过本机 Codex CLI 启动 Codex App Server 获取；重置卡只有在 App Server 明确确认成功后才会标记为成功。

额度和 Token 历史读取需要本机 Codex CLI 已登录。快速模式和重置卡功能还需要启动 Codex App Server。应用会查找 Codex CLI 的常见安装路径，找不到时尝试从 `PATH` 启动 `codex`。如果 CLI 位于其他位置，可在启动应用前设置：

```powershell
$env:CODEX_CLI_PATH = "C:\path\to\codex.exe"
```

请确保该 Codex CLI 可访问你要查看用量的账户。

## 开发环境

需要：

- Windows
- Node.js 和 pnpm
- Rust 稳定版（MSVC 工具链）及 Windows C++ 构建工具
- Microsoft Edge WebView2 Runtime
- 已安装并完成账户配置的 Codex CLI

在仓库根目录运行：

```powershell
pnpm install
pnpm tauri:dev
```

## 构建

```powershell
# TypeScript 检查并构建前端资源
pnpm build

# 构建 Tauri 桌面应用
pnpm tauri build
```

## 项目结构

- `src/`：React 与 TypeScript 前端、胶囊和详情面板
- `src-tauri/src/lib.rs`：Tauri 窗口、系统托盘、用量读取和重置卡操作
- `src-tauri/tauri.conf.json`：桌面窗口与构建配置
