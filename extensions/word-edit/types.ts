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
  operation?: FormatOperation;
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
