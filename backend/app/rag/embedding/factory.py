"""根据配置返回 Embedding 实例"""
from ..config import RAGSettings
from .base import BaseEmbedding
from .builtin import BuiltinEmbedding
from .external import ExternalEmbedding


def get_embedding(settings: RAGSettings | None = None) -> BaseEmbedding:
    from ..config import get_rag_settings
    s = settings or get_rag_settings()
    t = (s.embedding_type or "builtin").strip().lower()
    if t == "external":
        return ExternalEmbedding(s)
    return BuiltinEmbedding(s.embedding_builtin_model or "paraphrase-multilingual-MiniLM-L12-v2")
