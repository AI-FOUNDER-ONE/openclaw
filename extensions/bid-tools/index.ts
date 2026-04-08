import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "bid-tools",
  name: "Bid Tools Plugin",
  description: "投标文档自动生成工具集：招标解析、素材检索、合规校验",
  register() {
    // 占位：启用插件后在此注册 bid_analyze、knowledge_query、bid_validate 等工具
  },
});
