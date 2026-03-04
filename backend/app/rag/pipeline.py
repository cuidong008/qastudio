"""
RAG 管道：对外唯一入口。ask(question, course_id, chapter_id?) -> (answer, ppt_ref, knowledge_point, in_scope)
业务层仅依赖此接口与 indexer；不直接依赖 LLM/Embedding/Store。
"""
from .config import get_rag_settings
from .retriever import retrieve
from .generator import generate_answer


def ask(
    question: str,
    course_id: int,
    *,
    chapter_id: int | None = None,
) -> tuple[str, str | None, str | None, bool, int | None, int | None, str | None]:
    """
    基于 RAG 回答课程问题。
    返回 (answer, ppt_ref, knowledge_point, in_scope, reference_doc_id, reference_page, source_title)。
    若 RAG 未启用或检索为空，由 generator 返回默认提示语。
    """
    question = (question or "").strip()
    if not question:
        return (
            "请输入您的问题。",
            None,
            None,
            True,
            None,
            None,
            None,
        )
    chunks = retrieve(question, course_id, chapter_id=chapter_id)
    return generate_answer(question, chunks)
