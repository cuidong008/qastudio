"""
自研 RAG 模块：与业务解耦，可配置 LLM / Embedding / 向量库。
业务层仅通过 rag.pipeline.ask() 调用，或通过 rag.indexer 建索引。
"""
from .config import RAGSettings, get_rag_settings
from .schema import ChunkDocument, RetrievedChunk
from .pipeline import ask as rag_ask
from . import indexer

__all__ = [
    "RAGSettings",
    "get_rag_settings",
    "ChunkDocument",
    "RetrievedChunk",
    "rag_ask",
    "indexer",
]
