import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { startRelayServer } from "./relay-server";
import { executeWordEdit, WordEditToolSchema, WORD_EDIT_DESCRIPTION } from "./tool";

export default definePluginEntry({
  id: "word-edit",
  name: "Word Edit Plugin",
  description: "Word 文档可视化编辑插件，通过 WebSocket 中继连接 Word Add-in",
  register(api) {
    // 启动 WebSocket 中继服务
    startRelayServer();

    // 注册 word_edit 工具（直接传工具对象，同 tavily 写法）
    api.registerTool({
      name: "word_edit",
      label: "Word Edit",
      description: WORD_EDIT_DESCRIPTION,
      parameters: WordEditToolSchema,
      execute: executeWordEdit,
    } as AnyAgentTool);

    console.log("📝 Word Edit Plugin 已注册");
  },
});
