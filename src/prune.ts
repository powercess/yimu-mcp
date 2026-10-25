// 输出裁剪：面向 AI 消费的数据精简。
// 服务端 schema 面向 App 渲染（同步元数据 + UI 字段 + 空默认值），直接透传会浪费大量上下文；
// 这里统一做：空值裁剪、业务字段投影、数值/日期规整、用户对象脱敏。

// Node >=23.4 已支持 JSON 源文本访问；当前 TypeScript 标准库尚未声明这些 API。
const sourceJson = JSON as typeof JSON & {
  rawJSON(source: string): object;
  isRawJSON(value: unknown): boolean;
};

/** 数字保留源文本，避免脱敏后重新序列化时发生精度损失或指数溢出。 */
function parseJsonPreservingNumbers(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number" && context?.source !== undefined) {
      return sourceJson.rawJSON(context.source);
    }
    return value;
  });
}

const CREDENTIAL_FIELD = /token|password|passwd|passphrase|secret|authorization|cookie|credential|apikey|accesskey/;

/** MCP 输出的共同边界；客户端内部保留原始认证响应以完成登录和令牌更新。 */
export function sanitizeOutput(value: unknown, secrets: readonly string[] = []): unknown {
  const replacements = [...new Set(secrets.filter(Boolean).flatMap((secret) => {
    const forms = [secret, JSON.stringify(secret).slice(1, -1)];
    try { forms.push(encodeURIComponent(secret)); } catch { /* 非完整 Unicode 仍按原值脱敏 */ }
    return forms;
  }))].sort((a, b) => b.length - a.length);
  const redactText = (text: string): string => {
    for (const secret of replacements) text = text.split(secret).join("[REDACTED]");
    return text.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]");
  };
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") {
      // 有些接口把对象放在 JSON 字符串中；保持字符串类型同时清除其中的凭据字段。
      if (/^\s*[\[{]/.test(v)) {
        try {
          const parsed = parseJsonPreservingNumbers(v);
          const cleaned = JSON.stringify(visit(parsed));
          // 无需脱敏时保留原文，避免改写订单号等大整数以及用户的文本格式。
          if (cleaned !== JSON.stringify(parsed)) return cleaned;
        } catch { /* 普通业务文本 */ }
      }
      return redactText(v);
    }
    // rawJSON 是本次解析产生的数字原文，不作为普通对象遍历。
    if (sourceJson.isRawJSON(v)) return v;
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v)
        .filter(([key, entry]) => (
          (key === "token_set" || key === "password_configured") && typeof entry === "boolean"
        ) || !CREDENTIAL_FIELD.test(key.toLowerCase().replace(/[^a-z0-9]/g, "")))
        .map(([key, entry]) => [redactText(key), visit(entry)]));
    }
    return v;
  };
  return visit(value);
}

/** 递归丢弃空值：null/undefined/""/[]/{}；0/false 是业务值，保留 */
export function prune(v: unknown): unknown {
  if (Array.isArray(v)) {
    const a = v.map(prune).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const p = prune(val);
      if (p !== undefined) o[k] = p;
    }
    return Object.keys(o).length ? o : undefined;
  }
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string" && v === "") return undefined;
  return v;
}

/** 金额规整：两位小数，|n|<0.005 视为 0（消除浮点噪声）；非数字原样返回 */
export function roundMoney(n: unknown): unknown {
  if (typeof n !== "number" || !Number.isFinite(n)) return n;
  const r = Math.round(n * 100) / 100;
  return Math.abs(r) < 0.005 ? 0 : r;
}

/** 毫秒时间戳 → YYYY-MM-DD（本地时区）；非法值原样返回 */
export function fmtDate(ms: unknown): unknown {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return ms;
  const d = new Date(ms);
  const p = (x: number): string => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 实体投影表：只保留 AI 分析相关的业务字段（服务端同步/UI 字段一律丢弃） */
const PROJECTIONS: Record<string, string[]> = {
  Bill: ["billId", "cost", "time", "parentCategoryId", "childCategoryId", "remark", "assetId", "bookId", "tags", "reimbursement"],
  Asset: ["assetId", "assetName", "assetNumber", "assetType", "groupName", "intoTotalAsset"],
  ParentCategory: ["categoryId", "categoryName", "categoryType"],
  ChildCategory: ["categoryId", "categoryName", "parentCategoryId", "categoryType"],
  Transfer: ["transferId", "cost", "serviceCharge", "time", "fromAssetId", "toAssetId", "toCost", "billId", "remark"],
  Lend: ["lendId", "type", "number", "interest", "outTime", "inTime", "assetId", "repaymentAssetId", "remark"],
  Refund: ["refundId", "billId", "refundNum"],
  BillFile: ["fileId", "billId", "fileName", "fileSize"],
  AssetHistory: ["assetHistoryId", "assetId", "time", "currentNum", "changeNum", "changeContent"],
  Tag: ["tagId", "tagName"],
  AccountBook: ["accountBookId", "bookName", "bookType"],
};

const MONEY_FIELDS: Record<string, true> = {
  cost: true,
  serviceCharge: true,
  toCost: true,
  number: true,
  interest: true,
  refundNum: true,
  assetNumber: true,
  currentNum: true,
  changeNum: true,
};
const DATE_FIELDS: Record<string, true> = { time: true, outTime: true, inTime: true };

/** 实体投影：保留业务字段并规整数值/日期；未知实体仅做空值裁剪 */
export function projectEntity(type: string, obj: Record<string, unknown>): unknown {
  if (!obj || typeof obj !== "object") return obj;
  const keys = PROJECTIONS[type];
  if (!keys) return prune(obj);
  const o: Record<string, unknown> = {};
  for (const k of keys) {
    let val = obj[k];
    if (val === undefined) continue;
    if (MONEY_FIELDS[k]) val = roundMoney(val);
    if (DATE_FIELDS[k]) val = fmtDate(val);
    if (k === "tags" && (val === "[]" || val === "" || (Array.isArray(val) && val.length === 0))) continue;
    o[k] = val;
  }
  return prune(o);
}

/** 用户对象脱敏：只暴露身份/统计字段；password/微信/QQ token/手机号等永不出现在工具输出 */
export function sanitizeUser(u: Record<string, unknown> | null | undefined): unknown {
  if (!u || typeof u !== "object") return u;
  const o: Record<string, unknown> = {};
  const id = u.userId ?? u.id;
  if (id !== undefined) o.id = id;
  for (const k of ["name", "email", "billCount", "vipType", "vipTime"]) {
    if (u[k] !== undefined) o[k] = u[k];
  }
  return o;
}
