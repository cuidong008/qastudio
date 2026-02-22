"""根据配置返回 Embedding 实例（内置模型按配置缓存，避免每次请求重复加载）"""
import threading

from ..config import RAGSettings
from .base import BaseEmbedding
from .builtin import BuiltinEmbedding
from .external import ExternalEmbedding

_embedding_cache: dict[tuple, BaseEmbedding] = {}
_embedding_cache_lock = threading.Lock()


def _embedding_cache_key(s: RAGSettings) -> tuple:
    """用于缓存的 key：同配置复用同一实例，切换模型或类型时才会新建。"""
    t = (s.embedding_type or "builtin").strip().lower()
    if t == "external":
        return (
            "external",
            (getattr(s, "embedding_external_base_url", None) or "").strip(),
            (getattr(s, "embedding_external_model", None) or "").strip(),
        )
    return (
        "builtin",
        (getattr(s, "embedding_builtin_model", None) or "paraphrase-multilingual-MiniLM-L12-v2").strip(),
    )


def get_embedding(settings: RAGSettings | None = None) -> BaseEmbedding:
    """返回当前配置对应的 Embedding；内置模型只在首次使用或切换模型时加载，后续直接复用。"""
    from ..config import get_rag_settings

    s = settings or get_rag_settings()
    key = _embedding_cache_key(s)
    with _embedding_cache_lock:
        if key not in _embedding_cache:
            t = (s.embedding_type or "builtin").strip().lower()
            if t == "external":
                _embedding_cache[key] = ExternalEmbedding(s)
            else:
                _embedding_cache[key] = BuiltinEmbedding(
                    s.embedding_builtin_model or "paraphrase-multilingual-MiniLM-L12-v2"
                )
        return _embedding_cache[key]


def clear_embedding_cache() -> None:
    """清除 Embedding 缓存（例如在 Web 界面切换为本地模型或修改模型名后希望立即生效时调用）。"""
    with _embedding_cache_lock:
        _embedding_cache.clear()
