"""教师端：教学内容配置、课程/班级管理、学情数据监控与导出"""
import asyncio
import base64
import csv
import difflib
import io
import json
import logging
import mimetypes
import os
import re
import subprocess
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, Query, HTTPException, UploadFile, File, BackgroundTasks
from fastapi.responses import StreamingResponse, FileResponse
from openai import OpenAI
from pydantic import BaseModel, Field
from sqlalchemy import select, func, delete
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_db
from ..db.session import AsyncSessionLocal
from ..db.models import (
    User, Class, Course, Chapter, Teaching, UserRole,
    StudentClassMembership,
    Question, KnowledgePoint, KnowledgeDocument, PreviewRecord,
    AnswerRecord, QuestionAsked, ChapterConfig, CourseQuestionSynonym, QuestionGenerationTask, DocumentProcessTask,
)
from ..api.auth import require_teacher
from ..services.chapter_cleanup_service import cleanup_chapter_related_data
from ..services.course_knowledge_service import clear_course_knowledge

router = APIRouter(prefix="/teacher", tags=["teacher"])
logger = logging.getLogger(__name__)
DOC_PROCESS_TASK_STALE_MINUTES = 30


class ConfigChapterIn(BaseModel):
    chapter_id: int
    preview_enabled: bool = True
    preview_video_url: str | None = None
    difficulty_filter: list[str] | None = None  # 只开放某几种难度
    question_limit: int | None = None


class ChapterConfigOut(BaseModel):
    chapter_id: int
    title: str
    preview_enabled: bool
    preview_video_url: str | None
    difficulty_filter: list[str]  # 解析后的列表
    question_limit: int | None


class StatsOverviewOut(BaseModel):
    preview_completion_rate: float
    total_questions_asked: int
    top_asked: list[dict]
    answer_accuracy_rate: float
    weak_knowledge_points: list[str]


@router.get("/config/chapters", response_model=list[ChapterConfigOut])
async def list_chapter_configs(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """获取所有章节及其配置（用于教师端配置页）"""
    chapter_qry = select(Chapter).order_by(Chapter.order_index, Chapter.id)
    if user.role == UserRole.teacher.value:
        chapter_qry = (
            select(Chapter)
            .join(Course, Course.id == Chapter.course_id)
            .where(Course.owner_teacher_id == user.id)
            .order_by(Chapter.order_index, Chapter.id)
        )
    r_ch = await db.execute(chapter_qry)
    chapters = r_ch.scalars().all()
    r_cfg = await db.execute(select(ChapterConfig))
    configs = {c.chapter_id: c for c in r_cfg.scalars().all()}
    out = []
    for ch in chapters:
        cfg = configs.get(ch.id)
        df = (cfg.difficulty_filter or "").strip()
        difficulty_filter = [x.strip() for x in df.split(",") if x.strip()] if df else []
        out.append(ChapterConfigOut(
            chapter_id=ch.id,
            title=ch.title,
            preview_enabled=cfg.preview_enabled if cfg else True,
            preview_video_url=(cfg.preview_video_url if cfg else None),
            difficulty_filter=difficulty_filter,
            question_limit=cfg.question_limit if cfg else None,
        ))
    return out


@router.put("/config/chapter")
async def config_chapter(
    body: ConfigChapterIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """持久化章节配置：预习开关、难度筛选、题量限制"""
    chapter_qry = select(Chapter).where(Chapter.id == body.chapter_id)
    if user.role == UserRole.teacher.value:
        chapter_qry = (
            select(Chapter)
            .join(Course, Course.id == Chapter.course_id)
            .where(Chapter.id == body.chapter_id, Course.owner_teacher_id == user.id)
        )
    r = await db.execute(chapter_qry)
    if not r.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="章节不存在")
    r = await db.execute(select(ChapterConfig).where(ChapterConfig.chapter_id == body.chapter_id))
    cfg = r.scalar_one_or_none()
    difficulty_str = ",".join(body.difficulty_filter) if body.difficulty_filter else None
    if cfg:
        cfg.preview_enabled = body.preview_enabled
        cfg.preview_video_url = (body.preview_video_url or "").strip() or None
        cfg.difficulty_filter = difficulty_str
        cfg.question_limit = body.question_limit
    else:
        cfg = ChapterConfig(
            chapter_id=body.chapter_id,
            preview_enabled=body.preview_enabled,
            preview_video_url=(body.preview_video_url or "").strip() or None,
            difficulty_filter=difficulty_str,
            question_limit=body.question_limit,
        )
        db.add(cfg)
    await db.commit()
    return {"ok": True, "chapter_id": body.chapter_id}


class TeacherCourseOut(BaseModel):
    id: int
    name: str
    code: str | None
    description: str | None
    is_active: bool
    owner_teacher_id: int | None
    created_at: str | None


class TeacherCourseCreateIn(BaseModel):
    name: str
    code: str | None = None
    description: str | None = None
    is_active: bool = True


class TeacherCourseUpdateIn(BaseModel):
    name: str | None = None
    code: str | None = None
    description: str | None = None
    is_active: bool | None = None


class TeacherChapterOut(BaseModel):
    id: int
    course_id: int | None
    title: str
    order_index: int
    syllabus_ref: str | None
    question_count: int = 0


class TeacherChapterCreateIn(BaseModel):
    title: str
    order_index: int = 0
    syllabus_ref: str | None = None


class TeacherChapterUpdateIn(BaseModel):
    title: str | None = None
    order_index: int | None = None
    syllabus_ref: str | None = None


class TeacherKnowledgePointOut(BaseModel):
    id: int
    chapter_id: int
    title: str
    content: str | None
    ppt_slide_ref: str | None
    order_index: int


class TeacherKnowledgePointIn(BaseModel):
    title: str
    content: str | None = None
    ppt_slide_ref: str | None = None
    order_index: int | None = None


class TeacherKnowledgePointSaveIn(BaseModel):
    knowledge_points: list[TeacherKnowledgePointIn]


class TeacherGenerateKnowledgePointsIn(BaseModel):
    count: int = Field(default=5, ge=1, le=20)


class TeacherGenerateQuestionsIn(BaseModel):
    single_choice_max: int = Field(default=0, ge=0, le=30)
    multiple_choice_max: int = Field(default=0, ge=0, le=30)
    judge_max: int = Field(default=0, ge=0, le=30)
    qa_max: int = Field(default=0, ge=0, le=30)
    blank_max: int = Field(default=0, ge=0, le=30)


class TeacherGenerateTaskOut(BaseModel):
    ok: bool = True
    task_id: int
    status: str


class TeacherGenerateTaskStatusOut(BaseModel):
    id: int
    course_id: int
    chapter_id: int
    status: str
    request_payload: dict
    result_payload: dict | None
    error_message: str | None
    created_at: str | None
    updated_at: str | None


class TeacherDocumentProcessTaskOut(BaseModel):
    ok: bool = True
    task_id: int
    status: str


class TeacherDocumentProcessTaskStatusOut(BaseModel):
    id: int
    course_id: int
    chapter_id: int
    doc_id: int
    status: str
    request_payload: dict
    result_payload: dict | None
    error_message: str | None
    created_at: str | None
    updated_at: str | None


class TeacherQuestionOut(BaseModel):
    id: int
    course_id: int | None
    course_name: str | None
    chapter_id: int
    chapter_title: str
    question_type: str
    difficulty: str
    question_text: str
    options: str | None
    correct_answer: str
    explanation: str | None
    created_at: str | None


class TeacherQuestionUpdateIn(BaseModel):
    difficulty: str | None = None
    question_text: str | None = None
    options: list[str] | None = None
    correct_answer: str | None = None
    explanation: str | None = None


class TeacherDocumentChunkOut(BaseModel):
    index: int
    text: str


class TeacherKnowledgeDocumentOut(BaseModel):
    id: int
    chapter_id: int | None
    source_type: str
    title: str
    page_ref: str | None
    file_name: str | None
    file_size: int | None
    parse_status: str | None
    parse_error: str | None
    chunk_count: int | None
    created_at: str | None


class TeacherKnowledgeDocumentDetailOut(TeacherKnowledgeDocumentOut):
    content_preview: str
    chunks: list[TeacherDocumentChunkOut]


class TeacherClassOut(BaseModel):
    id: int
    name: str
    term: str | None
    course_id: int | None
    course_name: str | None = None
    owner_teacher_id: int | None
    student_count: int = 0
    created_at: str | None


class TeacherClassCreateIn(BaseModel):
    name: str
    term: str | None = None
    course_id: int


class TeacherClassUpdateIn(BaseModel):
    name: str | None = None
    term: str | None = None
    course_id: int | None = None


class TeacherStudentOut(BaseModel):
    id: int
    username: str
    student_no: str | None
    display_name: str | None


class TeacherClassStudentsAssignIn(BaseModel):
    student_ids: list[int] = []
    student_no: str | None = None
    name: str | None = None


async def _require_owned_course(db: AsyncSession, teacher_id: int, course_id: int) -> Course:
    r = await db.execute(select(Course).where(Course.id == course_id, Course.owner_teacher_id == teacher_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="课程不存在或无权限")
    return c


async def _require_owned_class(db: AsyncSession, teacher_id: int, class_id: int) -> Class:
    r = await db.execute(select(Class).where(Class.id == class_id, Class.owner_teacher_id == teacher_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="班级不存在或无权限")
    return c


async def _require_owned_chapter(db: AsyncSession, teacher_id: int, chapter_id: int) -> tuple[Chapter, Course]:
    r = await db.execute(
        select(Chapter, Course)
        .join(Course, Course.id == Chapter.course_id)
        .where(Chapter.id == chapter_id, Course.owner_teacher_id == teacher_id)
    )
    row = r.first()
    if not row:
        raise HTTPException(status_code=404, detail="章节不存在或无权限")
    return row[0], row[1]


async def _require_owned_document(db: AsyncSession, teacher_id: int, doc_id: int) -> tuple[KnowledgeDocument, Chapter, Course]:
    r = await db.execute(
        select(KnowledgeDocument, Chapter, Course)
        .join(Chapter, Chapter.id == KnowledgeDocument.chapter_id)
        .join(Course, Course.id == Chapter.course_id)
        .where(KnowledgeDocument.id == doc_id, Course.owner_teacher_id == teacher_id)
    )
    row = r.first()
    if not row:
        raise HTTPException(status_code=404, detail="文档不存在或无权限")
    return row[0], row[1], row[2]


def _is_document_task_stale(task: DocumentProcessTask) -> bool:
    ref = task.updated_at or task.created_at
    if not ref:
        return False
    return (datetime.utcnow() - ref) > timedelta(minutes=DOC_PROCESS_TASK_STALE_MINUTES)


async def _reconcile_document_process_tasks(
    db: AsyncSession,
    teacher_id: int,
    *,
    chapter_id: int | None = None,
    doc_id: int | None = None,
) -> set[int]:
    q = select(DocumentProcessTask).where(
        DocumentProcessTask.teacher_id == teacher_id,
        DocumentProcessTask.status.in_(["pending", "running"]),
    )
    if chapter_id is not None:
        q = q.where(DocumentProcessTask.chapter_id == chapter_id)
    if doc_id is not None:
        q = q.where(DocumentProcessTask.doc_id == doc_id)
    q = q.order_by(DocumentProcessTask.id.desc())
    r = await db.execute(q)
    tasks = r.scalars().all()
    active_doc_ids: set[int] = set()
    has_changes = False
    for task in tasks:
        if _is_document_task_stale(task):
            msg = f"任务超时或服务重启中断（超过 {DOC_PROCESS_TASK_STALE_MINUTES} 分钟未更新）"
            logger.warning(
                "doc_task_stale_mark_failed task_id=%s doc_id=%s status=%s updated_at=%s",
                task.id,
                task.doc_id,
                task.status,
                task.updated_at.isoformat() if task.updated_at else None,
            )
            task.status = "failed"
            task.error_message = msg
            rd = await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == task.doc_id))
            d = rd.scalar_one_or_none()
            if d is not None and d.parse_status == "processing":
                d.parse_status = "failed"
                if not (d.parse_error or "").strip():
                    d.parse_error = msg[:500]
            has_changes = True
            continue
        active_doc_ids.add(int(task.doc_id))
    if has_changes:
        await db.commit()
    return active_doc_ids


def _safe_pdf_filename(name: str) -> str:
    base, ext = os.path.splitext(name)
    safe = re.sub(r"[^\w\-.]", "_", base)[:96]
    final_ext = ext.lower() if ext.lower() == ".pdf" else ".pdf"
    return (safe or "document") + final_ext


def _safe_upload_filename(name: str) -> str:
    base, ext = os.path.splitext(name or "")
    safe = re.sub(r"[^\w\-.]", "_", base)[:96]
    suffix = (ext or "").lower()[:10]
    return (safe or "file") + suffix


def _normalize_text_key(text: str) -> str:
    return re.sub(r"\s+", "", (text or "").strip().lower())


def _extract_json_payload(raw: str) -> list[dict]:
    text = (raw or "").strip()
    if not text:
        return []
    candidates = [text]
    for pat in (r"\{[\s\S]*\}", r"\[[\s\S]*\]"):
        for m in re.finditer(pat, text):
            candidates.append(m.group(0))
    for c in candidates:
        try:
            obj = json.loads(c)
        except Exception:
            continue
        if isinstance(obj, dict) and isinstance(obj.get("questions"), list):
            return [x for x in obj["questions"] if isinstance(x, dict)]
        if isinstance(obj, list):
            return [x for x in obj if isinstance(x, dict)]
    return []


def _to_question_type(value: str) -> str | None:
    s = (value or "").strip().lower()
    if s in {"single_choice", "single", "choice", "mcq", "select", "单选", "单选题", "选择题"}:
        return "single_choice"
    if s in {"multiple_choice", "multiple", "multi", "multi_select", "多选", "多选题"}:
        return "multiple_choice"
    if s in {"judge", "true_false", "tf", "判断题"}:
        return "judge"
    if s in {"qa", "short_answer", "essay", "问答题", "简答题"}:
        return "qa"
    if s in {"blank", "fill_blank", "fill", "填空题"}:
        return "blank"
    return None


def _normalize_choice_options(options_raw: object) -> list[str]:
    if not isinstance(options_raw, list):
        return []
    cleaned: list[str] = []
    for item in options_raw:
        t = str(item or "").strip()
        if not t:
            continue
        t = re.sub(r"^[A-Da-d][\.\)\、\s]+", "", t).strip()
        if t:
            cleaned.append(t)
    return cleaned[:4]


def _normalize_choice_answer(answer_raw: object, options: list[str]) -> str | None:
    s = str(answer_raw or "").strip()
    if not s:
        return None
    m = re.match(r"^([A-Da-d])\b", s)
    if m:
        idx = ord(m.group(1).upper()) - ord("A")
        if 0 <= idx < len(options):
            return chr(ord("A") + idx)
    s_clean = re.sub(r"^[A-Da-d][\.\)\、\s]+", "", s).strip().lower()
    for i, opt in enumerate(options):
        if opt.lower() == s_clean:
            return chr(ord("A") + i)
    return None


def _normalize_judge_answer(answer_raw: object) -> str | None:
    s = str(answer_raw or "").strip().lower()
    if s in {"a", "正确", "对", "true", "t", "yes", "是"}:
        return "A"
    if s in {"b", "错误", "错", "false", "f", "no", "否"}:
        return "B"
    return None


def _trim_answer(value: object, max_len: int = 32) -> str:
    s = str(value or "").strip()
    return s[:max_len] if len(s) > max_len else s


def _normalize_difficulty(value: object) -> str:
    s = str(value or "").strip().lower()
    if s in {"basic", "基础"}:
        return "basic"
    if s in {"applied", "应用"}:
        return "applied"
    if s in {"extended", "拓展", "提高"}:
        return "extended"
    return "basic"


def _difficulty_limits(total: int) -> dict[str, int]:
    if total <= 0:
        return {"basic": 0, "applied": 0, "extended": 0}
    # 默认按 4:3:3 分配（基础:应用:拓展）
    weights = {"basic": 4, "applied": 3, "extended": 3}
    raw = {k: total * w / 10 for k, w in weights.items()}
    base = {k: int(v) for k, v in raw.items()}
    remain = total - sum(base.values())
    order = sorted(raw.keys(), key=lambda k: (raw[k] - base[k]), reverse=True)
    i = 0
    while remain > 0:
        base[order[i % len(order)]] += 1
        remain -= 1
        i += 1
    return base


def _normalize_multi_answer(value: object) -> str:
    s = str(value or "").upper().strip()
    parts = re.split(r"[,，、\s]+", s)
    letters = sorted({p for p in parts if p in {"A", "B", "C", "D"}})
    return ",".join(letters)


def _compact_match_text(text: str) -> str:
    t = (text or "").strip().lower()
    t = re.sub(r"\s+", "", t)
    t = re.sub(r"[，,。.!！?？:：;；、/\\\"'“”‘’`~·()\[\]{}<>《》【】\-_=+|]+", "", t)
    return t


def _tokenize_match_text(text: str) -> set[str]:
    s = _compact_match_text(text)
    if not s:
        return set()
    tokens: set[str] = set()
    for m in re.finditer(r"[a-z0-9]{2,}", s):
        tokens.add(m.group(0))
    cjk_segs = re.findall(r"[\u4e00-\u9fff]+", s)
    for seg in cjk_segs:
        n = len(seg)
        if n == 1:
            tokens.add(seg)
            continue
        for l in (2, 3):
            if n < l:
                continue
            for i in range(0, n - l + 1):
                tokens.add(seg[i:i + l])
    return tokens


def _build_chapter_kp_matchers(kp_rows: list[tuple[int, str, str | None]]) -> list[dict]:
    out: list[dict] = []
    for kp_id, title, content in kp_rows:
        title_text = (title or "").strip()
        if not title_text:
            continue
        content_text = (content or "").strip()
        compact_title = _compact_match_text(title_text)
        combined = f"{title_text}\n{content_text[:200]}".strip()
        out.append(
            {
                "id": int(kp_id),
                "title": title_text,
                "title_compact": compact_title,
                "tokens": _tokenize_match_text(combined),
            }
        )
    return out


def _match_question_kp_ids(
    question_text: str,
    explanation: str | None,
    chapter_kp_matchers: list[dict],
    limit: int = 3,
) -> list[int]:
    if not chapter_kp_matchers:
        return []
    q_text = (question_text or "").strip()
    if not q_text:
        return []
    q_compact = _compact_match_text(q_text)
    e_compact = _compact_match_text(explanation or "")
    q_tokens = _tokenize_match_text(q_text + "\n" + (explanation or ""))
    scored: list[tuple[int, int]] = []
    for item in chapter_kp_matchers:
        score = 0
        title_compact = item["title_compact"]
        if title_compact and len(title_compact) >= 2:
            if title_compact in q_compact:
                score += 8
            if e_compact and title_compact in e_compact:
                score += 5
            if q_compact and q_compact in title_compact:
                score += 2
        overlap = len(q_tokens.intersection(item["tokens"]))
        if overlap > 0:
            score += overlap
        if score > 0:
            scored.append((int(item["id"]), int(score)))
    scored.sort(key=lambda x: (-x[1], x[0]))
    return [kp_id for kp_id, _ in scored[:limit]]


def _build_generate_questions_prompt(
    chapter_title: str,
    context: str,
    single_choice_max: int,
    multiple_choice_max: int,
    judge_max: int,
    qa_max: int,
    blank_max: int,
    diff_basic_target: int,
    diff_applied_target: int,
    diff_extended_target: int,
) -> str:
    return f"""你是一名严谨的课程出题助手。请仅根据给定章节内容出题，不得超纲。

章节标题：{chapter_title}
题量上限：
- single_choice(单选题)：最多 {single_choice_max} 题
- multiple_choice(多选题)：最多 {multiple_choice_max} 题
- judge(判断题)：最多 {judge_max} 题
- qa(问答题)：最多 {qa_max} 题
- blank(填空题)：最多 {blank_max} 题
难度目标（尽量贴近）：
- basic(基础)：约 {diff_basic_target} 题
- applied(应用)：约 {diff_applied_target} 题
- extended(拓展)：约 {diff_extended_target} 题

要求：
1) 题目要清晰、覆盖关键知识点。
2) 单选题必须提供 4 个选项，correct_answer 必须是 A/B/C/D 且仅一个答案。
3) 多选题必须提供 4 个选项，correct_answer 用逗号分隔多个字母（如 A,C），至少 2 个答案。
4) 判断题 correct_answer 必须是 A 或 B，A=正确，B=错误。
5) 问答题与填空题提供标准答案（简短），不超过 32 字。
6) 每题给 difficulty: basic|applied|extended。
7) 仅输出 JSON，不要输出 markdown 或解释。

输出格式（严格）：
{{
  "questions": [
    {{
      "type": "single_choice|multiple_choice|judge|qa|blank",
      "difficulty": "basic|applied|extended",
      "question_text": "题干",
      "options": ["选项1","选项2","选项3","选项4"], 
      "correct_answer": "A",
      "explanation": "解析"
    }}
  ]
}}
说明：qa/blank 的 options 传 []；multiple_choice 的 correct_answer 示例 "A,C"。

章节内容：
{context}
"""


def _extract_knowledge_points_payload(raw: str) -> list[dict]:
    text = (raw or "").strip()
    if not text:
        return []
    candidates = [text]
    for pat in (r"\{[\s\S]*\}", r"\[[\s\S]*\]"):
        for m in re.finditer(pat, text):
            candidates.append(m.group(0))
    for c in candidates:
        try:
            obj = json.loads(c)
        except Exception:
            continue
        if isinstance(obj, dict) and isinstance(obj.get("knowledge_points"), list):
            return [x for x in obj["knowledge_points"] if isinstance(x, dict)]
        if isinstance(obj, list):
            return [x for x in obj if isinstance(x, dict)]
    return []


def _build_generate_knowledge_points_prompt(
    chapter_title: str,
    syllabus_ref: str | None,
    context: str,
    count: int,
) -> str:
    return f"""你是一名课程教研助理。请根据给定章节内容，提炼适合课堂教学的知识点。

章节标题：{chapter_title}
教学大纲引用：{(syllabus_ref or "无").strip()}
目标数量：{count}

要求：
1) 输出 {count} 条知识点，尽量覆盖概念、原理、应用场景。
2) title 控制在 8~24 字，避免重复、避免空泛。
3) content 用 1~2 句话解释，便于教师讲解。
4) ppt_slide_ref 可为空字符串。
5) 仅输出 JSON，不要输出 markdown 或解释。

输出格式（严格）：
{{
  "knowledge_points": [
    {{
      "title": "知识点标题",
      "content": "知识点解释",
      "ppt_slide_ref": ""
    }}
  ]
}}

章节材料：
{context}
"""


async def _generate_knowledge_points_for_chapter(
    db: AsyncSession,
    chapter: Chapter,
    count: int,
) -> list[TeacherKnowledgePointIn]:
    r_docs = await db.execute(
        select(KnowledgeDocument.title, KnowledgeDocument.content, KnowledgeDocument.page_ref)
        .where(KnowledgeDocument.chapter_id == chapter.id)
        .order_by(KnowledgeDocument.id.desc())
        .limit(30)
    )
    doc_rows = r_docs.all()
    context_parts: list[str] = []
    for title, content, page_ref in doc_rows:
        c = (content or "").strip()
        if not c:
            continue
        header = f"文档：{(title or '').strip()}".strip()
        if page_ref:
            header += f"（{page_ref}）"
        context_parts.append(f"{header}\n{c}")
    if not context_parts:
        context_parts.append(f"章节标题：{chapter.title}\n教学大纲：{chapter.syllabus_ref or '无'}")
    context = "\n\n---\n\n".join(context_parts).strip()
    if len(context) > 18000:
        context = context[:18000]

    from ..rag.config import get_rag_settings
    from ..rag.llm import get_llm

    settings = get_rag_settings()
    llm = get_llm(settings)
    prompt = _build_generate_knowledge_points_prompt(
        chapter_title=chapter.title,
        syllabus_ref=chapter.syllabus_ref,
        context=context,
        count=count,
    )
    raw = llm.generate(
        prompt,
        max_tokens=max(1000, int(settings.llm_max_tokens or 512)),
        temperature=0.2,
    )
    items = _extract_knowledge_points_payload(raw)
    if not items:
        raise RuntimeError("模型返回结果无法解析，请重试")

    out: list[TeacherKnowledgePointIn] = []
    seen: set[str] = set()
    for item in items:
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        key = _normalize_text_key(title)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(
            TeacherKnowledgePointIn(
                title=title[:128],
                content=(str(item.get("content") or "").strip() or None),
                ppt_slide_ref=(str(item.get("ppt_slide_ref") or "").strip() or None),
            )
        )
        if len(out) >= count:
            break
    if not out:
        raise RuntimeError("未生成有效知识点，请重试")
    return out


def _pdf_extract_text(content: bytes) -> tuple[str, int]:
    try:
        from pypdf import PdfReader
    except ModuleNotFoundError as e:
        raise HTTPException(status_code=500, detail="缺少依赖 pypdf，请先安装后重试") from e
    try:
        reader = PdfReader(io.BytesIO(content))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PDF 解析失败: {str(e)}")
    pages = []
    for i, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if text:
            pages.append(f"[第{i}页]\n{text}")
    return "\n\n".join(pages).strip(), len(reader.pages)


def _looks_like_useful_text(text: str, prefer_chinese: bool = False) -> bool:
    if not text:
        return False
    stripped = text.strip()
    if len(stripped) < 20:
        return False
    # 至少有一定数量的中英文数字字符，避免只有 markdown 框架或图片链接
    visible_chars = re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", stripped)
    if len(visible_chars) < 15:
        return False
    if prefer_chinese and _cjk_char_count(stripped) < 20:
        return False
    if prefer_chinese:
        cjk = _cjk_char_count(stripped)
        latin = len(re.findall(r"[A-Za-z]", stripped))
        # 中文场景中，若英文字母显著多于中文，通常是 OCR 乱码
        if cjk * 3 < latin:
            return False
    return True


def _cjk_char_count(text: str) -> int:
    if not text:
        return 0
    return len(re.findall(r"[\u4e00-\u9fff]", text))


def _list_tesseract_langs() -> set[str]:
    try:
        proc = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=10)
        if proc.returncode != 0:
            return set()
        langs = set()
        for line in (proc.stdout or "").splitlines():
            s = line.strip()
            if not s or s.lower().startswith("list of available languages"):
                continue
            langs.add(s)
        return langs
    except Exception:
        return set()


def _pdf_extract_text_with_tesseract(content: bytes, prefer_chinese: bool = False) -> tuple[str, int | None]:
    try:
        import pypdfium2 as pdfium
    except ModuleNotFoundError as e:
        raise RuntimeError("缺少 pypdfium2，无法启用 tesseract OCR 兜底") from e
    langs = _list_tesseract_langs()
    has_chinese_lang = "chi_sim" in langs or "chi_tra" in langs
    if "chi_sim" in langs:
        lang = "chi_sim+eng"
    elif "chi_tra" in langs:
        lang = "chi_tra+eng"
    elif "eng" in langs:
        if prefer_chinese:
            raise RuntimeError("tesseract 未安装中文语言包（chi_sim/chi_tra），无法可靠识别中文扫描件")
        lang = "eng"
    else:
        raise RuntimeError("tesseract 缺少可用语言包，请安装 chi_sim 或 eng")

    doc = pdfium.PdfDocument(io.BytesIO(content))
    texts: list[str] = []
    page_count = len(doc)
    with tempfile.TemporaryDirectory(prefix="qastudio_tesseract_") as tmpdir:
        root = Path(tmpdir)
        for i in range(page_count):
            page = doc[i]
            pil_img = page.render(scale=2.2).to_pil()
            img_path = root / f"p{i + 1}.png"
            pil_img.save(img_path)
            cmd = ["tesseract", str(img_path), "stdout", "-l", lang, "--psm", "6"]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
            if proc.returncode != 0:
                logger.warning("tesseract_page_failed page=%s rc=%s stderr=%s", i + 1, proc.returncode, (proc.stderr or "")[:240])
                continue
            txt = (proc.stdout or "").strip()
            if txt:
                texts.append(f"[第{i + 1}页]\n{txt}")
    out = "\n\n".join(texts).strip()
    if not out:
        hint = ""
        if not has_chinese_lang:
            hint = "（当前 tesseract 未安装中文语言包，可安装 chi_sim）"
        raise RuntimeError(f"tesseract OCR 未提取到文本{hint}")
    if prefer_chinese and _cjk_char_count(out) < 20:
        raise RuntimeError("OCR 结果几乎不含中文，可能未安装中文语言包或图片质量过低")
    return out, page_count


def _pdf_extract_text_with_mineru(content: bytes, file_name: str, method: str | None = None) -> tuple[str, int | None]:
    safe_name = _safe_pdf_filename(file_name)
    with tempfile.TemporaryDirectory(prefix="qastudio_mineru_") as tmpdir:
        root = Path(tmpdir)
        in_pdf = root / safe_name
        out_dir = root / "out"
        in_pdf.write_bytes(content)
        out_dir.mkdir(parents=True, exist_ok=True)
        cmd = [
            "mineru",
            "-p",
            str(in_pdf),
            "-o",
            str(out_dir),
            "-m",
            (method or settings.mineru_method or "auto"),
            "-l",
            settings.mineru_lang or "ch",
            "-b",
            settings.mineru_backend or "pipeline",
            "-d",
            settings.mineru_device or "cpu",
            "--vram",
            str(settings.mineru_vram or 1),
            "--source",
            settings.mineru_source or "huggingface",
        ]
        logger.info(
            "mineru_start file=%s size=%s method=%s lang=%s backend=%s device=%s source=%s",
            file_name,
            len(content),
            (method or settings.mineru_method or "auto"),
            settings.mineru_lang or "ch",
            settings.mineru_backend or "pipeline",
            settings.mineru_device or "cpu",
            settings.mineru_source or "huggingface",
        )
        run_env = os.environ.copy()
        run_env.setdefault("MINERU_DEVICE_MODE", settings.mineru_device or "cpu")
        run_env.setdefault("MINERU_VIRTUAL_VRAM_SIZE", str(settings.mineru_vram or 1))
        run_env.setdefault("MINERU_MODEL_SOURCE", settings.mineru_source or "huggingface")
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=run_env)
        except FileNotFoundError as e:
            logger.exception("mineru_not_found file=%s", file_name)
            raise RuntimeError("mineru 命令不存在，请先安装 MinerU") from e
        logger.info(
            "mineru_done file=%s rc=%s stdout_len=%s stderr_len=%s",
            file_name,
            proc.returncode,
            len(proc.stdout or ""),
            len(proc.stderr or ""),
        )
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip()
            logger.error("mineru_failed file=%s detail=%s", file_name, detail[:500])
            if "No module named 'doclayout_yolo'" in detail or 'No module named "doclayout_yolo"' in detail:
                detail = f"{detail}\nHint: pip install doclayout-yolo"
            raise RuntimeError(detail or "MinerU 解析失败")
        out_files = [str(p.relative_to(out_dir)) for p in out_dir.rglob("*") if p.is_file()]
        logger.info("mineru_outputs file=%s count=%s files=%s", file_name, len(out_files), out_files[:30])
        text_candidates: list[str] = []
        for md in sorted(out_dir.rglob("*.md"), key=lambda p: p.stat().st_size, reverse=True):
            try:
                txt = md.read_text(encoding="utf-8", errors="ignore").strip()
                if txt:
                    text_candidates.append(txt)
            except Exception:
                pass
        for txtf in sorted(out_dir.rglob("*.txt"), key=lambda p: p.stat().st_size, reverse=True):
            try:
                txt = txtf.read_text(encoding="utf-8", errors="ignore").strip()
                if txt:
                    text_candidates.append(txt)
            except Exception:
                pass
        for js in sorted(out_dir.rglob("*.json"), key=lambda p: p.stat().st_size, reverse=True):
            try:
                obj = json.loads(js.read_text(encoding="utf-8", errors="ignore"))
            except Exception:
                continue
            pieces: list[str] = []

            def walk(v):
                if isinstance(v, dict):
                    for vv in v.values():
                        walk(vv)
                elif isinstance(v, list):
                    for vv in v:
                        walk(vv)
                elif isinstance(v, str):
                    s = v.strip()
                    if s:
                        pieces.append(s)

            walk(obj)
            if pieces:
                text_candidates.append("\n".join(pieces))
        best = max(text_candidates, key=len).strip() if text_candidates else ""
        logger.info(
            "mineru_text_candidates file=%s candidates=%s best_len=%s",
            file_name,
            len(text_candidates),
            len(best),
        )
        if not best:
            detail = (proc.stderr or proc.stdout or "").strip()
            logger.error("mineru_empty_text file=%s detail=%s", file_name, detail[:500])
            if "No module named 'doclayout_yolo'" in detail or 'No module named "doclayout_yolo"' in detail:
                detail = f"{detail}\nHint: pip install doclayout-yolo"
            raise RuntimeError(f"MinerU 解析后未提取到文本。{detail[:300]}")
        page_count: int | None = None
        try:
            from pypdf import PdfReader
            page_count = len(PdfReader(io.BytesIO(content)).pages)
        except Exception:
            page_count = None
        return best, page_count


def _resolve_pdf_parser_provider(default_pdf_parser: str) -> tuple[dict, str]:
    if not default_pdf_parser or ":" not in default_pdf_parser:
        raise RuntimeError("PDF 外部解析器配置无效（应为 provider_id:model）")
    provider_id, model_name = default_pdf_parser.split(":", 1)
    provider_id, model_name = provider_id.strip(), model_name.strip()
    if not provider_id or not model_name:
        raise RuntimeError("PDF 外部解析器配置无效（provider/model 为空）")

    from ..rag.config_store import get_providers_list_raw
    providers = get_providers_list_raw()
    provider = next((p for p in providers if (p.get("id") or "").strip() == provider_id), None)
    if not provider:
        raise RuntimeError("PDF 外部解析器配置的提供商不存在，请重新选择")
    return provider, model_name


def _create_vlm_client_from_provider(provider: dict) -> OpenAI:
    p_type = (provider.get("type") or "openai_compatible").strip().lower()
    base_url = (provider.get("base_url") or "").strip()
    api_key = (provider.get("api_key") or "").strip()

    if p_type == "openai_compatible":
        base = base_url or "https://api.openai.com/v1"
        if not base.endswith("/v1"):
            base = base.rstrip("/") + "/v1"
        return OpenAI(base_url=base, api_key=api_key or "not-needed")
    if p_type == "qianwen":
        return OpenAI(base_url="https://dashscope.aliyuncs.com/compatible-mode/v1", api_key=api_key)
    if p_type == "zhipu":
        base = base_url or "https://open.bigmodel.cn/api/paas/v4"
        return OpenAI(base_url=base, api_key=api_key)
    raise RuntimeError(f"不支持的提供商类型: {p_type}")


def _pdf_extract_text_with_external_vlm(
    content: bytes,
    file_name: str,
    default_pdf_parser: str,
    prefer_chinese: bool = False,
) -> tuple[str, int]:
    provider, model_name = _resolve_pdf_parser_provider(default_pdf_parser)
    client = _create_vlm_client_from_provider(provider)
    provider_name = provider.get("name") or provider.get("id") or "unknown"

    try:
        import pypdfium2 as pdfium
    except ModuleNotFoundError as e:
        raise RuntimeError("缺少 pypdfium2，无法使用外部模型解析 PDF") from e

    doc = pdfium.PdfDocument(io.BytesIO(content))
    page_count = len(doc)
    if page_count <= 0:
        raise RuntimeError("PDF 页数为 0")

    logger.info(
        "doc_parse_external_vlm_start file=%s provider=%s model=%s pages=%s",
        file_name,
        provider_name,
        model_name,
        page_count,
    )

    page_texts: list[str] = []
    ocr_prompt = (
        "你是 PDF OCR 提取器。请逐字提取图片中的正文文本与表格内容，"
        "保留原有段落与换行，不要总结，不要解释，不要添加额外内容。"
    )

    for i in range(page_count):
        page = doc[i]
        image = page.render(scale=2.0).to_pil()
        with io.BytesIO() as buf:
            image.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")

        # 不同 OpenAI 兼容网关对多模态消息格式要求不一致，做两种格式重试
        message_variants = [
            [
                {"role": "system", "content": ocr_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "请提取这一页的可见文字。"},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                    ],
                },
            ],
            [
                {"role": "system", "content": ocr_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "请提取这一页的可见文字。"},
                        {"type": "image_url", "image_url": f"data:image/png;base64,{b64}"},
                    ],
                },
            ],
        ]

        max_tokens = 1800
        resp = None
        last_err: Exception | None = None
        for messages in message_variants:
            try:
                resp = client.chat.completions.create(
                    model=model_name,
                    messages=messages,
                    temperature=0,
                    max_tokens=max_tokens,
                )
                break
            except Exception as e:
                last_err = e
                msg = str(e)
                m = re.search(r"Range of max_tokens should be \[1,\s*(\d+)\]", msg)
                if m:
                    upper = max(1, int(m.group(1)))
                    try:
                        resp = client.chat.completions.create(
                            model=model_name,
                            messages=messages,
                            temperature=0,
                            max_tokens=min(max_tokens, upper),
                        )
                        break
                    except Exception as e2:
                        last_err = e2
                        continue
                # 仅参数类错误尝试下一个格式，其它错误直接抛出
                if ("invalid_parameter" in msg.lower()) or ("Invalid parameter" in msg):
                    continue
                raise
        if resp is None:
            if last_err is not None:
                raise RuntimeError(f"外部模型请求失败（参数不兼容或模型不支持图像）: {last_err}") from last_err
            raise RuntimeError("外部模型请求失败（未知错误）")
        text = ""
        if resp.choices:
            msg = resp.choices[0].message
            content_obj = msg.content
            if isinstance(content_obj, str):
                text = content_obj.strip()
            elif isinstance(content_obj, list):
                parts = []
                for part in content_obj:
                    if isinstance(part, dict):
                        t = (part.get("text") or "").strip()
                        if t:
                            parts.append(t)
                text = "\n".join(parts).strip()
        if text:
            page_texts.append(f"[第{i + 1}页]\n{text}")

    output = "\n\n".join(page_texts).strip()
    if not _looks_like_useful_text(output, prefer_chinese=prefer_chinese):
        raise RuntimeError("外部模型解析完成，但文本质量不足")
    return output, page_count


async def _parse_pdf_document_and_reindex(
    *,
    db: AsyncSession,
    doc: KnowledgeDocument,
    chapter: Chapter,
    course: Course,
    file_binary: bytes,
    file_name: str,
) -> None:
    """解析 PDF 文档并触发课程索引重建；异常由调用方统一处理并回写状态。"""
    engine = (settings.pdf_parse_engine or "mineru_then_pypdf").strip().lower()
    prefer_chinese = bool(re.search(r"[\u4e00-\u9fff]", file_name or "")) or (settings.mineru_lang or "").startswith("ch")
    default_pdf_parser = ""
    try:
        from ..rag.config_store import get_default_pdf_parser
        default_pdf_parser = get_default_pdf_parser()
    except Exception:
        default_pdf_parser = ""
    logger.info(
        "doc_parse_start chapter_id=%s course_id=%s doc_id=%s file=%s size=%s engine=%s default_pdf_parser=%s",
        chapter.id,
        course.id,
        doc.id,
        file_name,
        len(file_binary),
        engine,
        bool(default_pdf_parser),
    )
    extracted_text = ""
    total_pages: int | None = None
    mineru_errors: list[str] = []
    if default_pdf_parser:
        try:
            extracted_text, total_pages = _pdf_extract_text_with_external_vlm(
                file_binary,
                file_name,
                default_pdf_parser,
                prefer_chinese=prefer_chinese,
            )
            logger.info(
                "doc_parse_external_vlm_ok file=%s text_len=%s pages=%s",
                file_name,
                len((extracted_text or "").strip()),
                total_pages,
            )
        except Exception as e:
            logger.warning("doc_parse_external_vlm_failed file=%s err=%s", file_name, str(e))
            raise HTTPException(status_code=400, detail=f"外部 PDF 解析失败: {str(e)}")
    if engine == "mineru":
        if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
            try:
                extracted_text, total_pages = _pdf_extract_text_with_mineru(file_binary, file_name, method=settings.mineru_method or "auto")
            except Exception as e:
                logger.warning("doc_parse_mineru_auto_error file=%s err=%s", file_name, str(e))
                mineru_errors.append(str(e))
            if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
                try:
                    extracted_text, total_pages = _pdf_extract_text_with_mineru(file_binary, file_name, method="ocr")
                except Exception as e:
                    logger.warning("doc_parse_mineru_ocr_error file=%s err=%s", file_name, str(e))
                    mineru_errors.append(str(e))
    elif engine == "pypdf":
        if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
            logger.info("doc_parse_use_pypdf file=%s", file_name)
            try:
                extracted_text, total_pages = _pdf_extract_text(file_binary)
            except Exception as e:
                mineru_errors.append(str(e))
                extracted_text, total_pages = "", None
            if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
                try:
                    logger.info("doc_parse_try_tesseract_after_pypdf file=%s", file_name)
                    extracted_text, total_pages = _pdf_extract_text_with_tesseract(file_binary, prefer_chinese=prefer_chinese)
                except Exception as e:
                    logger.warning("doc_parse_tesseract_after_pypdf_failed file=%s err=%s", file_name, str(e))
                    mineru_errors.append(str(e))
    else:
        if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
            try:
                extracted_text, total_pages = _pdf_extract_text_with_mineru(file_binary, file_name, method=settings.mineru_method or "auto")
                if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
                    logger.info("doc_parse_mineru_auto_low_quality file=%s retry=ocr", file_name)
                    extracted_text, total_pages = _pdf_extract_text_with_mineru(file_binary, file_name, method="ocr")
            except Exception as e:
                logger.warning("doc_parse_mineru_fallback_to_pypdf file=%s err=%s", file_name, str(e))
                mineru_errors.append(str(e))
                try:
                    extracted_text, total_pages = _pdf_extract_text(file_binary)
                except Exception as e2:
                    mineru_errors.append(str(e2))
                    extracted_text, total_pages = "", None
            if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
                try:
                    fallback_text, fallback_pages = _pdf_extract_text(file_binary)
                    if len(fallback_text.strip()) > len(extracted_text.strip()):
                        logger.info(
                            "doc_parse_use_pypdf_better_text file=%s mineru_len=%s pypdf_len=%s",
                            file_name,
                            len(extracted_text.strip()),
                            len(fallback_text.strip()),
                        )
                        extracted_text, total_pages = fallback_text, fallback_pages
                except Exception:
                    pass
            if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
                try:
                    logger.info("doc_parse_try_tesseract_after_mineru_pypdf file=%s", file_name)
                    extracted_text, total_pages = _pdf_extract_text_with_tesseract(file_binary, prefer_chinese=prefer_chinese)
                except Exception as e:
                    logger.warning("doc_parse_tesseract_after_mineru_pypdf_failed file=%s err=%s", file_name, str(e))
                    mineru_errors.append(str(e))
    logger.info(
        "doc_parse_result file=%s text_len=%s pages=%s usable=%s",
        file_name,
        len((extracted_text or "").strip()),
        total_pages,
        _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese),
    )
    if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
        hints = []
        all_err = "\n".join(mineru_errors)
        if "doclayout_yolo" in all_err:
            hints.append("请在 backend 虚拟环境执行: pip install doclayout-yolo")
        if "No module named 'torch'" in all_err or 'No module named "torch"' in all_err:
            hints.append("请在 backend 虚拟环境执行: pip install torch")
        if "tesseract 未安装中文语言包" in all_err or "几乎不含中文" in all_err:
            hints.append("请安装中文 OCR 语言包: brew install tesseract-lang（并确认 tesseract --list-langs 有 chi_sim）")
        hint_text = f"；建议: {'；'.join(hints)}" if hints else ""
        extra = f"；最后错误: {mineru_errors[-1][:220]}{hint_text}" if mineru_errors else ""
        logger.error("doc_parse_failed_no_text file=%s extra=%s", file_name, extra)
        raise HTTPException(status_code=400, detail=f"未提取到可用文本，请检查 PDF 或 OCR 配置{extra}")

    doc.content = extracted_text
    doc.page_ref = f"{total_pages}页" if total_pages else None
    doc.parse_error = None
    doc.parse_status = "done"

    from ..rag import ChunkDocument
    from ..rag.chunking import chunk_documents
    preview_chunks = chunk_documents(
        [ChunkDocument(text=(doc.content or "").strip(), course_id=course.id, chapter_id=chapter.id, title=doc.title, source_id=f"doc_{doc.id}")]
    )
    doc.chunk_count = len(preview_chunks)

    from ..services.rag_index_service import build_index_for_course
    try:
        await build_index_for_course(db, course.id)
    except Exception as idx_err:
        logger.exception("doc_reindex_failed file=%s course_id=%s doc_id=%s", file_name, course.id, doc.id)
        msg = str(idx_err)
        tip = f"索引失败: {msg[:240]}"
        doc.parse_error = f"{doc.parse_error}；{tip}" if doc.parse_error else tip


@router.get("/courses", response_model=list[TeacherCourseOut])
async def list_teacher_courses(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(select(Course).where(Course.owner_teacher_id == user.id).order_by(Course.id))
    rows = r.scalars().all()
    return [
        TeacherCourseOut(
            id=c.id,
            name=c.name,
            code=c.code,
            description=c.description,
            is_active=c.is_active,
            owner_teacher_id=c.owner_teacher_id,
            created_at=c.created_at.isoformat() if c.created_at else None,
        )
        for c in rows
    ]


@router.post("/courses", response_model=TeacherCourseOut)
async def create_teacher_course(
    body: TeacherCourseCreateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    if body.code:
        r = await db.execute(select(Course).where(Course.code == body.code.strip()))
        if r.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="课程代码已存在")
    c = Course(
        name=body.name.strip(),
        code=body.code.strip() if body.code else None,
        description=body.description,
        is_active=body.is_active,
        owner_teacher_id=user.id,
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return TeacherCourseOut(
        id=c.id,
        name=c.name,
        code=c.code,
        description=c.description,
        is_active=c.is_active,
        owner_teacher_id=c.owner_teacher_id,
        created_at=c.created_at.isoformat() if c.created_at else None,
    )


@router.put("/courses/{course_id}", response_model=TeacherCourseOut)
async def update_teacher_course(
    course_id: int,
    body: TeacherCourseUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    c = await _require_owned_course(db, user.id, course_id)
    if body.name is not None:
        c.name = body.name.strip()
    if body.code is not None:
        code = body.code.strip() if body.code else None
        if code and code != c.code:
            r_dup = await db.execute(select(Course).where(Course.code == code, Course.id != c.id))
            if r_dup.scalar_one_or_none():
                raise HTTPException(status_code=400, detail="课程代码已存在")
        c.code = code
    if body.description is not None:
        c.description = body.description
    if body.is_active is not None:
        c.is_active = body.is_active
    await db.commit()
    await db.refresh(c)
    return TeacherCourseOut(
        id=c.id,
        name=c.name,
        code=c.code,
        description=c.description,
        is_active=c.is_active,
        owner_teacher_id=c.owner_teacher_id,
        created_at=c.created_at.isoformat() if c.created_at else None,
    )


@router.delete("/courses/{course_id}")
async def delete_teacher_course(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    c = await _require_owned_course(db, user.id, course_id)
    await db.delete(c)
    await db.commit()
    return {"ok": True}


@router.post("/courses/{course_id}/reindex")
async def reindex_teacher_course(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_course(db, user.id, course_id)
    from ..services.rag_index_service import build_index_for_course
    count = await build_index_for_course(db, course_id)
    return {"ok": True, "chunks_indexed": count}


@router.post("/courses/{course_id}/clear-knowledge")
async def clear_teacher_course_knowledge(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_course(db, user.id, course_id)
    stats = await clear_course_knowledge(db, course_id)
    await db.commit()
    from ..services.rag_index_service import build_index_for_course
    chunks = await build_index_for_course(db, course_id)
    return {"ok": True, "stats": stats, "chunks_indexed": chunks}


@router.get("/courses/{course_id}/chapters", response_model=list[TeacherChapterOut])
async def list_teacher_course_chapters(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_course(db, user.id, course_id)
    r = await db.execute(select(Chapter).where(Chapter.course_id == course_id).order_by(Chapter.order_index, Chapter.id))
    rows = r.scalars().all()
    chapter_ids = [ch.id for ch in rows]
    q_count_map: dict[int, int] = {}
    if chapter_ids:
        r_count = await db.execute(
            select(Question.chapter_id, func.count(Question.id))
            .where(Question.chapter_id.in_(chapter_ids), Question.is_active == True)
            .group_by(Question.chapter_id)
        )
        q_count_map = {int(row[0]): int(row[1]) for row in r_count.all()}
    return [
        TeacherChapterOut(
            id=ch.id,
            course_id=ch.course_id,
            title=ch.title,
            order_index=ch.order_index,
            syllabus_ref=ch.syllabus_ref,
            question_count=q_count_map.get(ch.id, 0),
        )
        for ch in rows
    ]


@router.post("/courses/{course_id}/chapters", response_model=TeacherChapterOut)
async def create_teacher_chapter(
    course_id: int,
    body: TeacherChapterCreateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_course(db, user.id, course_id)
    ch = Chapter(course_id=course_id, title=body.title.strip(), order_index=body.order_index, syllabus_ref=body.syllabus_ref)
    db.add(ch)
    await db.commit()
    await db.refresh(ch)
    return TeacherChapterOut(id=ch.id, course_id=ch.course_id, title=ch.title, order_index=ch.order_index, syllabus_ref=ch.syllabus_ref)


@router.put("/chapters/{chapter_id}", response_model=TeacherChapterOut)
async def update_teacher_chapter(
    chapter_id: int,
    body: TeacherChapterUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(
        select(Chapter, Course)
        .join(Course, Course.id == Chapter.course_id)
        .where(Chapter.id == chapter_id, Course.owner_teacher_id == user.id)
    )
    row = r.first()
    if not row:
        raise HTTPException(status_code=404, detail="章节不存在或无权限")
    ch = row[0]
    if body.title is not None:
        ch.title = body.title.strip()
    if body.order_index is not None:
        ch.order_index = body.order_index
    if body.syllabus_ref is not None:
        ch.syllabus_ref = body.syllabus_ref
    await db.commit()
    await db.refresh(ch)
    return TeacherChapterOut(id=ch.id, course_id=ch.course_id, title=ch.title, order_index=ch.order_index, syllabus_ref=ch.syllabus_ref)


@router.get("/chapters/{chapter_id}/knowledge-points", response_model=list[TeacherKnowledgePointOut])
async def list_teacher_chapter_knowledge_points(
    chapter_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    chapter, _ = await _require_owned_chapter(db, user.id, chapter_id)
    r = await db.execute(
        select(KnowledgePoint)
        .where(KnowledgePoint.chapter_id == chapter.id)
        .order_by(KnowledgePoint.order_index, KnowledgePoint.id)
    )
    rows = r.scalars().all()
    return [
        TeacherKnowledgePointOut(
            id=kp.id,
            chapter_id=kp.chapter_id,
            title=kp.title,
            content=kp.content,
            ppt_slide_ref=kp.ppt_slide_ref,
            order_index=kp.order_index,
        )
        for kp in rows
    ]


@router.post("/chapters/{chapter_id}/knowledge-points/generate", response_model=list[TeacherKnowledgePointIn])
async def generate_teacher_chapter_knowledge_points(
    chapter_id: int,
    body: TeacherGenerateKnowledgePointsIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    chapter, _ = await _require_owned_chapter(db, user.id, chapter_id)
    try:
        return await _generate_knowledge_points_for_chapter(db, chapter, body.count)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("generate_knowledge_points_failed chapter_id=%s err=%s", chapter_id, str(e))
        raise HTTPException(status_code=500, detail="生成知识点失败，请稍后重试")


@router.put("/chapters/{chapter_id}/knowledge-points", response_model=list[TeacherKnowledgePointOut])
async def save_teacher_chapter_knowledge_points(
    chapter_id: int,
    body: TeacherKnowledgePointSaveIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    chapter, _ = await _require_owned_chapter(db, user.id, chapter_id)
    cleaned: list[TeacherKnowledgePointIn] = []
    for idx, kp in enumerate(body.knowledge_points):
        title = (kp.title or "").strip()
        if not title:
            continue
        cleaned.append(
            TeacherKnowledgePointIn(
                title=title[:128],
                content=(kp.content or "").strip() or None,
                ppt_slide_ref=(kp.ppt_slide_ref or "").strip() or None,
                order_index=kp.order_index if kp.order_index is not None else (idx + 1),
            )
        )
    await db.execute(delete(KnowledgePoint).where(KnowledgePoint.chapter_id == chapter.id))
    for idx, kp in enumerate(cleaned):
        db.add(
            KnowledgePoint(
                chapter_id=chapter.id,
                title=kp.title,
                content=kp.content,
                ppt_slide_ref=kp.ppt_slide_ref,
                order_index=kp.order_index if kp.order_index is not None else (idx + 1),
            )
        )
    await db.commit()
    r = await db.execute(
        select(KnowledgePoint)
        .where(KnowledgePoint.chapter_id == chapter.id)
        .order_by(KnowledgePoint.order_index, KnowledgePoint.id)
    )
    rows = r.scalars().all()
    return [
        TeacherKnowledgePointOut(
            id=kp.id,
            chapter_id=kp.chapter_id,
            title=kp.title,
            content=kp.content,
            ppt_slide_ref=kp.ppt_slide_ref,
            order_index=kp.order_index,
        )
        for kp in rows
    ]


@router.delete("/chapters/{chapter_id}")
async def delete_teacher_chapter(
    chapter_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(
        select(Chapter, Course)
        .join(Course, Course.id == Chapter.course_id)
        .where(Chapter.id == chapter_id, Course.owner_teacher_id == user.id)
    )
    row = r.first()
    if not row:
        raise HTTPException(status_code=404, detail="章节不存在或无权限")
    ch, course = row[0], row[1]
    await cleanup_chapter_related_data(db, ch.id)
    await db.delete(ch)
    await db.commit()
    try:
        from ..services.rag_index_service import build_index_for_course
        await build_index_for_course(db, course.id)
    except Exception as e:
        logger.warning("delete_chapter_reindex_failed chapter_id=%s course_id=%s err=%s", ch.id, course.id, str(e))
    return {"ok": True}


async def _generate_questions_for_chapter(
    db: AsyncSession,
    chapter: Chapter,
    course: Course,
    body: TeacherGenerateQuestionsIn,
) -> tuple[dict[str, int], int]:
    r_docs = await db.execute(
        select(KnowledgeDocument.title, KnowledgeDocument.content, KnowledgeDocument.page_ref)
        .where(KnowledgeDocument.chapter_id == chapter.id)
        .order_by(KnowledgeDocument.id.desc())
        .limit(30)
    )
    doc_rows = r_docs.all()
    r_kps = await db.execute(
        select(KnowledgePoint.id, KnowledgePoint.title, KnowledgePoint.content)
        .where(KnowledgePoint.chapter_id == chapter.id)
        .order_by(KnowledgePoint.order_index, KnowledgePoint.id)
        .limit(100)
    )
    kp_rows = r_kps.all()
    chapter_kp_matchers = _build_chapter_kp_matchers(kp_rows)
    context_parts: list[str] = []
    for title, content, page_ref in doc_rows:
        c = (content or "").strip()
        if not c:
            continue
        header = f"文档：{(title or '').strip()}".strip()
        if page_ref:
            header += f"（{page_ref}）"
        context_parts.append(f"{header}\n{c}")
    for _, title, content in kp_rows:
        t = (title or "").strip()
        c = (content or "").strip()
        if not (t or c):
            continue
        context_parts.append(f"知识点：{t}\n{c}".strip())
    context = "\n\n---\n\n".join(context_parts).strip()
    if not context:
        raise RuntimeError("该章节暂无可用内容，请先上传或解析文档后再生成")
    if len(context) > 18000:
        context = context[:18000]

    from ..rag.config import get_rag_settings
    from ..rag.llm import get_llm

    settings = get_rag_settings()
    llm = get_llm(settings)
    diff_limits = _difficulty_limits(sum([body.single_choice_max, body.multiple_choice_max, body.judge_max, body.qa_max, body.blank_max]))
    prompt = _build_generate_questions_prompt(
        chapter_title=chapter.title,
        context=context,
        single_choice_max=body.single_choice_max,
        multiple_choice_max=body.multiple_choice_max,
        judge_max=body.judge_max,
        qa_max=body.qa_max,
        blank_max=body.blank_max,
        diff_basic_target=diff_limits["basic"],
        diff_applied_target=diff_limits["applied"],
        diff_extended_target=diff_limits["extended"],
    )
    raw = llm.generate(
        prompt,
        max_tokens=max(1400, int(settings.llm_max_tokens or 512)),
        temperature=0.2,
    )
    candidates = _extract_json_payload(raw)
    if not candidates:
        raise RuntimeError("模型返回结果无法解析，请重试")

    limits = {
        "single_choice": body.single_choice_max,
        "multiple_choice": body.multiple_choice_max,
        "judge": body.judge_max,
        "qa": body.qa_max,
        "blank": body.blank_max,
    }
    total_expected = sum(limits.values())
    created_by_type: dict[str, int] = {"single_choice": 0, "multiple_choice": 0, "judge": 0, "qa": 0, "blank": 0}
    created_by_diff: dict[str, int] = {"basic": 0, "applied": 0, "extended": 0}
    skipped = 0

    r_existing = await db.execute(select(Question.question_text).where(Question.chapter_id == chapter.id))
    existing_keys = {_normalize_text_key(row[0]) for row in r_existing.all() if (row[0] or "").strip()}

    def _try_add_item(item: dict, enforce_diff_limit: bool = True) -> bool:
        nonlocal skipped
        q_type = _to_question_type(str(item.get("type") or ""))
        if not q_type:
            skipped += 1
            return False
        if created_by_type[q_type] >= limits[q_type]:
            return False
        q_text_raw = str(item.get("question_text") or "").strip()
        if not q_text_raw:
            skipped += 1
            return False
        q_text = q_text_raw
        key = _normalize_text_key(q_text)
        if key in existing_keys:
            skipped += 1
            return False

        explanation = str(item.get("explanation") or "").strip() or None
        matched_kp_ids = _match_question_kp_ids(q_text, explanation, chapter_kp_matchers, limit=3)
        knowledge_point_ids = ",".join(str(x) for x in matched_kp_ids) if matched_kp_ids else None
        difficulty = _normalize_difficulty(item.get("difficulty"))
        if enforce_diff_limit and created_by_diff[difficulty] >= diff_limits[difficulty]:
            return False
        options_text: str | None = None
        correct_answer: str | None = None
        if q_type == "single_choice":
            opts = _normalize_choice_options(item.get("options"))
            ans = _normalize_choice_answer(item.get("correct_answer"), opts)
            if len(opts) != 4 or not ans:
                skipped += 1
                return False
            options_text = json.dumps([f"{chr(ord('A') + i)}. {x}" for i, x in enumerate(opts)], ensure_ascii=False)
            correct_answer = ans
        elif q_type == "multiple_choice":
            opts = _normalize_choice_options(item.get("options"))
            ans = _normalize_multi_answer(item.get("correct_answer"))
            if len(opts) != 4 or len([x for x in ans.split(",") if x]) < 2:
                skipped += 1
                return False
            options_text = json.dumps([f"{chr(ord('A') + i)}. {x}" for i, x in enumerate(opts)], ensure_ascii=False)
            correct_answer = ans
        elif q_type == "judge":
            ans = _normalize_judge_answer(item.get("correct_answer"))
            if not ans:
                skipped += 1
                return False
            options_text = json.dumps(["A. 正确", "B. 错误"], ensure_ascii=False)
            correct_answer = ans
        else:
            ans = _trim_answer(item.get("correct_answer"))
            if not ans:
                skipped += 1
                return False
            correct_answer = ans

        db.add(
            Question(
                course_id=course.id,
                chapter_id=chapter.id,
                difficulty=difficulty,
                question_type=q_type,
                question_text=q_text,
                options=options_text,
                correct_answer=correct_answer,
                explanation=explanation,
                knowledge_point_ids=knowledge_point_ids,
                is_active=True,
                is_approved=True,
            )
        )
        created_by_type[q_type] += 1
        created_by_diff[difficulty] += 1
        existing_keys.add(key)
        return True

    for item in candidates:
        _try_add_item(item, enforce_diff_limit=True)
        if sum(created_by_type.values()) >= total_expected:
            break

    # 若因难度配额导致未凑齐题量，第二轮放宽配额补齐
    if sum(created_by_type.values()) < total_expected:
        for item in candidates:
            _try_add_item(item, enforce_diff_limit=False)
            if sum(created_by_type.values()) >= total_expected:
                break
    await db.commit()
    return created_by_type, skipped


async def _run_question_generation_task(task_id: int):
    async with AsyncSessionLocal() as db:
        r = await db.execute(select(QuestionGenerationTask).where(QuestionGenerationTask.id == task_id))
        task = r.scalar_one_or_none()
        if not task:
            return
        task.status = "running"
        task.error_message = None
        await db.commit()
        try:
            r_ch = await db.execute(
                select(Chapter, Course)
                .join(Course, Course.id == Chapter.course_id)
                .where(Chapter.id == task.chapter_id, Course.id == task.course_id)
            )
            row = r_ch.first()
            if not row:
                raise RuntimeError("章节不存在")
            chapter, course = row[0], row[1]
            params = json.loads(task.request_payload or "{}")
            body = TeacherGenerateQuestionsIn(**params)
            created_by_type, skipped = await _generate_questions_for_chapter(db, chapter, course, body)
            task.status = "success"
            task.result_payload = json.dumps(
                {
                    "created": int(sum(created_by_type.values())),
                    "by_type": created_by_type,
                    "skipped": int(skipped),
                },
                ensure_ascii=False,
            )
            task.error_message = None
        except Exception as e:
            task.status = "failed"
            task.error_message = str(e)[:1000]
        await db.commit()


@router.post("/chapters/{chapter_id}/questions/generate", response_model=TeacherGenerateTaskOut)
async def create_generate_teacher_chapter_questions_task(
    chapter_id: int,
    body: TeacherGenerateQuestionsIn,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    chapter, course = await _require_owned_chapter(db, user.id, chapter_id)
    total_expected = body.single_choice_max + body.multiple_choice_max + body.judge_max + body.qa_max + body.blank_max
    if total_expected <= 0:
        raise HTTPException(status_code=400, detail="请至少设置一种题型数量大于 0")
    task = QuestionGenerationTask(
        course_id=course.id,
        chapter_id=chapter.id,
        teacher_id=user.id,
        status="pending",
        request_payload=json.dumps(body.model_dump(), ensure_ascii=False),
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    background_tasks.add_task(_run_question_generation_task, task.id)
    return TeacherGenerateTaskOut(task_id=task.id, status=task.status)


@router.get("/questions/tasks/{task_id}", response_model=TeacherGenerateTaskStatusOut)
async def get_generate_teacher_chapter_questions_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(select(QuestionGenerationTask).where(QuestionGenerationTask.id == task_id, QuestionGenerationTask.teacher_id == user.id))
    task = r.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    req_payload = {}
    res_payload = None
    try:
        req_payload = json.loads(task.request_payload or "{}")
    except Exception:
        req_payload = {}
    try:
        res_payload = json.loads(task.result_payload) if task.result_payload else None
    except Exception:
        res_payload = None
    return TeacherGenerateTaskStatusOut(
        id=task.id,
        course_id=task.course_id,
        chapter_id=task.chapter_id,
        status=task.status,
        request_payload=req_payload,
        result_payload=res_payload,
        error_message=task.error_message,
        created_at=task.created_at.isoformat() if task.created_at else None,
        updated_at=task.updated_at.isoformat() if task.updated_at else None,
    )


async def _run_document_process_task(task_id: int):
    async with AsyncSessionLocal() as db:
        r = await db.execute(select(DocumentProcessTask).where(DocumentProcessTask.id == task_id))
        task = r.scalar_one_or_none()
        if not task:
            logger.warning("doc_task_missing task_id=%s", task_id)
            return
        logger.info(
            "doc_task_start task_id=%s doc_id=%s chapter_id=%s course_id=%s teacher_id=%s",
            task.id,
            task.doc_id,
            task.chapter_id,
            task.course_id,
            task.teacher_id,
        )
        task.status = "running"
        task.error_message = None
        await db.commit()

        doc: KnowledgeDocument | None = None
        try:
            r_doc = await db.execute(
                select(KnowledgeDocument, Chapter, Course)
                .join(Chapter, Chapter.id == KnowledgeDocument.chapter_id)
                .join(Course, Course.id == Chapter.course_id)
                .where(
                    KnowledgeDocument.id == task.doc_id,
                    Chapter.id == task.chapter_id,
                    Course.id == task.course_id,
                    Course.owner_teacher_id == task.teacher_id,
                )
            )
            row = r_doc.first()
            if not row:
                raise RuntimeError("文档不存在或无权限")
            doc, chapter, course = row[0], row[1], row[2]
            logger.info("doc_task_loaded task_id=%s doc_id=%s file=%s", task.id, doc.id, doc.file_name)
            if doc.source_type != "pdf_upload":
                raise RuntimeError("仅 PDF 讲义支持重新识别与切片")
            if not doc.file_path:
                raise RuntimeError("文档原文件不存在，无法重新识别")
            abs_path = Path(settings.upload_dir) / doc.file_path
            if not abs_path.exists():
                raise RuntimeError("文档文件不存在，无法重新识别")
            binary = abs_path.read_bytes()
            if not binary:
                raise RuntimeError("文档文件为空，无法重新识别")
            doc.parse_status = "processing"
            doc.parse_error = None
            doc.chunk_count = None
            await db.commit()
            logger.info("doc_task_parse_begin task_id=%s doc_id=%s path=%s", task.id, doc.id, str(abs_path))

            await _parse_pdf_document_and_reindex(
                db=db,
                doc=doc,
                chapter=chapter,
                course=course,
                file_binary=binary,
                file_name=doc.file_name or doc.title or abs_path.name,
            )
            task.status = "success"
            task.result_payload = json.dumps(
                {
                    "doc_id": doc.id,
                    "parse_status": doc.parse_status,
                    "chunk_count": doc.chunk_count,
                },
                ensure_ascii=False,
            )
            task.error_message = None
            logger.info("doc_task_success task_id=%s doc_id=%s chunk_count=%s", task.id, doc.id, doc.chunk_count)
        except Exception as e:
            if isinstance(e, HTTPException):
                err_msg = e.detail if isinstance(e.detail, str) else str(e.detail)
            else:
                err_msg = str(e)
            task.status = "failed"
            task.error_message = err_msg[:4000]
            logger.exception("doc_task_failed task_id=%s doc_id=%s err=%s", task.id, task.doc_id, err_msg[:500])
            if doc is not None:
                doc.parse_status = "failed"
                doc.parse_error = err_msg[:500]
        await db.commit()


def _run_document_process_task_thread(task_id: int):
    """在线程中运行文档处理任务，避免阻塞主事件循环。"""
    try:
        logger.info("doc_task_thread_start task_id=%s", task_id)
        asyncio.run(_run_document_process_task(task_id))
        logger.info("doc_task_thread_end task_id=%s", task_id)
    except Exception:
        logger.exception("doc_task_thread_crash task_id=%s", task_id)


@router.get("/chapters/{chapter_id}/questions", response_model=list[TeacherQuestionOut])
async def list_teacher_chapter_questions(
    chapter_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_chapter(db, user.id, chapter_id)
    r = await db.execute(
        select(Question, Chapter, Course)
        .join(Chapter, Chapter.id == Question.chapter_id)
        .join(Course, Course.id == Chapter.course_id)
        .where(Question.chapter_id == chapter_id, Question.is_active == True, Course.owner_teacher_id == user.id)
        .order_by(Question.id.desc())
    )
    rows = r.all()
    return [
        TeacherQuestionOut(
            id=q.id,
            course_id=q.course_id or c.id,
            course_name=c.name,
            chapter_id=ch.id,
            chapter_title=ch.title,
            question_type=(q.question_type or "single_choice"),
            difficulty=q.difficulty,
            question_text=q.question_text,
            options=q.options,
            correct_answer=q.correct_answer,
            explanation=q.explanation,
            created_at=q.created_at.isoformat() if q.created_at else None,
        )
        for q, ch, c in rows
    ]


@router.put("/questions/{question_id}", response_model=TeacherQuestionOut)
async def update_teacher_question(
    question_id: int,
    body: TeacherQuestionUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(
        select(Question, Chapter, Course)
        .join(Chapter, Chapter.id == Question.chapter_id)
        .join(Course, Course.id == Chapter.course_id)
        .where(Question.id == question_id, Course.owner_teacher_id == user.id)
    )
    row = r.first()
    if not row:
        raise HTTPException(status_code=404, detail="题目不存在或无权限")
    q, ch, c = row[0], row[1], row[2]
    if body.difficulty is not None:
        q.difficulty = _normalize_difficulty(body.difficulty)
    if body.question_text is not None:
        text = body.question_text.strip()
        if not text:
            raise HTTPException(status_code=400, detail="question_text 不能为空")
        q.question_text = text
    if body.options is not None:
        opts = [str(x or "").strip() for x in body.options if str(x or "").strip()]
        q.options = json.dumps(opts, ensure_ascii=False) if opts else None
    if body.correct_answer is not None:
        ans = body.correct_answer.strip()
        if not ans:
            raise HTTPException(status_code=400, detail="correct_answer 不能为空")
        if (q.question_type or "") == "multiple_choice":
            ans = _normalize_multi_answer(ans) or ans
        q.correct_answer = ans
    if body.explanation is not None:
        q.explanation = body.explanation.strip() or None
    q.course_id = c.id
    await db.commit()
    await db.refresh(q)
    return TeacherQuestionOut(
        id=q.id,
        course_id=q.course_id,
        course_name=c.name,
        chapter_id=ch.id,
        chapter_title=ch.title,
        question_type=(q.question_type or "single_choice"),
        difficulty=q.difficulty,
        question_text=q.question_text,
        options=q.options,
        correct_answer=q.correct_answer,
        explanation=q.explanation,
        created_at=q.created_at.isoformat() if q.created_at else None,
    )


@router.delete("/questions/{question_id}")
async def delete_teacher_question(
    question_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(
        select(Question, Course)
        .join(Chapter, Chapter.id == Question.chapter_id)
        .join(Course, Course.id == Chapter.course_id)
        .where(Question.id == question_id, Course.owner_teacher_id == user.id)
    )
    row = r.first()
    if not row:
        raise HTTPException(status_code=404, detail="题目不存在或无权限")
    q = row[0]
    await db.delete(q)
    await db.commit()
    return {"ok": True}


@router.get("/chapters/{chapter_id}/documents", response_model=list[TeacherKnowledgeDocumentOut])
async def list_teacher_chapter_documents(
    chapter_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_chapter(db, user.id, chapter_id)
    active_task_doc_ids = await _reconcile_document_process_tasks(db, user.id, chapter_id=chapter_id)
    r = await db.execute(
        select(KnowledgeDocument)
        .where(KnowledgeDocument.chapter_id == chapter_id)
        .order_by(KnowledgeDocument.id.desc())
    )
    rows = r.scalars().all()
    orphan_fixed = False
    for d in rows:
        if d.parse_status == "processing" and d.id not in active_task_doc_ids:
            d.parse_status = "failed"
            if not (d.parse_error or "").strip():
                d.parse_error = "未检测到运行中的处理任务，已自动回收为失败状态，请重新发起处理。"
            orphan_fixed = True
            logger.warning("doc_processing_orphan_fix doc_id=%s chapter_id=%s", d.id, chapter_id)
    if orphan_fixed:
        await db.commit()
    return [
        TeacherKnowledgeDocumentOut(
            id=d.id,
            chapter_id=d.chapter_id,
            source_type=d.source_type,
            title=d.title,
            page_ref=d.page_ref,
            file_name=d.file_name,
            file_size=d.file_size,
            parse_status="processing" if d.id in active_task_doc_ids else d.parse_status,
            parse_error=None if d.id in active_task_doc_ids else d.parse_error,
            chunk_count=d.chunk_count,
            created_at=d.created_at.isoformat() if d.created_at else None,
        )
        for d in rows
    ]


@router.post("/chapters/{chapter_id}/documents/upload", response_model=TeacherKnowledgeDocumentOut)
async def upload_teacher_chapter_document(
    chapter_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    chapter, _ = await _require_owned_chapter(db, user.id, chapter_id)
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="请上传 PDF 文件")
    binary = await file.read()
    if not binary:
        raise HTTPException(status_code=400, detail="文件内容为空")
    root = Path(settings.upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    subdir = root / "knowledge"
    subdir.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_pdf_filename(file.filename)
    saved_name = f"{chapter_id}_{int(time.time())}_{safe_name}"
    abs_path = subdir / saved_name
    abs_path.write_bytes(binary)
    rel_path = f"knowledge/{saved_name}"

    doc = KnowledgeDocument(
        chapter_id=chapter.id,
        source_type="pdf_upload",
        title=file.filename,
        content="",
        file_name=file.filename,
        file_path=rel_path,
        file_size=len(binary),
        parse_status="uploaded",
        parse_error=None,
        chunk_count=None,
    )
    db.add(doc)

    await db.commit()
    await db.refresh(doc)
    return TeacherKnowledgeDocumentOut(
        id=doc.id,
        chapter_id=doc.chapter_id,
        source_type=doc.source_type,
        title=doc.title,
        page_ref=doc.page_ref,
        file_name=doc.file_name,
        file_size=doc.file_size,
        parse_status=doc.parse_status,
        parse_error=doc.parse_error,
        chunk_count=doc.chunk_count,
        created_at=doc.created_at.isoformat() if doc.created_at else None,
    )


@router.post("/chapters/{chapter_id}/videos/upload", response_model=TeacherKnowledgeDocumentOut)
async def upload_teacher_chapter_video(
    chapter_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    chapter, _ = await _require_owned_chapter(db, user.id, chapter_id)
    if not file.filename:
        raise HTTPException(status_code=400, detail="请上传视频文件")
    ext = Path(file.filename).suffix.lower()
    allow_ext = {".mp4", ".webm", ".mkv", ".mov", ".m4v"}
    if ext not in allow_ext:
        raise HTTPException(status_code=400, detail="仅支持 mp4/webm/mkv/mov/m4v 视频文件")
    binary = await file.read()
    if not binary:
        raise HTTPException(status_code=400, detail="文件内容为空")
    root = Path(settings.upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    subdir = root / "preview_videos"
    subdir.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_upload_filename(file.filename)
    saved_name = f"{chapter_id}_{int(time.time())}_{safe_name}"
    abs_path = subdir / saved_name
    abs_path.write_bytes(binary)
    rel_path = f"preview_videos/{saved_name}"
    doc = KnowledgeDocument(
        chapter_id=chapter.id,
        source_type="preview_video",
        title=file.filename,
        content="",
        file_name=file.filename,
        file_path=rel_path,
        file_size=len(binary),
        parse_status="done",
        parse_error=None,
        chunk_count=0,
    )
    db.add(doc)
    await db.commit()
    await db.refresh(doc)
    return TeacherKnowledgeDocumentOut(
        id=doc.id,
        chapter_id=doc.chapter_id,
        source_type=doc.source_type,
        title=doc.title,
        page_ref=doc.page_ref,
        file_name=doc.file_name,
        file_size=doc.file_size,
        parse_status=doc.parse_status,
        parse_error=doc.parse_error,
        chunk_count=doc.chunk_count,
        created_at=doc.created_at.isoformat() if doc.created_at else None,
    )


@router.get("/documents/{doc_id}", response_model=TeacherKnowledgeDocumentDetailOut)
async def get_teacher_document_detail(
    doc_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    doc, chapter, course = await _require_owned_document(db, user.id, doc_id)
    active_task_doc_ids = await _reconcile_document_process_tasks(db, user.id, doc_id=doc.id)
    if doc.parse_status == "processing" and doc.id not in active_task_doc_ids:
        doc.parse_status = "failed"
        if not (doc.parse_error or "").strip():
            doc.parse_error = "未检测到运行中的处理任务，已自动回收为失败状态，请重新发起处理。"
        await db.commit()
        logger.warning("doc_processing_orphan_fix_detail doc_id=%s", doc.id)
    active_task = doc.id in active_task_doc_ids
    effective_status = "processing" if active_task else doc.parse_status
    effective_error = None if active_task else doc.parse_error
    chunks_out: list[TeacherDocumentChunkOut] = []
    if doc.content and doc.parse_status == "done":
        from ..rag import ChunkDocument
        from ..rag.chunking import chunk_documents
        chunks = chunk_documents(
            [ChunkDocument(text=(doc.content or "").strip(), course_id=course.id, chapter_id=chapter.id, title=doc.title, source_id=f"doc_{doc.id}")]
        )
        chunks_out = [TeacherDocumentChunkOut(index=i + 1, text=chunk[0]) for i, chunk in enumerate(chunks[:50])]
    preview = (doc.content or "").strip()
    if len(preview) > 4000:
        preview = preview[:4000] + "\n\n..."
    return TeacherKnowledgeDocumentDetailOut(
        id=doc.id,
        chapter_id=doc.chapter_id,
        source_type=doc.source_type,
        title=doc.title,
        page_ref=doc.page_ref,
        file_name=doc.file_name,
        file_size=doc.file_size,
        parse_status=effective_status,
        parse_error=effective_error,
        chunk_count=doc.chunk_count,
        created_at=doc.created_at.isoformat() if doc.created_at else None,
        content_preview=preview,
        chunks=chunks_out,
    )


@router.delete("/documents/{doc_id}")
async def delete_teacher_document(
    doc_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    doc, _, course = await _require_owned_document(db, user.id, doc_id)
    abs_path: Path | None = None
    if doc.file_path:
        abs_path = Path(settings.upload_dir) / doc.file_path
    await db.delete(doc)
    await db.flush()
    try:
        from ..services.rag_index_service import build_index_for_course
        await build_index_for_course(db, course.id)
    except Exception:
        logger.exception("delete_doc_reindex_failed doc_id=%s course_id=%s", doc_id, course.id)
    await db.commit()
    if abs_path and abs_path.exists():
        try:
            abs_path.unlink()
        except Exception:
            logger.warning("delete_doc_file_unlink_failed doc_id=%s path=%s", doc_id, str(abs_path))
    return {"ok": True}


@router.post("/documents/{doc_id}/reprocess", response_model=TeacherDocumentProcessTaskOut)
async def reprocess_teacher_document(
    doc_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    doc, chapter, course = await _require_owned_document(db, user.id, doc_id)
    if doc.source_type != "pdf_upload":
        raise HTTPException(status_code=400, detail="仅 PDF 讲义支持重新识别与切片")
    if not doc.file_path:
        raise HTTPException(status_code=400, detail="文档原文件不存在，无法重新识别")
    abs_path = Path(settings.upload_dir) / doc.file_path
    if not abs_path.exists():
        raise HTTPException(status_code=400, detail="文档文件不存在，无法重新识别")

    await _reconcile_document_process_tasks(db, user.id, doc_id=doc.id)
    r_running = await db.execute(
        select(DocumentProcessTask)
        .where(
            DocumentProcessTask.doc_id == doc.id,
            DocumentProcessTask.teacher_id == user.id,
            DocumentProcessTask.status.in_(["pending", "running"]),
        )
        .order_by(DocumentProcessTask.id.desc())
    )
    running = r_running.scalar_one_or_none()
    if running:
        logger.info("doc_task_reuse_running task_id=%s doc_id=%s", running.id, doc.id)
        if doc.parse_status != "processing":
            doc.parse_status = "processing"
            doc.parse_error = None
            await db.commit()
        return TeacherDocumentProcessTaskOut(task_id=running.id, status=running.status)

    doc.parse_status = "processing"
    doc.parse_error = None
    doc.chunk_count = None
    task = DocumentProcessTask(
        course_id=course.id,
        chapter_id=chapter.id,
        doc_id=doc.id,
        teacher_id=user.id,
        status="pending",
        request_payload=json.dumps({"doc_id": doc.id}, ensure_ascii=False),
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    logger.info("doc_task_created task_id=%s doc_id=%s chapter_id=%s", task.id, doc.id, chapter.id)
    background_tasks.add_task(_run_document_process_task_thread, task.id)
    return TeacherDocumentProcessTaskOut(task_id=task.id, status=task.status)


@router.get("/documents/tasks/{task_id}", response_model=TeacherDocumentProcessTaskStatusOut)
async def get_reprocess_teacher_document_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(select(DocumentProcessTask).where(DocumentProcessTask.id == task_id, DocumentProcessTask.teacher_id == user.id))
    task = r.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    req_payload = {}
    res_payload = None
    try:
        req_payload = json.loads(task.request_payload or "{}")
    except Exception:
        req_payload = {}
    try:
        res_payload = json.loads(task.result_payload) if task.result_payload else None
    except Exception:
        res_payload = None
    return TeacherDocumentProcessTaskStatusOut(
        id=task.id,
        course_id=task.course_id,
        chapter_id=task.chapter_id,
        doc_id=task.doc_id,
        status=task.status,
        request_payload=req_payload,
        result_payload=res_payload,
        error_message=task.error_message,
        created_at=task.created_at.isoformat() if task.created_at else None,
        updated_at=task.updated_at.isoformat() if task.updated_at else None,
    )


@router.get("/documents/{doc_id}/file")
async def get_teacher_document_file(
    doc_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    doc, _, _ = await _require_owned_document(db, user.id, doc_id)
    if not doc.file_path:
        raise HTTPException(status_code=404, detail="文档原文件不存在")
    abs_path = Path(settings.upload_dir) / doc.file_path
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="文档文件不存在")
    media_type = mimetypes.guess_type(str(abs_path))[0] or "application/octet-stream"
    return FileResponse(
        path=str(abs_path),
        media_type=media_type,
        filename=doc.file_name or abs_path.name,
    )


@router.get("/classes", response_model=list[TeacherClassOut])
async def list_teacher_classes(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(select(Class).where(Class.owner_teacher_id == user.id).order_by(Class.id))
    rows = r.scalars().all()
    course_ids = [c.course_id for c in rows if c.course_id is not None]
    courses: dict[int, str] = {}
    if course_ids:
        r_course = await db.execute(select(Course).where(Course.id.in_(course_ids)))
        courses = {c.id: c.name for c in r_course.scalars().all()}
    counts: dict[int, int] = {}
    if rows:
        r_count = await db.execute(
            select(StudentClassMembership.class_id, func.count(StudentClassMembership.student_id))
            .where(StudentClassMembership.class_id.in_([c.id for c in rows]))
            .group_by(StudentClassMembership.class_id)
        )
        counts = {cid: cnt for cid, cnt in r_count.all()}
    return [
        TeacherClassOut(
            id=c.id,
            name=c.name,
            term=c.term,
            course_id=c.course_id,
            course_name=courses.get(c.course_id) if c.course_id else None,
            owner_teacher_id=c.owner_teacher_id,
            student_count=counts.get(c.id, 0),
            created_at=c.created_at.isoformat() if c.created_at else None,
        )
        for c in rows
    ]


@router.post("/classes", response_model=TeacherClassOut)
async def create_teacher_class(
    body: TeacherClassCreateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    course = await _require_owned_course(db, user.id, body.course_id)
    c = Class(
        name=body.name.strip(),
        term=body.term,
        course_id=course.id,
        owner_teacher_id=user.id,
    )
    db.add(c)
    await db.flush()
    r_teaching = await db.execute(
        select(Teaching).where(
            Teaching.course_id == course.id,
            Teaching.class_id == c.id,
            Teaching.teacher_id == user.id,
        )
    )
    if not r_teaching.scalar_one_or_none():
        db.add(
            Teaching(
                course_id=course.id,
                class_id=c.id,
                teacher_id=user.id,
                term=body.term,
                is_active=True,
            )
        )
    await db.commit()
    await db.refresh(c)
    return TeacherClassOut(
        id=c.id,
        name=c.name,
        term=c.term,
        course_id=c.course_id,
        course_name=course.name,
        owner_teacher_id=c.owner_teacher_id,
        student_count=0,
        created_at=c.created_at.isoformat() if c.created_at else None,
    )


@router.put("/classes/{class_id}", response_model=TeacherClassOut)
async def update_teacher_class(
    class_id: int,
    body: TeacherClassUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    c = await _require_owned_class(db, user.id, class_id)
    next_course: Course | None = None
    if body.course_id is not None:
        next_course = await _require_owned_course(db, user.id, body.course_id)
        c.course_id = next_course.id
    if body.name is not None:
        c.name = body.name.strip()
    if body.term is not None:
        c.term = body.term
    if c.course_id is not None:
        # 保证班级与课程存在本教师授课关系
        r_teaching = await db.execute(
            select(Teaching).where(
                Teaching.course_id == c.course_id,
                Teaching.class_id == c.id,
                Teaching.teacher_id == user.id,
            )
        )
        if not r_teaching.scalar_one_or_none():
            db.add(
                Teaching(
                    course_id=c.course_id,
                    class_id=c.id,
                    teacher_id=user.id,
                    term=c.term,
                    is_active=True,
                )
            )
    await db.commit()
    await db.refresh(c)
    r_count = await db.execute(
        select(func.count(StudentClassMembership.student_id)).where(StudentClassMembership.class_id == c.id)
    )
    student_count = r_count.scalar() or 0
    if not next_course and c.course_id is not None:
        r_course = await db.execute(select(Course).where(Course.id == c.course_id))
        next_course = r_course.scalar_one_or_none()
    return TeacherClassOut(
        id=c.id,
        name=c.name,
        term=c.term,
        course_id=c.course_id,
        course_name=next_course.name if next_course else None,
        owner_teacher_id=c.owner_teacher_id,
        student_count=student_count,
        created_at=c.created_at.isoformat() if c.created_at else None,
    )


@router.delete("/classes/{class_id}")
async def delete_teacher_class(
    class_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    c = await _require_owned_class(db, user.id, class_id)
    r_m = await db.execute(select(StudentClassMembership).where(StudentClassMembership.class_id == class_id))
    for m in r_m.scalars().all():
        await db.delete(m)
    await db.delete(c)
    await db.commit()
    return {"ok": True}


@router.get("/classes/{class_id}/students", response_model=list[TeacherStudentOut])
async def list_teacher_class_students(
    class_id: int,
    q: str | None = Query(None),
    student_no: str | None = Query(None),
    name: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_class(db, user.id, class_id)
    qry = (
        select(User)
        .join(StudentClassMembership, StudentClassMembership.student_id == User.id)
        .where(User.role == UserRole.student.value, StudentClassMembership.class_id == class_id)
        .order_by(User.id)
    )
    if q and q.strip():
        keyword = f"%{q.strip()}%"
        qry = qry.where((User.username.ilike(keyword)) | (User.display_name.ilike(keyword)) | (User.student_no.ilike(keyword)))
    if student_no and student_no.strip():
        qry = qry.where(User.student_no.ilike(f"%{student_no.strip()}%"))
    if name and name.strip():
        keyword = f"%{name.strip()}%"
        qry = qry.where((User.display_name.ilike(keyword)) | (User.username.ilike(keyword)))
    r = await db.execute(qry)
    return [TeacherStudentOut(id=s.id, username=s.username, student_no=s.student_no, display_name=s.display_name) for s in r.scalars().all()]


@router.post("/classes/{class_id}/students/assign")
async def assign_students_to_teacher_class(
    class_id: int,
    body: TeacherClassStudentsAssignIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_class(db, user.id, class_id)
    ids = [i for i in body.student_ids if isinstance(i, int)]
    qry = select(User).where(User.role == UserRole.student.value)
    if ids:
        qry = qry.where(User.id.in_(ids))
    else:
        if body.student_no and body.student_no.strip():
            qry = qry.where(User.student_no.ilike(f"%{body.student_no.strip()}%"))
        if body.name and body.name.strip():
            keyword = f"%{body.name.strip()}%"
            qry = qry.where((User.display_name.ilike(keyword)) | (User.username.ilike(keyword)))
        if not body.student_no and not body.name:
            raise HTTPException(status_code=400, detail="请填写学号/姓名或选择学生")
    r = await db.execute(qry)
    students = r.scalars().all()
    if not students:
        raise HTTPException(status_code=404, detail="学生不存在")
    assigned = 0
    for s in students:
        r_ex = await db.execute(
            select(StudentClassMembership).where(
                StudentClassMembership.student_id == s.id,
                StudentClassMembership.class_id == class_id,
            )
        )
        if not r_ex.scalar_one_or_none():
            db.add(StudentClassMembership(student_id=s.id, class_id=class_id))
            assigned += 1
    await db.commit()
    return {"ok": True, "assigned": assigned}


@router.delete("/classes/{class_id}/students/{student_id}")
async def remove_student_from_teacher_class(
    class_id: int,
    student_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_class(db, user.id, class_id)
    r = await db.execute(
        select(StudentClassMembership).where(
            StudentClassMembership.class_id == class_id,
            StudentClassMembership.student_id == student_id,
        )
    )
    m = r.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="该学生不在班级中")
    await db.delete(m)
    await db.commit()
    return {"ok": True}


@router.get("/students", response_model=list[TeacherStudentOut])
async def list_students_for_teacher(
    q: str | None = Query(None),
    student_no: str | None = Query(None),
    name: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    qry = select(User).where(User.role == UserRole.student.value).order_by(User.id)
    if q and q.strip():
        keyword = f"%{q.strip()}%"
        qry = qry.where((User.username.ilike(keyword)) | (User.display_name.ilike(keyword)) | (User.student_no.ilike(keyword)))
    if student_no and student_no.strip():
        qry = qry.where(User.student_no.ilike(f"%{student_no.strip()}%"))
    if name and name.strip():
        keyword = f"%{name.strip()}%"
        qry = qry.where((User.display_name.ilike(keyword)) | (User.username.ilike(keyword)))
    r = await db.execute(qry)
    return [TeacherStudentOut(id=s.id, username=s.username, student_no=s.student_no, display_name=s.display_name) for s in r.scalars().all()]


async def _user_ids_by_class(db: AsyncSession, class_id: int | None):
    """若指定 class_id，返回该班级用户 id 列表，用于过滤统计；否则返回 None 表示不过滤"""
    if class_id is None:
        return None
    r = await db.execute(select(StudentClassMembership.student_id).where(StudentClassMembership.class_id == class_id))
    return [row[0] for row in r.all()]


AUTO_SYNONYM_REFRESH_HOURS = 24
AUTO_SYNONYM_MIN_CONFIDENCE = 0.86
AUTO_SYNONYM_MAX_PER_COURSE = 80


def _normalize_question_text(question: str, course_synonyms: dict[str, str] | None = None) -> str:
    text = (question or "").strip().lower()
    if not text:
        return ""
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"[，,。.!！?？:：;；、/\\\"'“”‘’`~·()\[\]{}<>《》【】\-_=+|]+", "", text)
    replacements = {
        "请问一下": "请问",
        "请问": "",
        "一下": "",
        "么": "吗",
        "嘛": "吗",
        "提交": "上交",
        "交作业": "上交作业",
        "练习": "作业",
        "什么时候": "何时",
        "啥时候": "何时",
        "怎么": "如何",
        "如何样": "如何",
        "有何": "",
        "有什么": "",
        "有哪些": "",
        "是什么": "",
        "是啥": "",
        "特征": "特点",
        "的": "",
    }
    for src, dst in replacements.items():
        text = text.replace(src, dst)
    for phrase in ("有什么特点", "特点是什么", "有哪些特点", "有什么特征", "特征是什么", "有哪些特征"):
        text = text.replace(phrase, "特点")
    if course_synonyms:
        for src in sorted(course_synonyms.keys(), key=len, reverse=True):
            dst = course_synonyms.get(src, "")
            if not src or not dst:
                continue
            text = text.replace(src, dst)
    return text.strip()


def _question_keys_similar(a: str, b: str) -> bool:
    if not a or not b:
        return False
    if a == b:
        return True
    if a in b or b in a:
        return True
    ratio = difflib.SequenceMatcher(a=a, b=b).ratio()
    return ratio >= 0.86


def _extract_course_term(text: str) -> str:
    s = _normalize_question_text(text)
    if len(s) < 2:
        return ""
    return s[:40]


def _build_rule_based_aliases(terms: set[str]) -> list[tuple[str, str, float]]:
    pairs: list[tuple[str, str, float]] = []
    if not terms:
        return pairs
    term_set = {t for t in terms if len(t) >= 2}
    for t in term_set:
        if t.endswith("网络"):
            cand = t[:-2] + "网"
            if len(cand) >= 2:
                pairs.append((t, cand, 0.9))
        if t.endswith("特征"):
            cand = t[:-2] + "特点"
            pairs.append((t, cand, 0.88))
        if t.startswith("计算机") and len(t) > 3:
            cand = t.replace("计算机", "", 1)
            if len(cand) >= 2:
                pairs.append((t, cand, 0.86))
    out: list[tuple[str, str, float]] = []
    seen: set[tuple[str, str]] = set()
    for src, dst, conf in pairs:
        if src == dst or len(src) < 2 or len(dst) < 2:
            continue
        k = (src, dst)
        if k in seen:
            continue
        seen.add(k)
        out.append((src, dst, conf))
    return out


async def _auto_generate_course_synonyms(db: AsyncSession, course_id: int) -> list[tuple[str, str, float]]:
    # 1) 从课程内容抽取术语做规则映射
    r_ch = await db.execute(select(Chapter.id, Chapter.title).where(Chapter.course_id == course_id).order_by(Chapter.id))
    ch_rows = r_ch.all()
    chapter_ids = [row[0] for row in ch_rows]
    terms: set[str] = set()
    for _, title in ch_rows:
        t = _extract_course_term(title or "")
        if t:
            terms.add(t)
    if chapter_ids:
        r_kp = await db.execute(select(KnowledgePoint.title).where(KnowledgePoint.chapter_id.in_(chapter_ids)).limit(500))
        for (title,) in r_kp.all():
            t = _extract_course_term(title or "")
            if t:
                terms.add(t)
        r_docs = await db.execute(select(KnowledgeDocument.title).where(KnowledgeDocument.chapter_id.in_(chapter_ids)).limit(500))
        for (title,) in r_docs.all():
            t = _extract_course_term(title or "")
            if t:
                terms.add(t)
    pairs = _build_rule_based_aliases(terms)

    # 2) 从真实问句自动学习（同课程、RAG 命中）
    r_q = await db.execute(
        select(QuestionAsked.question_text, func.count(QuestionAsked.id).label("c"))
        .where(QuestionAsked.course_id == course_id, QuestionAsked.rag_hit == True)
        .group_by(QuestionAsked.question_text)
        .order_by(func.count(QuestionAsked.id).desc())
        .limit(300)
    )
    rows = r_q.all()
    norms = [_normalize_question_text(q or "") for q, _ in rows if (q or "").strip()]
    seen_pairs: set[tuple[str, str]] = {(src, dst) for src, dst, _ in pairs}
    for i in range(len(norms)):
        a = norms[i]
        if len(a) < 3:
            continue
        for j in range(i + 1, len(norms)):
            b = norms[j]
            if len(b) < 3:
                continue
            ratio = difflib.SequenceMatcher(a=a, b=b).ratio()
            if ratio < AUTO_SYNONYM_MIN_CONFIDENCE:
                continue
            src = a if len(a) >= len(b) else b
            dst = b if len(a) >= len(b) else a
            if src == dst:
                continue
            key = (src, dst)
            if key in seen_pairs:
                continue
            seen_pairs.add(key)
            pairs.append((src, dst, min(0.99, ratio)))
            if len(pairs) >= AUTO_SYNONYM_MAX_PER_COURSE:
                return pairs
    return pairs


async def _ensure_course_synonyms(db: AsyncSession, course_id: int):
    now = datetime.utcnow()
    r_existing = await db.execute(
        select(CourseQuestionSynonym)
        .where(
            CourseQuestionSynonym.course_id == course_id,
            CourseQuestionSynonym.auto_generated == True,
        )
        .order_by(CourseQuestionSynonym.updated_at.desc())
    )
    existing = r_existing.scalars().all()
    if existing:
        latest = existing[0].updated_at or existing[0].created_at
        if latest and latest > now - timedelta(hours=AUTO_SYNONYM_REFRESH_HOURS):
            return
    pairs = await _auto_generate_course_synonyms(db, course_id)
    if not pairs:
        return
    existing_by_source = {_normalize_question_text(x.source_term): x for x in existing}
    for src, dst, conf in pairs[:AUTO_SYNONYM_MAX_PER_COURSE]:
        src_norm = _normalize_question_text(src)
        dst_norm = _normalize_question_text(dst)
        if len(src_norm) < 2 or len(dst_norm) < 2 or src_norm == dst_norm:
            continue
        match = existing_by_source.get(src_norm)
        if match:
            match.target_term = dst_norm
            match.confidence = float(conf)
            match.status = "active"
            match.updated_at = now
            continue
        obj = CourseQuestionSynonym(
            course_id=course_id,
            source_term=src_norm,
            target_term=dst_norm,
            confidence=float(conf),
            status="active",
            auto_generated=True,
        )
        db.add(obj)
        existing_by_source[src_norm] = obj
    await db.flush()


async def _load_course_synonym_maps(db: AsyncSession, course_ids: set[int]) -> dict[int, dict[str, str]]:
    if not course_ids:
        return {}
    for course_id in course_ids:
        await _ensure_course_synonyms(db, course_id)
    r = await db.execute(
        select(
            CourseQuestionSynonym.course_id,
            CourseQuestionSynonym.source_term,
            CourseQuestionSynonym.target_term,
            CourseQuestionSynonym.confidence,
        )
        .where(
            CourseQuestionSynonym.course_id.in_(course_ids),
            CourseQuestionSynonym.status == "active",
        )
    )
    out: dict[int, dict[str, str]] = {cid: {} for cid in course_ids}
    for course_id, source_term, target_term, confidence in r.all():
        if float(confidence or 0.0) < AUTO_SYNONYM_MIN_CONFIDENCE:
            continue
        src = _normalize_question_text(source_term or "")
        dst = _normalize_question_text(target_term or "")
        if not src or not dst or src == dst:
            continue
        out.setdefault(course_id, {})[src] = dst
    return out


def _merge_similar_questions(rows: list[tuple[str, int, int | None]], course_synonym_maps: dict[int, dict[str, str]], limit: int = 5) -> list[dict]:
    clusters: list[dict] = []
    for question_text, count, course_id in rows:
        question = (question_text or "").strip()
        if not question:
            continue
        aliases = course_synonym_maps.get(course_id or -1, {})
        key = _normalize_question_text(question, aliases) or question
        hit = None
        for c in clusters:
            if _question_keys_similar(key, c["key"]):
                hit = c
                break
        if hit is None:
            clusters.append({
                "key": key,
                "question": question,
                "count": int(count or 0),
            })
            continue
        hit["count"] += int(count or 0)
        if len(question) < len(hit["question"]):
            hit["question"] = question
        if len(key) < len(hit["key"]):
            hit["key"] = key
    merged = sorted(
        [{"question": c["question"], "count": c["count"]} for c in clusters],
        key=lambda x: (-x["count"], x["question"]),
    )
    return merged[:limit]


async def _teacher_course_ids(db: AsyncSession, teacher_id: int) -> set[int]:
    r_owner = await db.execute(select(Course.id).where(Course.owner_teacher_id == teacher_id))
    owner_ids = {row[0] for row in r_owner.all()}
    r_teaching = await db.execute(select(Teaching.course_id).where(Teaching.teacher_id == teacher_id))
    teaching_ids = {row[0] for row in r_teaching.all()}
    return owner_ids | teaching_ids


def _apply_teacher_qa_scope(
    stmt,
    scoped_course_ids: set[int] | None,
    scoped_chapter_ids: list[int] | None,
):
    """教师端 QA 口径：默认按课程统计；仅在显式选章节时按章节过滤。"""
    if scoped_chapter_ids is not None:
        if not scoped_chapter_ids:
            return stmt.where(QuestionAsked.id == -1)
        return stmt.where(
            QuestionAsked.rag_hit == True,
            QuestionAsked.chapter_id.in_(scoped_chapter_ids),
        )
    if scoped_course_ids is not None:
        if not scoped_course_ids:
            return stmt.where(QuestionAsked.id == -1)
        return stmt.where(
            QuestionAsked.rag_hit == True,
            QuestionAsked.course_id.in_(scoped_course_ids),
        )
    return stmt.where(QuestionAsked.rag_hit == True)


@router.get("/stats/overview", response_model=StatsOverviewOut)
async def stats_overview(
    class_id: int | None = Query(None),
    course_id: int | None = Query(None),
    chapter_id: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    if class_id is not None and user.role == UserRole.teacher.value:
        await _require_owned_class(db, user.id, class_id)
    user_ids = await _user_ids_by_class(db, class_id)
    teacher_course_ids = await _teacher_course_ids(db, user.id) if user.role == UserRole.teacher.value else set()
    if user.role == UserRole.teacher.value and course_id is not None and course_id not in teacher_course_ids:
        raise HTTPException(status_code=404, detail="课程不存在或无权限")

    scoped_course_ids: set[int] | None = None
    if course_id is not None:
        scoped_course_ids = {course_id}
    elif user.role == UserRole.teacher.value:
        scoped_course_ids = teacher_course_ids

    chapter_obj = None
    if chapter_id is not None:
        r_chapter = await db.execute(select(Chapter).where(Chapter.id == chapter_id))
        chapter_obj = r_chapter.scalar_one_or_none()
        if chapter_obj is None:
            raise HTTPException(status_code=404, detail="章节不存在")
        if scoped_course_ids is not None and chapter_obj.course_id not in scoped_course_ids:
            raise HTTPException(status_code=404, detail="章节不存在或无权限")
        # 指定章节时，课程范围收敛到章节所属课程，避免扩大到其他课程。
        if course_id is None and chapter_obj.course_id is not None:
            scoped_course_ids = {chapter_obj.course_id}

    scoped_chapter_ids: list[int] | None = None
    if chapter_obj is not None:
        scoped_chapter_ids = [chapter_obj.id]
    elif scoped_course_ids is not None:
        if scoped_course_ids:
            r_ch = await db.execute(select(Chapter.id).where(Chapter.course_id.in_(scoped_course_ids)))
            scoped_chapter_ids = [row[0] for row in r_ch.all()]
        else:
            scoped_chapter_ids = []
    # QA 统计仅在明确选了章节时才按章节过滤；否则按课程过滤，包含课程级提问（chapter_id 为空）。
    qa_scoped_chapter_ids: list[int] | None = [chapter_obj.id] if chapter_obj is not None else None

    # 预习完成率（可选按班级）
    q_pr = select(func.count(PreviewRecord.id))
    q_pr_done = select(func.count(PreviewRecord.id)).where(PreviewRecord.completed == True)
    if scoped_chapter_ids is not None:
        q_pr = q_pr.where(PreviewRecord.chapter_id.in_(scoped_chapter_ids))
        q_pr_done = q_pr_done.where(PreviewRecord.chapter_id.in_(scoped_chapter_ids))
    if user_ids is not None:
        q_pr = q_pr.where(PreviewRecord.user_id.in_(user_ids))
        q_pr_done = q_pr_done.where(PreviewRecord.user_id.in_(user_ids))
    total_preview = await db.execute(q_pr)
    completed_preview = await db.execute(q_pr_done)
    pr_total = total_preview.scalar() or 0
    pr_done = completed_preview.scalar() or 0
    preview_rate = (pr_done / pr_total * 100) if pr_total else 0.0

    # 提问总数与高频问题
    q_qa = select(func.count(QuestionAsked.id))
    if user.role == UserRole.teacher.value:
        q_qa = _apply_teacher_qa_scope(q_qa, scoped_course_ids, qa_scoped_chapter_ids)
    else:
        if scoped_course_ids is not None:
            q_qa = q_qa.where(QuestionAsked.course_id.in_(scoped_course_ids))
        if scoped_chapter_ids is not None:
            q_qa = q_qa.where(QuestionAsked.chapter_id.in_(scoped_chapter_ids))
    if user_ids is not None:
        q_qa = q_qa.where(QuestionAsked.user_id.in_(user_ids))
    qa_total = await db.execute(q_qa)
    total_asked = qa_total.scalar() or 0
    top_q_stmt = (
        select(
            QuestionAsked.course_id,
            QuestionAsked.question_text,
            func.count(QuestionAsked.id).label("c"),
        )
        .group_by(QuestionAsked.course_id, QuestionAsked.question_text)
    )
    if user.role == UserRole.teacher.value:
        # 高频提问固定按课程口径，不随章节筛选变化。
        top_q_stmt = _apply_teacher_qa_scope(top_q_stmt, scoped_course_ids, None)
    else:
        if scoped_course_ids is not None:
            top_q_stmt = top_q_stmt.where(QuestionAsked.course_id.in_(scoped_course_ids))
        if scoped_chapter_ids is not None:
            top_q_stmt = top_q_stmt.where(QuestionAsked.chapter_id.in_(scoped_chapter_ids))
    if user_ids is not None:
        top_q_stmt = top_q_stmt.where(QuestionAsked.user_id.in_(user_ids))
    top_q_stmt = top_q_stmt.order_by(func.count(QuestionAsked.id).desc()).limit(200)
    top_q = await db.execute(top_q_stmt)
    synonym_course_ids = scoped_course_ids if (scoped_course_ids is not None) else teacher_course_ids
    course_synonym_maps = await _load_course_synonym_maps(db, synonym_course_ids) if synonym_course_ids else {}
    top_asked = _merge_similar_questions([(r[1], r[2], r[0]) for r in top_q.all()], course_synonym_maps, limit=5)

    # 作答正确率
    q_ans = select(func.count(AnswerRecord.id))
    q_ans_ok = select(func.count(AnswerRecord.id)).where(AnswerRecord.is_correct == True)
    if scoped_course_ids is not None or scoped_chapter_ids is not None:
        q_ans = q_ans.join(Question, Question.id == AnswerRecord.question_id)
        q_ans_ok = q_ans_ok.join(Question, Question.id == AnswerRecord.question_id)
        if scoped_course_ids is not None:
            q_ans = q_ans.where(Question.course_id.in_(scoped_course_ids))
            q_ans_ok = q_ans_ok.where(Question.course_id.in_(scoped_course_ids))
        if scoped_chapter_ids is not None:
            q_ans = q_ans.where(Question.chapter_id.in_(scoped_chapter_ids))
            q_ans_ok = q_ans_ok.where(Question.chapter_id.in_(scoped_chapter_ids))
    if user_ids is not None:
        q_ans = q_ans.where(AnswerRecord.user_id.in_(user_ids))
        q_ans_ok = q_ans_ok.where(AnswerRecord.user_id.in_(user_ids))
    total_answers = await db.execute(q_ans)
    correct_answers = await db.execute(q_ans_ok)
    ans_total = total_answers.scalar() or 0
    ans_ok = correct_answers.scalar() or 0
    accuracy = (ans_ok / ans_total * 100) if ans_total else 0.0

    # 薄弱知识点（Top 5）：按错题次数累计到知识点，再取频次最高的 5 个标题
    wrong_q_ids = (
        select(AnswerRecord.question_id, func.count(AnswerRecord.id).label("wrong_count"))
        .where(AnswerRecord.is_correct == False)
    )
    if scoped_course_ids is not None or scoped_chapter_ids is not None:
        wrong_q_ids = wrong_q_ids.join(Question, Question.id == AnswerRecord.question_id)
        if scoped_course_ids is not None:
            wrong_q_ids = wrong_q_ids.where(Question.course_id.in_(scoped_course_ids))
        if scoped_chapter_ids is not None:
            wrong_q_ids = wrong_q_ids.where(Question.chapter_id.in_(scoped_chapter_ids))
    if user_ids is not None:
        wrong_q_ids = wrong_q_ids.where(AnswerRecord.user_id.in_(user_ids))
    wrong_q_ids = wrong_q_ids.group_by(AnswerRecord.question_id)
    r_wrong = await db.execute(wrong_q_ids)
    wrong_rows = [(int(row[0]), int(row[1] or 0)) for row in r_wrong.all() if row[0] is not None]
    weak_titles: list[str] = []
    if wrong_rows:
        wqids = [qid for qid, _ in wrong_rows]
        wrong_count_by_qid = {qid: cnt for qid, cnt in wrong_rows}
        r_questions = await db.execute(select(Question).where(Question.id.in_(wqids)))
        questions = r_questions.scalars().all()
        kp_wrong_counts: dict[int, int] = {}
        for q in questions:
            q_wrong = int(wrong_count_by_qid.get(int(q.id), 0))
            if q_wrong <= 0:
                continue
            if q.knowledge_point_ids:
                for x in str(q.knowledge_point_ids).split(","):
                    x = x.strip()
                    if x.isdigit():
                        kp_id = int(x)
                        kp_wrong_counts[kp_id] = kp_wrong_counts.get(kp_id, 0) + q_wrong
        if kp_wrong_counts:
            kp_stmt = select(KnowledgePoint.id, KnowledgePoint.title).where(KnowledgePoint.id.in_(kp_wrong_counts.keys()))
            if scoped_chapter_ids is not None:
                kp_stmt = kp_stmt.where(KnowledgePoint.chapter_id.in_(scoped_chapter_ids))
            elif scoped_course_ids is not None:
                kp_stmt = kp_stmt.join(Chapter, Chapter.id == KnowledgePoint.chapter_id).where(Chapter.course_id.in_(scoped_course_ids))
            r_kp = await db.execute(kp_stmt)
            kp_title_map = {int(row[0]): row[1] for row in r_kp.all() if row[1]}
            ranked = sorted(
                [(kp_title_map[kid], cnt) for kid, cnt in kp_wrong_counts.items() if kid in kp_title_map],
                key=lambda x: (-x[1], x[0]),
            )
            weak_titles = [title for title, _ in ranked[:5]]
    if not weak_titles and (ans_total or total_asked):
        weak_titles = []  # 无错题时留空，不再写死

    return StatsOverviewOut(
        preview_completion_rate=round(preview_rate, 1),
        total_questions_asked=total_asked,
        top_asked=top_asked,
        answer_accuracy_rate=round(accuracy, 1),
        weak_knowledge_points=weak_titles,
    )


class ApproveContentIn(BaseModel):
    type: str  # "question" | "document"
    id: int


@router.post("/content/approve")
async def approve_content(
    body: ApproveContentIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """内容安全与审核：教师复核通过题目或知识库文档（先审后发占位流程）"""
    from datetime import datetime
    from fastapi import HTTPException
    if body.type == "question":
        r = await db.execute(select(Question).where(Question.id == body.id))
        q = r.scalar_one_or_none()
        if not q:
            raise HTTPException(status_code=404, detail="题目不存在")
        q.is_approved = True
    elif body.type == "document":
        r = await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == body.id))
        doc = r.scalar_one_or_none()
        if not doc:
            raise HTTPException(status_code=404, detail="知识库文档不存在")
        doc.reviewed_at = datetime.utcnow()
    else:
        raise HTTPException(status_code=400, detail="type 须为 question 或 document")
    await db.commit()
    return {"ok": True, "type": body.type, "id": body.id}


@router.get("/export/csv")
async def export_csv(
    report: str = Query("overview", description="overview | preview | answers | qa"),
    class_id: int | None = Query(None),
    course_id: int | None = Query(None),
    chapter_id: int | None = Query(None),
    user: User = Depends(require_teacher),
    db: AsyncSession = Depends(get_db),
):
    """导出学情数据为 CSV"""
    output = io.StringIO()
    writer = csv.writer(output)
    if class_id is not None and user.role == UserRole.teacher.value:
        await _require_owned_class(db, user.id, class_id)
    user_ids = await _user_ids_by_class(db, class_id)
    teacher_course_ids = await _teacher_course_ids(db, user.id) if user.role == UserRole.teacher.value else set()
    if user.role == UserRole.teacher.value and course_id is not None and course_id not in teacher_course_ids:
        raise HTTPException(status_code=404, detail="课程不存在或无权限")

    scoped_course_ids: set[int] | None = None
    if course_id is not None:
        scoped_course_ids = {course_id}
    elif user.role == UserRole.teacher.value:
        scoped_course_ids = teacher_course_ids

    chapter_obj = None
    if chapter_id is not None:
        r_chapter = await db.execute(select(Chapter).where(Chapter.id == chapter_id))
        chapter_obj = r_chapter.scalar_one_or_none()
        if chapter_obj is None:
            raise HTTPException(status_code=404, detail="章节不存在")
        if scoped_course_ids is not None and chapter_obj.course_id not in scoped_course_ids:
            raise HTTPException(status_code=404, detail="章节不存在或无权限")
        if course_id is None and chapter_obj.course_id is not None:
            scoped_course_ids = {chapter_obj.course_id}

    scoped_chapter_ids: list[int] | None = None
    if chapter_obj is not None:
        scoped_chapter_ids = [chapter_obj.id]
    elif scoped_course_ids is not None:
        if scoped_course_ids:
            r_ch = await db.execute(select(Chapter.id).where(Chapter.course_id.in_(scoped_course_ids)))
            scoped_chapter_ids = [row[0] for row in r_ch.all()]
        else:
            scoped_chapter_ids = []
    # QA 导出口径与看板一致：默认按课程统计；仅显式选章节时按章节过滤。
    qa_scoped_chapter_ids: list[int] | None = [chapter_obj.id] if chapter_obj is not None else None

    if report == "preview":
        writer.writerow(["user_id", "chapter_id", "completed", "completed_at"])
        qry = select(PreviewRecord)
        if scoped_chapter_ids is not None:
            qry = qry.where(PreviewRecord.chapter_id.in_(scoped_chapter_ids))
        if user_ids is not None:
            qry = qry.where(PreviewRecord.user_id.in_(user_ids))
        result = await db.execute(qry.order_by(PreviewRecord.created_at.desc()).limit(500))
        for r in result.scalars().all():
            writer.writerow([r.user_id, r.chapter_id, r.completed, r.completed_at])
    elif report == "answers":
        writer.writerow(["user_id", "question_id", "user_answer", "is_correct", "created_at"])
        qry = select(AnswerRecord)
        if scoped_course_ids is not None or scoped_chapter_ids is not None:
            qry = qry.join(Question, Question.id == AnswerRecord.question_id)
            if scoped_course_ids is not None:
                qry = qry.where(Question.course_id.in_(scoped_course_ids))
            if scoped_chapter_ids is not None:
                qry = qry.where(Question.chapter_id.in_(scoped_chapter_ids))
        if user_ids is not None:
            qry = qry.where(AnswerRecord.user_id.in_(user_ids))
        result = await db.execute(qry.order_by(AnswerRecord.created_at.desc()).limit(500))
        for r in result.scalars().all():
            writer.writerow([r.user_id, r.question_id, r.user_answer, r.is_correct, r.created_at])
    elif report == "qa":
        writer.writerow(["user_id", "chapter_id", "question_text", "answer_text", "created_at"])
        qry = select(QuestionAsked)
        if user.role == UserRole.teacher.value:
            qry = _apply_teacher_qa_scope(qry, scoped_course_ids, qa_scoped_chapter_ids)
        else:
            if scoped_course_ids is not None:
                qry = qry.where(QuestionAsked.course_id.in_(scoped_course_ids))
            if scoped_chapter_ids is not None:
                qry = qry.where(QuestionAsked.chapter_id.in_(scoped_chapter_ids))
        if user_ids is not None:
            qry = qry.where(QuestionAsked.user_id.in_(user_ids))
        result = await db.execute(qry.order_by(QuestionAsked.created_at.desc()).limit(500))
        for r in result.scalars().all():
            writer.writerow([r.user_id, r.chapter_id, r.question_text, r.answer_text, r.created_at])
    else:
        writer.writerow(["metric", "value"])
        st = await stats_overview(
            class_id=class_id,
            course_id=course_id,
            chapter_id=chapter_id,
            db=db,
            user=user,
        )
        writer.writerow(["preview_completion_rate", st.preview_completion_rate])
        writer.writerow(["total_questions_asked", st.total_questions_asked])
        writer.writerow(["answer_accuracy_rate", st.answer_accuracy_rate])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue().encode("utf-8-sig")]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=teacher_export.csv"},
    )
