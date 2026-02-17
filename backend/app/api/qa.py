"""课中/课后答疑：自然语言提问，基于知识库检索返回答案与参考文档定位"""
from pathlib import Path
import re

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_db
from ..db.models import User, QuestionAsked, KnowledgeDocument, KnowledgePoint, Chapter
from ..api.auth import get_current_user
from ..services.qa_engine import answer_from_documents, answer_question, QAResponse

router = APIRouter(prefix="/qa", tags=["qa"])


class AskIn(BaseModel):
    question: str
    course_id: int  # 课程级提问，不接收章节 id


class AskOut(BaseModel):
    answer: str
    document_ref: str | None
    reference_doc_id: int | None = None
    reference_page: int | None = None
    knowledge_point: str | None
    in_scope: bool
    question_asked_id: int | None = None  # 用于「将本条对话提交为学习反馈」


class ReferenceDocOut(BaseModel):
    id: int
    title: str
    source_type: str
    page_ref: str | None
    file_name: str | None


_PAGE_RE = re.compile(r"(?:\[第\s*(\d+)\s*页\]|第\s*(\d+)\s*页|(\d+)\s*页)")
_TOTAL_PAGES_RE = re.compile(r"^\s*(?:共?\s*)?\d+\s*页\s*$")


def _parse_page_num(text: str | None) -> int | None:
    if not text:
        return None
    m = _PAGE_RE.search(text)
    if not m:
        return None
    for g in m.groups():
        if g and g.isdigit():
            n = int(g)
            return n if n > 0 else None
    return None


def _looks_like_total_pages_ref(text: str | None) -> bool:
    s = (text or "").strip()
    if not s:
        return False
    # 例如 "52页" / "共52页" 多为文档总页数，不是命中页
    return bool(_TOTAL_PAGES_RE.match(s))


def _extract_keywords(question: str) -> list[str]:
    q = (question or "").strip().lower()
    if not q:
        return []
    zh = [w for w in re.findall(r"[\u4e00-\u9fff]{2,}", q) if len(w) >= 2]
    en = [w for w in re.findall(r"[a-z0-9]{3,}", q)]
    # 去重并保序
    seen: set[str] = set()
    out: list[str] = []
    for k in zh + en:
        if k not in seen:
            seen.add(k)
            out.append(k)
    return out[:10]


def _estimate_page_from_doc(question: str, content: str) -> int | None:
    text = (content or "").strip()
    if not text:
        return None
    # 按 [第N页] 切分页面块
    parts = re.split(r"\[第\s*(\d+)\s*页\]", text)
    if len(parts) < 3:
        return None
    keywords = _extract_keywords(question)
    if not keywords:
        return None
    best_page: int | None = None
    best_score = 0
    # parts: [prefix, page_num, page_text, page_num, page_text, ...]
    for i in range(1, len(parts) - 1, 2):
        page_s = (parts[i] or "").strip()
        page_text = (parts[i + 1] or "").lower()
        if not page_s.isdigit():
            continue
        score = 0
        for kw in keywords:
            if kw in page_text:
                score += 1
        if score > best_score:
            best_score = score
            best_page = int(page_s)
    return best_page if best_score > 0 else None


def _build_doc_tuples(docs: list, points: list | None = None) -> list[tuple[str, str | None, str | None]]:
    """(content, ref, title) for answer_from_documents"""
    out = []
    for d in docs:
        content = getattr(d, "content", None) or ""
        page_ref = getattr(d, "page_ref", None) or getattr(d, "file_name", None)
        title = getattr(d, "title", None)
        out.append((content, page_ref, title))
    if points:
        for p in points:
            content = getattr(p, "content", None) or getattr(p, "title", None) or ""
            page_ref = getattr(p, "ppt_slide_ref", None)
            title = getattr(p, "title", None)
            out.append((content, page_ref, title))
    return out


def _build_knowledge_miss_answer(question: str) -> str:
    prompt = (
        "你是一名大学计算机课程助教。当前用户问题在课程知识库中没有命中。"
        "请基于通用常识直接回答用户问题，要求：\n"
        "1) 先直接给可执行结论；\n"
        "2) 再给 2-3 条简短建议；\n"
        "3) 不提及知识库、检索或模型；\n"
        "4) 120 字以内。\n"
        f"用户问题：{question}"
    )
    try:
        from ..rag.config import get_rag_settings
        from ..rag.llm import get_llm

        settings = get_rag_settings()
        answer = get_llm(settings).generate(
            prompt,
            max_tokens=min(settings.llm_max_tokens, 220),
            temperature=max(settings.llm_temperature, 0.5),
        )
        text = (answer or "").strip()
        if text:
            return text
    except Exception:
        pass
    return "今年口红常见趋势是低饱和豆沙、奶咖棕、柔雾玫瑰。建议按肤色先试豆沙系，再看通勤/约会场景，优先选保湿不拔干质地。"


def _summarize_doc_answer(question: str, doc_tuples: list[tuple[str, str | None, str | None]]) -> str:
    context_blocks = []
    for idx, (content, ref, title) in enumerate(doc_tuples[:3], start=1):
        context_blocks.append(
            f"[片段{idx}] 标题: {title or '未知'}; 参考: {ref or '无'}\n{(content or '').strip()[:1600]}"
        )
    prompt = (
        "你是一名课程助教。请仅基于给定片段回答学生问题，并清洗 OCR/VLM 噪声（乱码、碎片词、重复文本）。\n"
        "要求：\n"
        "1) 只保留与问题直接相关的信息；\n"
        "2) 用 3-5 句简洁中文回答；\n"
        "3) 不输出无关背景，不编造片段外内容；\n"
        "4) 不输出“根据片段”等提示语。\n\n"
        f"学生问题：{question}\n\n"
        "课程片段：\n"
        + "\n\n".join(context_blocks)
    )
    try:
        from ..rag.config import get_rag_settings
        from ..rag.llm import get_llm

        settings = get_rag_settings()
        answer = get_llm(settings).generate(
            prompt,
            max_tokens=min(settings.llm_max_tokens, 360),
            temperature=min(settings.llm_temperature, 0.4),
        )
        text = (answer or "").strip()
        if text:
            return text
    except Exception:
        pass
    return (answer_from_documents(question, doc_tuples).answer or "").strip()


@router.post("/ask", response_model=AskOut)
async def ask(
    body: AskIn,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
):
    question = (body.question or "").strip()
    course_id = body.course_id
    chapter_ids_by_course: list[int] = []
    r_ids = await db.execute(select(Chapter.id).where(Chapter.course_id == course_id))
    chapter_ids_by_course = [row[0] for row in r_ids.all()]

    # RAG 开关：仅当启用时走 RAG 管道
    import os
    if os.environ.get("RAG_ENABLED", "false").lower() in ("true", "1"):
        try:
            from ..rag import get_rag_settings, rag_ask
            settings = get_rag_settings()
            if settings.enabled:
                answer, ppt_ref, knowledge_point, in_scope = rag_ask(
                    question, course_id, chapter_id=None
                )
                if "未在课程知识库" in (answer or ""):
                    answer = _build_knowledge_miss_answer(question)
                    ppt_ref = "当前问题在知识库中没有参考答案"
                    knowledge_point = None
                    in_scope = False
                question_asked_id = None
                if user:
                    record = QuestionAsked(
                        user_id=user.id,
                        chapter_id=None,
                        question_text=body.question,
                        answer_text=answer,
                        ppt_ref=ppt_ref,
                    )
                    db.add(record)
                    await db.flush()
                    question_asked_id = record.id
                return AskOut(
                    answer=answer,
                    document_ref=ppt_ref,
                    reference_doc_id=None,
                    reference_page=None if _looks_like_total_pages_ref(ppt_ref) else _parse_page_num(ppt_ref),
                    knowledge_point=knowledge_point,
                    in_scope=in_scope,
                    question_asked_id=question_asked_id,
                )
        except Exception:
            pass  # RAG 失败时回退到下方关键词检索

    # 从知识库检索：按课程下全部章节检索，按关键词在 content/title 中匹配（简单 LIKE）
    q_docs = select(KnowledgeDocument)
    if chapter_ids_by_course:
        q_docs = q_docs.where(KnowledgeDocument.chapter_id.in_(chapter_ids_by_course))
    else:
        q_docs = q_docs.where(KnowledgeDocument.chapter_id == -1)
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
    if not docs and question:
        q_pts = select(KnowledgePoint)
        if chapter_ids_by_course:
            q_pts = q_pts.where(KnowledgePoint.chapter_id.in_(chapter_ids_by_course))
        else:
            q_pts = q_pts.where(KnowledgePoint.chapter_id == -1)
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
        fallback_answer = _build_knowledge_miss_answer(question)
        no_ref_msg = "当前问题在知识库中没有参考答案"
        question_asked_id: int | None = None
        if user:
            record = QuestionAsked(
                user_id=user.id,
                chapter_id=None,
                question_text=body.question,
                answer_text=fallback_answer,
                ppt_ref=no_ref_msg,
            )
            db.add(record)
            await db.flush()
            question_asked_id = record.id
        return AskOut(
            answer=fallback_answer,
            document_ref=no_ref_msg,
            reference_doc_id=None,
            reference_page=None,
            knowledge_point=None,
            in_scope=False,
            question_asked_id=question_asked_id,
        )

    primary_doc = docs[0] if docs else None
    doc_tuples = _build_doc_tuples(docs, points if not docs else None)
    if doc_tuples:
        cleaned_answer = _summarize_doc_answer(body.question, doc_tuples)
        first_ref = doc_tuples[0][1]
        first_title = doc_tuples[0][2]
        guessed_page = None
        # PDF 上传文档里 first_ref 常是总页数（如 52页），优先用正文页标记反推命中页
        if primary_doc and (primary_doc.source_type or "") == "pdf_upload":
            if primary_doc.content:
                guessed_page = _estimate_page_from_doc(body.question, primary_doc.content)
            # 仅在不是总页数样式时，才退回引用字段解析
            if guessed_page is None and not _looks_like_total_pages_ref(first_ref):
                guessed_page = _parse_page_num(first_ref)
        else:
            guessed_page = _parse_page_num(first_ref)
            if guessed_page is None and primary_doc and primary_doc.content:
                guessed_page = _estimate_page_from_doc(body.question, primary_doc.content)
        first_ref = f"第{guessed_page}页" if guessed_page else first_ref
        resp = QAResponse(
            answer=cleaned_answer or "请参考教材与课堂文档对应章节。",
            ppt_ref=first_ref,
            knowledge_point=first_title,
            in_scope=True,
        )
    else:
        resp = answer_question(body.question, None)
    question_asked_id: int | None = None
    if user:
        record = QuestionAsked(
            user_id=user.id,
            chapter_id=primary_doc.chapter_id if primary_doc else None,
            question_text=body.question,
            answer_text=resp.answer,
            ppt_ref=resp.ppt_ref,
        )
        db.add(record)
        await db.flush()
        question_asked_id = record.id
    return AskOut(
        answer=resp.answer,
        document_ref=resp.ppt_ref,
        reference_doc_id=primary_doc.id if primary_doc else None,
        reference_page=None if _looks_like_total_pages_ref(resp.ppt_ref) else _parse_page_num(resp.ppt_ref),
        knowledge_point=resp.knowledge_point,
        in_scope=resp.in_scope,
        question_asked_id=question_asked_id,
    )


@router.get("/reference/{doc_id}", response_model=ReferenceDocOut)
async def get_reference_document(
    doc_id: int,
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == doc_id))
    doc = r.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="参考文档不存在")
    return ReferenceDocOut(
        id=doc.id,
        title=doc.title,
        source_type=doc.source_type,
        page_ref=doc.page_ref,
        file_name=doc.file_name,
    )


@router.get("/reference/{doc_id}/file")
async def get_reference_document_file(
    doc_id: int,
    db: AsyncSession = Depends(get_db),
):
    r = await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == doc_id))
    doc = r.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="参考文档不存在")
    if not doc.file_path:
        raise HTTPException(status_code=404, detail="参考文档原文件不存在")
    abs_path = Path(settings.upload_dir) / doc.file_path
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="参考文档文件不存在")
    return FileResponse(
        path=str(abs_path),
        media_type="application/pdf",
        filename=doc.file_name or abs_path.name,
    )
