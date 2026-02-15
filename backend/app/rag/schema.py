"""RAG 模块内部数据结构，与业务 DB 解耦"""
from pydantic import BaseModel
from typing import Any


class ChunkDocument(BaseModel):
    """供索引的文档：业务层从 DB 组装后传入。"""
    text: str
    course_id: int
    chapter_id: int | None = None
    page_ref: str | None = None
    title: str | None = None
    source_id: str | None = None  # 如 knowledge_doc id 或 ppt_slide id


class RetrievedChunk(BaseModel):
    """检索到的一条 chunk。"""
    chunk_id: str
    text: str
    metadata: dict[str, Any] = {}
    score: float = 0.0
