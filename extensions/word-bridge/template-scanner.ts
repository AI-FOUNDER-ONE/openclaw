import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { parseStringPromise } from "xml2js";

export interface StyleSpec {
  fontName?: string;
  fontNameEastAsia?: string;
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
  rightIndent?: number;
  color?: string;
  outlineLevel?: number;
}

export interface PageSetupSpec {
  topMargin?: number;
  bottomMargin?: number;
  leftMargin?: number;
  rightMargin?: number;
  paperWidth?: number;
  paperHeight?: number;
  headerDistance?: number;
  footerDistance?: number;
}

export interface TemplateHeadingInfo {
  level: number;
  text: string;
  style: StyleSpec;
}

export interface FormatTemplate {
  name: string;
  description: string;
  createdAt: string;
  sourceFile: string;
  fileSize: number;
  styles: Record<string, StyleSpec>;
  styleNameMap: Record<string, string>;
  headings: TemplateHeadingInfo[];
  bodyTextSample: string[];
  pageSetup?: PageSetupSpec;
  metadata: {
    totalParagraphs: number;
    headingCount: Record<string, number>;
    mainBodyFont: string;
    mainBodyFontEastAsia: string;
    mainBodySize: number;
    mainBodyLineSpacing: number;
    documentStructure: string[];
  };
}

function halfPtToPt(val: string | undefined): number | undefined {
  if (!val) {return undefined;}
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? undefined : n / 2;
}

function twipToPt(val: string | undefined): number | undefined {
  if (!val) {return undefined;}
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? undefined : n / 20;
}

function parseRunProps(rPr: any): Partial<StyleSpec> {
  if (!rPr) {return {};}
  const spec: Partial<StyleSpec> = {};
  const rFonts = rPr["w:rFonts"]?.[0]?.["$"];
  if (rFonts) {
    spec.fontName = rFonts["w:ascii"] || rFonts["w:hAnsi"] || undefined;
    spec.fontNameEastAsia = rFonts["w:eastAsia"] || undefined;
  }

  const sz = rPr["w:sz"]?.[0]?.["$"]?.["w:val"];
  if (sz) {spec.fontSize = halfPtToPt(sz);}
  const szCs = rPr["w:szCs"]?.[0]?.["$"]?.["w:val"];
  if (!spec.fontSize && szCs) {spec.fontSize = halfPtToPt(szCs);}

  if (rPr["w:b"]) {spec.bold = true;}
  if (rPr["w:i"]) {spec.italic = true;}

  const color = rPr["w:color"]?.[0]?.["$"]?.["w:val"];
  if (color && color !== "auto") {spec.color = "#" + color;}

  return spec;
}

function parseParagraphProps(pPr: any): Partial<StyleSpec> {
  if (!pPr) {return {};}
  const spec: Partial<StyleSpec> = {};
  const jc = pPr["w:jc"]?.[0]?.["$"]?.["w:val"];
  if (jc) {spec.alignment = jc;}

  const spacing = pPr["w:spacing"]?.[0]?.["$"];
  if (spacing) {
    if (spacing["w:line"]) {
      const lineVal = parseInt(spacing["w:line"], 10);
      const lineRule = spacing["w:lineRule"] || "auto";
      if (lineRule === "auto") {
        spec.lineSpacing = lineVal / 240;
        spec.lineSpacingRule = "multiple";
      } else if (lineRule === "exact") {
        spec.lineSpacing = lineVal / 20;
        spec.lineSpacingRule = "exact";
      } else if (lineRule === "atLeast") {
        spec.lineSpacing = lineVal / 20;
        spec.lineSpacingRule = "atLeast";
      }
    }
    if (spacing["w:before"]) {spec.spaceBefore = twipToPt(spacing["w:before"]);}
    if (spacing["w:after"]) {spec.spaceAfter = twipToPt(spacing["w:after"]);}
  }

  const ind = pPr["w:ind"]?.[0]?.["$"];
  if (ind) {
    if (ind["w:firstLine"]) {spec.firstLineIndent = twipToPt(ind["w:firstLine"]);}
    if (ind["w:hanging"]) {spec.firstLineIndent = -(twipToPt(ind["w:hanging"]) || 0);}
    if (ind["w:left"] || ind["w:start"]) {spec.leftIndent = twipToPt(ind["w:left"] || ind["w:start"]);}
    if (ind["w:right"] || ind["w:end"]) {spec.rightIndent = twipToPt(ind["w:right"] || ind["w:end"]);}
  }

  const outlineLvl = pPr["w:outlineLvl"]?.[0]?.["$"]?.["w:val"];
  if (outlineLvl !== undefined) {spec.outlineLevel = parseInt(outlineLvl, 10);}
  return spec;
}

function getParagraphText(wP: any): string {
  const runs = wP["w:r"] || [];
  let text = "";
  for (const run of runs) {
    const ts = run["w:t"];
    if (ts) {
      for (const t of ts) {
        text += typeof t === "string" ? t : t["_"] || "";
      }
    }
  }
  return text.trim();
}

export async function scanDocxFile(filePath: string): Promise<FormatTemplate> {
  const fileName = path.basename(filePath, ".docx");
  const stat = fs.statSync(filePath);
  const zip = new AdmZip(filePath);

  const stylesXml = zip.readAsText("word/styles.xml");
  const stylesDoc = await parseStringPromise(stylesXml);
  const documentXml = zip.readAsText("word/document.xml");
  const docDoc = await parseStringPromise(documentXml);

  const styles: Record<string, StyleSpec> = {};
  const styleNameMap: Record<string, string> = {};
  const wStyles = stylesDoc["w:styles"]?.["w:style"] || [];
  for (const wStyle of wStyles) {
    const styleId = wStyle["$"]?.["w:styleId"];
    const styleType = wStyle["$"]?.["w:type"];
    if (!styleId || styleType !== "paragraph") {continue;}

    const styleName = wStyle["w:name"]?.[0]?.["$"]?.["w:val"] || styleId;
    styleNameMap[styleName] = styleId;
    const pPr = wStyle["w:pPr"]?.[0];
    const rPr = wStyle["w:rPr"]?.[0];
    const spec: StyleSpec = { ...parseParagraphProps(pPr), ...parseRunProps(rPr) };
    if (Object.values(spec).some((v) => v !== undefined)) {styles[styleId] = spec;}
  }

  const bodyEl = docDoc["w:document"]?.["w:body"]?.[0];
  const wParagraphs = bodyEl?.["w:p"] || [];
  const headings: TemplateHeadingInfo[] = [];
  const bodyTextSample: string[] = [];
  const headingCount: Record<string, number> = {};
  const bodyFonts: Record<string, number> = {};
  const bodyFontsEA: Record<string, number> = {};
  const bodySizes: Record<number, number> = {};
  const bodyLineSpacings: Record<number, number> = {};
  let totalParagraphs = 0;

  for (const wP of wParagraphs) {
    totalParagraphs++;
    const pPr = wP["w:pPr"]?.[0];
    const pStyleId = pPr?.["w:pStyle"]?.[0]?.["$"]?.["w:val"] || "";
    const text = getParagraphText(wP);
    const styleBase = styles[pStyleId] || {};
    const directPProps = parseParagraphProps(pPr);
    const rPr = wP["w:r"]?.[0]?.["w:rPr"]?.[0];
    const directRProps = parseRunProps(rPr);
    const merged: StyleSpec = { ...styleBase, ...directPProps, ...directRProps };

    const isHeading =
      pStyleId.toLowerCase().includes("heading") ||
      pStyleId.includes("标题") ||
      (merged.outlineLevel !== undefined && merged.outlineLevel < 9);

    if (isHeading && text) {
      const level =
        merged.outlineLevel !== undefined
          ? merged.outlineLevel + 1
          : parseInt(pStyleId.replace(/\D/g, ""), 10) || 0;
      headings.push({ level, text: text.substring(0, 80), style: merged });
      headingCount[pStyleId] = (headingCount[pStyleId] || 0) + 1;
    } else if (text && bodyTextSample.length < 5) {
      bodyTextSample.push(text.substring(0, 100));
    }

    if (!isHeading && text) {
      if (merged.fontName) {bodyFonts[merged.fontName] = (bodyFonts[merged.fontName] || 0) + 1;}
      if (merged.fontNameEastAsia) {
        bodyFontsEA[merged.fontNameEastAsia] = (bodyFontsEA[merged.fontNameEastAsia] || 0) + 1;
      }
      if (merged.fontSize) {bodySizes[merged.fontSize] = (bodySizes[merged.fontSize] || 0) + 1;}
      if (merged.lineSpacing) {
        bodyLineSpacings[merged.lineSpacing] = (bodyLineSpacings[merged.lineSpacing] || 0) + 1;
      }
    }
  }

  let pageSetup: PageSetupSpec | undefined;
  const sectPr = bodyEl?.["w:sectPr"]?.[0];
  if (sectPr) {
    const pgSz = sectPr["w:pgSz"]?.[0]?.["$"];
    const pgMar = sectPr["w:pgMar"]?.[0]?.["$"];
    pageSetup = {
      paperWidth: twipToPt(pgSz?.["w:w"]),
      paperHeight: twipToPt(pgSz?.["w:h"]),
      topMargin: twipToPt(pgMar?.["w:top"]),
      bottomMargin: twipToPt(pgMar?.["w:bottom"]),
      leftMargin: twipToPt(pgMar?.["w:left"]),
      rightMargin: twipToPt(pgMar?.["w:right"]),
      headerDistance: twipToPt(pgMar?.["w:header"]),
      footerDistance: twipToPt(pgMar?.["w:footer"]),
    };
  }

  const topFont = Object.entries(bodyFonts).toSorted((a, b) => b[1] - a[1])[0];
  const topFontEA = Object.entries(bodyFontsEA).toSorted((a, b) => b[1] - a[1])[0];
  const topSize = Object.entries(bodySizes).toSorted((a, b) => b[1] - a[1])[0];
  const topSpacing = Object.entries(bodyLineSpacings).toSorted((a, b) => b[1] - a[1])[0];
  const documentStructure = headings.map((h) => `${"  ".repeat(h.level - 1)}H${h.level}: ${h.text}`);

  return {
    name: fileName,
    description: `从 ${path.basename(filePath)} 自动提取的格式模板`,
    createdAt: new Date().toISOString(),
    sourceFile: path.basename(filePath),
    fileSize: stat.size,
    styles,
    styleNameMap,
    headings,
    bodyTextSample,
    pageSetup,
    metadata: {
      totalParagraphs,
      headingCount,
      mainBodyFont: topFont ? topFont[0] : "",
      mainBodyFontEastAsia: topFontEA ? topFontEA[0] : "",
      mainBodySize: topSize ? Number(topSize[0]) : 0,
      mainBodyLineSpacing: topSpacing ? Number(topSpacing[0]) : 0,
      documentStructure,
    },
  };
}

export async function scanTemplateFolder(folderPath: string): Promise<Record<string, FormatTemplate>> {
  const templates: Record<string, FormatTemplate> = {};
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
    console.log(`📁 已创建模板文件夹: ${folderPath}`);
    return templates;
  }

  const files = fs
    .readdirSync(folderPath)
    .filter((f) => f.endsWith(".docx") && !f.startsWith("~$"));
  console.log(`📂 扫描模板文件夹: ${folderPath}, 找到 ${files.length} 个 .docx 文件`);
  for (const file of files) {
    const filePath = path.join(folderPath, file);
    try {
      console.log(`  📄 解析: ${file}...`);
      const template = await scanDocxFile(filePath);
      templates[template.name] = template;
      console.log(
        `  ✅ ${file} → "${template.name}" (${template.metadata.totalParagraphs} 段, ${Object.keys(template.styles).length} 种样式)`,
      );
    } catch (e: any) {
      console.error(`  ❌ ${file} 解析失败: ${e.message}`);
    }
  }
  return templates;
}

/** 根据当前文档的标题结构，自动匹配最相似的模板 */
export function findBestMatchingTemplate(
  currentHeadings: Array<{ level: number; text: string }>,
  templates: Record<string, FormatTemplate>,
): { templateName: string; similarity: number } | null {
  if (Object.keys(templates).length === 0) {return null;}

  let bestMatch = "";
  let bestScore = 0;

  const safeHeadings = currentHeadings.filter(
    (h): h is { level: number; text: string } =>
      h != null && typeof h.level === "number" && Number.isFinite(h.level),
  );

  for (const [name, tpl] of Object.entries(templates)) {
    let score = 0;

    const tplLevels = tpl.headings.map((h) => h.level);
    const curLevels = safeHeadings.map((h) => h.level);

    const tplLevelCounts: Record<number, number> = {};
    const curLevelCounts: Record<number, number> = {};
    for (const l of tplLevels) {tplLevelCounts[l] = (tplLevelCounts[l] || 0) + 1;}
    for (const l of curLevels) {curLevelCounts[l] = (curLevelCounts[l] || 0) + 1;}

    const allLevels = new Set([...Object.keys(tplLevelCounts), ...Object.keys(curLevelCounts)]);
    let levelSimilarity = 0;
    let levelTotal = 0;
    for (const l of allLevels) {
      const tplCount = tplLevelCounts[Number(l)] || 0;
      const curCount = curLevelCounts[Number(l)] || 0;
      const maxCount = Math.max(tplCount, curCount);
      if (maxCount > 0) {
        levelSimilarity += Math.min(tplCount, curCount) / maxCount;
        levelTotal++;
      }
    }
    if (levelTotal > 0) {score += (levelSimilarity / levelTotal) * 40;}

    const tplKeywords = new Set(
      tpl.headings
        .flatMap((h) => String(h.text ?? "").split(/[\s,，、：:]/))
        .filter((w) => w.length >= 2),
    );
    const curKeywords = new Set(
      safeHeadings
        .flatMap((h) => String(h.text ?? "").split(/[\s,，、：:]/))
        .filter((w) => w.length >= 2),
    );

    let keywordOverlap = 0;
    for (const kw of curKeywords) {
      if (tplKeywords.has(kw)) {keywordOverlap++;}
    }
    const keywordUnion = new Set([...tplKeywords, ...curKeywords]).size;
    if (keywordUnion > 0) {score += (keywordOverlap / keywordUnion) * 30;}

    const paraRatio =
      Math.min(tpl.metadata.totalParagraphs, safeHeadings.length * 10) /
      Math.max(tpl.metadata.totalParagraphs, safeHeadings.length * 10);
    score += paraRatio * 15;

    const headingRatio =
      Math.min(tpl.headings.length, safeHeadings.length) /
      Math.max(tpl.headings.length, safeHeadings.length, 1);
    score += headingRatio * 15;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = name;
    }
  }

  if (bestScore < 30) {return null;}

  return { templateName: bestMatch, similarity: Math.round(bestScore) };
}
