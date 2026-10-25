# yimu-mcp

一木记账（yimubill.com）的 MCP 服务：把一木记账网页版的能力封装成 AI 可调用的工具，
在支持 MCP 的客户端里就能直接读写你的账本。

## 能做什么

- **三种登录方式**：扫码登录（推荐，手机一扫即可）、邮箱密码登录、直接配置登录令牌
- **看账**：全量/增量同步账单、按账本分页查询、账单总数、删除记录
- **管账**：新增、更新、删除账单、资产、账本、标签、转账、借贷、分类、报销、退款、附件
- **辅助能力**：一句话记账解析（「午饭 35」自动识别金额和分类）、可显式启用的通用接口请求
- **扫码方便**：二维码直接显示在对话或终端里，不用打开图片文件

## 快速开始

需要 Node ≥ 23.4 或 Bun ≥ 1.x。

安装：

```bash
npm install -g @powercess/yimu-mcp
yimu-mcp        # 启动 MCP 服务
```

本地开发：

```bash
npm install && npm run build   # Node
# 或
bun install && bun run dev      # Bun，直接运行，无需构建
```

## 配置

建议通过环境变量提供配置，账号信息不进仓库：

| 环境变量 | 说明 |
|---|---|
| `YIMU_TOKEN` | 登录令牌 JWT（登录后获得，优先级最高） |
| `YIMU_EMAIL` / `YIMU_PASSWORD` | 账号邮箱/密码（可选：未配 TOKEN 时启动自动登录；`login_email` 不传参时用这对凭据） |
| `YIMU_USER_ID` | 用户 ID（部分接口需要，登录后自动获取） |
| `YIMU_BASE_URL` | 兼容配置项，仅接受官方 `https://yimubill.com/api`（可带结尾 `/`） |
| `YIMU_QR_DIR` | 二维码保存目录，默认系统临时目录 |
| `YIMU_CONFIG` | 可选，显式指定可信 JSON 配置文件的绝对路径；也可使用 `--config` |
| `YIMU_ENABLE_API_REQUEST` | 仅设为 `1` 时启用通用接口工具；也可使用 `--enable-api-request` |

不再自动读取启动目录中的 `yimu.config.json`。需要文件配置时，请使用 `--config /绝对路径/yimu.config.json`
或 `YIMU_CONFIG` 指向由你管理的可信文件。优先级为命令行参数 > 环境变量 > 显式文件 > 默认值；
显式文件不存在、不是有效 JSON 对象或使用相对路径时，启动会失败。API 地址始终受官方域名限制。

令牌可从一木记账网页版浏览器开发者工具里复制请求头 `token` 的值。

## 接入 MCP 客户端

全局安装后：

```json
{
  "mcpServers": {
    "yimu": {
      "command": "yimu-mcp",
      "env": { "YIMU_TOKEN": "你的JWT" }
    }
  }
}
```

仓库本地方式（`command` 指向可执行文件）：`node` + `dist/index.js`，或 `bun` + `src/index.ts`（无需构建）。

## 登录

1. **扫码登录（推荐）**：调用 `login_qr_start`，二维码直接显示在对话或终端里；
   手机打开一木记账 App，首页 → 更多 → 扫一扫，扫完调用 `login_qr_poll` 等待登录结果。
2. **邮箱密码登录**：调用 `login_email`，填邮箱和密码即可，密码加密传输；
   不传参数时自动使用环境变量 `YIMU_EMAIL` / `YIMU_PASSWORD`。
3. **JWT 直配**：在环境变量里配好 `YIMU_TOKEN`，启动即已登录。

> 配了 `YIMU_EMAIL` / `YIMU_PASSWORD` 而未配 TOKEN 时，服务启动会自动登录获取 JWT，
> AI 即可直接读写账本；令牌过期后随时调 `login_email`（无参）重新登录。
> 扫码/邮箱登录只返回登录状态和脱敏用户信息，JWT 留在当前工具进程内部供后续请求使用。
> 新 JWT 只更新内存，不写回环境变量或配置文件；重启后仍需原有有效配置或重新登录。

## 安全说明

- 密码提交时按官方协议使用 AES-128-ECB 加密；传输保密依赖 HTTPS。工具不自动保存登录凭据，
  `--print-config` 对令牌和密码掩码；使用文件配置时，文件权限和保存方式由你管理。
- 请求仅发送至 `https://yimubill.com`，并拒绝自动重定向；不能通过配置改为代理、HTTP 或其他域名。
- MCP 输出统一移除凭据字段和已知秘密的回显；错误结果仅保留安全的状态或错误码，不透传服务器原文。
- 扫码二维码和会话 ID 仍通过 MCP 交互展示，用于完成登录；这些是短期登录授权信息，仅应交给可信客户端。
- `api_request` 默认不注册，显式启用后其 `raw` 模式仍会脱敏。`get_sts` / `get_sts_no_verify`
  不再作为 MCP 工具公开，避免把对象存储临时凭据交给模型；内部 API 方法保留。
- 在 hub 等平台配置 `YIMU_PASSWORD` 前，请确认其环境变量存储方式；优先用 `YIMU_TOKEN` 或扫码登录。

## 工具一览

- **登录与账号**：`login_qr_start` `login_qr_poll` `login_email` `get_me` `auth_status`
- **查询**：`sync_pull`（增量同步，默认返回摘要：计数/收支合计/最近明细/分类Top）、`get_bill_count`（账单总数）、
  `get_book_bills`（账本账单分页，精简账单+收支小计）、
  `get_assets`（资产，仅业务字段）、`get_currency`（币种）、`get_category_info`（分类）、
  `get_share_accounts`（共享账本）、`get_account_members`（账本成员）、`get_delete_history`（删除记录）
- **记账**：`save_bill` / `save_bills`（单条/批量新增或更新）、`delete_bill`（删除）
- **其他实体**：`save_asset` `save_account_book` `save_tag` `save_transfer` `save_lend`
  `save_parent_category` `save_child_category` `save_reimbursement` `save_refund`
  `save_bill_file` `save_bill_import` `save_asset_history`（对应删除用 `delete_*`）
- **辅助**：`parse_bill_text`（一句话记账解析）、`api_request`（仅显式启用时，通用请求仍可读写接口）

## 测试

运行 `npm ci --ignore-scripts` 和 `npm test`，会先编译再执行 Node 测试。
回归测试使用模拟 API 响应、真实 MCP 内存传输和临时配置文件，不连接一木服务、不需要真实账号。
覆盖登录后继续认证、凭据输出、错误信息、恶意配置、地址校验和重定向策略。

## License

MIT
