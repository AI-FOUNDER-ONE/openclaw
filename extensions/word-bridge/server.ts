import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

import fs from "fs";
import https from "https";
import {
  scanTemplateFolder,
  scanDocxFile,
  findBestMatchingTemplate,
  type FormatTemplate,
} from "./template-scanner.js";
import {
  loadPreferences,
  setExplicitPreference,
  learnImplicitPreference,
  recordAcceptedSuggestion,
  recordRejectedSuggestion,
  getPreferenceSummary,
  getHighConfidencePreferences,
  getSkippedAuditCategories,
} from "./user-preferences.js";
/**
 * Word Bridge — STT 默认从本目录 `.env` 加载（见 WHISPER_* / STT_BACKEND）。
 *
 * 方案示例：
 * - Moonshot：`WHISPER_API_URL=https://api.moonshot.cn/v1/audio/transcriptions` + Moonshot Key
 * - OpenAI 官方：`https://api.openai.com/v1/audio/transcriptions`
 * - 硅基流动等兼容 OpenAI 的 transcriptions 端点
 * - 本地 whisper.cpp：`STT_BACKEND=local-whisper` + `LOCAL_WHISPER_URL`（默认 `/inference`）
 *   启动示例：`./build/bin/whisper-server -m models/ggml-large-v3.bin --port 18803 -l zh -bs 5 -bo 5`
 *   （`-bs` = beam-size，`-bo` = best-of；以 `./build/bin/whisper-server --help` 为准）
 *
 * `import 'dotenv/config'` 会先尝试 cwd 的 `.env`；随后 `dotenv.config({ path: 本目录/.env })`
 * 为未在环境中的变量补全（不覆盖已在进程/先前列表中的非空值）。
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import { Readable } from "stream";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";

const BRIDGE_PORT = 18801;
const TEMPLATES_DIR = path.join(__dirname, "templates");
const TEMPLATES_FILE = path.join(__dirname, ".templates.json");
let templateStore: Record<string, FormatTemplate> = {};

function loadTemplateCache() {
  try {
    if (fs.existsSync(TEMPLATES_FILE)) {
      templateStore = JSON.parse(fs.readFileSync(TEMPLATES_FILE, "utf-8")) as Record<
        string,
        FormatTemplate
      >;
    }
  } catch {
    templateStore = {};
  }
}

function saveTemplateCache() {
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templateStore, null, 2), "utf-8");
}

async function initTemplates() {
  const prefLoaded = loadPreferences();
  console.log("👤 用户偏好已加载:", Object.keys(prefLoaded.preferences).length, "项");
  loadTemplateCache();
  if (!fs.existsSync(TEMPLATES_DIR)) {
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
    console.log(`📁 已创建模板目录: ${TEMPLATES_DIR}`);
    console.log("   请将 .docx 模板文件放入此目录，Agent 会自动学习格式规范");
  }

  const files = fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith(".docx") && !f.startsWith("~$"));
  let updated = false;
  for (const file of files) {
    const filePath = path.join(TEMPLATES_DIR, file);
    const fileName = path.basename(file, ".docx");
    const stat = fs.statSync(filePath);
    const cached = templateStore[fileName];
    if (cached && cached.sourceFile === file && new Date(cached.createdAt).getTime() >= stat.mtimeMs) {
      continue;
    }
    try {
      console.log(`📄 扫描模板: ${file}...`);
      templateStore[fileName] = await scanDocxFile(filePath);
      updated = true;
      console.log(`✅ 模板 "${fileName}" 已更新`);
    } catch (e: any) {
      console.error(`❌ 模板 "${file}" 扫描失败: ${e.message}`);
    }
  }
  if (updated) {saveTemplateCache();}
  console.log(`📚 模板库就绪: ${Object.keys(templateStore).length} 个模板`);

  fs.watch(TEMPLATES_DIR, { persistent: false }, async (_eventType, filename) => {
    if (!filename || !filename.endsWith(".docx") || filename.startsWith("~$")) {return;}
    const debounceKey = `__tplWatch_${filename}`;
    if ((globalThis as any)[debounceKey]) {return;}
    (globalThis as any)[debounceKey] = true;
    setTimeout(() => {
      (globalThis as any)[debounceKey] = false;
    }, 500);

    const filePath = path.join(TEMPLATES_DIR, filename);
    const templateName = path.basename(filename, ".docx");
    if (!fs.existsSync(filePath)) {
      if (templateStore[templateName]) {
        delete templateStore[templateName];
        saveTemplateCache();
        console.log(`🗑️ 模板 "${templateName}" 已移除（文件被删除）`);
      }
      return;
    }
    try {
      console.log(`📄 检测到模板变化: ${filename}，重新扫描...`);
      templateStore[templateName] = await scanDocxFile(filePath);
      saveTemplateCache();
      console.log(`✅ 模板 "${templateName}" 已自动更新`);
    } catch (e: any) {
      console.error(`❌ 自动扫描 ${filename} 失败: ${e.message}`);
    }
  });
}

const app = express();

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

// ========== 语音转文字 API ==========
// 中间件顺序（须保持）：① express.raw('/api/stt') ② app.post('/api/stt') ③ 其它 API ④ express.static（最后）

const STT_BACKEND = process.env.STT_BACKEND || "openai-whisper";
const WHISPER_API_KEY = process.env.WHISPER_API_KEY || process.env.OPENAI_API_KEY || "";
const WHISPER_API_URL =
  process.env.WHISPER_API_URL || "https://api.openai.com/v1/audio/transcriptions";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-1";
const LOCAL_WHISPER_URL = process.env.LOCAL_WHISPER_URL || "http://127.0.0.1:18803/inference";

if (STT_BACKEND === "openai-whisper" && !WHISPER_API_KEY) {
  console.warn(
    "[word-bridge] STT 未配置密钥：请在 extensions/word-bridge/.env 中设置 WHISPER_API_KEY（或 OPENAI_API_KEY），或导出环境变量",
  );
}

// ① STT 的 raw body（必须在 express.static 之前）
app.use("/api/stt", express.raw({ type: "application/octet-stream", limit: "25mb" }));

function sttInputSuffixFromMime(m: string): string {
  const lower = m.toLowerCase();
  if (lower.includes("mp4") || lower.includes("m4a") || lower.includes("aac")) {
    return ".mp4";
  }
  if (lower.includes("webm")) {
    return ".webm";
  }
  return ".webm";
}

// ② STT 路由
app.post("/api/stt", async (req, res) => {
  try {
    const audioBuffer = req.body as Buffer;
    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ error: "未收到音频数据" });
    }
    const audioMime = String(req.headers["x-audio-mime"] ?? "unknown");
    console.log(
      `🎙️ 收到音频 ${(audioBuffer.length / 1024).toFixed(1)}KB, 格式: ${audioMime}, 后端: ${STT_BACKEND}`,
    );
    if (STT_BACKEND === "openai-whisper") {
      console.log(
        `🔑 STT 配置: backend=${STT_BACKEND}, url=${WHISPER_API_URL}, model=${WHISPER_MODEL}, key=${WHISPER_API_KEY ? "已配置(" + WHISPER_API_KEY.substring(0, 8) + "...)" : "未配置"}`,
      );
    } else if (STT_BACKEND === "local-whisper") {
      console.log(`🔑 STT 配置: backend=${STT_BACKEND}, url=${LOCAL_WHISPER_URL}`);
    }

    let text = "";

    if (STT_BACKEND === "openai-whisper") {
      if (!WHISPER_API_KEY) {
        return res.status(500).json({ error: "未配置 WHISPER_API_KEY 或 OPENAI_API_KEY 环境变量" });
      }
      const FormData = (await import("form-data")).default;
      const form = new FormData();
      form.append("file", audioBuffer, { filename: "audio.webm", contentType: "audio/webm" });
      form.append("model", WHISPER_MODEL);
      form.append("language", "zh");
      form.append("response_format", "json");

      const response = await fetch(WHISPER_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHISPER_API_KEY}`,
          ...form.getHeaders(),
        },
        body: form.getBuffer() as unknown as BodyInit,
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("Whisper API 错误:", response.status, errText);

        let hint = "";
        if (response.status === 404 || response.status === 400) {
          hint =
            "。该 API 可能不支持 audio/transcriptions 接口，请在 .env 中切换到 OpenAI 或 SiliconFlow";
        } else if (response.status === 401) {
          hint = "。API Key 无效或已过期，请检查 .env 中的 WHISPER_API_KEY";
        }

        return res.status(500).json({
          error: `STT API 错误 ${response.status}${hint}`,
          detail: errText.substring(0, 300),
        });
      }
      const result = (await response.json()) as { text: string };
      text = result.text || "";
    } else if (STT_BACKEND === "local-whisper") {
      // ---- 本地 whisper.cpp server ----
      // whisper.cpp 对 webm 支持不稳定，先用 ffmpeg 转为 wav
      const tmpDir = os.tmpdir();
      const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const inExt = sttInputSuffixFromMime(audioMime);
      const inputPath = path.join(tmpDir, `stt-input-${uniq}${inExt}`);
      const outputPath = path.join(tmpDir, `stt-output-${uniq}.wav`);

      try {
        fs.writeFileSync(inputPath, audioBuffer);

        execFileSync(
          "ffmpeg",
          [
            "-y",
            "-i",
            inputPath,
            "-af",
            "highpass=f=80,lowpass=f=8000,volume=2.0",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            outputPath,
          ],
          { timeout: 120_000, stdio: "pipe", maxBuffer: 50 * 1024 * 1024 },
        );

        try {
          const probeResult = execFileSync(
            "ffprobe",
            [
              "-v",
              "error",
              "-show_entries",
              "format=duration,size",
              "-show_entries",
              "stream=sample_rate,channels,codec_name",
              "-of",
              "json",
              outputPath,
            ],
            { timeout: 5000, maxBuffer: 1024 * 1024 },
          ).toString();
          console.log("🔍 WAV 诊断:", probeResult);
        } catch {
          console.log("🔍 ffprobe 不可用，跳过诊断");
        }

        const wavBuffer = fs.readFileSync(outputPath);
        console.log(
          `🔄 音频转换: ${(audioBuffer.length / 1024).toFixed(1)}KB → ${(wavBuffer.length / 1024).toFixed(1)}KB wav (${inExt} 输入)`,
        );

        const FormData = (await import("form-data")).default;
        const form = new FormData();
        form.append("file", wavBuffer, { filename: "audio.wav", contentType: "audio/wav" });
        form.append("language", "zh");
        form.append("response_format", "json");

        const response = await fetch(LOCAL_WHISPER_URL, {
          method: "POST",
          headers: form.getHeaders(),
          body: form.getBuffer() as unknown as BodyInit,
        });

        if (!response.ok) {
          const errText = await response.text();
          console.error("本地 Whisper 错误:", response.status, errText);
          return res.status(500).json({
            error: `本地 Whisper ${response.status}: ${errText.substring(0, 200)}`,
          });
        }

        const result = (await response.json()) as { text: string };
        text = result.text || "";
      } finally {
        try {
          fs.unlinkSync(inputPath);
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(outputPath);
        } catch {
          /* ignore */
        }
      }
    } else {
      return res.status(400).json({ error: `未知 STT 后端: ${STT_BACKEND}` });
    }

    console.log(`🎙️ 识别结果: "${text}"`);
    res.json({ text, backend: STT_BACKEND });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "STT 处理失败";
    console.error("STT 处理失败:", err);
    res.status(500).json({ error: message });
  }
});

app.get("/api/templates", (_req, res) => {
  const list = Object.entries(templateStore).map(([name, tpl]) => ({
    name,
    description: tpl.description,
    sourceFile: tpl.sourceFile,
    fileSize: tpl.fileSize,
    createdAt: tpl.createdAt,
    paragraphs: tpl.metadata.totalParagraphs,
    styles: Object.keys(tpl.styles || {}).length,
    mainFont: tpl.metadata.mainBodyFont,
    mainFontCN: tpl.metadata.mainBodyFontEastAsia,
    mainSize: tpl.metadata.mainBodySize,
    lineSpacing: tpl.metadata.mainBodyLineSpacing,
    headings: tpl.metadata.headingCount,
    structure: (tpl.metadata.documentStructure || []).slice(0, 20),
  }));
  res.json({ templates: list, count: list.length, folder: TEMPLATES_DIR });
});

app.post("/api/templates/match", express.json({ limit: "2mb" }), (req, res) => {
  try {
    const currentHeadings = Array.isArray(req.body?.currentHeadings) ? req.body.currentHeadings : [];
    const match = findBestMatchingTemplate(currentHeadings, templateStore);
    res.json({ match });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "模板匹配失败" });
  }
});

app.get("/api/preferences", (_req, res) => {
  const prefs = getHighConfidencePreferences(0.3);
  res.json({
    summary: getPreferenceSummary(),
    preferences: prefs,
    count: prefs.length,
    skipCategories: getSkippedAuditCategories(),
  });
});

app.post("/api/preferences/set", express.json({ limit: "1mb" }), (req, res) => {
  const { key, value, context } = req.body ?? {};
  if (!key) {
    res.status(400).json({ error: "缺少 key" });
    return;
  }
  setExplicitPreference(String(key), value, context != null ? String(context) : undefined);
  res.json({ success: true, message: `偏好 "${key}" 已设置` });
});

app.post("/api/preferences/learn", express.json({ limit: "1mb" }), (req, res) => {
  const { key, value, context } = req.body ?? {};
  if (!key) {
    res.status(400).json({ error: "缺少 key" });
    return;
  }
  learnImplicitPreference(String(key), value, context != null ? String(context) : undefined);
  res.json({ success: true });
});

app.post("/api/preferences/feedback", express.json({ limit: "1mb" }), (req, res) => {
  const { category, suggestion, accepted, reason } = req.body ?? {};
  if (!category || suggestion == null) {
    res.status(400).json({ error: "缺少 category 或 suggestion" });
    return;
  }
  if (accepted) {
    recordAcceptedSuggestion(String(category), String(suggestion));
  } else {
    recordRejectedSuggestion(String(category), String(suggestion), reason != null ? String(reason) : undefined);
  }
  res.json({ success: true });
});

app.get("/api/templates/:name", (req, res) => {
  const tpl = templateStore[req.params.name];
  if (!tpl) {
    res.status(404).json({ error: `模板 "${req.params.name}" 不存在` });
    return;
  }
  res.json(tpl);
});

app.post("/api/templates", express.json({ limit: "10mb" }), (req, res) => {
  try {
    const body = req.body ?? {};
    templateStore = body as Record<string, FormatTemplate>;
    saveTemplateCache();
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "保存模板失败" });
  }
});

app.post("/api/templates/scan", async (_req, res) => {
  try {
    const scanned = await scanTemplateFolder(TEMPLATES_DIR);
    templateStore = { ...templateStore, ...scanned };
    saveTemplateCache();
    res.json({
      success: true,
      message: `扫描完成，共 ${Object.keys(templateStore).length} 个模板`,
      templates: Object.keys(templateStore),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "扫描模板失败" });
  }
});

app.delete("/api/templates/:name", (req, res) => {
  const name = req.params.name;
  if (!templateStore[name]) {
    res.status(404).json({ error: "模板不存在" });
    return;
  }
  delete templateStore[name];
  saveTemplateCache();
  res.json({ success: true, message: `模板 "${name}" 已删除` });
});

app.post("/api/templates/upload", express.raw({ type: "*/*", limit: "50mb" }), async (req, res) => {
  try {
    let headerName = (req.headers["x-filename"] as string) || `uploaded_${Date.now()}.docx`;
    try {
      headerName = decodeURIComponent(headerName);
    } catch {
      /* keep raw */
    }
    const base = path.basename(headerName).replace(/^~\$/, "");
    if (!base.toLowerCase().endsWith(".docx")) {
      res.status(400).json({ error: "仅支持 .docx 文件" });
      return;
    }
    const bodyBuf = req.body;
    if (!Buffer.isBuffer(bodyBuf) || bodyBuf.length === 0) {
      res.status(400).json({ error: "文件内容为空" });
      return;
    }
    const filePath = path.join(TEMPLATES_DIR, base);
    fs.writeFileSync(filePath, bodyBuf);
    const template = await scanDocxFile(filePath);
    templateStore[template.name] = template;
    saveTemplateCache();
    res.json({
      success: true,
      message: `模板 "${template.name}" 已上传并解析`,
      template: {
        name: template.name,
        paragraphs: template.metadata.totalParagraphs,
        styles: Object.keys(template.styles || {}).length,
      },
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "上传模板失败" });
  }
});

app.get("/api/tts-config", (_req, res) => {
  res.json({
    engine: "web-speech-synthesis",
    defaultLang: "zh-CN",
    defaultRate: 1.0,
    defaultPitch: 1.0,
    note: "TTS 使用浏览器内置 Web Speech Synthesis API，无需服务端处理",
  });
});

// ③ 最后：静态文件（勿挪到 /api/stt 之前，否则未匹配文件会 404）
app.use(express.static(path.join(__dirname)));

const certPath = path.join(__dirname, "127.0.0.1+1.pem");
const keyPath = path.join(__dirname, "127.0.0.1+1-key.pem");

if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
  console.error("");
  console.error("❌ 未找到 HTTPS 证书。请运行：");
  console.error("   cd extensions/word-bridge");
  console.error("   mkcert 127.0.0.1 localhost");
  console.error("");
  process.exit(1);
}

const server = https.createServer(
  { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
  app,
);

const GATEWAY_WS_URL = "ws://127.0.0.1:18789";
const wssProxy = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const rawUrl = req.url ?? "";
  const pathname = rawUrl.split("?")[0] ?? "";
  if (pathname === "/gateway" || pathname.startsWith("/gateway/")) {
    wssProxy.handleUpgrade(req, socket, head, function (clientWs) {
      console.log("📡 新的 Chat 连接，正在连接 Gateway...");

      var gatewayWs = new WebSocket(GATEWAY_WS_URL, {
        headers: {
          Origin: "https://127.0.0.1:18801",
        },
      });

      // 缓存 clientWs 消息，等 gatewayWs open 后再发
      var clientBuffer: Array<WebSocket.RawData> = [];
      var gatewayReady = false;

      gatewayWs.on("open", function () {
        console.log("📡 Gateway 代理已连接");
        gatewayReady = true;
        // 发送缓存的消息
        for (var i = 0; i < clientBuffer.length; i++) {
          gatewayWs.send(clientBuffer[i]);
        }
        clientBuffer = [];
      });

      // 客户端 → Gateway（转为 string）
      clientWs.on("message", function (data, isBinary) {
        var textMsg = isBinary ? "" : data.toString();
        var msg = isBinary ? data : Buffer.from(textMsg, "utf-8");
        var msgPreview = isBinary ? "(binary)" : textMsg.substring(0, 120);
        console.log(
          "📡 Client → Gateway:",
          msgPreview,
        );
        if (gatewayReady && gatewayWs.readyState === WebSocket.OPEN) {
          gatewayWs.send(msg);
        } else {
          clientBuffer.push(msg);
        }
      });

      // Gateway → 客户端（转为 string）
      gatewayWs.on("message", function (data, isBinary) {
        var msg = isBinary ? data : data.toString();
        if (typeof msg === "string") {
          try {
            var parsed = JSON.parse(msg);
            if (
              parsed &&
              (parsed.type === "word_action_result" ||
                parsed.type === "plan_update" ||
                parsed.type === "execution_item")
            ) {
              console.log("📡 Gateway event:", parsed.type);
            }
          } catch {
            // ignore parse errors for non-JSON text frames
          }
        }
        console.log(
          "📡 Gateway → Client:",
          typeof msg === "string" ? msg.substring(0, 120) : "(binary)",
        );
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(msg);
        }
      });

      clientWs.on("close", function (code, reason) {
        console.log("📡 Client 断开, code=" + code);
        gatewayWs.close();
      });

      gatewayWs.on("close", function (code, reason) {
        console.log("📡 Gateway 断开, code=" + code);
        clientWs.close();
      });

      clientWs.on("error", function (err) {
        console.error("📡 Client WS error:", err.message);
        gatewayWs.close();
      });

      gatewayWs.on("error", function (err) {
        console.error("📡 Gateway WS error:", err.message);
        clientWs.close();
      });
    });
    return;
  }
  socket.destroy();
});

server.listen(BRIDGE_PORT, () => {
  console.log(`📎 Word Bridge HTTPS: https://127.0.0.1:${BRIDGE_PORT}`);
  console.log("📡 Gateway WSS 代理: wss://127.0.0.1:18801/gateway");
  initTemplates().catch((e) => console.error("模板初始化失败:", e));
});

export { server };
