"""简单文本切片：按长度与重叠，保留元数据"""
from .schema import ChunkDocument
from .config import RAGSettings, get_rag_settings


def chunk_documents(
    documents: list[ChunkDocument],
    chunk_size: int | None = None,
    chunk_overlap: int | None = None,
    settings: RAGSettings | None = None,
) -> list[tuple[str, dict]]:
    """
    将文档列表切分为 (text, metadata) 列表。
    metadata 含 course_id, chapter_id, page_ref, title 等，供向量库与生成时使用。
    """
    s = settings or get_rag_settings()
    size = chunk_size if chunk_size is not None else s.chunk_size
    overlap = chunk_overlap if chunk_overlap is not None else s.chunk_overlap
    out = []
    for i, doc in enumerate(documents):
        meta = {
            "course_id": doc.course_id,
            "chapter_id": doc.chapter_id,
            "page_ref": doc.page_ref,
            "title": doc.title,
            "source_id": doc.source_id,
        }
        text = (doc.text or "").strip()
        if not text:
            continue
        if len(text) <= size:
            out.append((text, {**meta, "chunk_index": 0}))
            continue
        start = 0
        idx = 0
        while start < len(text):
            end = start + size
            piece = text[start:end]
            out.append((piece, {**meta, "chunk_index": idx}))
            idx += 1
            start = end - overlap
            if start >= len(text):
                break
    return out
