// 一木记账 MCP 工具：把网页端接口映射为 MCP 工具。
// 除标注「免鉴权」的工具外，均要求已持有 JWT（YIMU_TOKEN 配置或登录获得）。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YimuClient, YimuError } from "./api.ts";
import { encryptPassword } from "./crypto.ts";
import { renderQrPng, renderQrTerminal, saveQrPng } from "./qr.ts";
import { prune, projectEntity, sanitizeUser, sanitizeOutput, roundMoney, fmtDate } from "./prune.ts";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

/** MCP 内容块：文本或图片（图片供支持图片的 harness 直接展示） */
type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** 带图片的结果：text 为给人看的说明，image 为可选图片内容 */
interface QrResult {
  text: string;
  image?: { data: string; mimeType: string };
}

/** 统一输出：QrResult 渲染为 文本+图片 内容块；其余 JSON 序列化 */
const out = (v: unknown, opts?: { noPrune?: boolean }): { content: ContentBlock[] } => {
  if (
    v &&
    typeof v === "object" &&
    (v as Record<string, unknown>).image &&
    typeof (v as Record<string, unknown>).text === "string"
  ) {
    const r = v as QrResult;
    const content: ContentBlock[] = [{ type: "text", text: r.text }];
    if (r.image) content.push({ type: "image", data: r.image.data, mimeType: r.image.mimeType });
    return { content };
  }
  const data = opts?.noPrune ? v : prune(v);
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data ?? null, null, 1) }] };
};

interface PropSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
}

/**
 * 内部 JSON-Schema 描述 → zod 形状（SDK registerTool 的 inputSchema 需要 zod schema 值）。
 * number 用 coerce 容忍 LLM 传字符串数字；object/array 开放结构，required 由缺省 optional 区分。
 * 声明 additionalProperties:false 时返回 .strict()，运行时同样拒绝未知键（与声明契约一致）。
 */
function toShape(desc: Record<string, unknown>): z.ZodType {
  const props = (desc.properties ?? {}) as Record<string, PropSchema>;
  const required = (desc.required as string[] | undefined) ?? [];
  const shape: Record<string, z.ZodType> = {};
  for (const [k, p] of Object.entries(props)) {
    let s: z.ZodType;
    switch (p.type) {
      case "number":
      case "integer":
        s = p.type === "integer" ? z.coerce.number().int() : z.coerce.number();
        break;
      case "boolean":
        s = z.boolean();
        break;
      case "object":
        s = z.record(z.string(), z.unknown());
        break;
      case "array":
        s = z.array(z.record(z.string(), z.unknown()));
        break;
      case "string":
        s = p.enum && p.enum.length >= 2 ? z.enum(p.enum as [string, ...string[]]) : z.string();
        break;
      default:
        s = z.unknown();
        break;
    }
    if (p.description) s = s.describe(p.description);
    if (!required.includes(k)) s = s.optional();
    shape[k] = s;
  }
  const obj = z.object(shape);
  return desc.additionalProperties === false ? obj.strict() : obj;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 免鉴权工具（登录/扫码/同步会话） */
  noAuth?: boolean;
  /** 跳过空值裁剪，但不能跳过凭据脱敏。 */
  noPrune?: boolean;
  handler: Handler;
}

/** 实体字段说明（字段名来自服务端数据快照；未知实体注明） */
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** 实体字段说明（字段名来自服务端快照 schemas.json；未知实体注明） */
const SCHEMA_HINTS: Record<string, string> = {
  Bill:
    "billId 主键；cost 金额（元）；time 记账时间(ms)；billType 记录方式（1快捷/2手动/3导入/4周期/5自动/6模板）；" +
    "parentCategoryId/childCategoryId 分类（收支由分类决定）；" +
    "remark 备注；assetId 账户；bookId 账本；tags 标签（数组或 JSON 字符串均可）；recordTime 记录时间；" +
    "reimbursement/reimbursementEnd 报销；notIntoTotal/notIntoBudget 不计收支/预算；currencyInfo 币种；userId/updateTime 自动填充",
  Asset:
    "assetId 主键；assetName 名称；assetType 类型；assetNumber 余额；totalQuota 总额度；intoTotalAsset 计入总资产；" +
    "hide 隐藏；bookId 账本；currency 币种；remark/simpleName/cardCode/positionWeight 可选；userId/updateTime 自动填充",
  Transfer: "transferId 主键；cost 金额；serviceCharge 手续费；time 时间；fromAssetId/toAssetId 转出/转入账户；toCost 到账金额；billId 关联账单；remark 备注",
  Lend: "lendId 主键；type 类型（借出/借入）；number 金额；interest 利息；outTime/inTime 借出/归还时间；assetId 关联账户；repaymentAssetId 还款账户；remark 备注",
  ParentCategory: "categoryId 主键；categoryName 名称；iconUrl 图标；positionWeight 排序；hide 隐藏；categoryType 类型",
  ChildCategory: "categoryId 主键；categoryName 名称；iconUrl 图标；parentCategoryId 所属一级分类；positionWeight 排序；hide 隐藏；categoryType 类型",
  Refund: "refundId 主键；billId 关联账单；refundNum 退款金额；refundInfos 退款明细（JSON）",
  BillFile: "fileId 主键；billId 关联账单；remotePath 远程路径；fileName 文件名；fileSize 大小；transferId/lendId 可选",
  AssetHistory: "assetHistoryId 主键；assetId 账户；time 时间；currentNum 变动后余额；changeNum 变动额；changeContent 变动说明",
  Tag: "tag 字段无快照数据；至少携带 tagId/tagName 与 userId，其余按服务端契约传递",
  AccountBook: "accountBookId 主键；bookName 账本名；bookType 账本类型；shareUsers 共享用户；字段按服务端契约传递",
  Reimbursement: "reimbursement 无快照数据；携带 billId/remark/金额字段与 userId，按服务端契约传递",
  BillImport: "billImport 导入记录；无快照数据，按服务端契约传递",
};

/** 同步数据摘要：计数 + 收支合计 + 最近10笔 + 分类Top + 资产（面向 AI 分析，避免全量实体淹没上下文） */
function summarizeSync(d: Record<string, unknown>): unknown {
  const bills = Array.isArray(d.Bill) ? (d.Bill as Record<string, unknown>[]) : [];
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(d)) if (Array.isArray(v)) counts[k] = v.length;
  let income = 0;
  let expense = 0;
  const byCat = new Map<number, { count: number; expense: number; income: number }>();
  for (const b of bills) {
    const cost = typeof b.cost === "number" && Number.isFinite(b.cost) ? b.cost : Number(b.cost) || 0;
    const inc = Number(b.parentCategoryId) === 9; // 系统收入根分类（与网页端一致）
    if (inc) income += cost;
    else expense += cost;
    const cid = Number(b.parentCategoryId) || 0;
    const e = byCat.get(cid) ?? { count: 0, expense: 0, income: 0 };
    e.count += 1;
    if (inc) e.income += cost;
    else e.expense += cost;
    byCat.set(cid, e);
  }
  const topCategories = [...byCat.entries()]
    .map(([id, v]) => ({ parentCategoryId: id, count: v.count, expense: roundMoney(v.expense), income: roundMoney(v.income) }))
    .sort((x, y) => Number(y.expense) + Number(y.income) - (Number(x.expense) + Number(x.income)))
    .slice(0, 10);
  const recentBills = [...bills]
    .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0))
    .slice(0, 10)
    .map((b) => ({
      billId: b.billId,
      cost: roundMoney(b.cost),
      date: fmtDate(b.time),
      parentCategoryId: b.parentCategoryId,
      childCategoryId: b.childCategoryId,
      remark: b.remark,
      assetId: b.assetId,
    }));
  const assets = Array.isArray(d.Asset)
    ? d.Asset.map((x) => projectEntity("Asset", (x ?? {}) as Record<string, unknown>))
    : [];
  return prune({
    syncTime: d.syncTime,
    counts,
    totals: { income: roundMoney(income), expense: roundMoney(expense), bills: bills.length },
    recentBills,
    topCategories,
    assets,
  });
}

export function registerYimuTools(
  server: McpServer,
  client: YimuClient,
  qrDir: string,
  creds: { email: string; password: string } = { email: "", password: "" },
  options: { enableApiRequest?: boolean } = {},
): void {
  // 保留本次工具进程已使用的秘密，防止令牌刷新或登录结束后的迟到回显。
  const secrets = new Set<string>();
  const rememberSecrets = (password = ""): void => {
    if (client.token) secrets.add(client.token);
    // 一木 userObjectToken 通常是公开邮箱；非邮箱形式仍作为凭据处理。
    if (client.userToken && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.userToken)) secrets.add(client.userToken);
    for (const value of [creds.password, password]) {
      if (value) {
        secrets.add(value);
        secrets.add(encryptPassword(value));
      }
    }
  };
  rememberSecrets();
  const requireAuth = (args: Record<string, unknown>): void => {
    if (!client.token) {
      throw new YimuError(
        `未登录：缺少 JWT。请配置 YIMU_TOKEN，或用 login_qr_start/login_qr_poll 扫码登录、login_email 邮箱登录。${args.user_id ? `当前 user_id=${args.user_id}` : ""}`,
      );
    }
  };
  const uid = (args: Record<string, unknown>): string =>
    str(args.user_id || args.userId) || client.userId;

  const tools: ToolDef[] = [
    // ---------------- 认证 ----------------
    {
      name: "auth_status",
      description: "查看登录状态（本地配置，不发请求）：是否持有 JWT、用户 ID、API 基址。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      noAuth: true,
      handler: async () => ({
        logged_in: Boolean(client.token),
        token_set: Boolean(client.token),
        user_id: client.userId || null,
        base_url: client.baseUrl,
        email_configured: Boolean(creds.email),
        password_configured: Boolean(creds.password),
      }),
    },
    {
      name: "login_qr_start",
      description:
        "创建扫码登录会话（免鉴权）。返回 session_id、qr_payload（login:<session_id>）与二维码图片：\n" +
        "1) 结果附带的 image 内容块可直接在支持图片的 harness 界面展示；\n" +
        "2) text 中内嵌 UTF-8 终端二维码（等宽字体直显，无需打开图片）；\n" +
        "3) 图片同时保存到二维码目录（--qr-dir / YIMU_QR_DIR，默认系统临时目录 yimu-mcp/），text 中给出完整路径；\n" +
        "4) 服务端同时把 ANSI 彩色二维码打印到 stderr（服务运行在终端里时控制台直接可见）。\n" +
        "二维码 2 分钟有效，用一木记账 App【首页】-【更多】-【扫一扫】扫描后调用 login_qr_poll 等待登录结果。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      noAuth: true,
      handler: async (): Promise<QrResult> => {
        const sessionId = await client.addScanLogin();
        const payload = `login:${sessionId}`;
        const file = await saveQrPng(payload, qrDir, `qr-${sessionId}.png`);
        const terminalQr = await renderQrTerminal(payload, "utf8");
        // ANSI 彩色版直接打 stderr：服务端跑在终端里时控制台立即可扫（stdout 是 JSON-RPC 通道，不能动）
        process.stderr.write(`\n[yimu-mcp] 扫码登录二维码（控制台直显，2 分钟有效）:\n${await renderQrTerminal(payload, "ansi")}\n`);
        return {
          text:
            `扫码登录二维码已生成。\n` +
            `session_id: ${sessionId}\n` +
            `qr_payload: ${payload}\n` +
            `二维码图片已保存到: ${file}\n` +
            `（请用一木记账 App【首页】-【更多】-【扫一扫】扫描，然后调用 login_qr_poll 等待登录；` +
            `二维码在下方，控制台折叠时可 ctrl+o 展开）\n` +
            `控制台二维码（UTF-8 半块字符，等宽字体直显）:\n${terminalQr}`,
          image: { data: (await renderQrPng(payload)).toString("base64"), mimeType: "image/png" },
        };
      },
    },
    {
      name: "login_qr_poll",
      description:
        "等待/轮询扫码登录结果（免鉴权）。timeout 秒内每 3 秒查询一次，用户扫码后返回 status=success 与用户对象（JWT 仅保留在当前进程内部）；" +
        "timeout=0 只查一次。默认 120 秒。",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "login_qr_start 返回的 session_id" },
          timeout: { type: "number", description: "等待秒数，0=只查一次；默认 120" },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      noAuth: true,
      handler: async (a) => {
        const sid = str(a.session_id);
        const timeout = num(a.timeout, 120);
        const deadline = Date.now() + timeout * 1000;
        for (;;) {
          const user = await client.getScanLogin(sid);
          if (user) return { status: "success", user: sanitizeUser(user) };
          if (timeout === 0 || Date.now() >= deadline) {
            return { status: "pending", hint: "等待扫码或登录尚未完成；可再次调用本工具（传 timeout 秒数则自动等待）" };
          }
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 3000);
          await promise;
        }
      },
    },
    {
      name: "login_email",
      description:
        "邮箱密码登录（免鉴权）。密码按网页端加密方案（AES-128-ECB）加密后提交；仅返回登录状态与用户对象。" +
        "不传 email/password 时使用环境变量 YIMU_EMAIL/YIMU_PASSWORD（未配置则报错）。" +
        "请优先使用扫码登录（更安全）。",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string", description: "一木记账账号邮箱；缺省用环境变量 YIMU_EMAIL" },
          password: { type: "string", description: "账号密码；缺省用环境变量 YIMU_PASSWORD（仅本次调用，不落盘）" },
        },
        additionalProperties: false,
      },
      noAuth: true,
      handler: async (a) => {
        const email = str(a.email) || creds.email;
        const password = str(a.password) || creds.password;
        if (!email || !password) {
          throw new YimuError("缺少邮箱或密码：请传 email/password 参数，或在环境变量配置 YIMU_EMAIL/YIMU_PASSWORD");
        }
        const user = await client.loginByEmail(email, password);
        return { status: "success", user: sanitizeUser(user as Record<string, unknown>) };
      },
    },
    {
      name: "get_me",
      description: "查询当前用户信息（POST /user/getUserInfoById）；响应顶层 token 会自动刷新 JWT。",
      inputSchema: {
        type: "object",
        properties: { user_id: { type: "string", description: "用户 ID，缺省用配置/登录值" } },
        additionalProperties: false,
      },
      handler: async (a) => {
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID：请传 user_id 或先登录");
        return sanitizeUser((await client.getUserInfoById(id)) as Record<string, unknown>);
      },
    },

    // ---------------- 读取 ----------------
    {
      name: "sync_pull",
      description:
        "增量拉取业务数据（GET /updateTime/getUpdateDataPage/{userId}/{time}）。" +
        "默认返回摘要：syncTime、各实体计数、收支合计、最近10笔、分类Top10、资产列表——适合 AI 快速分析账目；" +
        "需要完整明细时传 summary=false，各实体按业务字段精简返回（Bill 只含 billId/cost/日期/分类/备注等）。" +
        "time 为上次同步时间戳(ms)，缺省 0 表示全量。",
      inputSchema: {
        type: "object",
        properties: {
          time: { type: "number", description: "上次同步时间戳(ms)，0=全量" },
          summary: { type: "boolean", description: "默认 true：返回摘要；false 返回全部实体明细（已精简）" },
          user_id: { type: "string" },
        },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        const t = a.time === undefined ? 0 : num(a.time, 0);
        const data = (await client.getUpdateDataPage(id, t)) as Record<string, unknown> | null;
        if (!data || typeof data !== "object") return data;
        if (a.summary !== false) return summarizeSync(data);
        const outData: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(data)) {
          outData[k] = Array.isArray(v) ? v.map((x) => projectEntity(k, (x ?? {}) as Record<string, unknown>)) : v;
        }
        return prune(outData);
      },
    },
    {
      name: "get_delete_history",
      description: "查询删除记录（GET /deleteHistory/getDeleteHistory/{userId}/{time}），time 缺省 0 全量。",
      inputSchema: {
        type: "object",
        properties: {
          time: { type: "number", description: "起始时间戳(ms)" },
          user_id: { type: "string" },
        },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getDeleteHistory(id, a.time === undefined ? 0 : num(a.time, 0));
      },
    },
    {
      name: "get_bill_count",
      description: "查询账单总数（GET /bill/getBillCount/{userId}）。",
      inputSchema: {
        type: "object",
        properties: { user_id: { type: "string" } },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getBillCount(id);
      },
    },
    {
      name: "get_book_bills",
      description:
        "分页查询账本账单（GET /bill/getAccountBillPage/{userId}/{bookId}/{page}）。" +
        "返回 {syncTime, hasMoreData, billCount, totals:{income,expense}, bills:[精简账单]}；" +
        "账单只含 billId/cost/日期/分类/备注/账户等业务字段。page 从 0 起，按 hasMoreData 翻页。",
      inputSchema: {
        type: "object",
        properties: {
          book_id: { type: "string", description: "账本 ID" },
          page: { type: "number", description: "页码，从 0 开始" },
          user_id: { type: "string", description: "账本所属用户 ID，缺省用当前用户" },
        },
        required: ["book_id"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        const page = num(a.page, 0);
        const r = (await client.getAccountBillPage(id, str(a.book_id), page)) as Record<string, unknown> | null;
        if (!r || typeof r !== "object") return r;
        const bills = Array.isArray(r.Bill) ? (r.Bill as Record<string, unknown>[]) : [];
        let income = 0;
        let expense = 0;
        for (const b of bills) {
          const cost = typeof b.cost === "number" && Number.isFinite(b.cost) ? b.cost : Number(b.cost) || 0;
          if (Number(b.parentCategoryId) === 9) income += cost;
          else expense += cost;
        }
        return prune({
          syncTime: r.syncTime,
          hasMoreData: r.hasMoreData,
          page,
          billCount: bills.length,
          totals: { income: roundMoney(income), expense: roundMoney(expense) },
          bills: bills.map((b) => projectEntity("Bill", b)),
        });
      },
    },
    {
      name: "get_book_last_time",
      description: "查询账本最后同步时间戳(ms)（GET /bill/getAccountLastTime/{userId}/{bookId}），可作增量同步游标。",
      inputSchema: {
        type: "object",
        properties: {
          book_id: { type: "string", description: "账本 ID" },
          user_id: { type: "string" },
        },
        required: ["book_id"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getAccountLastTime(id, str(a.book_id));
      },
    },
    {
      name: "get_share_accounts",
      description: "查询共享账本列表（GET /accountBook/getShareAccount/{userId}）。",
      inputSchema: {
        type: "object",
        properties: { user_id: { type: "string" } },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getShareAccount(id);
      },
    },
    {
      name: "get_assets",
      description: "查询资产列表（GET /asset/getAsset/{userId}/{time}），time 为起始时间戳(ms)，缺省 0 全量；每个资产只保留业务字段（名称/余额/类型/分组）。",
      inputSchema: {
        type: "object",
        properties: {
          time: { type: "number", description: "起始时间戳(ms)" },
          user_id: { type: "string" },
        },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        const r = await client.getAsset(id, a.time === undefined ? 0 : num(a.time, 0));
        return Array.isArray(r) ? r.map((x) => projectEntity("Asset", x)) : r;
      },
    },
    {
      name: "get_account_members",
      description: "查询账本成员（GET /accountBook/getAccountMember/{userId}/{bookId}）。",
      inputSchema: {
        type: "object",
        properties: {
          book_id: { type: "string", description: "账本 ID" },
          user_id: { type: "string" },
        },
        required: ["book_id"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getAccountMember(id, str(a.book_id));
      },
    },
    {
      name: "get_account_delete_history",
      description:
        "查询账本删除历史（GET /accountBook/getAccountDeleteHistory/{userId}/{ownerId}/{bookId}/{lastSyncTime}）。",
      inputSchema: {
        type: "object",
        properties: {
          book_id: { type: "string", description: "账本 ID" },
          owner_id: { type: "string", description: "账本所属用户 ID" },
          last_sync_time: { type: "number", description: "上次同步时间戳(ms)" },
          user_id: { type: "string" },
        },
        required: ["book_id"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getAccountDeleteHistory(id, str(a.owner_id || a.ownerId) || id, str(a.book_id), num(a.last_sync_time, 0));
      },
    },
    {
      name: "get_currency",
      description: "查询币种数据（GET /currency/getCurrencyData/{userId}）。",
      inputSchema: {
        type: "object",
        properties: { user_id: { type: "string" } },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getCurrencyData(id);
      },
    },
    {
      name: "get_category_info",
      description: "查询分类信息（图标/预设分类，GET /icon/getCategoryInfo/{userId}）。",
      inputSchema: {
        type: "object",
        properties: { user_id: { type: "string" } },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getCategoryInfo(id);
      },
    },

    // ---------------- 同步限流会话 ----------------
    {
      name: "sync_start",
      description:
        "开始同步限流会话（免鉴权，POST /bookkeeping/rateLimit/sync/start）。" +
        "批量写操作前先 start，全部完成后务必 sync_end 归还会话，避免触发限流。返回 {syncCount, sessionId}。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      noAuth: true,
      handler: async () => client.syncStart(),
    },
    {
      name: "sync_end",
      description: "结束同步限流会话（免鉴权，POST /bookkeeping/rateLimit/sync/end?sessionId=）。",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string", description: "sync_start 返回的 sessionId" } },
        additionalProperties: false,
      },
      noAuth: true,
      handler: async (a) => client.syncEnd(a.session_id ? str(a.session_id) : undefined),
    },

    // ---------------- 写入：账单 ----------------
    {
      name: "save_bill",
      description:
        "新增或更新账单（POST /bill/addOrUpdateBill，upsert：带 billId 为更新，缺省为新增）。" +
        "自动归一化：tags 数组→JSON 字符串、recordTime 缺省取 updateTime/当前时间、billId 超 int32 自动重生成。" +
        "bill 字段：\n" + SCHEMA_HINTS.Bill,
      inputSchema: {
        type: "object",
        properties: {
          bill: { type: "object", description: "账单对象，见描述字段说明" },
        },
        required: ["bill"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const b = a.bill as Record<string, unknown>;
        if (!b || typeof b !== "object") throw new YimuError("bill 必须是对象");
        if (b.userId === undefined && client.userId) b.userId = Number(client.userId) || client.userId;
        return client.addOrUpdateBill(b);
      },
    },
    {
      name: "save_bills",
      description:
        "批量新增/更新账单（POST /bill/addOrUpdateBillList）。自动按 100 条分批、每批 updateTime 递增（与网页端一致）。" +
        "bill 字段同 save_bill。",
      inputSchema: {
        type: "object",
        properties: {
          bills: { type: "array", items: { type: "object" }, description: "账单对象数组（自动分批）" },
        },
        required: ["bills"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const list = a.bills;
        if (!Array.isArray(list) || list.length === 0) throw new YimuError("bills 必须是非空数组");
        const userId = Number(client.userId) || client.userId;
        const bills = list.map((b) => {
          const obj = (b ?? {}) as Record<string, unknown>;
          if (obj.userId === undefined && client.userId) obj.userId = userId;
          return obj;
        });
        return client.addOrUpdateBillList(bills);
      },
    },
    {
      name: "delete_bill",
      description: "删除账单（POST /bill/deleteBill，按 billId 删除）。",
      inputSchema: {
        type: "object",
        properties: {
          bill_id: { type: "string", description: "账单 ID" },
          user_id: { type: "string" },
        },
        required: ["bill_id"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        return client.deleteBill(str(a.bill_id), uid(a) || undefined);
      },
    },

    // ---------------- 写入：其他实体（表驱动） ----------------
    ...Object.entries(ENTITY_ENDPOINTS).flatMap(([toolKey, ep]) => {
      const cap = ep.action; // 如 Asset
      const saveTool: ToolDef = {
        name: `save_${toolKey}`,
        description: `新增或更新${ep.label}（POST /${ep.domain}/addOrUpdate${cap}，upsert：带主键为更新）。entity 字段：${SCHEMA_HINTS[cap] ?? "按服务端契约传递"}`,
        inputSchema: {
          type: "object",
          properties: { entity: { type: "object", description: `${ep.label}对象` } },
          required: ["entity"],
          additionalProperties: false,
        },
        handler: async (a) => {
          requireAuth(a);
          const e = a.entity as Record<string, unknown>;
          if (!e || typeof e !== "object") throw new YimuError("entity 必须是对象");
          if (e.userId === undefined && client.userId) e.userId = Number(client.userId) || client.userId;
          return client.addOrUpdateEntity(ep.domain, `addOrUpdate${cap}`, e);
        },
      };
      const delTool: ToolDef = {
        name: `delete_${toolKey}`,
        description: `删除${ep.label}（POST /${ep.domain}/delete${cap}）。entity 需携带主键字段（${ep.pk}）与 userId。`,
        inputSchema: {
          type: "object",
          properties: { entity: { type: "object", description: `${ep.label}对象（含主键 ${ep.pk}）` } },
          required: ["entity"],
          additionalProperties: false,
        },
        handler: async (a) => {
          requireAuth(a);
          const e = a.entity as Record<string, unknown>;
          if (!e || typeof e !== "object") throw new YimuError("entity 必须是对象");
          if (e.userId === undefined && client.userId) e.userId = Number(client.userId) || client.userId;
          return client.addOrUpdateEntity(ep.domain, `delete${cap}`, e);
        },
      };
      return [saveTool, ...(ep.noDelete ? [] : [delTool])];
    }),

    // ---------------- 工具类 ----------------
    {
      name: "parse_bill_text",
      description: "解析记账原始文本（GET /bill/analysisBillInfoT/{userId}/{text}），返回结构化账单信息。",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "原始记账文本，如「午饭 25 元 餐饮」" },
          user_id: { type: "string" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.parseBillText(id, str(a.text));
      },
    },
    {
      name: "api_request",
      description:
        "通用 API 请求（逃生通道，覆盖全部接口）。path 支持 {userId}/{bookId}/{time} 等占位符由 params 填充；" +
        "自动携带 token 头并解包 {code,msg,result} 信封；所有输出均移除凭据。可用路径见 README 接口清单；" +
        "例如：{method:POST, path:/bill/addOrUpdateBill, body:{...}}、{method:GET, path:/bill/getBillCount/{userId}, params:{userId:123}}。",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST"], description: "HTTP 方法" },
          path: { type: "string", description: "接口路径，如 /user/getUserInfoById 或 /bookkeeping/rateLimit/sync/start" },
          params: { type: "object", description: "路径占位符 {x} 的取值" },
          query: { type: "object", description: "查询参数" },
          body: { type: "object", description: "JSON 请求体" },
          form: { type: "object", description: "表单请求体（application/x-www-form-urlencoded）" },
          raw: { type: "boolean", description: "true 时保留响应信封，但仍移除凭据" },
        },
        required: ["method", "path"],
        additionalProperties: false,
      },
      noPrune: true,
      handler: async (a) => {
        requireAuth(a);
        const method = String(a.method).toUpperCase();
        const path = str(a.path);
        return client.request(method, path, {
          params: (a.params as Record<string, string | number> | undefined) ?? {},
          query: (a.query as Record<string, string | number> | undefined) ?? {},
          body: a.body,
          form: a.form as Record<string, string> | undefined,
          raw: Boolean(a.raw),
        });
      },
    },
  ];

  for (const t of tools) {
    if (t.name === "api_request" && !options.enableApiRequest) continue;
    const guard = async (
      args: unknown,
    ): Promise<{ content: ContentBlock[]; isError?: boolean }> => {
      const a = (args ?? {}) as Record<string, unknown>;
      rememberSecrets(str(a.password));
      try {
        if (!t.noAuth) requireAuth(a);
        const result = await t.handler(a);
        rememberSecrets();
        return out(sanitizeOutput(result, [...secrets]), t.noPrune ? { noPrune: true } : undefined);
      } catch (e) {
        rememberSecrets();
        const message = e instanceof YimuError ? e.message : "工具调用失败，请检查输入或登录状态";
        return { isError: true, content: [{ type: "text", text: String(sanitizeOutput(message, [...secrets])) }] };
      }
    };
    server.registerTool(
      t.name,
      { title: t.name, description: t.description, inputSchema: toShape(t.inputSchema) },
      guard,
    );
  }
}

/** 通用实体端点表：toolKey → 域/动作/主键/中文名 */
const ENTITY_ENDPOINTS: Record<string, { domain: string; action: string; pk: string; label: string; noDelete?: boolean }> = {
  asset: { domain: "asset", action: "Asset", pk: "assetId", label: "资产" },
  account_book: { domain: "accountBook", action: "AccountBook", pk: "accountBookId", label: "账本" },
  tag: { domain: "tag", action: "Tag", pk: "tagId", label: "标签" },
  transfer: { domain: "transfer", action: "Transfer", pk: "transferId", label: "转账" },
  lend: { domain: "lend", action: "Lend", pk: "lendId", label: "借贷" },
  parent_category: { domain: "parentCategory", action: "ParentCategory", pk: "categoryId", label: "一级分类" },
  child_category: { domain: "childCategory", action: "ChildCategory", pk: "categoryId", label: "二级分类" },
  reimbursement: { domain: "reimbursement", action: "Reimbursement", pk: "reimbursementId", label: "报销" },
  refund: { domain: "refund", action: "Refund", pk: "refundId", label: "退款" },
  bill_file: { domain: "billFile", action: "BillFile", pk: "fileId", label: "账单附件" },
  bill_import: { domain: "billImport", action: "BillImport", pk: "importId", label: "账单导入记录", noDelete: true },
  asset_history: { domain: "assetHistory", action: "AssetHistory", pk: "assetHistoryId", label: "资产变动记录" },
};
