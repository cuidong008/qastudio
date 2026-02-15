# 自研 RAG 模块配置说明

RAG 模块与业务解耦。**优先通过后管台 Web 界面配置**（与 [RAGFlow 的 Model providers](https://ragflow.io/docs/llm_api_key_setup) 类似），未在界面配置的项再回退到环境变量或 `.env`（前缀 `RAG_`）。

## 通过 Web 界面配置（推荐）

1. 管理员登录 → 进入 **RAG 配置**（或 `/admin/rag`）。
2. 在页面中填写或修改：总开关、LLM 类型与对应 API 地址/Key、Embedding 类型与模型、向量库路径与切片参数等。
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

## 建索引

1. **后管台页面**：管理员登录 → **课程管理** → 每个课程行有「重建索引」按钮，点击即可为该课程重建 RAG 向量索引。
2. **接口**：`POST /api/admin/courses/{course_id}/reindex`（需管理员登录）
3. 索引来源：该课程下所有章节的 **知识库文档**、**知识点**、**PPT 幻灯片文本**

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
