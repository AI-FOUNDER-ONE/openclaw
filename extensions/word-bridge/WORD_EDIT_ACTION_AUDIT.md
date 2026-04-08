# Word Bridge — 全量 action 排查表

> 对照 `taskpane.html` 与 `tool.ts`。**假成功**指：`success: true` 或 Agent 误以为完成，但文档未按预期变化。  
> 约定：Agent **必须**阅读返回 JSON 的 `error`、`data.warnings`、`changelog`、`note` 及数量字段。

## 图例

| 等级 | 含义                                                    |
| ---- | ------------------------------------------------------- |
| 低   | 失败多会抛错或 `success: false`                         |
| 中   | 有边界条件或仅部分区域生效                              |
| 高   | 曾易出现假成功；已加 `warnings` 或改为 `success: false` |

---

## 只读类（一般不涉及「改了没生效」）

| action                   | 等级 | 说明                                            |
| ------------------------ | ---- | ----------------------------------------------- |
| read_structure           | 低   | 仅 body.paragraphs；不含表内段落细节            |
| read_full_structure      | 中   | 大量 load；失败整段报错；表内段落不在主列表     |
| read_page_setup          | 中   | 部分字段依赖 WordApi；内层 try 填 null          |
| read_headers_footers     | 中   | 无页眉脚的节可能为空；空 catch 仅吞单节错误     |
| read_images              | 低   | 单张失败仍有条目                                |
| read_document_properties | 中   | 自定义属性块失败时 customProps 可能为空且不报错 |
| read_tracked_changes     | 低   | 不支持则 **success: false**                     |
| read_tables              | 低   | 预览仅前 3 行                                   |
| read_comments            | 低   | 不支持则 false                                  |
| read_hyperlinks          | 中   | 依赖 Range.hyperlink；与 Word 版本有关          |
| get_status               | 低   | 仅连接与历史摘要                                |
| get_history              | 低   | 会话内历史                                      |

---

## 写入类

| action                                | 等级     | 假成功风险与处理                                                                                                             |
| ------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| edit_paragraphs                       | **已降** | 有有效 edits 但 0 次替换 → **success: false** + changelog                                                                    |
| apply_format                          | **已降** | 行距/段前段后：先展开 **Range→paragraphs** 再写 **paragraphFormat + Paragraph.lineSpacing\***；`target:all` **不含表内段落** |
| clear_highlights                      | **已降** | **clearedParagraphs / bodyParagraphCount**；不足时有 **warnings**                                                            |
| set_font                              | **已降** | `size` 用 `!== undefined`；高亮失败仍 sync 其它项并带 **warnings**                                                           |
| set_paragraph_format                  | 中       | 行距/首缩已修；仍受样式/保护限制                                                                                             |
| apply_style                           | 低       | 非法样式名多在 **sync 抛错** → 整体失败                                                                                      |
| read_tables                           | —        | （只读）                                                                                                                     |
| edit_table_cell                       | **已降** | **getCell** 越界 → **success: false**                                                                                        |
| insert_table                          | 中       | insertTable 失败整段抛错；values 维错可能整表失败                                                                            |
| insert_paragraph                      | 中       | 非法 **styleName** 可能导致整次 **sync** 失败                                                                                |
| insert_paragraphs_batch               | **已降** | 0 插入 → **success: false**；部分跳过 → **warnings**                                                                         |
| insert_page_break                     | 低       | 索引无效 false                                                                                                               |
| insert_comment                        | 低       | 需 API 支持；失败抛错                                                                                                        |
| delete_paragraphs                     | **已降** | 有 indices 但 0 次删除 → **success: false**                                                                                  |
| delete_text                           | 低       | 0 匹配 false                                                                                                                 |
| delete_range                          | 低       | expandTo/delete 失败会 catch                                                                                                 |
| remove_hyperlinks                     | 低~中    | 已用 **getHyperlinkRanges + hyperlink.delete()** 清除段内多链；失败时回退整段 `.hyperlink`；`removedCount` 为删除的链段数    |
| add_table_row                         | 低       | addRows 失败抛错                                                                                                             |
| insert_toc                            | 中       | TOC 域失败时 **success: true** + **note + warnings**（占位正文）                                                             |
| set_header_footer                     | **已降** | changelog 中含 ⚠️ 时写入 **data.warnings**                                                                                   |
| insert_image                          | 低       | 仅 base64；失败 false                                                                                                        |
| set_page_setup                        | **已降** | 方向失败进 changelog ⚠️ 并 **data.warnings**                                                                                 |
| track_changes                         | 低       | 不支持 → **success: false**                                                                                                  |
| set_properties                        | **已降** | 自定义属性失败有 changelog ⚠️ + **data.warnings**                                                                            |
| content_control                       | 中       | list 只读；delete/insert 失败抛错                                                                                            |
| save_document                         | 低       | 宿主可能禁止保存则抛错                                                                                                       |
| undo_last / multi_undo / undo_to_step | 中       | 成功仅代表调用了 undo；步数与历史可能不完全一致                                                                              |

---

## 清单与宿主

- `manifest.xml`：**WordApi 1.5+**（与 paragraphFormat / pageSetup 等一致）。
- **表格、页眉页脚、文本框**：`apply_format` 的 `all` 仅遍历 **body.paragraphs**，表内正文常需单独处理。

---

## Agent 检查清单（每次改文档后）

1. `success === false` → 读 `error` + `changelog`。
2. `data.warnings` 存在 → 向用户说明「部分未生效」。
3. `edit_paragraphs` → 看 `changeCount`。
4. `clear_highlights` → 比对 `clearedParagraphs` 与 `bodyParagraphCount`。
5. `delete_paragraphs` → 看 `deletedCount`。
6. `insert_toc` → 是否有 `note` / `warnings`。
7. 含表格的文档 → 不要默认「全文」包含表内。
