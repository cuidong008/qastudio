"""课中/课后答疑：自然语言提问，基于知识库检索返回答案与 PPT 定位"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..db.models import User, QuestionAsked, KnowledgeDocument, KnowledgePoint, Chapter
from ..api.auth import get_current_user
from ..services.qa_engine import answer_from_documents, answer_question, QAResponse

router = APIRouter(prefix="/qa", tags=["qa"])


class AskIn(BaseModel):
    question: str
    chapter_id: int | None = None
    course_id: int | None = None  # 可选；若不传则从 chapter_id 解析


class AskOut(BaseModel):
    answer: str
    ppt_ref: str | None
    knowledge_point: str | None
    in_scope: bool
    question_asked_id: int | None = None  # 用于「将本条对话提交为学习反馈」


def _build_doc_tuples(docs: list, points: list | None = None) -> list[tuple[str, str | None, str | None]]:
    """(content, page_ref, title) for answer_from_documents"""
    out = []
    for d in docs:
        content = getattr(d, "content", None) or ""
        page_ref = getattr(d, "page_ref", None)
        title = getattr(d, "title", None)
        out.append((content, page_ref, title))
    if points:
        for p in points:
            content = getattr(p, "content", None) or getattr(p, "title", None) or ""
            page_ref = getattr(p, "ppt_slide_ref", None)
            title = getattr(p, "title", None)
            out.append((content, page_ref, title))
    return out


@router.post("/ask", response_model=AskOut)
async def ask(
    body: AskIn,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
):
    question = (body.question or "").strip()
    course_id = body.course_id
    if course_id is None and body.chapter_id is not None:
        r_ch = await db.execute(select(Chapter).where(Chapter.id == body.chapter_id))
        ch = r_ch.scalar_one_or_none()
        if ch and ch.course_id is not None:
            course_id = ch.course_id

    # RAG 开关：仅当启用且能确定 course_id 时才导入并走 RAG 管道
    import os
    if os.environ.get("RAG_ENABLED", "false").lower() in ("true", "1") and course_id is not None:
        try:
            from ..rag import get_rag_settings, rag_ask
            settings = get_rag_settings()
            if settings.enabled:
                answer, ppt_ref, knowledge_point, in_scope = rag_ask(
                    question, course_id, chapter_id=body.chapter_id
                )
                question_asked_id = None
                if user:
                    record = QuestionAsked(
                        user_id=user.id,
                        chapter_id=body.chapter_id,
                        question_text=body.question,
                        answer_text=answer,
                        ppt_ref=ppt_ref,
                    )
                    db.add(record)
                    await db.flush()
                    question_asked_id = record.id
                return AskOut(
                    answer=answer,
                    ppt_ref=ppt_ref,
                    knowledge_point=knowledge_point,
                    in_scope=in_scope,
                    question_asked_id=question_asked_id,
                )
        except Exception:
            pass  # RAG 失败时回退到下方关键词检索

    # 从知识库检索：优先限定章节，按关键词在 content/title 中匹配（简单 LIKE）
    q_docs = select(KnowledgeDocument)
    if body.chapter_id is not None:
        q_docs = q_docs.where(KnowledgeDocument.chapter_id == body.chapter_id)
    if question:
        like = f"%{question[:50]}%"
        q_docs = q_docs.where(
            or_(
                KnowledgeDocument.content.ilike(like),
                KnowledgeDocument.title.ilike(like),
            )
        )
    q_docs = q_docs.order_by(KnowledgeDocument.id).limit(3)
    doc_result = await db.execute(q_docs)
    docs = list(doc_result.scalars().all())
    # 若无文档匹配，再查知识点表（标题/内容）
    points: list = []
    if not docs and question and body.chapter_id is not None:
        q_pts = select(KnowledgePoint).where(KnowledgePoint.chapter_id == body.chapter_id)
        like = f"%{question[:30]}%"
        q_pts = q_pts.where(
            or_(
                KnowledgePoint.title.ilike(like),
                KnowledgePoint.content.ilike(like),
            )
        )
        q_pts = q_pts.order_by(KnowledgePoint.order_index).limit(2)
        pts_result = await db.execute(q_pts)
        points = list(pts_result.scalars().all())
    if not docs and not points and question:
        # 放宽：不按关键词，只按章节取第一条文档
        q_fallback = select(KnowledgeDocument)
        if body.chapter_id is not None:
            q_fallback = q_fallback.where(KnowledgeDocument.chapter_id == body.chapter_id)
        q_fallback = q_fallback.order_by(KnowledgeDocument.id).limit(1)
        fallback = await db.execute(q_fallback)
        docs = list(fallback.scalars().all())
    doc_tuples = _build_doc_tuples(docs, points if not docs else None)
    resp = answer_from_documents(body.question, doc_tuples) if doc_tuples else answer_question(body.question, body.chapter_id)
    question_asked_id: int | None = None
    if user:
        record = QuestionAsked(
            user_id=user.id,
            chapter_id=body.chapter_id,
            question_text=body.question,
            answer_text=resp.answer,
            ppt_ref=resp.ppt_ref,
        )
        db.add(record)
        await db.flush()
        question_asked_id = record.id
    return AskOut(
        answer=resp.answer,
        ppt_ref=resp.ppt_ref,
        knowledge_point=resp.knowledge_point,
        in_scope=resp.in_scope,
        question_asked_id=question_asked_id,
    )
