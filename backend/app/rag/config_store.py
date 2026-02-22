"""RAG 配置存储：从数据库读写，供 get_rag_settings 使用（Web 界面配置优先于 .env）"""
from __future__ import annotations

import json
import uuid

# 敏感字段：GET 时若已有值则返回占位符，PUT 时若客户端传占位符则不覆盖
SECRET_KEYS = frozenset({
    "llm_vllm_api_key",
    "llm_qianwen_api_key",
    "llm_zhipu_api_key",
    "embedding_external_api_key",
    "embedding_qianwen_api_key",
    "embedding_zhipu_api_key",
})

# 模型提供商相关 key（rag_providers 为 JSON 数组，其内 api_key 需脱敏）
RAG_PROVIDERS_KEY = "rag_providers"
DEFAULT_LLM_KEY = "default_llm"
DEFAULT_EMBEDDING_KEY = "default_embedding"
DEFAULT_RERANK_KEY = "default_rerank"
DEFAULT_PDF_PARSER_KEY = "default_pdf_parser"
DEFAULT_TTS_KEY = "default_tts"

MASKED_PLACEHOLDER = "***"

_cache: dict[str, str] = {}
_loaded = False


def get_all() -> dict[str, str]:
    """返回当前内存中的配置（key -> value），敏感值未脱敏，供 get_rag_settings 用"""
    return dict(_cache)


def get_all_masked() -> dict[str, str]:
    """返回供 API 展示的配置：敏感键若已有值则改为占位符"""
    out = dict(_cache)
    for k in SECRET_KEYS:
        if k in out and (out[k] or "").strip():
            out[k] = MASKED_PLACEHOLDER
    return out


def is_loaded() -> bool:
    return _loaded


async def load_from_db(session) -> None:
    """从数据库加载到内存（启动时或保存后调用）"""
    global _cache, _loaded
    from sqlalchemy import select
    from ..db.models import RagConfig

    result = await session.execute(select(RagConfig))
    rows = result.scalars().all()
    _cache = {r.key: (r.value or "") for r in rows}
    _loaded = True


async def save_to_db(session, updates: dict[str, str | int | float | bool]) -> None:
    """
    将 updates 合并进内存并写库。
    敏感键若值为 MASKED_PLACEHOLDER 或空，则不更新（保留原值）。
    保存后清除 Embedding 实例缓存，使切换模型/类型或 API Key 后下次请求立即生效。
    """
    from ..db.models import RagConfig

    for k, v in updates.items():
        if k in SECRET_KEYS and (v is None or str(v).strip() in ("", MASKED_PLACEHOLDER)):
            continue
        str_val = _to_str(v)
        _cache[k] = str_val
        # upsert
        from sqlalchemy.dialects.sqlite import insert as sqlite_insert
        stmt = sqlite_insert(RagConfig).values(key=k, value=str_val)
        stmt = stmt.on_conflict_do_update(index_elements=["key"], set_={"value": str_val})
        await session.execute(stmt)
    await session.commit()
    # 不再次 load_from_db，已在 _cache 中更新
    try:
        from .embedding.factory import clear_embedding_cache
        clear_embedding_cache()
    except Exception:
        pass

def _to_str(v: str | int | float | bool) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


# ---------- 模型提供商（RAGFlow 风格：先配提供商，再选默认模型）----------

def get_providers_list() -> list[dict]:
    """返回已保存的提供商列表；每条 api_key 若存在则脱敏为 ***"""
    raw = _cache.get(RAG_PROVIDERS_KEY) or "[]"
    try:
        providers = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    out = []
    for p in providers:
        item = dict(p)
        if (item.get("api_key") or "").strip():
            item["api_key"] = MASKED_PLACEHOLDER
        out.append(item)
    return out


def get_providers_list_raw() -> list[dict]:
    """返回提供商列表（未脱敏），仅用于 get_rag_settings 解析"""
    raw = _cache.get(RAG_PROVIDERS_KEY) or "[]"
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []


def get_default_llm() -> str:
    return (_cache.get(DEFAULT_LLM_KEY) or "").strip()


def get_default_embedding() -> str:
    return (_cache.get(DEFAULT_EMBEDDING_KEY) or "").strip()


def get_default_rerank() -> str:
    return (_cache.get(DEFAULT_RERANK_KEY) or "").strip()


def get_default_pdf_parser() -> str:
    return (_cache.get(DEFAULT_PDF_PARSER_KEY) or "").strip()


def get_default_tts() -> str:
    return (_cache.get(DEFAULT_TTS_KEY) or "").strip()


async def save_providers_and_defaults(
    session,
    providers: list[dict],
    default_llm: str = "",
    default_embedding: str = "",
    default_rerank: str = "",
    default_pdf_parser: str = "",
    default_tts: str = "",
) -> None:
    """
    保存提供商列表与默认模型选择。
    providers 中 api_key 若为 *** 或空，则保留该条在库中的原 api_key（需与 get_providers_list_raw 合并）。
    """
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert
    from ..db.models import RagConfig

    existing_raw = get_providers_list_raw()
    by_id = {p["id"]: p for p in existing_raw if p.get("id")}

    merged = []
    for p in providers:
        pid = p.get("id") or str(uuid.uuid4())
        item = {"id": pid, "type": p.get("type", "openai_compatible"), "name": p.get("name", "").strip() or "未命名"}
        item["base_url"] = (p.get("base_url") or "").strip()
        ak = (p.get("api_key") or "").strip()
        if ak and ak != MASKED_PLACEHOLDER:
            item["api_key"] = ak
        elif by_id.get(pid) and (by_id[pid].get("api_key") or "").strip():
            item["api_key"] = by_id[pid]["api_key"]
        else:
            item["api_key"] = ""
        merged.append(item)

    _cache[RAG_PROVIDERS_KEY] = json.dumps(merged, ensure_ascii=False)
    _cache[DEFAULT_LLM_KEY] = (default_llm or "").strip()
    _cache[DEFAULT_EMBEDDING_KEY] = (default_embedding or "").strip()
    _cache[DEFAULT_RERANK_KEY] = (default_rerank or "").strip()
    _cache[DEFAULT_PDF_PARSER_KEY] = (default_pdf_parser or "").strip()
    _cache[DEFAULT_TTS_KEY] = (default_tts or "").strip()

    for key, val in (
        (RAG_PROVIDERS_KEY, _cache[RAG_PROVIDERS_KEY]),
        (DEFAULT_LLM_KEY, _cache[DEFAULT_LLM_KEY]),
        (DEFAULT_EMBEDDING_KEY, _cache[DEFAULT_EMBEDDING_KEY]),
        (DEFAULT_RERANK_KEY, _cache[DEFAULT_RERANK_KEY]),
        (DEFAULT_PDF_PARSER_KEY, _cache[DEFAULT_PDF_PARSER_KEY]),
        (DEFAULT_TTS_KEY, _cache[DEFAULT_TTS_KEY]),
    ):
        stmt = sqlite_insert(RagConfig).values(key=key, value=val)
        stmt = stmt.on_conflict_do_update(index_elements=["key"], set_={"value": val})
        await session.execute(stmt)
    await session.commit()
    try:
        from .embedding.factory import clear_embedding_cache
        clear_embedding_cache()
    except Exception:
        pass
