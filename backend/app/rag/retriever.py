"""检索：按 course_id（及可选 chapter_id）向量检索"""
from .config import get_rag_settings
from .schema import RetrievedChunk
from .embedding import get_embedding
from .store.chroma_store import ChromaVectorStore


def retrieve(
    question: str,
    course_id: int,
    *,
    chapter_id: int | None = None,
    top_k: int | None = None,
) -> list[RetrievedChunk]:
    """
    在指定课程知识库中检索与问题最相关的 chunk。
    """
    settings = get_rag_settings()
    k = top_k if top_k is not None else settings.top_k
    embedding = get_embedding(settings)
    query_vec = embedding.embed_one(question)
    store = ChromaVectorStore(settings)
    hits = store.search(course_id=course_id, query_embedding=query_vec, top_k=k, chapter_id=chapter_id)
    return [
        RetrievedChunk(chunk_id=h[0], text=h[1], metadata=h[2], score=h[3])
        for h in hits
    ]
