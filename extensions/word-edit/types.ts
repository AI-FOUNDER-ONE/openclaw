// ========== Word Edit 工具参数 ==========

export interface FontSettings {
  name?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  highlightColor?: string;
}

export interface ParagraphFormat {
  alignment?: "Left" | "Center" | "Right" | "Justified";
  /** 与 lineSpacingRule 配合；2 倍行距常见为 lineSpacingRule=Multiple + lineSpacing=2 */
  lineSpacing?: number;
  /** Multiple=倍数；Exactly/AtLeast=磅；不传时由脚本按数值推断（约 0.5–5 视为倍数） */
  lineSpacingRule?: "Multiple" | "Exactly" | "AtLeast" | "Auto";
  firstLineIndent?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  leftIndent?: number;
  rightIndent?: number;
}

export interface TableData {
  rows: number;
  cols: number;
  values?: string[][];
}

// ========== apply_format 通用格式操作 ==========

export interface FormatTarget {
  type: "all" | "paragraph" | "range" | "search" | "selection";
  index?: number; // type='paragraph' 时，段落索引
  start?: number; // type='range' 时，起始段落索引（含）
  end?: number; // type='range' 时，结束段落索引（含）
  text?: string; // type='search' 时，搜索文本
}

export interface FormatOperation {
  font?: {
    name?: string;
    size?: number;
    bold?: boolean;
    italic?: boolean;
    color?: string;
    highlightColor?: string | null; // null 表示清除高亮
    underline?: boolean;
    strikethrough?: boolean;
  };
  format?: {
    alignment?: "Left" | "Center" | "Right" | "Justified";
    lineSpacing?: number;
    lineSpacingRule?: "Multiple" | "Exactly" | "AtLeast" | "Auto";
    firstLineIndent?: number;
    spaceBefore?: number;
    spaceAfter?: number;
  };
  style?: string; // Word 内置样式名，如 'Heading 1', 'Normal'
}

export type WordEditAction =
  | "read_structure"
  | "read_full_structure"
  | "read_page_setup"
  | "read_paragraph_detail"
  | "read_headers_footers"
  | "read_images"
  | "read_document_properties"
  | "read_tracked_changes"
  | "read_selection"
  | "replace_selection"
  | "format_selection"
  | "audit_document"
  | "get_heading_outline"
  | "set_preference"
  | "manage_template"
  | "edit_paragraphs"
  | "get_status"
  | "set_font"
  | "set_paragraph_format"
  | "apply_style"
  | "apply_format"
  | "clear_highlights"
  | "read_tables"
  | "edit_table_cell"
  | "insert_table"
  | "insert_paragraph"
  | "insert_paragraphs_batch"
  | "insert_page_break"
  | "insert_comment"
  | "read_comments"
  | "save_document"
  | "undo_last"
  | "multi_undo"
  | "undo_to_step"
  | "create_checkpoint"
  | "get_history"
  | "delete_paragraphs"
  | "delete_text"
  | "delete_range"
  | "read_hyperlinks"
  | "remove_hyperlinks"
  | "add_table_row"
  | "insert_toc"
  | "set_header_footer"
  | "insert_image"
  | "set_page_setup"
  | "track_changes"
  | "set_properties"
  | "content_control";

export interface WordEditParams {
  action: WordEditAction;
  edits?: ParagraphEdit[];
  paragraphIndex?: number;
  font?: FontSettings;
  format?: ParagraphFormat;
  styleName?: string;
  target?: FormatTarget;
  operation?: FormatOperation | "save" | "list" | "show" | "apply" | "delete" | "scan" | "compare";
  tableIndex?: number;
  rowIndex?: number;
  colIndex?: number;
  cellText?: string;
  tableData?: TableData;
  text?: string;
  position?: "Before" | "After";
  items?: Array<{
    text: string;
    index?: number;
    position?: "Before" | "After";
    style?: string;
  }>;
  /** action=multi_undo 时：连续撤销步数，默认 1，最多 20 */
  steps?: number;
  /** action=undo_to_step 时：回退到第几步（0=初始状态） */
  targetStep?: number;
  label?: string;
  checks?: string[];
  templateName?: string;
  autoFix?: boolean;
  /** audit_document：网关注入的用户偏好、模板与摘要（任务窗格侧消费） */
  auditContext?: {
    userPrefs?: Record<string, unknown>;
    templateSpec?: unknown;
    preferenceSummary?: string;
    skipCategories?: string[];
    templateAutoMatched?: boolean;
    effectiveTemplateName?: string | null;
  };
  /** set_preference：偏好键，也可用工具参数里的 key */
  preferenceKey?: string;
  preferenceValue?: string | number;
  preferenceContext?: string;
  description?: string;
  indices?: number[];
  searchText?: string;
  replaceText?: string;
  matchCase?: boolean;
  matchWholeWord?: boolean;
  maxMatches?: number;
  startIndex?: number;
  endIndex?: number;
  /** remove_hyperlinks：all | paragraph | search（勿与 apply_format 的 target 对象混用） */
  hyperlinkTarget?: "all" | "paragraph" | "search";
  clearFormat?: boolean;
  /** add_table_row：行数据 */
  values?: string[][];
  rowCount?: number;
  headerText?: string;
  footerText?: string;
  headerAlignment?: "Left" | "Center" | "Right";
  footerAlignment?: "Left" | "Center" | "Right";
  headerFont?: { name?: string; size?: number; bold?: boolean };
  footerFont?: { name?: string; size?: number };
  headerFooterType?: "Primary" | "FirstPage" | "EvenPages";
  pageNumber?: boolean;
  sectionIndex?: number;
  base64?: string;
  imageUrl?: string;
  width?: number;
  height?: number;
  altTitle?: string;
  altDescription?: string;
  marginTop?: number;
  marginBottom?: number;
  orientation?: "Portrait" | "Landscape";
  mode?: "on" | "off" | "toggle";
  title?: string;
  subject?: string;
  author?: string;
  company?: string;
  manager?: string;
  keywords?: string;
  comments?: string;
  category?: string;
  customProperties?: Record<string, string>;
  ccAction?: "insert" | "list" | "delete";
  tag?: string;
  placeholderText?: string;
  appearance?: "BoundingBox" | "Tags" | "Hidden";
  color?: string;
  cannotEdit?: boolean;
  cannotDelete?: boolean;
}

export interface ParagraphEdit {
  searchText: string; // 要查找的原文（精确匹配）
  replaceText: string; // 替换后的文字；不要以 \n 或 \r\n 结尾，需新增段落请用 insert_paragraph
  highlightColor?: string; // 高亮颜色（默认 Yellow）
}

export interface WordEditResult {
  success: boolean;
  action: string;
  data?: any;
  changeCount?: number;
  changelog?: string[];
  error?: string;
}

export const CREATE_CHECKPOINT_ACTION_DEFINITION = {
  name: "create_checkpoint",
  description:
    "在执行大批量修改前创建一个会话检查点。如果后续操作失败，可以回滚到此检查点。建议在以下场景使用：修改超过 5 个段落、全文替换、目录更新、批量格式调整。",
  parameters: {
    type: "object",
    properties: {
      label: {
        type: "string",
        description: '检查点标签，描述当前文档状态，如 "TOC更新前" "批量替换前"',
      },
    },
    required: ["label"],
  },
} as const;

export const SET_PREFERENCE_ACTION_DEFINITION = {
  name: "set_preference",
  description:
    "记录用户的排版与格式偏好。当用户明确表达喜好时调用（例如「正文用宋体」「标题黑体」「行距 1.5」「小四」）。后续 audit_document 会优先按此偏好审视。",
  parameters: {
    type: "object",
    properties: {
      preferenceKey: {
        type: "string",
        description:
          "偏好键。常用：body.font、body.fontCN（东亚字体）、body.fontSize（pt）、body.lineSpacing（倍数）、body.firstLineIndent（pt）、h1.fontCN、h1.fontSize、page.topMargin 等",
      },
      preferenceValue: {
        type: ["string", "number"],
        description: "偏好值",
      },
      preferenceContext: {
        type: "string",
        description: "用户原话或场景说明，便于日后理解来源",
      },
    },
    required: ["preferenceKey", "preferenceValue"],
  },
} as const;

export const AUDIT_DOCUMENT_ACTION_DEFINITION = {
  name: "audit_document",
  description:
    "自动审视整个文档的结构和排版，生成问题报告。会加载已学习的用户偏好，并在未指定模板时按标题结构自动匹配模板库；检查项包括标题层级、空段落、格式一致性、行距/字体/缩进等。可选传入 templateName 作为对照基准。",
  parameters: {
    type: "object",
    properties: {
      checks: {
        type: "array",
        items: { type: "string" },
        description:
          "要执行的检查项列表。可选值：heading_hierarchy, empty_paragraphs, format_consistency, spacing, font_consistency, indent, toc_match, header_footer, page_break, all。默认 all。",
      },
      templateName: {
        type: "string",
        description: "可选。用哪个已保存的模板作为格式基准来对照。不传则用通用排版规范检查。",
      },
      autoFix: {
        type: "boolean",
        description:
          "是否自动修复发现的问题。false=只报告不修改（默认），true=自动修复可安全修复的问题。",
      },
    },
  },
} as const;

export const MANAGE_TEMPLATE_ACTION_DEFINITION = {
  name: "manage_template",
  description:
    "管理文档格式模板。可以从当前文档提取格式规范保存为模板，也可以查看/删除已有模板，或将模板应用到当前文档。",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["save", "list", "show", "apply", "delete", "scan", "compare"],
        description:
          "save=从当前文档提取格式保存, list=列出所有, show=查看详情, apply=应用模板到当前文档, delete=删除, scan=重新扫描模板文件夹, compare=对比当前文档与模板的差异",
      },
      templateName: {
        type: "string",
        description:
          'save/show/apply/delete 时必填。模板名称（如"投标书模板"、"技术方案模板"）',
      },
      description: {
        type: "string",
        description: "save 时可选。模板描述说明。",
      },
    },
    required: ["operation"],
  },
} as const;
