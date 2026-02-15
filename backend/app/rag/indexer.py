"""索引：将课程文档切分、向量化并写入向量库（与业务 DB 解耦，由调用方传入文档列表）"""
from .config import get_rag_settings
from .schema import ChunkDocument
from .chunking import chunk_documents
from .embedding import get_embedding
from .store.chroma_store import ChromaVectorStore
import uuid


def index_course_documents(
    documents: list[ChunkDocument],
    course_id: int,
    *,
    replace: bool = True,
) -> int:
    """
    将某课程的文档列表建索引到向量库。
    documents 由业务层从 KnowledgeDocument / KnowledgePoint / PptSlide 等组装。
    replace=True 时先删除该 course_id 下旧数据再写入。
    返回写入的 chunk 数量。
    """
    if not documents:
        return 0
    settings = get_rag_settings()
    store = ChromaVectorStore(settings)
    if replace:
        store.delete_by_course(course_id)
    chunks = chunk_documents(documents, settings=settings)
    if not chunks:
        return 0
    texts = [c[0] for c in chunks]
    metas = [c[1] for c in chunks]
    embedding = get_embedding(settings)
    embeddings = embedding.embed(texts)
    ids = [f"c{course_id}_{uuid.uuid4().hex[:12]}" for _ in chunks]
    store.add(course_id=course_id, ids=ids, texts=texts, metadatas=metas, embeddings=embeddings)
    return len(ids)
