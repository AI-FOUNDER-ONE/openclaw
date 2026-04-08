import { sendToWordBridge, getWordEditRelayStatus } from "./relay-server.js";
import {
  WordEditParams,
  ParagraphEdit,
  FontSettings,
  ParagraphFormat,
  TableData,
  FormatTarget,
  FormatOperation,
} from "./types.js";

const WORD_BRIDGE_HTTP = "https://127.0.0.1:18801";

async function bridgeRequest(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; json: unknown | null }> {
  try {
    const resp = await fetch(`${WORD_BRIDGE_HTTP}${path}`, init);
    let json: unknown | null = null;
    try {
      json = (await resp.json()) as unknown;
    } catch {
      json = null;
    }
    return { ok: resp.ok, json };
  } catch {
    return { ok: false, json: null };
  }
}

/**
 * 三层标准融合：用户偏好 > 模板 > 通用（返回 null 表示本维度无强制目标）。
 * 与任务窗格 `runAuditDocument` 内逻辑保持一致，便于单测与对照。
 */
export function getTargetValue(
  prefKey: string,
  templateStyleProp: string,
  currentStyle: string,
  userPrefs: Record<string, unknown>,
  templateSpec: Record<string, unknown> | null | undefined,
): { value: unknown; source: "user_preference" | "template" | "general_rule" } | null {
  if (userPrefs[prefKey] !== undefined && userPrefs[prefKey] !== null) {
    return { value: userPrefs[prefKey], source: "user_preference" };
  }

  if (templateSpec && typeof templateSpec === "object") {
    const styles = templateSpec.styles as Record<string, Record<string, unknown>> | undefined;
    const styleSpec = styles?.[currentStyle];
    if (styleSpec && styleSpec[templateStyleProp] !== undefined) {
      return { value: styleSpec[templateStyleProp], source: "template" };
    }

    const meta = templateSpec.metadata as Record<string, unknown> | undefined;
    if (templateStyleProp === "fontName" && meta?.mainBodyFont) {
      return { value: meta.mainBodyFont, source: "template" };
    }
    if (templateStyleProp === "fontNameEastAsia" && meta?.mainBodyFontEastAsia) {
      return { value: meta.mainBodyFontEastAsia, source: "template" };
    }
    if (templateStyleProp === "fontSize" && meta?.mainBodySize != null) {
      return { value: meta.mainBodySize, source: "template" };
    }
    if (templateStyleProp === "lineSpacing" && meta?.mainBodyLineSpacing != null) {
      return { value: meta.mainBodyLineSpacing, source: "template" };
    }
  }

  return null;
}

const operationHistory: Array<{ action: string; timestamp: string }> = [];
const TEMPLATE_STORAGE_KEY = "__word_format_templates";

interface FormatTemplate {
  name: string;
  description: string;
  createdAt: string;
  documentName: string;
  styles: Record<
    string,
    {
      fontName?: string;
      fontSize?: number;
      bold?: boolean;
      italic?: boolean;
      alignment?: string;
      lineSpacing?: number;
      lineSpacingRule?: string;
      spaceAfter?: number;
      spaceBefore?: number;
      firstLineIndent?: number;
      leftIndent?: number;
      color?: string;
    }
  >;
  pageSetup?: {
    paperSize?: string;
    topMargin?: number;
    bottomMargin?: number;
    leftMargin?: number;
    rightMargin?: number;
  };
  metadata: {
    totalParagraphs: number;
    headingCount: Record<string, number>;
    mainBodyFont: string;
    mainBodySize: number;
  };
}

let templateStore: Record<string, FormatTemplate> = {};
let templatesLoaded = false;

async function loadTemplatesFromServer() {
  if (templatesLoaded) {return;}
  try {
    const resp = await fetch("https://127.0.0.1:18801/api/templates", {
      headers: { "x-template-storage-key": TEMPLATE_STORAGE_KEY },
    });
    if (resp.ok) {
      const payload = (await resp.json()) as
        | Record<string, FormatTemplate>
        | { templates?: Array<{ name: string }> };
      if (payload && "templates" in payload && Array.isArray(payload.templates)) {
        const merged: Record<string, FormatTemplate> = {};
        for (const item of payload.templates) {
          if (!item?.name) {continue;}
          try {
            const detail = await fetch(
              "https://127.0.0.1:18801/api/templates/" + encodeURIComponent(item.name),
            );
            if (detail.ok) {
              merged[item.name] = (await detail.json()) as FormatTemplate;
            }
          } catch {}
        }
        templateStore = merged;
      } else {
        templateStore = payload as Record<string, FormatTemplate>;
      }
    }
  } catch {}
  templatesLoaded = true;
}

async function saveTemplatesToServer() {
  try {
    await fetch("https://127.0.0.1:18801/api/templates", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-template-storage-key": TEMPLATE_STORAGE_KEY,
      },
      body: JSON.stringify(templateStore),
    });
  } catch (e) {
    console.error("[word_edit] 保存模板失败", e);
  }
}

function loadTemplate(name: string): FormatTemplate | null {
  return templateStore[name] || null;
}

// ========== AgentToolResult 辅助函数 ==========
// 参照 tavily-search-tool.ts 的 jsonResult 写法

function jsonResult(data: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function broadcastResult(action: string, result: any, success: boolean) {
  try {
    const dispatcher = (globalThis as any).__openclaw_dispatch;
    if (typeof dispatcher === "function") {
      dispatcher({
        type: "word_action_result",
        action,
        success,
        summary: success ? `✅ ${action} 执行成功` : `❌ ${action} 执行失败`,
        details: result,
        timestamp: Date.now(),
      });
    }
  } catch (e) {}
}

function buildWordEditParams(rawParams: Record<string, unknown>): WordEditParams {
  const action = rawParams.action as WordEditParams["action"];
  const params: WordEditParams = { action };
  if (rawParams.edits !== undefined) {params.edits = rawParams.edits as ParagraphEdit[];}
  if (rawParams.paragraphIndex !== undefined)
    {params.paragraphIndex = Number(rawParams.paragraphIndex);}
  if (rawParams.font !== undefined) {params.font = rawParams.font as FontSettings;}
  if (rawParams.format !== undefined) {params.format = rawParams.format as ParagraphFormat;}
  if (rawParams.styleName !== undefined) {params.styleName = String(rawParams.styleName);}
  if (rawParams.tableIndex !== undefined) {params.tableIndex = Number(rawParams.tableIndex);}
  if (rawParams.rowIndex !== undefined) {params.rowIndex = Number(rawParams.rowIndex);}
  if (rawParams.colIndex !== undefined) {params.colIndex = Number(rawParams.colIndex);}
  if (rawParams.cellText !== undefined) {params.cellText = String(rawParams.cellText);}
  if (rawParams.tableData !== undefined) {params.tableData = rawParams.tableData as TableData;}
  if (rawParams.text !== undefined) {params.text = String(rawParams.text);}
  if (rawParams.position !== undefined)
    {params.position = rawParams.position as WordEditParams["position"];}
  if (rawParams.target !== undefined) {params.target = rawParams.target as FormatTarget;}
  if (rawParams.operation !== undefined) {params.operation = rawParams.operation as FormatOperation;}
  if (rawParams.steps !== undefined) {params.steps = Number(rawParams.steps);}
  if (rawParams.targetStep !== undefined) {params.targetStep = Number(rawParams.targetStep);}
  if (rawParams.label !== undefined) {params.label = String(rawParams.label);}
  if (rawParams.checks !== undefined) {params.checks = rawParams.checks as string[];}
  if (rawParams.templateName !== undefined) {params.templateName = String(rawParams.templateName);}
  if (rawParams.autoFix !== undefined) {params.autoFix = rawParams.autoFix as boolean;}
  if (rawParams.operation !== undefined)
    {params.operation = rawParams.operation as WordEditParams["operation"];}
  if (rawParams.description !== undefined) {params.description = String(rawParams.description);}
  if (rawParams.items !== undefined) {params.items = rawParams.items as WordEditParams["items"];}
  if (rawParams.indices !== undefined) {params.indices = rawParams.indices as number[];}
  if (rawParams.searchText !== undefined) {params.searchText = rawParams.searchText as string;}
  if (rawParams.replaceText !== undefined) {params.replaceText = rawParams.replaceText as string;}
  if (rawParams.matchCase !== undefined) {params.matchCase = rawParams.matchCase as boolean;}
  if (rawParams.matchWholeWord !== undefined)
    {params.matchWholeWord = rawParams.matchWholeWord as boolean;}
  if (rawParams.maxMatches !== undefined) {params.maxMatches = Number(rawParams.maxMatches);}
  if (rawParams.startIndex !== undefined) {params.startIndex = Number(rawParams.startIndex);}
  if (rawParams.endIndex !== undefined) {params.endIndex = Number(rawParams.endIndex);}
  if (rawParams.hyperlinkTarget !== undefined) {
    params.hyperlinkTarget = rawParams.hyperlinkTarget as WordEditParams["hyperlinkTarget"];
  }
  if (rawParams.clearFormat !== undefined) {params.clearFormat = rawParams.clearFormat as boolean;}
  if (rawParams.values !== undefined) {params.values = rawParams.values as string[][];}
  if (rawParams.rowCount !== undefined) {params.rowCount = Number(rawParams.rowCount);}
  if (rawParams.headerText !== undefined) {params.headerText = String(rawParams.headerText);}
  if (rawParams.footerText !== undefined) {params.footerText = String(rawParams.footerText);}
  if (rawParams.headerAlignment !== undefined) {
    params.headerAlignment = rawParams.headerAlignment as WordEditParams["headerAlignment"];
  }
  if (rawParams.footerAlignment !== undefined) {
    params.footerAlignment = rawParams.footerAlignment as WordEditParams["footerAlignment"];
  }
  if (rawParams.headerFont !== undefined)
    {params.headerFont = rawParams.headerFont as WordEditParams["headerFont"];}
  if (rawParams.footerFont !== undefined)
    {params.footerFont = rawParams.footerFont as WordEditParams["footerFont"];}
  if (rawParams.headerFooterType !== undefined) {
    params.headerFooterType = rawParams.headerFooterType as WordEditParams["headerFooterType"];
  }
  if (rawParams.pageNumber !== undefined) {params.pageNumber = rawParams.pageNumber as boolean;}
  if (rawParams.sectionIndex !== undefined) {params.sectionIndex = Number(rawParams.sectionIndex);}
  if (rawParams.base64 !== undefined) {params.base64 = String(rawParams.base64);}
  if (rawParams.imageUrl !== undefined) {params.imageUrl = String(rawParams.imageUrl);}
  if (rawParams.width !== undefined) {params.width = Number(rawParams.width);}
  if (rawParams.height !== undefined) {params.height = Number(rawParams.height);}
  if (rawParams.altTitle !== undefined) {params.altTitle = String(rawParams.altTitle);}
  if (rawParams.altDescription !== undefined)
    {params.altDescription = String(rawParams.altDescription);}
  if (rawParams.marginTop !== undefined) {params.marginTop = Number(rawParams.marginTop);}
  if (rawParams.marginBottom !== undefined) {params.marginBottom = Number(rawParams.marginBottom);}
  if (rawParams.orientation !== undefined) {
    params.orientation = rawParams.orientation as WordEditParams["orientation"];
  }
  if (rawParams.mode !== undefined) {params.mode = rawParams.mode as WordEditParams["mode"];}
  if (rawParams.title !== undefined) {params.title = String(rawParams.title);}
  if (rawParams.subject !== undefined) {params.subject = String(rawParams.subject);}
  if (rawParams.author !== undefined) {params.author = String(rawParams.author);}
  if (rawParams.company !== undefined) {params.company = String(rawParams.company);}
  if (rawParams.manager !== undefined) {params.manager = String(rawParams.manager);}
  if (rawParams.keywords !== undefined) {params.keywords = String(rawParams.keywords);}
  if (rawParams.comments !== undefined) {params.comments = String(rawParams.comments);}
  if (rawParams.category !== undefined) {params.category = String(rawParams.category);}
  if (rawParams.customProperties !== undefined) {
    params.customProperties = rawParams.customProperties as Record<string, string>;
  }
  if (rawParams.ccAction !== undefined)
    {params.ccAction = rawParams.ccAction as WordEditParams["ccAction"];}
  if (rawParams.tag !== undefined) {params.tag = String(rawParams.tag);}
  if (rawParams.placeholderText !== undefined)
    {params.placeholderText = String(rawParams.placeholderText);}
  if (rawParams.appearance !== undefined) {
    params.appearance = rawParams.appearance as WordEditParams["appearance"];
  }
  if (rawParams.color !== undefined) {params.color = String(rawParams.color);}
  if (rawParams.cannotEdit !== undefined) {params.cannotEdit = rawParams.cannotEdit as boolean;}
  if (rawParams.cannotDelete !== undefined) {params.cannotDelete = rawParams.cannotDelete as boolean;}
  if (rawParams.preferenceKey !== undefined) {params.preferenceKey = String(rawParams.preferenceKey);}
  if (rawParams.preferenceValue !== undefined) {
    const v = rawParams.preferenceValue;
    if (typeof v === "number" && Number.isFinite(v)) {params.preferenceValue = v;}
    else if (typeof v === "string") {params.preferenceValue = v;}
    else {params.preferenceValue = String(v);}
  }
  if (rawParams.preferenceContext !== undefined) {
    params.preferenceContext = String(rawParams.preferenceContext);
  }
  if (params.action === "set_preference") {
    if (!params.preferenceKey && rawParams.key !== undefined) {
      params.preferenceKey = String(rawParams.key);
    }
    if (params.preferenceValue === undefined && rawParams.value !== undefined) {
      const v = rawParams.value;
      if (typeof v === "number" && Number.isFinite(v)) {params.preferenceValue = v;}
      else if (typeof v === "string") {params.preferenceValue = v;}
      else {params.preferenceValue = String(v);}
    }
    if (!params.preferenceContext && rawParams.context !== undefined) {
      params.preferenceContext = String(rawParams.context);
    }
  }
  return params;
}

// ========== word_edit 工具执行函数 ==========

export async function executeWordEdit(_toolCallId: string, rawParams: Record<string, unknown>) {
  const params = buildWordEditParams(rawParams);

  // 输入校验
  if (params.action === "edit_paragraphs") {
    if (!params.edits || params.edits.length === 0) {
      return jsonResult({ success: false, action: params.action, error: "缺少 edits 参数" });
    }
    params.edits = params.edits.filter(
      (e: ParagraphEdit) => e.replaceText && e.replaceText.trim() !== "",
    );
    if (params.edits.length === 0) {
      return jsonResult({ success: false, action: params.action, error: "替换内容不能为空" });
    }
    if (params.edits.length > 10) {
      params.edits = params.edits.slice(0, 10);
    }
  }

  if (params.action === "replace_selection") {
    if (params.text === undefined || params.text === null) {
      return jsonResult({ success: false, action: params.action, error: "缺少 text 参数" });
    }
  }

  if (params.action === "set_preference") {
    const key = params.preferenceKey?.trim();
    const value = params.preferenceValue;
    const context = params.preferenceContext;
    if (!key || value === undefined) {
      return jsonResult({
        success: false,
        action: "set_preference",
        error: "缺少 preferenceKey（或 key）与 preferenceValue（或 value）",
      });
    }
    const { ok, json } = await bridgeRequest("/api/preferences/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value, context }),
    });
    if (!ok) {
      return jsonResult({
        success: false,
        action: "set_preference",
        error: "无法写入偏好（请确认 Word Bridge HTTPS 服务已在 127.0.0.1:18801 运行）",
        details: json,
      });
    }
    const out = {
      success: true,
      action: "set_preference",
      message: `已记住您的偏好：${key} = ${JSON.stringify(value)}`,
      hint: "后续 audit_document 会优先应用此偏好",
    };
    broadcastResult("set_preference", out, true);
    return jsonResult(out);
  }

  if (params.action === "audit_document") {
    const checks = params.checks && params.checks.length > 0 ? params.checks : ["all"];
    const prefsRes = await bridgeRequest("/api/preferences");
    const prefsPayload = prefsRes.ok
      ? (prefsRes.json as {
          preferences?: Array<{ key: string; value: unknown }>;
          summary?: string;
          skipCategories?: string[];
        } | null)
      : null;

    const userPrefs: Record<string, unknown> = {};
    for (const pref of prefsPayload?.preferences ?? []) {
      if (pref?.key) {userPrefs[pref.key] = pref.value;}
    }
    const preferenceSummary = prefsPayload?.summary ?? "";
    const skipCategories = prefsPayload?.skipCategories ?? [];

    let templateName = params.templateName?.trim() || null;
    let templateSpec: unknown = null;
    let templateAutoMatched = false;

    const relay = getWordEditRelayStatus();
    if (!templateName && relay.bridgeConnected) {
      const outlineRes = await sendToWordBridge({ action: "get_heading_outline" } as WordEditParams);
      const headings = outlineRes.data?.headings;
      if (Array.isArray(headings) && headings.length > 0) {
        const matchRes = await bridgeRequest("/api/templates/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentHeadings: headings }),
        });
        const matchPayload = matchRes.ok
          ? (matchRes.json as { match?: { templateName: string; similarity: number } | null } | null)
          : null;
        const match = matchPayload?.match;
        if (match && match.similarity >= 40) {
          templateName = match.templateName;
          templateAutoMatched = true;
        }
      }
    }
    if (templateName) {
      const specRes = await bridgeRequest("/api/templates/" + encodeURIComponent(templateName));
      if (specRes.ok && specRes.json && typeof specRes.json === "object") {
        templateSpec = specRes.json;
      }
    }

    const bridgeResult = await sendToWordBridge({
      ...params,
      checks,
      autoFix: params.autoFix === true,
      templateName: templateName || undefined,
      auditContext: {
        userPrefs,
        templateSpec,
        preferenceSummary,
        skipCategories,
        templateAutoMatched,
        effectiveTemplateName: templateName,
      },
    } as WordEditParams);
    broadcastResult("audit_document", bridgeResult,  bridgeResult.success);
    return jsonResult(bridgeResult);
  }

  if (params.action === "manage_template") {
    await loadTemplatesFromServer();
    const operation = params.operation;
    if (!operation) {
      return jsonResult({ success: false, action: "manage_template", error: "缺少 operation 参数" });
    }
    switch (operation) {
      case "scan":
      case "compare":
      case "save":
      case "list":
      case "show":
      case "apply":
      case "delete": {
        const localTemplate = params.templateName ? loadTemplate(params.templateName) : null;
        const bridgeResult = await sendToWordBridge(params);
        if (operation === "delete" && params.templateName && localTemplate) {
          delete templateStore[params.templateName];
          await saveTemplatesToServer();
        }
        broadcastResult("manage_template", bridgeResult,  bridgeResult.success);
        return jsonResult(bridgeResult);
      }
      default:
        return jsonResult({
          success: false,
          action: "manage_template",
          error: `不支持的 operation: ${String(operation)}`,
        });
    }
  }

  if (params.action === "create_checkpoint") {
    const label = params.label || "unnamed";
    const timestamp = new Date().toISOString();
    const readRes = await sendToWordBridge({ action: "read_structure" } as WordEditParams);
    const paragraphs = (readRes.data && Array.isArray(readRes.data.paragraphs) && readRes.data.paragraphs) || [];
    const snapshot = {
      label,
      timestamp,
      paragraphCount: paragraphs.length,
      undoStackSize: operationHistory.length,
    };
    const g = globalThis as any;
    if (!Array.isArray(g.__wordCheckpoints)) {g.__wordCheckpoints = [];}
    g.__wordCheckpoints.push(snapshot);
    if (g.__wordCheckpoints.length > 10) {g.__wordCheckpoints.shift();}
    const checkpointResult = {
      success: true,
      action: "create_checkpoint",
      checkpoint: snapshot,
      message: `检查点 "${label}" 已创建。段落数: ${snapshot.paragraphCount}, Undo 栈深度: ${snapshot.undoStackSize}`,
    };
    broadcastResult("create_checkpoint", snapshot, true);
    return jsonResult(checkpointResult);
  }

  if (params.action === "get_status") {
    const relay = getWordEditRelayStatus();
    if (!relay.bridgeConnected) {
      return jsonResult({
        success: false,
        action: "get_status",
        error:
          "Word Bridge 未连接。任务窗格需连上 " +
          relay.relayWssUrl +
          "；中继" +
          (relay.relayListening ? "已在监听" : "未启动（检查网关日志与 word-edit 插件）"),
        data: {
          relayListening: relay.relayListening,
          bridgeConnected: relay.bridgeConnected,
          relayWssUrl: relay.relayWssUrl,
          checklist: [
            "openclaw.json → plugins.entries.word-edit.enabled = true",
            "本机网关进程已启动（与执行 word_edit 的为同一台机器）",
            "Word 中打开 OpenClaw / Word Bridge 加载项并显示任务窗格，直至「桥接」指示为已连接",
            "网关重启后 Word 侧会自动重连；若仍红点多等几秒或重新打开任务窗格",
            "若任务窗格持续报 WebSocket 错误：多为本机 wss 自签证书被宿主拦截，需在同一用户环境下调试",
          ],
        },
      });
    }
  }

  const result = await sendToWordBridge(params);
  operationHistory.push({ action: params.action, timestamp: new Date().toISOString() });
  if (operationHistory.length > 200) {
    operationHistory.shift();
  }
  broadcastResult(params.action, result,  result.success);
  return jsonResult(result);
}

// ========== 工具 JSON Schema（传给 LLM） ==========
// 推荐用 TypeBox 生成，下面用普通对象也能工作

export const WordEditToolSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "read_structure",
        "read_full_structure",
        "read_page_setup",
        "read_paragraph_detail",
        "read_headers_footers",
        "read_images",
        "read_document_properties",
        "read_tracked_changes",
        "read_selection",
        "replace_selection",
        "format_selection",
        "set_preference",
        "audit_document",
        "manage_template",
        "edit_paragraphs",
        "get_status",
        "set_font",
        "set_paragraph_format",
        "apply_style",
        "apply_format",
        "clear_highlights",
        "read_tables",
        "edit_table_cell",
        "insert_table",
        "insert_paragraph",
        "insert_paragraphs_batch",
        "insert_page_break",
        "insert_comment",
        "read_comments",
        "save_document",
        "undo_last",
        "multi_undo",
        "undo_to_step",
        "create_checkpoint",
        "get_history",
        "delete_paragraphs",
        "delete_text",
        "delete_range",
        "read_hyperlinks",
        "remove_hyperlinks",
        "add_table_row",
        "insert_toc",
        "set_header_footer",
        "insert_image",
        "set_page_setup",
        "track_changes",
        "set_properties",
        "content_control",
      ],
      description: "操作类型",
    },
    edits: {
      type: "array",
      description: "段落编辑列表（action=edit_paragraphs 时必填）",
      items: {
        type: "object",
        properties: {
          searchText: { type: "string", description: "要查找的原文（必须精确匹配）" },
          replaceText: {
            type: "string",
            description:
              "替换后的文字。注意：newText 不应以 \\n 或 \\r\\n 结尾，这会导致产生多余的空段落。如果需要在段落后插入新段落，请使用 insert_paragraph action。",
          },
        },
        required: ["searchText", "replaceText"],
      },
    },
    checks: {
      type: "array",
      items: { type: "string" },
      description:
        "audit_document 检查项列表。可选值：heading_hierarchy, empty_paragraphs, format_consistency, spacing, font_consistency, indent, toc_match, header_footer, page_break, all（默认 all）",
    },
    templateName: {
      type: "string",
      description: "audit_document/manage_template 的模板名称（如：投标书模板）",
    },
    autoFix: {
      type: "boolean",
      description: "audit_document 是否自动修复可修复问题（默认 false）",
    },
    preferenceKey: {
      type: "string",
      description:
        "set_preference：偏好键（如 body.font、body.fontCN、body.fontSize、body.lineSpacing、body.firstLineIndent、h1.fontCN）",
    },
    preferenceValue: {
      type: ["string", "number"],
      description: "set_preference：偏好值",
    },
    preferenceContext: {
      type: "string",
      description: "set_preference：用户原话或场景，可选",
    },
    paragraphIndex: {
      type: "number",
      description: "目标段落索引（从 read_structure 获取）",
    },
    font: {
      type: "object",
      properties: {
        name: { type: "string" },
        size: { type: "number" },
        bold: { type: "boolean" },
        italic: { type: "boolean" },
        color: { type: "string" },
        highlightColor: { type: "string" },
      },
      description: "字体设置（action=set_font 时用）",
    },
    format: {
      type: "object",
      properties: {
        alignment: { type: "string", enum: ["Left", "Center", "Right", "Justified"] },
        lineSpacing: {
          type: "number",
          description:
            "行距数值：配合 lineSpacingRule；2 倍行距用 Multiple+2。仅写数字不传规则时，0.5–5 按倍数、更大按固定磅推断",
        },
        lineSpacingRule: {
          type: "string",
          enum: ["Multiple", "Exactly", "AtLeast", "Auto"],
          description:
            "必配合 lineSpacing：Multiple=倍数（2=双倍）；Exactly/AtLeast=磅。双倍行距推荐 Multiple+2",
        },
        firstLineIndent: {
          type: "number",
          description: "首行缩进，单位磅(pt)；非字符数。中文约两格≈2×正文字号（如 12pt 字常用 24）",
        },
        spaceBefore: { type: "number" },
        spaceAfter: { type: "number" },
        leftIndent: { type: "number", description: "左缩进（磅）" },
        rightIndent: { type: "number", description: "右缩进（磅）" },
      },
      description:
        "段落格式（set_paragraph_format / format_selection / apply_format.operation.format 时用）",
    },
    styleName: {
      type: "string",
      description:
        "Word 样式名称（apply_style / format_selection 时用；format_selection 可与 font、format 同传）",
    },
    tableIndex: {
      type: "number",
      description: "表格索引（action=edit_table_cell/insert_table 时用）",
    },
    rowIndex: { type: "number", description: "行索引" },
    colIndex: { type: "number", description: "列索引" },
    cellText: {
      type: "string",
      description: "单元格新文本（action=edit_table_cell 时用）",
    },
    tableData: {
      type: "object",
      properties: {
        rows: { type: "number" },
        cols: { type: "number" },
        values: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
        },
      },
      description: "新表格数据（action=insert_table 时用）",
    },
    text: {
      type: "string",
      description:
        "文本：insert_paragraph / insert_comment / replace_selection（替换选区为新内容，可为空字符串）",
    },
    items: {
      type: "array",
      description:
        "批量插入段落列表（action=insert_paragraphs_batch 时用）。自动从后往前插入防止索引漂移。每个 text 支持 \\n 换行，每行自动成为独立段落。",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "段落文本（支持 \\n 换行）" },
          index: { type: "number", description: "参考段落索引（从 read_structure 获取）" },
          position: {
            type: "string",
            enum: ["Before", "After"],
            description: "插入位置（默认 After）",
          },
          style: { type: "string", description: "Word 样式名（如 Heading 1, Normal）" },
        },
        required: ["text"],
      },
    },
    position: {
      type: "string",
      enum: ["Before", "After"],
      description: "插入位置（默认 After）",
    },
    target: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["all", "paragraph", "range", "search", "selection"],
          description: "作用范围：selection=当前用户选区（须先在 Word 中选中文本）；其余同前",
        },
        index: { type: "number", description: "段落索引（type=paragraph 时用）" },
        start: { type: "number", description: "起始段落索引（type=range 时用，含）" },
        end: { type: "number", description: "结束段落索引（type=range 时用，含）" },
        text: { type: "string", description: "搜索文本（type=search 时用）" },
      },
      required: ["type"],
      description: "格式操作的作用范围（action=apply_format 时必填）",
    },
    operation: {
      type: ["object", "string"],
      properties: {
        font: {
          type: "object",
          properties: {
            name: { type: "string" },
            size: { type: "number" },
            bold: { type: "boolean" },
            italic: { type: "boolean" },
            color: { type: "string" },
            highlightColor: {
              type: ["string", "null"],
              description: "高亮颜色，null 表示清除",
            },
            underline: { type: "boolean" },
            strikethrough: { type: "boolean" },
          },
          description: "字体设置",
        },
        format: {
          type: "object",
          properties: {
            alignment: { type: "string", enum: ["Left", "Center", "Right", "Justified"] },
            lineSpacing: {
              type: "number",
              description:
                "行距：2 倍须 lineSpacingRule=Multiple 且 lineSpacing=2；勿只写 2（旧行为易被当成磅值无效）",
            },
            lineSpacingRule: {
              type: "string",
              enum: ["Multiple", "Exactly", "AtLeast", "Auto"],
              description: "与 Word paragraphFormat 一致；双倍行距用 Multiple",
            },
            firstLineIndent: {
              type: "number",
              description:
                "首行缩进，单位磅(pt)；非字符数。中文约两格≈2×正文字号（如 12pt 字常用 24）",
            },
            spaceBefore: { type: "number" },
            spaceAfter: { type: "number" },
            leftIndent: { type: "number" },
            rightIndent: { type: "number" },
          },
          description: "段落格式",
        },
        style: { type: "string", description: "Word 样式名（如 Heading 1, Normal）" },
      },
      description:
        "apply_format 时传对象格式操作；manage_template 时可传字符串 save|list|show|apply|delete|scan|compare",
    },
    steps: {
      type: "number",
      description: "连续撤销步数（action=multi_undo 时用，默认 1，最多 20）",
    },
    targetStep: {
      type: "number",
      description:
        "回退到第几步（0=初始状态）。先用 get_history 查看操作历史确定步数（action=undo_to_step 时用）",
    },
    label: {
      type: "string",
      description:
        '检查点标签（action=create_checkpoint 时必填）。例如："TOC更新前"、"批量替换前"',
    },
    indices: {
      type: "array",
      items: { type: "number" },
      description:
        "段落索引列表：delete_paragraphs 时必填（从后往前删）；read_paragraph_detail 时指定要读取完整原文的段落（与 read_structure 的 [0],[1]… 一致）。未传 indices 时 read_paragraph_detail 默认读取正文前最多 50 段。",
    },
    searchText: {
      type: "string",
      description: "要搜索的文本（action=delete_text 时用）。精确匹配。",
    },
    replaceText: {
      type: "string",
      description: '替换文本（action=delete_text 时用）。为空字符串""则删除匹配文本，有值则替换。',
    },
    matchCase: {
      type: "boolean",
      description: "是否区分大小写（action=delete_text 时用，默认 true）",
    },
    matchWholeWord: {
      type: "boolean",
      description: "是否全词匹配（action=delete_text 时用，默认 false）",
    },
    maxMatches: {
      type: "number",
      description: "最多处理几处匹配（action=delete_text 时用，0=全部，默认 0）",
    },
    startIndex: {
      type: "number",
      description: "起始段落索引（action=delete_range 时用）",
    },
    endIndex: {
      type: "number",
      description: "结束段落索引（action=delete_range 时用，含此段落）",
    },
    hyperlinkTarget: {
      type: "string",
      enum: ["all", "paragraph", "search"],
      description: "remove_hyperlinks 作用范围（勿与 apply_format 的 target 对象混用；默认 all）",
    },
    clearFormat: {
      type: "boolean",
      description: "清除超链接时同时清除蓝色下划线格式（remove_hyperlinks，默认 true）",
    },
    values: {
      type: "array",
      items: { type: "array", items: { type: "string" } },
      description: "表格行数据（add_table_row 用）",
    },
    rowCount: { type: "number", description: "添加空行数（add_table_row，默认 1）" },
    headerText: { type: "string", description: "页眉文字（set_header_footer）" },
    footerText: { type: "string", description: "页脚文字（set_header_footer）" },
    headerAlignment: {
      type: "string",
      enum: ["Left", "Center", "Right"],
      description: "页眉对齐",
    },
    footerAlignment: {
      type: "string",
      enum: ["Left", "Center", "Right"],
      description: "页脚对齐",
    },
    headerFont: {
      type: "object",
      properties: {
        name: { type: "string" },
        size: { type: "number" },
        bold: { type: "boolean" },
      },
      description: "页眉字体",
    },
    footerFont: {
      type: "object",
      properties: {
        name: { type: "string" },
        size: { type: "number" },
      },
      description: "页脚字体",
    },
    headerFooterType: {
      type: "string",
      enum: ["Primary", "FirstPage", "EvenPages"],
      description: "页眉页脚类型（默认 Primary）",
    },
    pageNumber: { type: "boolean", description: "是否在页脚插入页码（set_header_footer）" },
    sectionIndex: {
      type: "number",
      description: "节索引（set_header_footer / set_page_setup，默认 0）",
    },
    base64: { type: "string", description: "Base64 图片（insert_image）" },
    imageUrl: { type: "string", description: "图片 URL（insert_image，当前不支持）" },
    width: { type: "number", description: "图片宽度（insert_image）" },
    height: { type: "number", description: "图片高度（insert_image）" },
    altTitle: { type: "string", description: "图片替代标题（insert_image）" },
    altDescription: { type: "string", description: "图片替代描述（insert_image）" },
    marginTop: { type: "number", description: "上边距 pt（set_page_setup）" },
    marginBottom: { type: "number", description: "下边距 pt（set_page_setup）" },
    orientation: {
      type: "string",
      enum: ["Portrait", "Landscape"],
      description: "纸张方向（set_page_setup，部分环境仅提示）",
    },
    mode: {
      type: "string",
      enum: ["on", "off", "toggle"],
      description: "修订模式（track_changes）",
    },
    title: { type: "string", description: "文档标题（set_properties）" },
    subject: { type: "string", description: "文档主题（set_properties）" },
    author: { type: "string", description: "作者（set_properties）" },
    company: { type: "string", description: "公司（set_properties）" },
    manager: { type: "string", description: "经理（set_properties）" },
    keywords: { type: "string", description: "关键词（set_properties）" },
    comments: { type: "string", description: "备注（set_properties）" },
    category: { type: "string", description: "类别（set_properties）" },
    customProperties: { type: "object", description: "自定义属性键值（set_properties）" },
    ccAction: {
      type: "string",
      enum: ["insert", "list", "delete"],
      description: "内容控件操作（content_control）",
    },
    tag: { type: "string", description: "内容控件标签（content_control）" },
    placeholderText: { type: "string", description: "内容控件占位文字" },
    appearance: {
      type: "string",
      enum: ["BoundingBox", "Tags", "Hidden"],
      description: "内容控件外观",
    },
    color: { type: "string", description: "内容控件颜色" },
    cannotEdit: { type: "boolean", description: "内容控件锁定编辑" },
    cannotDelete: { type: "boolean", description: "内容控件锁定删除" },
  },
  required: ["action"],
};

export const WORD_EDIT_DESCRIPTION = `操作已打开的 Word 文档。action 与含义（共 48 种）：

1. read_structure — 轻量段落结构摘要；用于快速定位 paragraphIndex（每段文本仅预览约前 80 字，不可直接当 searchText）
2. read_paragraph_detail — 读取指定段落完整文本（不截断）。参数 indices=[0,5,6,7]；未传 indices 时默认读取正文前最多 50 段。与 read_structure 不同：后者截断，本 action 返回完整原文。
3. read_full_structure — 完整段落格式细节
4. read_page_setup — 页面相关 + 文档属性（依宿主 API）
5. read_headers_footers — 各节页眉页脚文本
6. read_images — 正文嵌入式图片信息
7. read_document_properties — 文档属性
8. read_tracked_changes — 修订记录（WordApi 1.6+）
9. set_preference — 记录用户明确格式偏好（preferenceKey / preferenceValue / preferenceContext）；后续 audit_document 优先套用
10. audit_document — 自动审视文档结构与排版并输出问题报告（可 autoFix）；会加载已学习偏好并可在未指定模板时按标题自动匹配模板库
11. manage_template — 模板保存/查看/应用/删除
12. edit_paragraphs — 批量替换；edits 内 searchText→replaceText；单次最多 10 条
13. get_status — Bridge 与文档状态摘要
14. set_font —（兼容）paragraphIndex + font
15. set_paragraph_format —（兼容）paragraphIndex + format
16. apply_style —（兼容）paragraphIndex + styleName
17. read_tables — 全部表格结构与预览
18. edit_table_cell — tableIndex + rowIndex + colIndex + cellText
19. insert_table — paragraphIndex + tableData
20. insert_paragraph — paragraphIndex + text + position；支持 \\n 多行；可选 styleName
21. insert_paragraphs_batch — items=[{text, index?, position?, style?}]；从后往前插入
22. insert_page_break — 指定段落后分页
23. insert_comment — paragraphIndex + text
24. read_comments — 读取批注
25. save_document — 保存
26. undo_last — 原生撤销一步
27. apply_format — target + operation 通用格式；target 可含 type:selection（当前选区）。多倍行距传 UI 倍数 1.5/2 + lineSpacingRule=Multiple（Bridge 自动×12 写入 OM）
28. clear_highlights — 清除全文高亮
29. multi_undo — steps 连续撤销
30. get_history — 会话操作历史
31. create_checkpoint — 批量修改前创建会话检查点（label 必填）
32. undo_to_step — 回退到 targetStep
33. delete_paragraphs — indices 按索引删段；全部索引无效时 success=false
34. delete_text — searchText + replaceText（空=删）+ matchCase/matchWholeWord/maxMatches
35. delete_range — startIndex..endIndex 连续删段
36. read_hyperlinks — 列出正文段落中带超链接的项（依宿主 API）
37. remove_hyperlinks — hyperlinkTarget: all|paragraph|search；段内多链用 getHyperlinkRanges+hyperlink.delete()；可选 clearFormat
38. add_table_row — tableIndex + values[][] 或 rowCount
39. insert_toc — paragraphIndex 附近插入目录占位/TOC 域（依宿主能力）
40. set_header_footer — sectionIndex + headerText/footerText + headerFooterType + 对齐/字体 + pageNumber
41. insert_image — base64 + paragraphIndex；不支持 imageUrl
42. set_page_setup — sectionIndex + marginTop/marginBottom（磅）；orientation 可能仅提示
43. track_changes — mode on|off|toggle（WordApi 1.6+）
44. set_properties — title/subject/author 等 + customProperties
45. content_control — ccAction insert|list|delete；insert 用 paragraphIndex/tag/title 等
46. read_selection — 读取当前选中文本与格式；无参数；用户须先在 Word 中选中内容
47. replace_selection — text=新内容，替换选区（保留原字符样式基底）；可选 font
48. format_selection — 对选区设格式不改字；font / format / styleName 可组合

选区操作：用户说「优化这段话」「翻译选中」「加粗选中」时须先 read_selection；改格式→format_selection；改内容→LLM 后 replace_selection；apply_format 也可用 target:{type:'selection'}。

⚠️ 选区流程：1) Word 中选中 2) read_selection 3) 按意图 format_selection 或 replace_selection 4) 简要回复结果

删除策略：不连续段落→delete_paragraphs | 连续多段→delete_range | 词语句子→delete_text(replaceText='') | 全文替换→delete_text(replaceText 有值)
超链接：清除手型链接→remove_hyperlinks(hyperlinkTarget='all') | 读取→read_hyperlinks
插入：单段 insert_paragraph | 多段 insert_paragraphs_batch | 目录 insert_toc
所有修改类操作可通过 undo_last / undo_to_step 撤销

信息读取策略：read_structure / read_paragraph_detail / read_selection（选区） / read_full_structure / read_tables / read_headers_footers / read_page_setup / read_document_properties / read_images / read_tracked_changes 按需调用。
工具返回若含「未知 action」→ 更新 taskpane、清缓存、完全退出 Word。undo_* 失败可建议 Cmd+Z/Ctrl+Z。
重要：格式优先 apply_format；edit_paragraphs 须精确匹配原文。

⚠️ 重要工作流程约束：
- 修改前：先用 read_paragraph_detail 获取目标段落的完整文本，再用完整文本作为 searchText（勿用 read_structure 截断预览当 searchText）。
- 修改后：必须再次 read_paragraph_detail 或 read_structure 验证修改是否生效。
- 若 edit_paragraphs 返回 success:false 或 changeCount:0，说明 searchText 未匹配，不要告诉用户「已完成」。
- read_structure 的文本是截断的（约前 80 字），不能直接用作 searchText。

【避免「Agent 报成功但 Word 未变」— 务必读返回 JSON】
- apply_format：若 data.warnings 非空，表示样式/高亮/对齐等有段落未生效；勿对用户宣称全部完成。多倍行距：JSON 里写 1.5/2 即可，由 Bridge 换算为 Word 内部值。
- clear_highlights：比对 data.clearedParagraphs 与 data.bodyParagraphCount；小于总数时表格内/页眉脚高亮可能仍在。
- edit_paragraphs：success=false 或 changeCount=0 表示未写入任何替换；须 read_paragraph_detail 取全文核对 searchText，勿宣称成功。
- insert_paragraphs_batch：success=false 且 insertedParagraphs=0 表示未插入。
- insert_toc：占位模式带 data.note 与 data.warnings；页码域失败见 set_header_footer 的 changelog。
- track_changes：不支持则 success=false。
- set_header_footer / set_page_setup / set_properties：changelog 中含 ⚠️ 时同步有 data.warnings。
- delete_paragraphs：0 段删除时 success=false。
- set_font：高亮失败时可能 success=true 但带 data.warnings（其余字体仍可能已应用）。
- edit_table_cell：行列越界 success=false。
- 表格内段落不在 body.paragraphs 的「全文」枚举里时，apply_format target=all 可能改不到表内；需按表单独处理。
加载项清单要求 WordApi 1.5+；过旧 Word 可能整类格式不生效。`;
