"""课中/课后答疑：自然语言提问，基于知识库检索返回答案与参考文档定位"""
from pathlib import Path
import re
import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_db
from ..db.models import User, UserRole, QuestionAsked, KnowledgeDocument, KnowledgePoint, Chapter, Course
from ..api.auth import get_current_user
from ..services.qa_engine import answer_from_documents, answer_question, QAResponse
from ..rag.generator import distill_answer_if_raw

router = APIRouter(prefix="/qa", tags=["qa"])
logger = logging.getLogger(__name__)


class AskIn(BaseModel):
    question: str
    course_id: int | None = None  # 课程级提问；教师可传 null 表示「全部课程」


class AskOut(BaseModel):
    answer: str
    document_ref: str | None
    reference_doc_id: int | None = None
    reference_page: int | None = None
    reference_doc_title: str | None = None  # 参考文档名称（文件名或标题），用于展示「参考文档：文件名，第xx页」
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


def _judge_course_relevance(question: str, course_name: str | None, answer: str) -> bool:
    """大模型判断该问题是否与当前课程无关。返回 True=无关，False=有关。异常时返回 False。"""
    course_label = (course_name or "未指定课程").strip() or "未指定课程"
    prompt = (
        "你负责判断：用户下面提的问题是否与「当前课程」内容相关。\n"
        "当前课程名：" + course_label + "\n"
        "用户问题：" + (question or "").strip() + "\n"
        "若问题明显与课程知识点、教材、课堂内容无关（如闲聊、其他学科、无关话题），请仅回复一个字：否。\n"
        "若与课程有关或难以判断，请仅回复一个字：是。\n"
        "只输出「是」或「否」，不要其他内容。"
    )
    try:
        from ..rag.config import get_rag_settings
        from ..rag.llm import get_llm
        settings = get_rag_settings()
        out = get_llm(settings).generate(
            prompt,
            max_tokens=10,
            temperature=0.1,
        )
        text = (out or "").strip()
        if "否" in text and "是" not in text:
            return True
        return False
    except Exception:
        return False


# 大模型也未能给出合适答案时，统一返回的提示文案
NO_MATCH_ANSWER = "该问题未匹配到合适答案，建议结合教材和课堂PPT复习"


def _is_no_match_response(text: str) -> bool:
    """判断大模型返回是否表示「无法匹配到合适答案」（含旧话术与约定短语）。"""
    t = (text or "").strip()
    if not t:
        return True
    if "无法匹配到合适答案" in t and len(t) < 80:
        return True
    if t == "无法匹配到合适答案" or t.replace(" ", "").replace("　", "") == "无法匹配到合适答案":
        return True
    # 大模型可能仍返回旧话术，也视为未匹配，统一替换为新提示
    if "未在课程知识库中匹配到相关内容" in t or ("未在课程知识库" in t and "结合教材" in t):
        return True
    return False


def _try_llm_answer_or_no_match(question: str) -> tuple[bool, str]:
    """
    先让大模型尝试回答问题；若模型判定无法给出匹配度合适的答案，则返回固定提示。
    返回 (found_suitable_answer, answer_text)。若未找到合适答案，answer_text 为 NO_MATCH_ANSWER。
    """
    prompt = (
        "你是一名课程助教。请尝试回答用户问题。\n"
        "若你能基于课程或通用知识给出匹配度合适的答案，请直接写出答案（2～5 句，简洁）。\n"
        "若你无法给出匹配度合适的答案（如问题与课程明显无关、或信息不足无法回答），请只输出一行：无法匹配到合适答案。\n\n"
        f"用户问题：{question}"
    )
    try:
        from ..rag.config import get_rag_settings
        from ..rag.llm import get_llm

        settings = get_rag_settings()
        answer = get_llm(settings).generate(
            prompt,
            max_tokens=min(settings.llm_max_tokens, 280),
            temperature=max(settings.llm_temperature, 0.4),
        )
        text = (answer or "").strip()
        if _is_no_match_response(text):
            return (False, NO_MATCH_ANSWER)
        return (True, text)
    except Exception:
        return (False, NO_MATCH_ANSWER)


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

    if course_id is not None:
        r_ids = await db.execute(select(Chapter.id).where(Chapter.course_id == course_id))
        chapter_ids_by_course = [row[0] for row in r_ids.all()]
    else:
        # 教师/教研组长「全部课程」：在其名下全部课程的章节内检索；admin 不选课程时在全库章节内检索
        role = getattr(user, "role", None) if user else None
        if not user or role not in ("teacher", "teaching_leader", "admin"):
            raise HTTPException(status_code=400, detail="请选择课程")
        if role == "admin":
            r_ch = await db.execute(select(Chapter.id))
            chapter_ids_by_course = [row[0] for row in r_ch.all()]
        else:
            r_courses = await db.execute(select(Course.id).where(Course.owner_teacher_id == user.id))
            teacher_course_ids = [row[0] for row in r_courses.all()]
            if not teacher_course_ids:
                chapter_ids_by_course = []
            else:
                r_ch = await db.execute(select(Chapter.id).where(Chapter.course_id.in_(teacher_course_ids)))
                chapter_ids_by_course = [row[0] for row in r_ch.all()]

    # RAG 开关：以数据库配置（后管台）为准；仅单课程时走 RAG
    try:
        from ..rag import get_rag_settings, rag_ask

        settings = get_rag_settings()
        if settings.enabled and course_id is not None:
            answer, ppt_ref, knowledge_point, in_scope, rag_reference_doc_id, rag_reference_page, rag_source_title = rag_ask(
                question, course_id, chapter_id=None
            )
            logger.warning(
                "[RAG-TRACE] qa_api after rag_ask answer_len=%s preview=%r ppt_ref=%r",
                len(answer or ""),
                (answer or "")[:150],
                ppt_ref,
            )
            # 无 chunks（情况2）或 有 chunks 但模型判为未匹配（情况1）：统一由大模型尝试作答，无合适答案再给固定提示
            if "当前问题在知识库中没有参考答案" in (ppt_ref or ""):
                if answer is None or (answer or "").strip() == "":
                    _, answer = _try_llm_answer_or_no_match(question)
                if _is_no_match_response(answer or ""):
                    answer = NO_MATCH_ANSWER
            elif "未在课程知识库" in (answer or "") and not (ppt_ref or knowledge_point):
                logger.warning("[RAG-TRACE] qa_api_rag_miss_try_llm_then_fixed q=%r course_id=%s", question, course_id)
                _, answer = _try_llm_answer_or_no_match(question)
                ppt_ref = "当前问题在知识库中没有参考答案"
                knowledge_point = None
                in_scope = False
            else:
                logger.warning(
                    "[RAG-TRACE] qa_api_rag_hit q=%r course_id=%s ref=%r kp=%r in_scope=%s",
                    question,
                    course_id,
                    ppt_ref,
                    knowledge_point,
                    in_scope,
                )
            # 兜底：任一路径若答案仍是“未匹配”话术（含旧版），先让大模型尝试作答，仍无合适答案再给固定提示
            if _is_no_match_response(answer or ""):
                logger.warning("[RAG-TRACE] qa_api_rag_unified_no_match_try_llm q=%r", question)
                _, answer = _try_llm_answer_or_no_match(question)
                if _is_no_match_response(answer or ""):
                    answer = NO_MATCH_ANSWER
                ppt_ref = "当前问题在知识库中没有参考答案"
                knowledge_point = None
                in_scope = False
            # 在本地知识库中没能找到合适答案时，对学生角色调用大模型判断是否与当前所选课程无关，并记录
            if "当前问题在知识库中没有参考答案" in (ppt_ref or ""):
                course_irrelevant = None
                if user and getattr(user, "role", None) == UserRole.student.value and course_id is not None:
                    course_name_for_judge = None
                    r_course = await db.execute(select(Course.name).where(Course.id == course_id))
                    row = r_course.one_or_none()
                    if row:
                        course_name_for_judge = row[0]
                    course_irrelevant = _judge_course_relevance(question, course_name_for_judge, answer or "")
            else:
                course_irrelevant = False
            # 若答案仍像课件原文，用大模型蒸馏成针对问题的简洁回答（RAG 与非 RAG 统一）
            logger.warning("[RAG-TRACE] qa_api before distill_answer_if_raw")
            answer = distill_answer_if_raw(question, answer or "")
            logger.warning("[RAG-TRACE] qa_api after distill_answer_if_raw answer_len=%s", len(answer or ""))
            question_asked_id = None
            if user:
                rag_hit = bool(
                    ((ppt_ref or "").strip() and "当前问题在知识库中没有参考答案" not in (ppt_ref or ""))
                    or (knowledge_point or "").strip()
                )
                record = QuestionAsked(
                    user_id=user.id,
                    course_id=course_id,
                    chapter_id=None,
                    question_text=body.question,
                    answer_text=answer,
                    ppt_ref=ppt_ref,
                    rag_hit=rag_hit,
                    course_irrelevant=course_irrelevant if "当前问题在知识库中没有参考答案" in (ppt_ref or "") else False,
                )
                db.add(record)
                await db.flush()
                question_asked_id = record.id
            # 大模型作答且无参考答案时，只展示“当前问题在知识库中没有参考答案”，不展示参考文档/文件名
            no_answer_ref = "当前问题在知识库中没有参考答案" in (ppt_ref or "")
            reference_doc_title = None
            out_reference_doc_id = rag_reference_doc_id
            out_reference_page = rag_reference_page if rag_reference_page and rag_reference_page > 0 else (
                None if _looks_like_total_pages_ref(ppt_ref) else _parse_page_num(ppt_ref)
            )
            if not no_answer_ref:
                if rag_reference_doc_id is not None:
                    r_doc = await db.execute(
                        select(KnowledgeDocument.file_name, KnowledgeDocument.title).where(
                            KnowledgeDocument.id == rag_reference_doc_id
                        )
                    )
                    row = r_doc.one_or_none()
                    if row:
                        reference_doc_title = (row[0] or row[1] or "").strip() or None
                if reference_doc_title is None and (rag_source_title or "").strip() and (ppt_ref or "").strip():
                    reference_doc_title = (rag_source_title or "").strip()
            else:
                out_reference_doc_id = None
                out_reference_page = None
            return AskOut(
                answer=answer,
                document_ref=ppt_ref,
                reference_doc_id=out_reference_doc_id,
                reference_page=out_reference_page,
                reference_doc_title=reference_doc_title,
                knowledge_point=knowledge_point,
                in_scope=in_scope,
                question_asked_id=question_asked_id,
            )
        logger.warning("[RAG-TRACE] qa_api_rag_disabled_by_config course_id=%s", course_id)
    except Exception as e:
        logger.warning("[RAG-TRACE] qa_api rag path failed or disabled, fallback to keyword: %s", e)
        pass  # RAG 失败时回退到下方关键词检索

    # 从知识库检索：按课程下全部章节检索，按关键词在 content/title 中匹配（简单 LIKE）
    logger.warning("[RAG-TRACE] qa_api using KEYWORD path (no RAG or RAG failed)")
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
        # 关键词路径也无命中：先让大模型尝试作答，若无合适答案再给固定提示
        _, fallback_answer = _try_llm_answer_or_no_match(question)
        no_ref_msg = "当前问题在知识库中没有参考答案"
        # 在本地知识库中没能找到合适答案时，对学生角色调用大模型判断是否与当前所选课程无关，并记录
        course_irrelevant_fallback = None
        if user and getattr(user, "role", None) == UserRole.student.value and course_id is not None:
            course_name_for_judge = None
            r_course = await db.execute(select(Course.name).where(Course.id == course_id))
            row = r_course.one_or_none()
            if row:
                course_name_for_judge = row[0]
            course_irrelevant_fallback = _judge_course_relevance(question, course_name_for_judge, fallback_answer)
        question_asked_id: int | None = None
        if user:
            record = QuestionAsked(
                user_id=user.id,
                course_id=course_id,
                chapter_id=None,
                question_text=body.question,
                answer_text=fallback_answer,
                ppt_ref=no_ref_msg,
                rag_hit=False,
                course_irrelevant=course_irrelevant_fallback,
            )
            db.add(record)
            await db.flush()
            question_asked_id = record.id
        return AskOut(
            answer=fallback_answer,
            document_ref=no_ref_msg,
            reference_doc_id=None,
            reference_page=None,
            reference_doc_title=None,
            knowledge_point=None,
            in_scope=False,
            question_asked_id=question_asked_id,
        )

    primary_doc = docs[0] if docs else None
    doc_tuples = _build_doc_tuples(docs, points if not docs else None)
    if doc_tuples:
        cleaned_answer = _summarize_doc_answer(body.question, doc_tuples)
        logger.warning(
            "[RAG-TRACE] qa_api keyword path after _summarize_doc_answer answer_len=%s preview=%r",
            len(cleaned_answer or ""),
            (cleaned_answer or "")[:150],
        )
        # 若仍像课件原文（如 LLM 未总结或失败后用了 answer_from_documents 的截断原文），蒸馏成简洁回答
        cleaned_answer = distill_answer_if_raw(body.question, cleaned_answer or "")
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
        # 教师端学情统计按 rag_hit=True 口径统计“命中课程知识”的提问。
        # 这里属于非 RAG 引擎分支，但只要命中了文档/知识点并给出课程内回答，仍应记为命中。
        fallback_rag_hit = bool(doc_tuples and resp.in_scope and ((resp.ppt_ref or "").strip() or (resp.knowledge_point or "").strip()))
        record_chapter_id = primary_doc.chapter_id if primary_doc else (points[0].chapter_id if points else None)
        record = QuestionAsked(
            user_id=user.id,
            course_id=course_id,
            chapter_id=record_chapter_id,
            question_text=body.question,
            answer_text=resp.answer,
            ppt_ref=resp.ppt_ref,
            rag_hit=fallback_rag_hit,
            course_irrelevant=False,
        )
        db.add(record)
        await db.flush()
        question_asked_id = record.id
    reference_doc_title = None
    if primary_doc:
        reference_doc_title = (primary_doc.file_name or primary_doc.title or "").strip() or None
    return AskOut(
        answer=resp.answer,
        document_ref=resp.ppt_ref,
        reference_doc_id=primary_doc.id if primary_doc else None,
        reference_page=None if _looks_like_total_pages_ref(resp.ppt_ref) else _parse_page_num(resp.ppt_ref),
        reference_doc_title=reference_doc_title,
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
