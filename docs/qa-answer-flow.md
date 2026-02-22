# 课中答疑（/api/qa/ask）答案处理逻辑总结

## 一、入口与分支

**入口**：`POST /api/qa/ask`，body：`{ question, course_id }`

整体有两个大分支，**只会走其中一个**：

1. **RAG 已开启**（`get_rag_settings().enabled == True`）→ 走 **RAG 路径**
2. **RAG 未开启或 RAG 抛错**（`except` 被触发）→ 走 **关键词检索路径**

---

## 二、RAG 路径（settings.enabled == True）

```
qa.py ask()
  → from ..rag import rag_ask
  → rag_ask(question, course_id)
       → pipeline.ask()
            → retriever.retrieve(question, course_id)  得到 chunks
            → generator.generate_answer(question, chunks)
  → 得到 answer, ppt_ref, knowledge_point, ...
  → 若 answer 含「未在课程知识库」且无 ppt_ref/knowledge_point → 换成通用兜底答案
  → answer = distill_answer_if_raw(question, answer)   ← 统一再蒸馏一次
  → 入库、返回 AskOut(answer=answer, ...)
```

### 2.1 检索（retriever）

- 向量 + BM25 等从 Chroma 里按课程检索，得到 `chunks: list[RetrievedChunk]`。
- 每个 chunk 有 `text`（课件/文档片段，可能含 `[第1页]`、学校名、日程等）和 `metadata`。

### 2.2 生成答案（generator.generate_answer）

1. **无 chunks**  
   - 用 LLM 回答问题（提示：知识库无匹配，请基于通用知识简短回答用户问题）。  
   - 引用信息固定为「参考文档：当前问题在知识库中没有参考答案」（`ppt_ref = NO_CHUNKS_REF`），无 reference_doc_id / reference_page。

2. **有 chunks**  
   - `build_prompt(question, chunks)`：把前 5 个 chunk 的 `text` 拼成「课程知识库片段」+ 系统提示（要求只输出 JSON：`{"answer":"...","ref_pages":[...]}`）。  
   - **第一次 LLM 调用**：`llm.generate(prompt)` → 得到 `raw`。

3. **解析 LLM 输出**（`_parse_structured_llm_output(raw)`）  
   - 尝试从 `raw` 里解析出 JSON，取 `answer` 和 `ref_pages`；解析时对 `answer` 做 `_clean_answer_text`（去掉“参考：xxx”等）。  
   - **若解析不到 JSON**：把整段 `raw` 当作答案（`answer = _clean_answer_text(raw)`），`ref_pages = []`。  
   - 即：模型若直接输出课件原文、不包在 JSON 里，会把整段原文当成 answer。

4. **课件原文检测 + 蒸馏（generator 内）**  
   - `_looks_like_raw_slide(answer)` 为 True 时：  
     - 再调一次 LLM：`_distill_raw_content(question, answer, llm)`，用提示语要求「只保留与问题相关的 2～10 句，去掉页码/学校名/日程等」。  
   - 若蒸馏**抛错**：返回 `raw_content[:500]+"…"` 或原文，不会变成简洁回答。  
   - 若蒸馏**成功**：用蒸馏结果覆盖 `answer`，并对结果做 `_clean_answer_text`。

5. **引用信息**  
   - 从 chunks 的 metadata 里取 ppt_ref、knowledge_point、reference_doc_id、reference_page 等，和 answer 一起返回。

### 2.3 qa.py 里 RAG 路径的再次蒸馏

- 在返回前执行：`answer = distill_answer_if_raw(question, answer)`。
- `distill_answer_if_raw`：  
  - 若 `_looks_like_raw_slide(answer)` 为 False → 直接返回原 `answer`。  
  - 若为 True → 调 `get_rag_settings()`、`get_llm(settings)`，再调 `_distill_raw_content`。  
  - 若这里**抛错**（例如 RAG 未配置、LLM 初始化失败）：`except` 里会 `return (answer or "").strip()`，**原样返回未蒸馏的 answer**。

---

## 三、关键词检索路径（RAG 未开启或 RAG 抛错）

```
qa.py ask()
  → 跳过 rag_ask（或 except 吞掉异常）
  → 用 SQL：KnowledgeDocument / KnowledgePoint 按 question 做 LIKE 检索
  → 得到 docs、points
  → 若无任何命中 → 返回「当前问题在知识库中没有参考答案」+ 通用兜底答案
  → 若有命中：
       doc_tuples = _build_doc_tuples(docs, points)
       cleaned_answer = _summarize_doc_answer(question, doc_tuples)
       cleaned_answer = distill_answer_if_raw(question, cleaned_answer)
       resp = QAResponse(answer=cleaned_answer, ...)
  → 返回 AskOut(answer=resp.answer, ...)
```

### 3.1 _summarize_doc_answer

- 用 LLM 把 `doc_tuples`（content, page_ref, title）拼成 prompt，要求「3～5 句简洁中文、去掉噪声」。
- **若 LLM 抛错**：内部 `except` 里会执行  
  `return (answer_from_documents(question, doc_tuples).answer or "").strip()`。

### 3.2 answer_from_documents（仅在做 _summarize_doc_answer 失败时用到）

- **不做任何 LLM**：取第一个文档的 `content`，`_truncate(content, 400)`。
- 即：**直接返回课件/文档原文的前 400 字**，所以会看到 `[第1页]`、学校名等原文。

### 3.3 关键词路径的蒸馏

- `cleaned_answer = distill_answer_if_raw(body.question, cleaned_answer or "")`。
- 若这里 `_looks_like_raw_slide(cleaned_answer)` 为 True，会再调 LLM 蒸馏；若蒸馏或 LLM 初始化失败，仍会返回未蒸馏的原文。

---

## 四、课件原文判定（_looks_like_raw_slide）

在 `generator.py` 里，满足任一即视为「课件原文」：

1. 出现 `[第N页]` 或 `【第N页】` 等页码块。
2. 出现预设标题/日程：如「西发航空学院」「Year-end SUMMARY」「局域网技术概述」、行首的 `15min` 等。
3. 出现「第X页」且总长 > 200 字。
4. 「第X页」出现 ≥ 2 次。
5. 总长 > 350 且含「页」且含「第」或 `[` 或 `【`。

**注意**：这里依赖**字符串字面**。若实际返回的格式有细微差异（例如全角/半角、空格、换行、不同学校名），可能判不到，导致不会触发蒸馏。

---

## 五、可能导致「仍然返回原文」的原因

1. **实际没走 RAG**  
   - 后管台或配置里 RAG 未开启，或 `rag_ask` 抛错被 `except: pass` 吞掉，则全程走关键词路径。  
   - 若关键词路径里 `_summarize_doc_answer` 失败，就会用 `answer_from_documents` 的 400 字原文；再依赖 `distill_answer_if_raw`。若蒸馏或 LLM 失败，就还是原文。

2. **RAG 路径里第一次 LLM 没按 JSON 输出**  
   - 模型若直接输出大段课件原文（没有 `{"answer":"...","ref_pages":[]}`），`_parse_structured_llm_output` 会把整段当 answer。  
   - 若后续 `_looks_like_raw_slide` 没命中（格式/编码/学校名等与当前规则不一致），generator 内不会蒸馏，到 qa.py 再蒸馏一次；若仍没命中或蒸馏失败，就还是原文。

3. **蒸馏失败但被吞掉**  
   - `_distill_raw_content` 或 `distill_answer_if_raw` 里 `get_llm(settings)` 或 `llm.generate(...)` 抛错时，会 fallback 成「原文」或「原文前 500 字」，不会报错给前端，所以**看起来像没变化**。

4. **判定没命中**  
   - 实际返回的文本里没有 `[第N页]`、没有「西发航空学院」等当前规则，或长度/格式不满足上述 5 条，则 `_looks_like_raw_slide` 为 False，不会进入蒸馏。

---

## 六、建议排查步骤

1. **确认当前走的是哪条路径**  
   - 看日志：是否有 `[RAG-TRACE] qa_api_rag_hit` 或 `[RAG-TRACE] qa_api_rag_miss_to_general_answer`（RAG 路径），还是完全没有这些（关键词路径）。  
   - 若有 `[RAG-TRACE] qa_api_rag_disabled_by_config`，说明 RAG 未开启。

2. **确认是否触发蒸馏**  
   - 搜日志：`[RAG-TRACE] answer_looks_like_raw_slide_distill`（generator 内）、以及 `distill_answer_if_raw` 里若抛错会有 `distill_answer_if_raw_failed` / `distill_raw_content_failed`。  
   - 若从没有这些日志：要么没被判成原文，要么没走到蒸馏逻辑。

3. **确认 LLM 是否可用**  
   - 在关键词路径下，蒸馏依赖 `get_rag_settings()` 和 `get_llm(settings)`；若 RAG 未配置或 LLM 未配置，这里会静默失败并返回原文。

4. **打印一次“真实 answer”再判一次**  
   - 在 `distill_answer_if_raw` 入口处打 log：`logger.warning("[RAG-TRACE] distill_input answer_len=%s preview=%s", len(answer), (answer or "")[:200])`。  
   - 再在 `_looks_like_raw_slide(answer)` 后打：`logger.warning("[RAG-TRACE] looks_like_raw_slide=%s", result)`。  
   - 可以确认：实际传入的答案长什么样、是否被判定为原文。

5. **若希望更稳**  
   - 可考虑：只要 `len(answer) > 300`（或更高阈值）就强制做一次蒸馏，不依赖 `_looks_like_raw_slide`，避免因格式差异导致永远不蒸馏。

---

## 七、相关代码位置速查

| 步骤           | 文件                     | 函数/位置 |
|----------------|--------------------------|-----------|
| 入口、分支     | `backend/app/api/qa.py`  | `ask()` 约 196 行起 |
| RAG 调用       | `backend/app/rag/pipeline.py` | `ask()` → `retrieve` + `generate_answer` |
| 检索           | `backend/app/rag/retriever.py` | `retrieve()` |
| 生成+蒸馏      | `backend/app/rag/generator.py` | `generate_answer()`、`_looks_like_raw_slide`、`_distill_raw_content`、`distill_answer_if_raw` |
| 统一再蒸馏     | `backend/app/api/qa.py`  | RAG 路径内 `distill_answer_if_raw(question, answer)`；关键词路径内 `distill_answer_if_raw(body.question, cleaned_answer)` |
| 关键词兜底原文 | `backend/app/services/qa_engine.py` | `answer_from_documents()` 仅做截断 |
