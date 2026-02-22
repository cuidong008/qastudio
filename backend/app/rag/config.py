"""RAG 模块配置：优先从 Web 界面写入的数据库读取，其次 .env / 环境变量"""
from pydantic_settings import BaseSettings

from .config_store import (
    get_providers_list_raw,
    get_default_llm,
    get_default_embedding,
)


class RAGSettings(BaseSettings):
    # ----- 总开关 -----
    enabled: bool = False  # 为 True 时业务层使用 RAG 管道，否则走原有关键词+截断

    # ----- LLM：vllm | qianwen | zhipu -----
    llm_type: str = "vllm"
    # vLLM（OpenAI 兼容）
    llm_vllm_base_url: str = "http://localhost:8000/v1"
    llm_vllm_model: str = ""
    llm_vllm_api_key: str = "not-needed"
    # 阿里千问
    llm_qianwen_api_key: str = ""
    llm_qianwen_model: str = "qwen-turbo"
    # 智谱
    llm_zhipu_api_key: str = ""
    llm_zhipu_model: str = "glm-4-flash"
    llm_zhipu_base_url: str = "https://open.bigmodel.cn/api/paas/v4"

    # ----- Embedding：builtin 程序自带 | external 外部 API -----
    embedding_type: str = "builtin"
    embedding_dim: int = 384  # builtin 或外部模型维度需一致
    # builtin：本地模型名（sentence-transformers）
    embedding_builtin_model: str = "paraphrase-multilingual-MiniLM-L12-v2"
    # Hugging Face 镜像（仅影响 builtin 从 HF 下载模型），国内可填 https://hf-mirror.com
    hf_endpoint: str = ""
    # external：OpenAI 兼容或指定厂商
    embedding_external_api_key: str = ""
    embedding_external_base_url: str = ""
    embedding_external_model: str = "text-embedding-3-small"
    embedding_external_batch_size: int = 10
    # 千问 / 智谱 embedding 若用独立 endpoint 可在此配
    embedding_qianwen_api_key: str = ""
    embedding_zhipu_api_key: str = ""

    # ----- 向量库（单机） -----
    vector_store_path: str = "./data/rag_vector_db"
    vector_collection_name: str = "qastudio_chunks"
    top_k: int = 5
    chunk_size: int = 400
    chunk_overlap: int = 80
    # ----- 混合检索 -----
    hybrid_enabled: bool = True
    vector_recall_k: int = 30
    sparse_recall_k: int = 30
    fused_top_n: int = 60
    rrf_k: int = 60
    # ----- Query Rewrite / HyDE -----
    query_rewrite_enabled: bool = True
    query_rewrite_count: int = 4
    hyde_enabled: bool = True
    hyde_max_tokens: int = 220
    hyde_temperature: float = 0.2
    # ----- Rerank -----
    rerank_enabled: bool = True
    rerank_top_n: int = 60
    # ----- 无答案阈值与兜底 -----
    no_answer_threshold: float = 0.12

    # ----- 生成参数 -----
    llm_max_tokens: int = 512
    llm_temperature: float = 0.3

    class Config:
        env_prefix = "RAG_"
        env_file = ".env"
        extra = "ignore"


def _coerce(value: str, field_name: str) -> str | int | float | bool:
    """把 DB 存的字符串按 RAGSettings 字段类型转换"""
    if value is None or value == "":
        return value
    # 根据字段名推断类型（与 RAGSettings 一致）
    int_fields = {
        "embedding_dim",
        "embedding_external_batch_size",
        "top_k",
        "chunk_size",
        "chunk_overlap",
        "vector_recall_k",
        "sparse_recall_k",
        "fused_top_n",
        "rrf_k",
        "query_rewrite_count",
        "hyde_max_tokens",
        "rerank_top_n",
        "llm_max_tokens",
    }
    float_fields = {"llm_temperature", "hyde_temperature", "no_answer_threshold"}
    bool_fields = {
        "enabled",
        "hybrid_enabled",
        "query_rewrite_enabled",
        "hyde_enabled",
        "rerank_enabled",
    }
    if field_name in bool_fields:
        return value.lower() in ("true", "1", "yes")
    if field_name in int_fields:
        try:
            return int(value)
        except ValueError:
            return value
    if field_name in float_fields:
        try:
            return float(value)
        except ValueError:
            return value
    return value


def _resolve_from_providers() -> dict:
    """
    若已配置「模型提供商」与「默认模型」，则根据其解析出 llm_* / embedding_* 的覆盖项。
    返回可合并进 defaults 的 dict（仅包含 RAGSettings 的字段）。
    """
    providers = get_providers_list_raw()
    default_llm = get_default_llm()
    default_embedding = get_default_embedding()
    if not default_llm and not default_embedding:
        return {}

    by_id = {p["id"]: p for p in providers if p.get("id")}
    overlay = {}

    # 解析 default_llm → provider_id:model_name
    if default_llm and ":" in default_llm:
        pid, model_name = default_llm.split(":", 1)
        pid, model_name = pid.strip(), model_name.strip()
        if pid and model_name and pid in by_id:
            prov = by_id[pid]
            t = (prov.get("type") or "openai_compatible").strip().lower()
            base = (prov.get("base_url") or "").strip()
            ak = (prov.get("api_key") or "").strip()
            if t == "openai_compatible":
                overlay["llm_type"] = "vllm"
                overlay["llm_vllm_base_url"] = base or "http://localhost:8000/v1"
                overlay["llm_vllm_model"] = model_name
                overlay["llm_vllm_api_key"] = ak or "not-needed"
            elif t == "qianwen":
                overlay["llm_type"] = "qianwen"
                overlay["llm_qianwen_api_key"] = ak
                overlay["llm_qianwen_model"] = model_name
            elif t == "zhipu":
                overlay["llm_type"] = "zhipu"
                overlay["llm_zhipu_api_key"] = ak
                overlay["llm_zhipu_model"] = model_name
                overlay["llm_zhipu_base_url"] = (prov.get("base_url") or "").strip() or "https://open.bigmodel.cn/api/paas/v4"

    # 解析 default_embedding（支持 builtin、openai_compatible、千问、智谱）
    if default_embedding:
        if default_embedding.strip().lower() == "builtin":
            overlay["embedding_type"] = "builtin"
        elif ":" in default_embedding:
            pid, model_name = default_embedding.split(":", 1)
            pid, model_name = pid.strip(), model_name.strip()
            if pid and model_name and pid in by_id:
                prov = by_id[pid]
                t = (prov.get("type") or "openai_compatible").strip().lower()
                ak = (prov.get("api_key") or "").strip()
                overlay["embedding_type"] = "external"
                overlay["embedding_external_model"] = model_name
                if t == "openai_compatible":
                    base = (prov.get("base_url") or "").strip()
                    overlay["embedding_external_base_url"] = base or "https://api.openai.com/v1"
                    overlay["embedding_external_api_key"] = ak or "not-needed"
                    overlay["embedding_dim"] = 1536 if ("1536" in model_name or "3-small" in model_name) else 384
                elif t == "qianwen":
                    # 千问 DashScope 兼容 OpenAI 的 embedding：https://dashscope.aliyuncs.com/compatible-mode/v1
                    overlay["embedding_external_base_url"] = "https://dashscope.aliyuncs.com/compatible-mode/v1"
                    overlay["embedding_external_api_key"] = ak
                    overlay["embedding_dim"] = 1536 if "v3" in model_name else 1024
                elif t == "zhipu":
                    overlay["embedding_external_base_url"] = (prov.get("base_url") or "").strip() or "https://open.bigmodel.cn/api/paas/v4"
                    overlay["embedding_external_api_key"] = ak
                    overlay["embedding_dim"] = 2048 if "embedding-3" in model_name else 1024

    return overlay


# 仅从 .env 读取的 key，不随 Web 配置存库（如 Hugging Face 镜像）
_ENV_ONLY_KEYS = frozenset({"hf_endpoint"})


def get_rag_settings() -> RAGSettings:
    """优先使用 Web 界面（数据库）中的配置；若配置了模型提供商与默认模型则据此解析，否则用传统 key 与 .env"""
    defaults = RAGSettings().model_dump()
    try:
        from .config_store import get_all, is_loaded
        if is_loaded():
            db = get_all()
            for key, val in db.items():
                if key in _ENV_ONLY_KEYS:
                    continue  # hf_endpoint 等仅从 .env 读取
                if key in defaults and val is not None and str(val).strip() != "":
                    defaults[key] = _coerce(str(val), key)
            # 若存在提供商与默认模型，则用其覆盖 llm / embedding 相关项
            overlay = _resolve_from_providers()
            for k, v in overlay.items():
                if k in defaults:
                    defaults[k] = v
    except Exception:
        pass
    return RAGSettings(**defaults)
