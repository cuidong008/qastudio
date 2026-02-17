# 自研 RAG 模块配置说明

RAG 模块与业务解耦。**优先通过后管台 Web 界面配置**（与 [RAGFlow 的 Model providers](https://ragflow.io/docs/llm_api_key_setup) 类似），未在界面配置的项再回退到环境变量或 `.env`（前缀 `RAG_`）。

## 通过 Web 界面配置（推荐）

1. 管理员登录 → 进入 **RAG 配置**（或 `/admin/rag`）。
2. 在页面中填写或修改：总开关、模型提供商、默认 LLM/Embedding/Rerank、**默认 PDF 解析器（外部模型）**、向量库路径与切片参数等。
3. 点击「保存配置」，配置写入数据库并立即生效，无需改 .env 或重启。
4. API Key 等敏感项在页面上显示为 `***`；留空或保持 `***` 保存表示不修改该 Key。

## 环境变量 / .env（可选兜底）

未在 Web 界面保存过的项，将使用以下环境变量或默认值。

### 总开关

- `RAG_ENABLED=true`：启用 RAG 答疑（否则走原有关键词检索 + 截断）

### LLM（大模型）

- `RAG_LLM_TYPE`：`vllm` | `qianwen` | `zhipu`
- **vLLM（自建）**
  - `RAG_LLM_VLLM_BASE_URL`：如 `http://localhost:8000/v1`
  - `RAG_LLM_VLLM_MODEL`：模型名，空则自动取第一个
  - `RAG_LLM_VLLM_API_KEY`：可选
- **阿里千问**
  - `RAG_LLM_QIANWEN_API_KEY`：必填
  - `RAG_LLM_QIANWEN_MODEL`：如 `qwen-turbo`
- **智谱**
  - `RAG_LLM_ZHIPU_API_KEY`：必填
  - `RAG_LLM_ZHIPU_MODEL`：如 `glm-4-flash`
  - `RAG_LLM_ZHIPU_BASE_URL`：可选，默认智谱 PaaS 地址

### Embedding

- `RAG_EMBEDDING_TYPE`：`builtin` | `external`
- **builtin（程序自带）**
  - 需安装：`pip install sentence-transformers`
  - `RAG_EMBEDDING_BUILTIN_MODEL`：如 `paraphrase-multilingual-MiniLM-L12-v2`（约 384 维）
- **external（外部 API，OpenAI 兼容）**
  - `RAG_EMBEDDING_EXTERNAL_BASE_URL`：如 `https://api.openai.com/v1`
  - `RAG_EMBEDDING_EXTERNAL_API_KEY`：必填
  - `RAG_EMBEDDING_EXTERNAL_MODEL`：如 `text-embedding-3-small`
  - `RAG_EMBEDDING_DIM`：向量维度，须与模型一致

### 向量库（单机 Chroma）

- `RAG_VECTOR_STORE_PATH`：持久化目录，如 `./data/rag_vector_db`
- `RAG_VECTOR_COLLECTION_NAME`：集合名
- `RAG_TOP_K`：检索条数，默认 5
- `RAG_CHUNK_SIZE`：切片长度，默认 400
- `RAG_CHUNK_OVERLAP`：切片重叠，默认 80

### 混合检索与重排（推荐开启）

- `RAG_HYBRID_ENABLED`：是否启用混合检索，默认 `true`
- `RAG_VECTOR_RECALL_K`：向量召回候选数，默认 `30`
- `RAG_SPARSE_RECALL_K`：稀疏召回候选数，默认 `30`
- `RAG_FUSED_TOP_N`：RRF 融合后保留候选数，默认 `60`
- `RAG_RRF_K`：RRF 常量，默认 `60`
- `RAG_QUERY_REWRITE_ENABLED`：是否启用多查询改写，默认 `true`
- `RAG_QUERY_REWRITE_COUNT`：改写路数上限，默认 `4`
- `RAG_HYDE_ENABLED`：是否启用 HyDE 伪文档扩展，默认 `true`
- `RAG_HYDE_MAX_TOKENS`：HyDE 生成长度，默认 `220`
- `RAG_HYDE_TEMPERATURE`：HyDE 温度，默认 `0.2`
- `RAG_RERANK_ENABLED`：是否启用重排，默认 `true`
- `RAG_RERANK_TOP_N`：进入重排的候选数，默认 `60`
- `RAG_NO_ANSWER_THRESHOLD`：无答案阈值（低于该值触发弱兜底），默认 `0.12`

## 建索引

1. **后管台页面**：管理员登录 → **课程管理** → 每个课程行有「重建索引」按钮，点击即可为该课程重建 RAG 向量索引。
2. **接口**：`POST /api/admin/courses/{course_id}/reindex`（需管理员登录）
3. 索引来源：该课程下所有章节的 **知识库文档**、**知识点**、**PPT 幻灯片文本**

## PDF 外部解析器（RAGFlow 风格）

1. 管理员登录 → **RAG 配置** → 先在「模型提供商」添加可用的 VLM 提供商（OpenAI 兼容 / 千问 / 智谱）。
2. 在「设置默认模型」中选择 **默认 PDF 解析器（外部模型）**，格式与其它默认模型一致（`provider_id:model`）。
3. 上传 PDF 时将优先调用该外部模型做页面 OCR/文本提取；若失败，会自动回退到服务端 `PDF_PARSE_ENGINE`（MinerU/PyPDF/Tesseract）链路。
4. 图片扫描件建议优先选择具备视觉 OCR 能力的模型（例如 `gpt-4o`、`qwen-vl-*`、`glm-4v-*`）。

## 示例 .env（千问 + 自带 embedding）

```env
RAG_ENABLED=true
RAG_LLM_TYPE=qianwen
RAG_LLM_QIANWEN_API_KEY=sk-xxx
RAG_EMBEDDING_TYPE=builtin
```

## 示例 .env（vLLM 自建 + 外部 embedding）

```env
RAG_ENABLED=true
RAG_LLM_TYPE=vllm
RAG_LLM_VLLM_BASE_URL=http://192.168.1.100:8000/v1
RAG_LLM_VLLM_MODEL=Qwen2.5-7B-Instruct
RAG_EMBEDDING_TYPE=external
RAG_EMBEDDING_EXTERNAL_BASE_URL=http://192.168.1.100:8001/v1
RAG_EMBEDDING_EXTERNAL_API_KEY=not-needed
RAG_EMBEDDING_EXTERNAL_MODEL=your-embedding-model
RAG_EMBEDDING_DIM=1024
```
