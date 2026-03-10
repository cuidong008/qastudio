"""教师端：教学内容配置、课程/班级管理、学情数据监控与导出"""
import asyncio
import base64
import csv
import difflib
import html
import io
import json
import logging
import mimetypes
import os
import re
import subprocess
import tempfile
import time
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote_plus
from urllib.request import Request, urlopen

from fastapi import APIRouter, Depends, Query, HTTPException, UploadFile, File, BackgroundTasks, Form
from fastapi.responses import StreamingResponse, FileResponse
from openai import OpenAI
from pydantic import BaseModel, Field
from sqlalchemy import select, func, delete, update, and_, or_, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_db
from ..db.session import AsyncSessionLocal
from ..db.models import (
    User, Class, Course, Chapter, Teaching, UserRole,
    StudentClassMembership,
    Question, KnowledgePoint, KnowledgeDocument, DocumentChapter, PreviewRecord,
    AnswerRecord, QuestionAsked, ChapterConfig, CourseQuestionSynonym, QuestionGenerationTask, DocumentProcessTask, CourseReindexTask, Paper, PaperFile,
    ReviewRecord, StudentFeedback,
)
from ..api.auth import require_teacher
from ..services.chapter_cleanup_service import cleanup_chapter_related_data
from ..services.course_knowledge_service import clear_course_knowledge
from ..services.course_reindex_task_service import run_course_reindex_task_thread
from ..services.difficulty import difficulty_from_score

router = APIRouter(prefix="/teacher", tags=["teacher"])
logger = logging.getLogger(__name__)
DOC_PROCESS_TASK_STALE_MINUTES = 30


def _is_teacher_scoped(user: User) -> bool:
    """教师或教研组长：仅能操作自己名下的数据；admin 可看全部"""
    return user.role in (UserRole.teacher.value, UserRole.teaching_leader.value)

# 文档处理任务运行时状态（内存）：重启后为空，不持久化
_document_task_running: set[int] = set()
_document_task_cancelled: set[int] = set()


async def reset_document_process_tasks_on_startup() -> None:
    """应用启动时将 DB 中未完成的任务标为已取消，避免重启后仍显示「处理中」。"""
    async with AsyncSessionLocal() as db:
        r = await db.execute(
            select(DocumentProcessTask).where(
                DocumentProcessTask.status.in_(["pending", "running"])
            )
        )
        tasks = r.scalars().all()
        if not tasks:
            return
        msg = "服务重启已中断"
        for t in tasks:
            t.status = "cancelled"
            t.error_message = msg
        doc_ids = [t.doc_id for t in tasks]
        rdoc = await db.execute(
            select(KnowledgeDocument).where(
                KnowledgeDocument.id.in_(doc_ids),
                KnowledgeDocument.parse_status == "processing",
            )
        )
        for d in rdoc.scalars().all():
            d.parse_status = "failed"
            d.parse_error = (d.parse_error or "").strip() or msg
        await db.commit()
        logger.info("document_process_tasks_reset_on_startup count=%s doc_ids=%s", len(tasks), doc_ids)


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


class PaperGenerateDefaultRowOut(BaseModel):
    """生成试卷页「题型数量&难度配置」表格一行的默认值（无 id）"""
    type: str  # single_choice | multiple_choice | judge | blank | qa
    count: int
    difficulty: str
    score: float


class ExerciseGenerateDefaultRowOut(BaseModel):
    """生成习题页「题目类型配置」表格一行的默认值（最大数量、难度系数）"""
    type: str  # single_choice | multiple_choice | judge | blank | qa
    max: int
    difficulty: str


@router.get("/config/exercise-generate-defaults", response_model=list[ExerciseGenerateDefaultRowOut])
async def get_exercise_generate_defaults(
    user: User = Depends(require_teacher),
):
    """获取生成习题页「题目类型配置」表格的默认行（最大数量、难度系数由后台配置）"""
    s = settings
    return [
        ExerciseGenerateDefaultRowOut(
            type="single_choice",
            max=s.exercise_default_single_choice_max,
            difficulty=s.exercise_default_difficulty,
        ),
        ExerciseGenerateDefaultRowOut(
            type="multiple_choice",
            max=s.exercise_default_multiple_choice_max,
            difficulty=s.exercise_default_difficulty,
        ),
        ExerciseGenerateDefaultRowOut(
            type="judge",
            max=s.exercise_default_judge_max,
            difficulty=s.exercise_default_difficulty,
        ),
        ExerciseGenerateDefaultRowOut(
            type="blank",
            max=s.exercise_default_blank_max,
            difficulty=s.exercise_default_difficulty,
        ),
        ExerciseGenerateDefaultRowOut(
            type="qa",
            max=s.exercise_default_qa_max,
            difficulty=s.exercise_default_difficulty,
        ),
    ]


class StatsOverviewOut(BaseModel):
    preview_completion_rate: float
    preview_student_count: int = 0  # 有预习记录的学生数（去重）
    completed_question_count: int = 0  # 完成习题数（作答记录数）
    feedback_question_count: int = 0  # 反馈问题数（按课程/班级筛选）
    top_asked: list[dict]  # 每项含 question, count, course_id (可选)
    answer_accuracy_rate: float
    ai_ask_count: int = 0  # AI提问数：与 top_asked 同口径（课程/章节/学生范围内答疑提问总数）
    ai_irrelevant_count: int = 0  # AI无关问题数：course_irrelevant=True 的提问条数
    weak_knowledge_points: list[str]
    weak_knowledge_point_course_ids: list[int | None] = []  # 与 weak_knowledge_points 同序，每条对应课程 id
    weak_knowledge_point_wrong_counts: list[int] = []  # 与 weak_knowledge_points 同序，每条错题次数


class StatsByCourseStudentRowOut(BaseModel):
    """学情课程统计详细表一行：按课程+学生维度，班级名称来自教师管理且关联该课程、该学生为其成员的班级"""
    course_id: int
    course_name: str
    student_id: int
    student_no: str
    student_name: str
    class_name: str  # 从 teacher/classes 关联：该课程下、该学生所属的班级名称
    preview_rate: str  # 该学生在该课程下的预习完成率（课程维度），如 "85.0%"
    preview_completed_chapter_ids: list[int] = []  # 该学生在该课程下已完成预习的章节 id 列表，学情章节表按「本章是否完成」显示 100% 或 0%
    completed_question_count: int
    completed_question_count_by_chapter: list[dict] = []  # 学情章节表用：按章节的完成习题数，[{"chapter_id": int, "count": int}]
    correct_question_count_by_chapter: list[dict] = []  # 学情章节表用：按章节的正确习题数，[{"chapter_id": int, "count": int}]，用于计算每章正确率
    accuracy_rate: str  # 如 "92.1%" 或 "—"
    feedback_question_count: int
    ai_ask_count: int
    ai_irrelevant_count: int
    weak_knowledge_points: str  # 学情课程表：按「课程+学生」维度的高频薄弱知识点，多条用 "; " 连接
    weak_knowledge_points_by_chapter: list[dict] = []  # 学情章节表：按「课程+章节+学生」维度，[{"chapter_id": int, "weak_knowledge_points": str}]


@router.get("/config/paper-generate-defaults", response_model=list[PaperGenerateDefaultRowOut])
async def get_paper_generate_defaults(
    user: User = Depends(require_teacher),
):
    """获取生成试卷页「题型数量&难度配置」表格的默认行（数量、难度、每题分数由后台配置）"""
    s = settings
    return [
        PaperGenerateDefaultRowOut(
            type="single_choice",
            count=s.paper_default_single_choice_count,
            difficulty=s.paper_default_difficulty,
            score=s.paper_default_single_choice_score,
        ),
        PaperGenerateDefaultRowOut(
            type="multiple_choice",
            count=s.paper_default_multiple_choice_count,
            difficulty=s.paper_default_difficulty,
            score=s.paper_default_multiple_choice_score,
        ),
        PaperGenerateDefaultRowOut(
            type="judge",
            count=s.paper_default_judge_count,
            difficulty=s.paper_default_difficulty,
            score=s.paper_default_judge_score,
        ),
        PaperGenerateDefaultRowOut(
            type="blank",
            count=s.paper_default_blank_count,
            difficulty=s.paper_default_difficulty,
            score=s.paper_default_blank_score,
        ),
        PaperGenerateDefaultRowOut(
            type="qa",
            count=s.paper_default_qa_count,
            difficulty=s.paper_default_difficulty,
            score=s.paper_default_qa_score,
        ),
    ]


@router.get("/config/chapters", response_model=list[ChapterConfigOut])
async def list_chapter_configs(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """获取所有章节及其配置（用于教师端配置页）"""
    chapter_qry = select(Chapter).order_by(Chapter.order_index, Chapter.id)
    if _is_teacher_scoped(user):
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
    if _is_teacher_scoped(user):
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
    remark: str | None = None
    is_active: bool
    owner_teacher_id: int | None
    created_at: str | None


class TeacherCourseCreateIn(BaseModel):
    name: str
    code: str | None = None
    description: str | None = None
    remark: str | None = Field(default=None, max_length=128)
    is_active: bool = True


class TeacherCourseUpdateIn(BaseModel):
    name: str | None = None
    code: str | None = None
    description: str | None = None
    remark: str | None = Field(default=None, max_length=128)
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
    question_bank_type: str = Field(default="training", min_length=1, max_length=20)
    single_choice_difficulty_score: float = Field(default=0.8, ge=0, le=1, multiple_of=0.01)
    multiple_choice_difficulty_score: float = Field(default=0.8, ge=0, le=1, multiple_of=0.01)
    judge_difficulty_score: float = Field(default=0.8, ge=0, le=1, multiple_of=0.01)
    qa_difficulty_score: float = Field(default=0.8, ge=0, le=1, multiple_of=0.01)
    blank_difficulty_score: float = Field(default=0.8, ge=0, le=1, multiple_of=0.01)
    knowledge_point_ids: list[int] = Field(default_factory=list)


class TeacherPaperGenerateConfigIn(BaseModel):
    type: str = Field(min_length=1, max_length=32)
    count: int = Field(default=0, ge=0, le=200)
    difficulty: float | None = Field(default=None, ge=0, le=1, multiple_of=0.01)
    score: float = Field(default=0, ge=0, le=100)


class TeacherPaperPreviewQuestionIn(BaseModel):
    question_type: str = Field(min_length=1, max_length=32)
    question_text: str = Field(min_length=1, max_length=10000)
    options: list[str] = Field(default_factory=list)
    correct_answer: str = Field(default="", max_length=1000)
    explanation: str | None = None
    difficulty_score: float = Field(default=0.8, ge=0, le=1, multiple_of=0.01)
    score: float = Field(default=0, ge=0, le=100)
    source: str = Field(default="local", min_length=1, max_length=20)


class TeacherGeneratePaperIn(BaseModel):
    course_id: int
    chapter_ids: list[int] = Field(default_factory=list, min_length=1)
    paper_title: str = Field(min_length=1, max_length=128)
    paper_bank_type: str = Field(default="training", min_length=1, max_length=20)  # training | formal
    question_source: str = Field(default="local", min_length=1, max_length=20)  # local | internet
    overall_difficulty: float | None = Field(default=None, ge=0, le=1, multiple_of=0.01)
    configs: list[TeacherPaperGenerateConfigIn] = Field(default_factory=list, min_length=1)
    save_to_bank: bool = True
    preview_questions_override: list[TeacherPaperPreviewQuestionIn] | None = None


class TeacherPaperInsufficientOut(BaseModel):
    question_type: str
    requested: int
    available: int
    missing: int


class TeacherPaperPreviewQuestionOut(BaseModel):
    question_type: str
    question_text: str
    options: list[str] = []
    correct_answer: str
    explanation: str | None = None
    difficulty_score: float
    score: float
    source: str  # local | internet


class TeacherGeneratePaperOut(BaseModel):
    ok: bool = True
    paper_id: int | None = None
    status: str
    is_partial: bool
    message: str
    insufficient_types: list[TeacherPaperInsufficientOut] = []
    preview_questions: list[TeacherPaperPreviewQuestionOut] = []
    total_score: float
    overall_difficulty: float


class TeacherPaperListItemOut(BaseModel):
    id: int
    course_id: int
    course_name: str
    title: str
    paper_type: str  # electronic | file
    paper_bank_type: str
    question_source: str
    status: str
    review_status: str  # pending | reviewed
    is_partial: bool
    total_score: float
    overall_difficulty: float
    chapter_ids: list[int] = []
    created_at: str | None
    updated_at: str | None


class TeacherPaperDetailOut(TeacherPaperListItemOut):
    request_payload: dict
    content_payload: dict | None
    error_message: str | None


class TeacherPaperUpdateIn(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=128)
    status: str | None = Field(default=None, min_length=1, max_length=24)
    paper_bank_type: str | None = Field(default=None, min_length=1, max_length=20)
    question_source: str | None = Field(default=None, min_length=1, max_length=20)
    total_score: float | None = Field(default=None, ge=0)
    overall_difficulty: float | None = Field(default=None, ge=0, le=1)
    request_payload: dict | None = None
    content_payload: dict | None = None
    error_message: str | None = None


class TeacherPaperPageOut(BaseModel):
    items: list[TeacherPaperListItemOut]
    total: int
    page: int
    page_size: int


class TeacherPaperBatchDeleteIn(BaseModel):
    paper_ids: list[int] = Field(min_length=1)


class TeacherPaperBatchDeleteOut(BaseModel):
    ok: bool = True
    deleted: int


class TeacherPaperFileOut(BaseModel):
    id: int
    paper_id: int
    file_name: str
    created_at: str | None


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


class TeacherGenerateTaskSummaryOut(BaseModel):
    task_id: int
    course_id: int
    chapter_id: int
    status: str
    updated_at: str | None


class TeacherDocumentProcessTaskOut(BaseModel):
    ok: bool = True
    task_id: int
    status: str


class TeacherDocumentProcessTaskStatusOut(BaseModel):
    id: int
    course_id: int
    chapter_id: int | None
    doc_id: int
    status: str
    request_payload: dict
    result_payload: dict | None
    error_message: str | None
    created_at: str | None
    updated_at: str | None


class TeacherCourseReindexTaskOut(BaseModel):
    ok: bool = True
    task_id: int
    status: str


class TeacherCourseReindexTaskStatusOut(BaseModel):
    id: int
    course_id: int
    status: str
    request_payload: dict
    result_payload: dict | None
    error_message: str | None
    created_at: str | None
    updated_at: str | None


class TeacherCourseReindexTaskSummaryOut(BaseModel):
    task_id: int
    course_id: int
    status: str
    updated_at: str | None


class TeacherQuestionOut(BaseModel):
    id: int
    course_id: int | None
    course_name: str | None
    chapter_id: int
    chapter_title: str
    question_type: str
    question_bank_type: str
    difficulty: str
    difficulty_score: float
    question_text: str
    options: str | None
    correct_answer: str
    explanation: str | None
    remark: str | None
    is_approved: bool
    generated_time: str | None
    edited_time: str | None
    knowledge_point_ids: str | None
    knowledge_points: list[str] = []
    created_at: str | None


class TeacherQuestionUpdateIn(BaseModel):
    difficulty: str | None = None
    question_bank_type: str | None = None
    difficulty_score: float | None = Field(default=None, ge=0, le=1, multiple_of=0.01)
    question_text: str | None = None
    options: list[str] | None = None
    correct_answer: str | None = None
    explanation: str | None = None
    remark: str | None = Field(default=None, max_length=128)
    is_approved: bool | None = None
    knowledge_point_ids: list[int] | None = None


class TeacherImportQuestionPreviewItemOut(BaseModel):
    chapter_id: int | None = None
    chapter_title: str | None = None
    question_type: str
    question_text: str
    options: list[str] = []
    correct_answer: str
    explanation: str | None = None
    difficulty_score: float | None = None  # 0~1，识别不到则为 None


class TeacherImportQuestionsPreviewOut(BaseModel):
    course_id: int
    chapter_ids: list[int]
    question_bank_type: str
    parsed_count: int
    items: list[TeacherImportQuestionPreviewItemOut]


class TeacherGenerateQuestionsPreviewOut(BaseModel):
    course_id: int
    chapter_id: int
    question_bank_type: str
    output_count: int
    generated_count: int
    by_type: dict[str, int]
    skipped: int
    items: list[TeacherImportQuestionPreviewItemOut]


class TeacherImportConfirmItemIn(BaseModel):
    chapter_id: int
    question_type: str
    question_text: str
    options: list[str] = []
    correct_answer: str
    explanation: str | None = None
    difficulty_score: float | None = None


class TeacherImportConfirmIn(BaseModel):
    course_id: int
    question_bank_type: str = "training"
    items: list[TeacherImportConfirmItemIn]


class TeacherImportConfirmOut(BaseModel):
    imported_count: int
    message: str


class TeacherDocumentChunkOut(BaseModel):
    index: int
    text: str


class TeacherKnowledgeDocumentOut(BaseModel):
    id: int
    chapter_id: int | None
    course_id: int | None = None
    source_type: str
    title: str
    page_ref: str | None
    file_name: str | None
    file_size: int | None
    parse_status: str | None
    parse_error: str | None
    chunk_count: int | None
    student_visible: bool = True
    downloadable: bool = True
    chapter_ids: list[int] = []
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
    admin_class_or_dept: str | None = None


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


async def _require_owned_document(db: AsyncSession, teacher_id: int, doc_id: int) -> tuple[KnowledgeDocument, Chapter | None, Course]:
    r = await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == doc_id))
    doc = r.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="文档不存在")
    if doc.chapter_id is not None:
        r2 = await db.execute(
            select(Chapter, Course)
            .join(Course, Course.id == Chapter.course_id)
            .where(Chapter.id == doc.chapter_id, Course.owner_teacher_id == teacher_id)
        )
        row2 = r2.first()
        if not row2:
            raise HTTPException(status_code=404, detail="文档不存在或无权限")
        return doc, row2[0], row2[1]
    if doc.course_id is not None:
        r3 = await db.execute(
            select(Course).where(Course.id == doc.course_id, Course.owner_teacher_id == teacher_id)
        )
        course = r3.scalar_one_or_none()
        if not course:
            raise HTTPException(status_code=404, detail="文档不存在或无权限")
        ch_result = await db.execute(select(Chapter).where(Chapter.course_id == doc.course_id).order_by(Chapter.order_index).limit(1))
        first_ch = ch_result.scalar_one_or_none()
        return doc, first_ch, course
    raise HTTPException(status_code=404, detail="文档不存在或无权限")


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


def _summarize_llm_raw_for_log(raw: object, head_chars: int = 800, tail_chars: int = 400) -> tuple[int, str, str]:
    text = str(raw or "")
    compact = re.sub(r"\s+", " ", text).strip()
    if not compact:
        return 0, "", ""
    head = compact[:max(0, int(head_chars))]
    if len(compact) > tail_chars:
        tail = compact[-max(0, int(tail_chars)):]
    else:
        tail = compact
    return len(compact), head, tail


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


def _normalize_question_bank_type(value: object) -> str:
    s = str(value or "").strip().lower()
    if s in {"training", "train", "训练库"}:
        return "training"
    if s in {"exam", "考试用题库", "考试题库"}:
        return "exam"
    return "training"


def _normalize_paper_bank_type(value: object) -> str:
    s = str(value or "").strip().lower()
    if s in {"training", "train", "训练库"}:
        return "training"
    if s in {"formal", "exam", "正式题库", "正式库"}:
        return "formal"
    return "training"


def _normalize_question_source(value: object) -> str:
    s = str(value or "").strip().lower()
    if s in {"internet", "web", "online", "互联网", "联网"}:
        return "internet"
    return "local"


def _normalize_paper_status(value: object) -> str:
    s = str(value or "").strip().lower()
    if s in {"reviewed", "已审核", "generated", "已生成"}:
        return "reviewed"
    if s in {"pending", "待审核", "partial", "未完全生成", "部分生成", "failed", "失败"}:
        return "pending"
    return "pending"


def _normalize_difficulty_score(value: object, default: float = 0.8) -> float:
    try:
        x = float(value)
    except Exception:
        return float(default)
    if x < 0:
        x = 0.0
    if x > 1:
        x = 1.0
    return round(float(x), 2)


def _parse_question_options(options_raw: object) -> list[str]:
    if options_raw is None:
        return []
    if isinstance(options_raw, list):
        values = options_raw
    else:
        try:
            parsed = json.loads(str(options_raw))
            values = parsed if isinstance(parsed, list) else []
        except Exception:
            return []
    out: list[str] = []
    for item in values:
        s = str(item or "").strip()
        if not s:
            continue
        out.append(s)
    return out


def _strip_html_tags(text: str) -> str:
    s = re.sub(r"<[^>]+>", " ", text or "")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _duckduckgo_search_snippets(query: str, max_items: int = 5, timeout_sec: float = 8.0) -> list[str]:
    q = (query or "").strip()
    if not q:
        return []
    url = f"https://duckduckgo.com/html/?q={quote_plus(q)}"
    req = Request(
        url=url,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"
        },
    )
    try:
        with urlopen(req, timeout=timeout_sec) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
    except Exception:
        return []
    blocks = re.findall(r'<a[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)</a>[\s\S]{0,1200}?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)</a>', html, flags=re.I)
    out: list[str] = []
    for title_html, snippet_html in blocks:
        title = _strip_html_tags(title_html)
        snippet = _strip_html_tags(snippet_html)
        if not (title or snippet):
            continue
        merged = f"{title}：{snippet}".strip("：")
        if merged:
            out.append(merged[:300])
        if len(out) >= max_items:
            break
    return out


def _build_web_search_queries(course_name: str, chapter_title: str, kp_rows: list[tuple[int, str, str | None]]) -> list[str]:
    queries: list[str] = []
    base = f"{course_name} {chapter_title} 题目 习题"
    queries.append(base.strip())
    for _, kp_title, _ in kp_rows[:6]:
        t = (kp_title or "").strip()
        if not t:
            continue
        queries.append(f"{course_name} {chapter_title} {t} 练习题".strip())
    seen: set[str] = set()
    out: list[str] = []
    for q in queries:
        k = _normalize_text_key(q)
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(q)
    return out[:8]


async def _build_online_search_context(course_name: str, chapter_title: str, kp_rows: list[tuple[int, str, str | None]]) -> str:
    queries = _build_web_search_queries(course_name, chapter_title, kp_rows)
    if not queries:
        return ""
    context_parts: list[str] = []
    for q in queries:
        snippets = await asyncio.to_thread(_duckduckgo_search_snippets, q, 4, 8.0)
        if not snippets:
            continue
        context_parts.append(f"联网检索关键词：{q}\n" + "\n".join([f"- {x}" for x in snippets]))
    return "\n\n".join(context_parts).strip()


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


def _plan_question_generation_batches(
    limits: dict[str, int],
    output_token_budget: int,
) -> list[dict[str, int]]:
    """
    按题型顺序规划分批，尽量不拆分单个题型到多批。
    仅当某题型自身超出单批预算时，才强制拆分该题型。
    """
    type_order = ["single_choice", "multiple_choice", "judge", "blank", "qa"]
    # 经验值：用于估算单题输出 token 成本（含 JSON 结构与字段开销）
    per_question_token_est = {
        "single_choice": 170,
        "multiple_choice": 185,
        "judge": 95,
        "blank": 90,
        "qa": 120,
    }
    budget = max(200, int(output_token_budget))
    batches: list[dict[str, int]] = []
    current = {k: 0 for k in type_order}
    current_cost = 0

    def _flush():
        nonlocal current, current_cost
        total = sum(current.values())
        if total > 0:
            batches.append({k: int(v) for k, v in current.items() if int(v) > 0})
        current = {k: 0 for k in type_order}
        current_cost = 0

    for q_type in type_order:
        remain = max(0, int(limits.get(q_type, 0)))
        if remain <= 0:
            continue
        unit_cost = max(1, int(per_question_token_est.get(q_type, 120)))
        while remain > 0:
            full_cost = remain * unit_cost
            # 当前批可容纳该题型全部剩余：整块放入，不拆分。
            if current_cost + full_cost <= budget:
                current[q_type] += remain
                current_cost += full_cost
                remain = 0
                continue
            # 当前批已有题，且放不下该题型全部：先结批，下一批再尝试整块放入。
            if current_cost > 0:
                _flush()
                continue
            # 当前批为空但该题型自身超预算：必须拆分该题型。
            fit = max(1, budget // unit_cost)
            take = max(1, min(remain, fit))
            current[q_type] += take
            current_cost += take * unit_cost
            remain -= take
            _flush()
    _flush()
    return batches


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


async def _backfill_question_kp_ids_for_chapter(
    db: AsyncSession,
    chapter_id: int,
    overwrite: bool = False,
) -> int:
    """按当前章节知识点重新匹配并回填题目的 knowledge_point_ids。"""
    r_kps = await db.execute(
        select(KnowledgePoint.id, KnowledgePoint.title, KnowledgePoint.content)
        .where(KnowledgePoint.chapter_id == chapter_id)
        .order_by(KnowledgePoint.order_index, KnowledgePoint.id)
    )
    kp_rows = r_kps.all()
    chapter_kp_matchers = _build_chapter_kp_matchers(kp_rows)
    if not chapter_kp_matchers:
        return 0

    q_stmt = select(Question).where(Question.chapter_id == chapter_id)
    if not overwrite:
        q_stmt = q_stmt.where((Question.knowledge_point_ids == None) | (func.trim(Question.knowledge_point_ids) == ""))
    r_q = await db.execute(q_stmt.order_by(Question.id))
    questions = r_q.scalars().all()

    updated = 0
    for q in questions:
        matched_kp_ids = _match_question_kp_ids(q.question_text or "", q.explanation, chapter_kp_matchers, limit=3)
        knowledge_point_ids = ",".join(str(x) for x in matched_kp_ids) if matched_kp_ids else None
        current_val = (q.knowledge_point_ids or "").strip() if q.knowledge_point_ids else ""
        next_val = knowledge_point_ids or ""
        if current_val == next_val:
            continue
        q.knowledge_point_ids = knowledge_point_ids
        updated += 1
    return updated


def _build_generate_questions_prompt(
    chapter_title: str,
    context: str,
    single_choice_max: int,
    multiple_choice_max: int,
    judge_max: int,
    qa_max: int,
    blank_max: int,
    question_bank_type: str,
    single_choice_difficulty_score: float,
    multiple_choice_difficulty_score: float,
    judge_difficulty_score: float,
    qa_difficulty_score: float,
    blank_difficulty_score: float,
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
题库类型：{question_bank_type}
各题型目标难度系数（0~1，越大越难）：
- single_choice：{single_choice_difficulty_score}
- multiple_choice：{multiple_choice_difficulty_score}
- judge：{judge_difficulty_score}
- qa：{qa_difficulty_score}
- blank：{blank_difficulty_score}
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


def _build_generate_knowledge_points_auto_prompt(
    chapter_title: str,
    syllabus_ref: str | None,
    context: str,
    max_count: int = 10,
) -> str:
    return f"""你是一名课程教研助理。请根据给定章节内容，提炼适合课堂教学的知识点。

章节标题：{chapter_title}
教学大纲引用：{(syllabus_ref or "无").strip()}

要求：
1) 由你自行判断本章合适的知识点数量，建议 4~{max_count} 条，不得超过 {max_count} 条。
2) 尽量覆盖概念、原理、应用场景，避免重复与空泛。
3) title 控制在 8~24 字，content 用 1~2 句话解释，便于教师讲解。
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
    raw = await asyncio.to_thread(
        llm.generate,
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


async def _generate_knowledge_points_for_chapter_auto(
    db: AsyncSession,
    chapter: Chapter,
    max_count: int = 10,
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
    prompt = _build_generate_knowledge_points_auto_prompt(
        chapter_title=chapter.title,
        syllabus_ref=chapter.syllabus_ref,
        context=context,
        max_count=max_count,
    )
    raw = await asyncio.to_thread(
        llm.generate,
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
        if len(out) >= max_count:
            break
    if not out:
        raise RuntimeError("未生成有效知识点，请重试")
    return out


async def _auto_generate_and_save_kps_for_chapter(
    db: AsyncSession,
    chapter: Chapter,
    max_count: int = 10,
) -> list[tuple[int, str, str | None]]:
    generated = await _generate_knowledge_points_for_chapter_auto(db, chapter, max_count=max_count)
    await db.execute(delete(KnowledgePoint).where(KnowledgePoint.chapter_id == chapter.id))
    for idx, kp in enumerate(generated):
        db.add(
            KnowledgePoint(
                chapter_id=chapter.id,
                title=kp.title,
                content=kp.content,
                ppt_slide_ref=kp.ppt_slide_ref,
                order_index=idx + 1,
            )
        )
    await db.flush()
    r_kps = await db.execute(
        select(KnowledgePoint.id, KnowledgePoint.title, KnowledgePoint.content)
        .where(KnowledgePoint.chapter_id == chapter.id)
        .order_by(KnowledgePoint.order_index, KnowledgePoint.id)
    )
    return [(int(row[0]), str(row[1] or ""), row[2]) for row in r_kps.all() if row[0] and row[1]]


def _trim_text_for_answer(value: str | None, limit: int = 32) -> str:
    txt = re.sub(r"\s+", " ", (value or "").strip())
    if not txt:
        return ""
    return txt[:limit] if len(txt) > limit else txt


def _question_has_any_kp_id(question: Question, kp_ids: set[int]) -> bool:
    if not kp_ids:
        return False
    q_kp_ids = set(_parse_numeric_id_csv(question.knowledge_point_ids))
    return bool(q_kp_ids.intersection(kp_ids))


async def _cleanup_orphan_knowledge_points_for_chapter(db: AsyncSession, chapter_id: int) -> int:
    r_kp = await db.execute(select(KnowledgePoint.id).where(KnowledgePoint.chapter_id == chapter_id))
    kp_ids = [int(row[0]) for row in r_kp.all() if row[0] is not None]
    if not kp_ids:
        return 0

    r_q = await db.execute(select(Question.knowledge_point_ids).where(Question.chapter_id == chapter_id, Question.is_active == True))
    referenced: set[int] = set()
    for row in r_q.all():
        referenced.update(_parse_numeric_id_csv(row[0]))

    orphan_ids = [kid for kid in kp_ids if kid not in referenced]
    if not orphan_ids:
        return 0
    await db.execute(delete(KnowledgePoint).where(KnowledgePoint.id.in_(orphan_ids)))
    return len(orphan_ids)


async def _ensure_each_kp_has_question(
    db: AsyncSession,
    chapter: Chapter,
    course: Course,
    kp_rows: list[tuple[int, str, str | None]],
    existing_keys: set[str],
    created_by_type: dict[str, int],
    created_by_diff: dict[str, int],
    question_bank_type: str,
    default_difficulty_score: float,
    qa_limit: int | None = None,
) -> int:
    if not kp_rows:
        return 0

    r_q = await db.execute(
        select(Question.id, Question.knowledge_point_ids)
        .where(Question.chapter_id == chapter.id, Question.is_active == True)
    )
    covered_ids: set[int] = set()
    for _, kp_csv in r_q.all():
        covered_ids.update(_parse_numeric_id_csv(kp_csv))

    added = 0
    for kp_id, kp_title, kp_content in kp_rows:
        if qa_limit is not None and int(created_by_type.get("qa", 0)) >= int(qa_limit):
            break
        if int(kp_id) in covered_ids:
            continue
        base_q = f"【知识点专项】请简要说明“{kp_title}”的核心概念与应用。"
        q_text = base_q
        suffix = 2
        while _normalize_text_key(q_text) in existing_keys:
            q_text = f"{base_q}（补充题{suffix}）"
            suffix += 1
        answer = _trim_text_for_answer(kp_content, 32) or _trim_text_for_answer(kp_title, 32) or "见课堂讲解"
        explanation = f"本题用于覆盖知识点：{kp_title}。"
        now_ts = datetime.utcnow()
        db.add(
            Question(
                course_id=course.id,
                chapter_id=chapter.id,
                question_bank_type=question_bank_type,
                difficulty_score=default_difficulty_score,
                difficulty="basic",
                question_type="qa",
                question_text=q_text,
                options=None,
                correct_answer=answer,
                explanation=explanation,
                knowledge_point_ids=str(int(kp_id)),
                is_active=True,
                is_approved=False,
                generated_time=now_ts,
                edited_time=now_ts,
            )
        )
        existing_keys.add(_normalize_text_key(q_text))
        covered_ids.add(int(kp_id))
        created_by_type["qa"] = int(created_by_type.get("qa", 0)) + 1
        created_by_diff["basic"] = int(created_by_diff.get("basic", 0)) + 1
        added += 1
    return added


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


def _extract_pdf_text(file_binary: bytes, file_name: str) -> tuple[str, int | None]:
    """仅做 PDF 文本提取，不访问 DB。返回 (extracted_text, total_pages)，失败时抛出 HTTPException。"""
    engine = (settings.pdf_parse_engine or "mineru_then_pypdf").strip().lower()
    prefer_chinese = bool(re.search(r"[\u4e00-\u9fff]", file_name or "")) or (settings.mineru_lang or "").startswith("ch")
    default_pdf_parser = ""
    try:
        from ..rag.config_store import get_default_pdf_parser
        default_pdf_parser = get_default_pdf_parser()
    except Exception:
        default_pdf_parser = ""
    logger.info(
        "doc_parse_start file=%s size=%s engine=%s default_pdf_parser=%s",
        file_name, len(file_binary), engine, bool(default_pdf_parser),
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
                file_name, len((extracted_text or "").strip()), total_pages,
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
                            file_name, len(extracted_text.strip()), len(fallback_text.strip()),
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
        file_name, len((extracted_text or "").strip()), total_pages,
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
    return extracted_text, total_pages


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
    extracted_text, total_pages = _extract_pdf_text(file_binary, file_name)
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


def _extract_docx_text(content: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            names = [n for n in ("word/document.xml", "word/footnotes.xml", "word/endnotes.xml") if n in zf.namelist()]
            if not names:
                return ""
            parts: list[str] = []
            for name in names:
                xml = zf.read(name).decode("utf-8", errors="ignore")
                xml = re.sub(r"</w:p\s*>", "\n", xml, flags=re.IGNORECASE)
                xml = re.sub(r"<[^>]+>", "", xml)
                txt = html.unescape(xml).strip()
                if txt:
                    parts.append(txt)
            return "\n".join(parts).strip()
    except Exception:
        return ""


def _extract_legacy_word_text(content: bytes) -> str:
    for enc in ("utf-8", "gb18030", "gbk"):
        try:
            text = content.decode(enc, errors="ignore").strip()
            if _looks_like_useful_text(text, prefer_chinese=True):
                return text
        except Exception:
            continue
    return ""


def _build_import_questions_prompt(
    question_context: str,
    answer_context: str,
    chapter_options_text: str,
) -> str:
    return f"""你是一名严谨的试题整理助手。请从“题目文档”和“答案文档”中提取题目，并尽量将题目与答案正确对应。

要求：
1) 只输出 JSON，不要输出 markdown 或解释。
2) question_type 取值仅允许：single_choice | multiple_choice | judge | blank | qa。
2.1) chapter_title 尽量从给定章节列表中选择最匹配的一项；无法判断可留空字符串。
3) 如果是 single_choice / multiple_choice，options 最多 4 个，correct_answer 优先输出字母（A/B/C/D 或 A,C）。
4) 如果是 judge，correct_answer 仅输出 A 或 B（A=正确，B=错误）。
5) 题干尽量简洁完整，去掉无关前后缀。
6) 若无法确认答案，可留空字符串，但尽量依据答案文档补全。
7) explanation 可为空字符串。
8) difficulty_score：难度系数，取值 0~1（0 最难，1 最简单）。根据题干与答案综合判断难度；无法判断时可省略该字段或留空。

输出格式（严格）：
{{
  "questions": [
    {{
      "chapter_title": "章节名称（来自给定章节列表）",
      "question_type": "single_choice|multiple_choice|judge|blank|qa",
      "question_text": "题干",
      "options": ["A选项", "B选项", "C选项", "D选项"],
      "correct_answer": "A",
      "explanation": "解析",
      "difficulty_score": 0.8
    }}
  ]
}}

题目文档内容：
{question_context}

答案文档内容：
{answer_context}

可选章节列表（请优先从这里选择 chapter_title）：
{chapter_options_text}
"""


def _pair_name_key(file_name: str, role: str) -> str:
    stem = Path(file_name or "").stem
    s = stem.lower()
    # 统一分隔符，便于 key 对齐（中英文括号、横线、空格等）。
    s = re.sub(r"[\s_\-\(\)\[\]【】（）]+", "", s)
    answer_tokens = ["参考答案", "答案", "解析", "解答", "answer", "answers", "solution", "solutions"]
    question_tokens = ["题目", "试题", "question", "questions"]
    tokens = answer_tokens if role == "answer" else question_tokens
    for t in tokens:
        s = s.replace(t, "")
    return s.strip()


def _pair_documents_by_name(
    docs: list[dict[str, object]],
) -> tuple[list[tuple[dict[str, object], dict[str, object]]], list[dict[str, object]], list[dict[str, object]]]:
    answer_docs = [d for d in docs if bool(d.get("is_answer"))]
    question_docs = [d for d in docs if not bool(d.get("is_answer"))]
    matched_pairs: list[tuple[dict[str, object], dict[str, object]]] = []
    used_q_ids: set[int] = set()
    used_a_ids: set[int] = set()

    q_by_key: dict[str, list[dict[str, object]]] = {}
    for q in question_docs:
        key = _pair_name_key(str(q.get("file_name") or ""), "question")
        q_by_key.setdefault(key, []).append(q)

    # 第一轮：key 精确匹配
    for a in answer_docs:
        a_key = _pair_name_key(str(a.get("file_name") or ""), "answer")
        if not a_key:
            continue
        cands = [q for q in q_by_key.get(a_key, []) if int(q["idx"]) not in used_q_ids]
        if not cands:
            continue
        best_q = cands[0]
        matched_pairs.append((best_q, a))
        used_q_ids.add(int(best_q["idx"]))
        used_a_ids.add(int(a["idx"]))

    # 第二轮：模糊匹配（处理 A卷.docx ↔ A卷答案.docx 等）
    for a in answer_docs:
        if int(a["idx"]) in used_a_ids:
            continue
        a_key = _pair_name_key(str(a.get("file_name") or ""), "answer")
        best_q: dict[str, object] | None = None
        best_score = 0.0
        for q in question_docs:
            if int(q["idx"]) in used_q_ids:
                continue
            q_key = _pair_name_key(str(q.get("file_name") or ""), "question")
            if not q_key and not a_key:
                continue
            score = difflib.SequenceMatcher(None, q_key, a_key).ratio()
            if score > best_score:
                best_score = score
                best_q = q
        if best_q is not None and best_score >= 0.55:
            matched_pairs.append((best_q, a))
            used_q_ids.add(int(best_q["idx"]))
            used_a_ids.add(int(a["idx"]))

    unmatched_questions = [q for q in question_docs if int(q["idx"]) not in used_q_ids]
    unmatched_answers = [a for a in answer_docs if int(a["idx"]) not in used_a_ids]
    return matched_pairs, unmatched_questions, unmatched_answers


def _normalize_import_questions(
    candidates: list[dict],
    chapter_options: list[tuple[int, str]],
) -> list[TeacherImportQuestionPreviewItemOut]:
    chapter_title_map = {title: cid for cid, title in chapter_options}
    chapter_norm_map = {re.sub(r"\s+", "", (title or "").lower()): (cid, title) for cid, title in chapter_options}

    def _match_chapter(raw_title: object, q_text: str, explanation: str | None) -> tuple[int | None, str | None]:
        t = str(raw_title or "").strip()
        if t and t in chapter_title_map:
            return chapter_title_map[t], t
        t_norm = re.sub(r"\s+", "", t.lower())
        if t_norm and t_norm in chapter_norm_map:
            cid, title = chapter_norm_map[t_norm]
            return cid, title
        # 模糊匹配：章标题在题干/解析中命中
        hay = f"{q_text}\n{explanation or ''}"
        for cid, title in chapter_options:
            if title and title in hay:
                return cid, title
        if len(chapter_options) == 1:
            cid, title = chapter_options[0]
            return cid, title
        # 模糊字符串相似度兜底
        if t:
            best_cid: int | None = None
            best_title: str | None = None
            best_score = 0.0
            for cid, title in chapter_options:
                score = difflib.SequenceMatcher(None, t, title).ratio()
                if score > best_score:
                    best_score = score
                    best_cid = cid
                    best_title = title
            if best_cid is not None and best_score >= 0.55:
                return best_cid, best_title
        return None, None

    def _fallback_answer_from_explanation(explanation: str) -> str:
        text = (explanation or "").strip()
        if not text:
            return ""
        m = re.search(r"(?:参考答案|答案|answer)\s*[:：]\s*(.+)", text, flags=re.IGNORECASE)
        if m:
            return _trim_answer(m.group(1), max_len=64)
        # 兜底：取第一行作为答案
        first_line = text.splitlines()[0].strip()
        return _trim_answer(first_line, max_len=64)

    out: list[TeacherImportQuestionPreviewItemOut] = []
    for item in candidates:
        q_type = _to_question_type(str(item.get("question_type") or item.get("type") or ""))
        if not q_type:
            continue
        q_text = str(item.get("question_text") or "").strip()
        if not q_text:
            continue
        options: list[str] = []
        answer = ""
        if q_type == "single_choice":
            opts = _normalize_choice_options(item.get("options"))
            ans = _normalize_choice_answer(item.get("correct_answer"), opts)
            if len(opts) == 4:
                options = [f"{chr(ord('A') + i)}. {x}" for i, x in enumerate(opts)]
            answer = ans or _trim_answer(item.get("correct_answer"), max_len=16)
        elif q_type == "multiple_choice":
            opts = _normalize_choice_options(item.get("options"))
            ans = _normalize_multi_answer(item.get("correct_answer"))
            if len(opts) == 4:
                options = [f"{chr(ord('A') + i)}. {x}" for i, x in enumerate(opts)]
            answer = ans or _trim_answer(item.get("correct_answer"), max_len=16)
        elif q_type == "judge":
            options = ["A. 正确", "B. 错误"]
            answer = _normalize_judge_answer(item.get("correct_answer")) or _trim_answer(item.get("correct_answer"), max_len=8)
        else:
            answer = _trim_answer(item.get("correct_answer"), max_len=64)
        explanation = str(item.get("explanation") or "").strip() or None
        if not answer and explanation:
            # 部分模型会把答案写到 explanation 字段，这里做回填。
            answer = _fallback_answer_from_explanation(explanation)
        if not answer and q_type == "judge" and explanation:
            j = _normalize_judge_answer(explanation)
            if j:
                answer = j
        chapter_id, chapter_title = _match_chapter(item.get("chapter_title"), q_text, explanation)
        raw_diff = item.get("difficulty_score")
        try:
            d = float(raw_diff) if raw_diff is not None and str(raw_diff).strip() != "" else None
        except (TypeError, ValueError):
            d = None
        if d is not None and (d < 0 or d > 1):
            d = None
        out.append(
            TeacherImportQuestionPreviewItemOut(
                chapter_id=chapter_id,
                chapter_title=chapter_title,
                question_type=q_type,
                question_text=q_text,
                options=options,
                correct_answer=answer,
                explanation=explanation,
                difficulty_score=round(d, 2) if d is not None else None,
            )
        )
    return out


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
            remark=c.remark,
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
    remark_val = (body.remark or "").strip()[:128] if body.remark else None
    c = Course(
        name=body.name.strip(),
        code=body.code.strip() if body.code else None,
        description=body.description,
        remark=remark_val or None,
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
        remark=c.remark,
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
    if body.remark is not None:
        c.remark = (body.remark.strip()[:128] or None) if body.remark else None
    if body.is_active is not None:
        c.is_active = body.is_active
    await db.commit()
    await db.refresh(c)
    return TeacherCourseOut(
        id=c.id,
        name=c.name,
        code=c.code,
        description=c.description,
        remark=c.remark,
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
    r_ch = await db.execute(select(Chapter.id).where(Chapter.course_id == course_id))
    chapter_ids = [row[0] for row in r_ch.all()]
    # 先删依赖 chapter 的任务表（含 doc_id 引用 knowledge_documents），再删章节关联数据，最后删章节
    if chapter_ids:
        await db.execute(delete(QuestionGenerationTask).where(QuestionGenerationTask.chapter_id.in_(chapter_ids)))
        await db.execute(delete(DocumentProcessTask).where(DocumentProcessTask.chapter_id.in_(chapter_ids)))
        await db.execute(delete(ReviewRecord).where(ReviewRecord.chapter_id.in_(chapter_ids)))
    await db.flush()
    for ch_id in chapter_ids:
        await cleanup_chapter_related_data(db, ch_id)
    await db.flush()
    if chapter_ids:
        await db.execute(delete(Chapter).where(Chapter.id.in_(chapter_ids)))
    await db.execute(delete(Chapter).where(Chapter.course_id == course_id))
    await db.flush()
    logger.info("delete_course_chapters course_id=%s chapter_ids=%s", course_id, chapter_ids)
    await db.execute(delete(Teaching).where(Teaching.course_id == course_id))
    await db.execute(delete(CourseQuestionSynonym).where(CourseQuestionSynonym.course_id == course_id))
    await db.execute(update(Class).where(Class.course_id == course_id).values(course_id=None))
    await db.execute(update(QuestionAsked).where(QuestionAsked.course_id == course_id).values(course_id=None))
    await db.execute(delete(CourseReindexTask).where(CourseReindexTask.course_id == course_id))
    # 课程级文档（无 chapter_id）：删除记录并删磁盘文件
    r_kd = await db.execute(
        select(KnowledgeDocument.file_path).where(
            and_(KnowledgeDocument.course_id == course_id, KnowledgeDocument.chapter_id.is_(None))
        )
    )
    course_level_paths = [row[0] for row in r_kd.all() if row[0]]
    await db.execute(
        delete(KnowledgeDocument).where(
            and_(KnowledgeDocument.course_id == course_id, KnowledgeDocument.chapter_id.is_(None))
        )
    )
    await db.flush()
    root = Path(settings.upload_dir)
    for rel in course_level_paths:
        try:
            path = root / rel
            if path.exists() and path.is_file():
                path.unlink()
        except Exception as e:
            logger.warning("delete_course_level_file_failed course_id=%s file=%s err=%s", course_id, rel, str(e))
    await db.delete(c)
    await db.commit()
    try:
        from ..rag.config import get_rag_settings
        from ..rag.store.chroma_store import ChromaVectorStore
        store = ChromaVectorStore(get_rag_settings())
        store.delete_by_course(course_id)
    except Exception as e:
        logger.warning("delete_course_vector_cleanup_skipped course_id=%s err=%s", course_id, str(e)[:200])
    return {"ok": True}


@router.post("/courses/{course_id}/reindex", response_model=TeacherCourseReindexTaskOut)
async def reindex_teacher_course(
    course_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_course(db, user.id, course_id)
    r_running = await db.execute(
        select(CourseReindexTask)
        .where(CourseReindexTask.course_id == course_id, CourseReindexTask.status.in_(["pending", "running"]))
        .order_by(CourseReindexTask.id.desc())
    )
    running = r_running.scalar_one_or_none()
    if running:
        return TeacherCourseReindexTaskOut(task_id=running.id, status=running.status)
    task = CourseReindexTask(
        course_id=course_id,
        requested_by_id=user.id,
        requested_by_role="teacher",
        status="pending",
        request_payload=json.dumps({"course_id": course_id}, ensure_ascii=False),
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    background_tasks.add_task(run_course_reindex_task_thread, task.id)
    return TeacherCourseReindexTaskOut(task_id=task.id, status=task.status)


@router.get("/courses/reindex/tasks/{task_id}", response_model=TeacherCourseReindexTaskStatusOut)
async def get_teacher_course_reindex_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(
        select(CourseReindexTask, Course)
        .join(Course, Course.id == CourseReindexTask.course_id)
        .where(CourseReindexTask.id == task_id, Course.owner_teacher_id == user.id)
    )
    row = r.first()
    if not row:
        raise HTTPException(status_code=404, detail="任务不存在")
    task = row[0]
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
    return TeacherCourseReindexTaskStatusOut(
        id=task.id,
        course_id=task.course_id,
        status=task.status,
        request_payload=req_payload,
        result_payload=res_payload,
        error_message=task.error_message,
        created_at=task.created_at.isoformat() if task.created_at else None,
        updated_at=task.updated_at.isoformat() if task.updated_at else None,
    )


@router.get("/courses/reindex/active", response_model=list[TeacherCourseReindexTaskSummaryOut])
async def list_teacher_course_reindex_active_tasks(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(
        select(CourseReindexTask, Course)
        .join(Course, Course.id == CourseReindexTask.course_id)
        .where(
            Course.owner_teacher_id == user.id,
            CourseReindexTask.status.in_(["pending", "running"]),
        )
        .order_by(CourseReindexTask.course_id, CourseReindexTask.id.desc())
    )
    latest_by_course: dict[int, CourseReindexTask] = {}
    for row in r.all():
        task = row[0]
        if task.course_id not in latest_by_course:
            latest_by_course[task.course_id] = task
    return [
        TeacherCourseReindexTaskSummaryOut(
            task_id=t.id,
            course_id=t.course_id,
            status=t.status,
            updated_at=t.updated_at.isoformat() if t.updated_at else None,
        )
        for t in latest_by_course.values()
    ]


@router.post("/courses/{course_id}/clear-knowledge")
async def clear_teacher_course_knowledge(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_course(db, user.id, course_id)
    stats = await clear_course_knowledge(db, course_id)
    await db.commit()
    chunks = 0
    try:
        from ..services.rag_index_service import build_index_for_course
        chunks = await build_index_for_course(db, course_id)
    except Exception as e:
        logger.warning("clear_knowledge_reindex_skipped course_id=%s err=%s", course_id, str(e)[:300])
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


@router.get("/courses/{course_id}/documents", response_model=list[TeacherKnowledgeDocumentOut])
async def list_teacher_course_documents(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_course(db, user.id, course_id)
    ch_sub = select(Chapter.id).where(Chapter.course_id == course_id)
    doc_ids_sub = select(DocumentChapter.doc_id).where(DocumentChapter.chapter_id.in_(ch_sub)).distinct()
    r = await db.execute(
        select(KnowledgeDocument)
        .where(or_(KnowledgeDocument.course_id == course_id, KnowledgeDocument.id.in_(doc_ids_sub)))
        .order_by(KnowledgeDocument.id.desc())
    )
    rows = r.scalars().all()
    doc_ids = [d.id for d in rows]
    chapter_ids_map = await _get_doc_chapter_ids(db, doc_ids)
    return [
        TeacherKnowledgeDocumentOut(
            id=d.id,
            chapter_id=d.chapter_id,
            course_id=getattr(d, "course_id", None),
            source_type=d.source_type,
            title=d.title,
            page_ref=d.page_ref,
            file_name=d.file_name,
            file_size=d.file_size,
            parse_status=d.parse_status,
            parse_error=d.parse_error,
            chunk_count=d.chunk_count,
            student_visible=getattr(d, "student_visible", True) if getattr(d, "student_visible", None) is not None else True,
            downloadable=getattr(d, "downloadable", True) if getattr(d, "downloadable", None) is not None else True,
            chapter_ids=chapter_ids_map.get(d.id, []),
            created_at=d.created_at.isoformat() if d.created_at else None,
        )
        for d in rows
    ]


def _parse_chapter_ids_form(value: str) -> list[int]:
    if not (value or "").strip():
        return []
    try:
        raw = json.loads(value)
        return [int(x) for x in raw if isinstance(x, (int, float)) and int(x) > 0]
    except Exception:
        return []


@router.post("/courses/{course_id}/documents/upload", response_model=TeacherKnowledgeDocumentOut)
async def upload_teacher_course_document(
    course_id: int,
    file: UploadFile = File(...),
    chapter_ids_json: str = Form("[]", description="JSON 数组，关联章节 id；空或 [] 表示全部章节"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    course = await _require_owned_course(db, user.id, course_id)
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="请上传 PDF 文件")
    binary = await file.read()
    if not binary:
        raise HTTPException(status_code=400, detail="文件内容为空")
    r_ch = await db.execute(select(Chapter.id).where(Chapter.course_id == course_id).order_by(Chapter.order_index))
    all_chapter_ids = [row[0] for row in r_ch.all()]
    chapter_ids = _parse_chapter_ids_form(chapter_ids_json)
    if not chapter_ids:
        chapter_ids = all_chapter_ids
    if not chapter_ids and all_chapter_ids:
        chapter_ids = all_chapter_ids
    for ch_id in chapter_ids:
        await _require_owned_chapter(db, user.id, ch_id)
    root = Path(settings.upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    subdir = root / "knowledge"
    subdir.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_pdf_filename(file.filename)
    saved_name = f"c{course_id}_{int(time.time())}_{safe_name}"
    abs_path = subdir / saved_name
    abs_path.write_bytes(binary)
    rel_path = f"knowledge/{saved_name}"
    doc = KnowledgeDocument(
        course_id=course_id,
        chapter_id=chapter_ids[0] if chapter_ids else None,
        source_type="pdf_upload",
        title=file.filename,
        content="",
        file_name=file.filename,
        file_path=rel_path,
        file_size=len(binary),
        parse_status="uploaded",
        parse_error=None,
        chunk_count=None,
        student_visible=False,
        downloadable=False,
    )
    db.add(doc)
    await db.flush()
    for ch_id in chapter_ids:
        db.add(DocumentChapter(doc_id=doc.id, chapter_id=ch_id))
    await db.commit()
    await db.refresh(doc)
    chapter_ids_map = await _get_doc_chapter_ids(db, [doc.id])
    return TeacherKnowledgeDocumentOut(
        id=doc.id,
        chapter_id=doc.chapter_id,
        course_id=doc.course_id,
        source_type=doc.source_type,
        title=doc.title,
        page_ref=doc.page_ref,
        file_name=doc.file_name,
        file_size=doc.file_size,
        parse_status=doc.parse_status,
        parse_error=doc.parse_error,
        chunk_count=doc.chunk_count,
        student_visible=doc.student_visible,
        downloadable=doc.downloadable,
        chapter_ids=chapter_ids_map.get(doc.id, []),
        created_at=doc.created_at.isoformat() if doc.created_at else None,
    )


@router.post("/courses/{course_id}/videos/upload", response_model=TeacherKnowledgeDocumentOut)
async def upload_teacher_course_video(
    course_id: int,
    file: UploadFile = File(...),
    chapter_ids_json: str = Form("[]", description="JSON 数组，关联章节 id；空或 [] 表示全部章节"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    course = await _require_owned_course(db, user.id, course_id)
    if not file.filename:
        raise HTTPException(status_code=400, detail="请上传视频文件")
    ext = Path(file.filename).suffix.lower()
    if ext not in {".mp4", ".webm", ".mkv", ".mov", ".m4v"}:
        raise HTTPException(status_code=400, detail="仅支持 mp4/webm/mkv/mov/m4v 视频文件")
    binary = await file.read()
    if not binary:
        raise HTTPException(status_code=400, detail="文件内容为空")
    r_ch = await db.execute(select(Chapter.id).where(Chapter.course_id == course_id).order_by(Chapter.order_index))
    all_chapter_ids = [row[0] for row in r_ch.all()]
    chapter_ids = _parse_chapter_ids_form(chapter_ids_json)
    if not chapter_ids:
        chapter_ids = all_chapter_ids
    for ch_id in chapter_ids:
        await _require_owned_chapter(db, user.id, ch_id)
    root = Path(settings.upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    subdir = root / "preview_videos"
    subdir.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_upload_filename(file.filename)
    saved_name = f"c{course_id}_{int(time.time())}_{safe_name}"
    abs_path = subdir / saved_name
    abs_path.write_bytes(binary)
    rel_path = f"preview_videos/{saved_name}"
    doc = KnowledgeDocument(
        course_id=course_id,
        chapter_id=chapter_ids[0] if chapter_ids else None,
        source_type="preview_video",
        title=file.filename,
        content="",
        file_name=file.filename,
        file_path=rel_path,
        file_size=len(binary),
        parse_status="done",
        parse_error=None,
        chunk_count=0,
        student_visible=False,
        downloadable=False,
    )
    db.add(doc)
    await db.flush()
    for ch_id in chapter_ids:
        db.add(DocumentChapter(doc_id=doc.id, chapter_id=ch_id))
    await db.commit()
    await db.refresh(doc)
    chapter_ids_map = await _get_doc_chapter_ids(db, [doc.id])
    return TeacherKnowledgeDocumentOut(
        id=doc.id,
        chapter_id=doc.chapter_id,
        course_id=doc.course_id,
        source_type=doc.source_type,
        title=doc.title,
        page_ref=doc.page_ref,
        file_name=doc.file_name,
        file_size=doc.file_size,
        parse_status=doc.parse_status,
        parse_error=doc.parse_error,
        chunk_count=doc.chunk_count,
        student_visible=doc.student_visible,
        downloadable=doc.downloadable,
        chapter_ids=chapter_ids_map.get(doc.id, []),
        created_at=doc.created_at.isoformat() if doc.created_at else None,
    )


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
    r_old_kp = await db.execute(
        select(KnowledgePoint.id, KnowledgePoint.title)
        .where(KnowledgePoint.chapter_id == chapter.id)
        .order_by(KnowledgePoint.order_index, KnowledgePoint.id)
    )
    old_kps = [(int(row[0]), str(row[1] or "").strip()) for row in r_old_kp.all() if row[0]]
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
    new_title_keys = {_normalize_text_key(item.title) for item in cleaned if (item.title or "").strip()}
    removed_kp_ids = [
        kid for kid, title in old_kps
        if title and _normalize_text_key(title) not in new_title_keys
    ]
    if removed_kp_ids:
        r_q = await db.execute(select(Question).where(Question.chapter_id == chapter.id))
        questions = r_q.scalars().all()
        removed_set = set(int(x) for x in removed_kp_ids)
        for q in questions:
            if _question_has_any_kp_id(q, removed_set):
                await db.delete(q)
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
    await db.flush()
    await _backfill_question_kp_ids_for_chapter(db, chapter.id, overwrite=True)
    await _cleanup_orphan_knowledge_points_for_chapter(db, chapter.id)
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
    dry_run: bool = False,
) -> tuple[dict[str, int], int, list[TeacherImportQuestionPreviewItemOut], int]:
    question_bank_type = _normalize_question_bank_type(body.question_bank_type)
    type_difficulty_score = {
        "single_choice": _normalize_difficulty_score(body.single_choice_difficulty_score),
        "multiple_choice": _normalize_difficulty_score(body.multiple_choice_difficulty_score),
        "judge": _normalize_difficulty_score(body.judge_difficulty_score),
        "qa": _normalize_difficulty_score(body.qa_difficulty_score),
        "blank": _normalize_difficulty_score(body.blank_difficulty_score),
    }
    r_docs = await db.execute(
        select(KnowledgeDocument.title, KnowledgeDocument.content, KnowledgeDocument.page_ref)
        .where(KnowledgeDocument.chapter_id == chapter.id)
        .order_by(KnowledgeDocument.id.desc())
        .limit(30)
    )
    doc_rows = r_docs.all()
    selected_kp_ids = [int(x) for x in (body.knowledge_point_ids or []) if int(x) > 0]
    # 若前端指定了知识点，则仅按所选知识点出题；未选时：章节已有知识点则用已有出题，否则再自动生成知识点后出题。
    if selected_kp_ids:
        r_kps = await db.execute(
            select(KnowledgePoint.id, KnowledgePoint.title, KnowledgePoint.content)
            .where(KnowledgePoint.chapter_id == chapter.id, KnowledgePoint.id.in_(selected_kp_ids))
            .order_by(KnowledgePoint.order_index, KnowledgePoint.id)
        )
        kp_rows = [(int(row[0]), str(row[1] or ""), row[2]) for row in r_kps.all() if row[0] and row[1]]
        if not kp_rows:
            raise RuntimeError("所选知识点与当前章节不匹配，无法生成习题")
    else:
        # 先查该章节是否已有知识点
        r_existing = await db.execute(
            select(KnowledgePoint.id, KnowledgePoint.title, KnowledgePoint.content)
            .where(KnowledgePoint.chapter_id == chapter.id)
            .order_by(KnowledgePoint.order_index, KnowledgePoint.id)
        )
        existing_rows = [(int(row[0]), str(row[1] or ""), row[2]) for row in r_existing.all() if row[0] and row[1]]
        if existing_rows:
            kp_rows = existing_rows
        else:
            # 章节无知识点时再自动生成（最多 10 条），再根据知识点出题
            kp_rows = await _auto_generate_and_save_kps_for_chapter(db, chapter, max_count=10)
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
    # 联网检索补充上下文：根据课程/章节/知识点抓取公开网页摘要，提升题目覆盖与新颖度。
    online_context = await _build_online_search_context(course.name or "", chapter.title or "", kp_rows)
    if online_context:
        context_parts.append(online_context)
    context = "\n\n---\n\n".join(context_parts).strip()
    if not context:
        raise RuntimeError("该章节暂无可用内容，请先上传或解析文档后再生成")
    if len(context) > 18000:
        context = context[:18000]

    from ..rag.config import get_rag_settings
    from ..rag.llm import get_llm

    settings = get_rag_settings()
    llm = get_llm(settings)
    llm_max_tokens = max(
        1400,
        int(getattr(settings, "exercise_generate_max_tokens", 4096) or settings.llm_max_tokens or 512),
    )
    limits = {
        "single_choice": body.single_choice_max,
        "multiple_choice": body.multiple_choice_max,
        "judge": body.judge_max,
        "qa": body.qa_max,
        "blank": body.blank_max,
    }
    total_expected = sum(limits.values())
    diff_limits = _difficulty_limits(total_expected)
    batch_output_budget = max(600, int(llm_max_tokens * 0.65))
    planned_batches = _plan_question_generation_batches(limits, batch_output_budget)
    if not planned_batches:
        planned_batches = [{k: int(v) for k, v in limits.items() if int(v) > 0}]
    logger.info(
        "question_generate_batch_plan course_id=%s chapter_id=%s total_expected=%s llm_max_tokens=%s batch_budget=%s batches=%s",
        course.id,
        chapter.id,
        total_expected,
        llm_max_tokens,
        batch_output_budget,
        planned_batches,
    )

    model_output_count = 0
    created_by_type: dict[str, int] = {"single_choice": 0, "multiple_choice": 0, "judge": 0, "qa": 0, "blank": 0}
    created_by_diff: dict[str, int] = {"basic": 0, "applied": 0, "extended": 0}
    preview_items: list[TeacherImportQuestionPreviewItemOut] = []
    skipped = 0

    r_existing = await db.execute(select(Question.question_text).where(Question.chapter_id == chapter.id))
    existing_keys = {_normalize_text_key(row[0]) for row in r_existing.all() if (row[0] or "").strip()}

    def _mark_skipped(candidate_idx: int | None, skipped_candidate_indices: set[int]):
        nonlocal skipped
        if candidate_idx is None:
            skipped += 1
            return
        if candidate_idx in skipped_candidate_indices:
            return
        skipped_candidate_indices.add(candidate_idx)
        skipped += 1

    def _try_add_item(
        item: dict,
        enforce_diff_limit: bool,
        candidate_idx: int | None,
        accepted_candidate_indices: set[int],
        skipped_candidate_indices: set[int],
    ) -> bool:
        nonlocal skipped
        q_type = _to_question_type(str(item.get("type") or ""))
        if not q_type:
            _mark_skipped(candidate_idx, skipped_candidate_indices)
            return False
        if created_by_type[q_type] >= limits[q_type]:
            return False
        q_text_raw = str(item.get("question_text") or "").strip()
        if not q_text_raw:
            _mark_skipped(candidate_idx, skipped_candidate_indices)
            return False
        q_text = q_text_raw
        key = _normalize_text_key(q_text)
        if key in existing_keys:
            _mark_skipped(candidate_idx, skipped_candidate_indices)
            return False

        pre_explanation = str(item.get("explanation") or "").strip() or None
        matched_kp_ids = _match_question_kp_ids(q_text, pre_explanation, chapter_kp_matchers, limit=3)
        knowledge_point_ids = ",".join(str(x) for x in matched_kp_ids) if matched_kp_ids else None
        difficulty = _normalize_difficulty(item.get("difficulty"))
        if enforce_diff_limit and created_by_diff[difficulty] >= diff_limits[difficulty]:
            return False
        options_text: str | None = None
        correct_answer: str | None = None
        preview_options: list[str] = []
        if q_type == "single_choice":
            opts = _normalize_choice_options(item.get("options"))
            ans = _normalize_choice_answer(item.get("correct_answer"), opts)
            if len(opts) != 4 or not ans:
                _mark_skipped(candidate_idx, skipped_candidate_indices)
                return False
            options_text = json.dumps([f"{chr(ord('A') + i)}. {x}" for i, x in enumerate(opts)], ensure_ascii=False)
            correct_answer = ans
            preview_options = opts
        elif q_type == "multiple_choice":
            opts = _normalize_choice_options(item.get("options"))
            ans = _normalize_multi_answer(item.get("correct_answer"))
            if len(opts) != 4 or len([x for x in ans.split(",") if x]) < 2:
                _mark_skipped(candidate_idx, skipped_candidate_indices)
                return False
            options_text = json.dumps([f"{chr(ord('A') + i)}. {x}" for i, x in enumerate(opts)], ensure_ascii=False)
            correct_answer = ans
            preview_options = opts
        elif q_type == "judge":
            ans = _normalize_judge_answer(item.get("correct_answer"))
            if not ans:
                _mark_skipped(candidate_idx, skipped_candidate_indices)
                return False
            options_text = json.dumps(["A. 正确", "B. 错误"], ensure_ascii=False)
            correct_answer = ans
            preview_options = ["正确", "错误"]
        else:
            ans = _trim_answer(item.get("correct_answer"))
            if not ans:
                _mark_skipped(candidate_idx, skipped_candidate_indices)
                return False
            correct_answer = ans

        raw_explanation = str(item.get("explanation") or "").strip()
        explanation = raw_explanation or f"参考答案：{correct_answer}"

        now_ts = datetime.utcnow()
        if not dry_run:
            db.add(
                Question(
                    course_id=course.id,
                    chapter_id=chapter.id,
                    question_bank_type=question_bank_type,
                    difficulty_score=type_difficulty_score[q_type],
                    difficulty=difficulty,
                    question_type=q_type,
                    question_text=q_text,
                    options=options_text,
                    correct_answer=correct_answer,
                    explanation=explanation,
                    knowledge_point_ids=knowledge_point_ids,
                    is_active=True,
                    is_approved=False,
                    generated_time=now_ts,
                    edited_time=now_ts,
                )
            )
        else:
            preview_items.append(
                TeacherImportQuestionPreviewItemOut(
                    chapter_id=chapter.id,
                    chapter_title=chapter.title,
                    question_type=q_type,
                    question_text=q_text,
                    options=preview_options,
                    correct_answer=correct_answer,
                    explanation=explanation,
                    difficulty_score=type_difficulty_score[q_type],
                )
            )
        created_by_type[q_type] += 1
        created_by_diff[difficulty] += 1
        existing_keys.add(key)
        if candidate_idx is not None:
            accepted_candidate_indices.add(candidate_idx)
        return True

    for batch_idx, batch_limits in enumerate(planned_batches, start=1):
        batch_total = sum(int(v) for v in batch_limits.values())
        if batch_total <= 0:
            continue
        batch_diff_limits = _difficulty_limits(batch_total)
        prompt = _build_generate_questions_prompt(
            chapter_title=chapter.title,
            context=context,
            single_choice_max=int(batch_limits.get("single_choice", 0)),
            multiple_choice_max=int(batch_limits.get("multiple_choice", 0)),
            judge_max=int(batch_limits.get("judge", 0)),
            qa_max=int(batch_limits.get("qa", 0)),
            blank_max=int(batch_limits.get("blank", 0)),
            question_bank_type=question_bank_type,
            single_choice_difficulty_score=type_difficulty_score["single_choice"],
            multiple_choice_difficulty_score=type_difficulty_score["multiple_choice"],
            judge_difficulty_score=type_difficulty_score["judge"],
            qa_difficulty_score=type_difficulty_score["qa"],
            blank_difficulty_score=type_difficulty_score["blank"],
            diff_basic_target=batch_diff_limits["basic"],
            diff_applied_target=batch_diff_limits["applied"],
            diff_extended_target=batch_diff_limits["extended"],
        )
        raw, finish_reason = await asyncio.to_thread(
            llm.generate_with_meta,
            prompt,
            max_tokens=llm_max_tokens,
            temperature=0.2,
        )
        candidates = _extract_json_payload(raw)
        if not candidates:
            raw_text = str(raw or "")
            finish = str(finish_reason or "").strip().lower()
            logger.warning(
                "question_generate_parse_failed course_id=%s chapter_id=%s batch=%s/%s finish_reason=%s max_tokens=%s raw_len=%s raw_preview=%r batch_limits=%s",
                course.id,
                chapter.id,
                batch_idx,
                len(planned_batches),
                finish_reason,
                llm_max_tokens,
                len(raw_text),
                raw_text[:240],
                batch_limits,
            )
            if finish == "length":
                raise RuntimeError("模型输出被截断（length），请降低题量或提高 max_tokens 后重试")
            raise RuntimeError("模型返回结果无法解析，请重试")
        model_output_count += len(candidates)

        accepted_candidate_indices: set[int] = set()
        skipped_candidate_indices: set[int] = set()
        for idx, item in enumerate(candidates):
            _try_add_item(
                item=item,
                enforce_diff_limit=True,
                candidate_idx=idx,
                accepted_candidate_indices=accepted_candidate_indices,
                skipped_candidate_indices=skipped_candidate_indices,
            )
            if sum(created_by_type.values()) >= total_expected:
                break
        if sum(created_by_type.values()) >= total_expected:
            break

        # 若因难度配额导致该批未充分利用，再放宽难度配额补齐。
        for idx, item in enumerate(candidates):
            if idx in accepted_candidate_indices:
                continue
            _try_add_item(
                item=item,
                enforce_diff_limit=False,
                candidate_idx=idx,
                accepted_candidate_indices=accepted_candidate_indices,
                skipped_candidate_indices=skipped_candidate_indices,
            )
            if sum(created_by_type.values()) >= total_expected:
                break
        if sum(created_by_type.values()) >= total_expected:
            break
    if not dry_run:
        await db.flush()
        # 强制覆盖：每个知识点至少保留 1 道题；缺失时自动补充知识点专项题。
        await _ensure_each_kp_has_question(
            db=db,
            chapter=chapter,
            course=course,
            kp_rows=kp_rows,
            existing_keys=existing_keys,
            created_by_type=created_by_type,
            created_by_diff=created_by_diff,
            question_bank_type=question_bank_type,
            default_difficulty_score=type_difficulty_score["qa"],
            qa_limit=body.qa_max,
        )
        await db.commit()
    return created_by_type, skipped, preview_items, model_output_count


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
            created_by_type, skipped, _, _ = await _generate_questions_for_chapter(db, chapter, course, body)
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


@router.post("/chapters/{chapter_id}/questions/generate-preview", response_model=TeacherGenerateQuestionsPreviewOut)
async def generate_teacher_chapter_questions_preview(
    chapter_id: int,
    body: TeacherGenerateQuestionsIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    chapter, course = await _require_owned_chapter(db, user.id, chapter_id)
    total_expected = body.single_choice_max + body.multiple_choice_max + body.judge_max + body.qa_max + body.blank_max
    if total_expected <= 0:
        raise HTTPException(status_code=400, detail="请至少设置一种题型数量大于 0")
    normalized_bank_type = _normalize_question_bank_type(body.question_bank_type)
    body = body.model_copy(update={"question_bank_type": normalized_bank_type})
    created_by_type, skipped, items, model_output_count = await _generate_questions_for_chapter(db, chapter, course, body, dry_run=True)
    return TeacherGenerateQuestionsPreviewOut(
        course_id=course.id,
        chapter_id=chapter.id,
        question_bank_type=normalized_bank_type,
        output_count=int(model_output_count),
        generated_count=int(sum(created_by_type.values())),
        by_type=created_by_type,
        skipped=int(skipped),
        items=items,
    )


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


@router.get("/questions/active-tasks", response_model=list[TeacherGenerateTaskSummaryOut])
async def list_generate_teacher_chapter_questions_active_tasks(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(
        select(QuestionGenerationTask)
        .where(
            QuestionGenerationTask.teacher_id == user.id,
            QuestionGenerationTask.status.in_(["pending", "running"]),
        )
        .order_by(QuestionGenerationTask.chapter_id, QuestionGenerationTask.id.desc())
    )
    rows = r.scalars().all()
    latest_by_chapter: dict[int, QuestionGenerationTask] = {}
    for task in rows:
        if task.chapter_id not in latest_by_chapter:
            latest_by_chapter[task.chapter_id] = task
    return [
        TeacherGenerateTaskSummaryOut(
            task_id=t.id,
            course_id=t.course_id,
            chapter_id=t.chapter_id,
            status=t.status,
            updated_at=t.updated_at.isoformat() if t.updated_at else None,
        )
        for t in latest_by_chapter.values()
    ]


def _build_generate_paper_prompt(
    course_name: str,
    chapter_titles: list[str],
    paper_title: str,
    overall_difficulty: float | None,
    configs: list[dict],
) -> str:
    cfg_lines: list[str] = []
    for row in configs:
        cfg_lines.append(
            f"- {row['type']}：数量 {row['count']}，难度系数 {_normalize_difficulty_score(row.get('difficulty'), 0.8)}，每题分数 {float(row.get('score') or 0)}"
        )
    overall_text = "未指定（按各题型难度）" if overall_difficulty is None else str(_normalize_difficulty_score(overall_difficulty))
    chapter_text = "、".join([x for x in chapter_titles if x]) if chapter_titles else "未指定章节"
    return f"""你是一名严谨的高校教师出卷助手。请基于联网检索公开可靠资料来生成试卷题目，题目应贴合课程与章节，避免无关内容。

课程：{course_name}
章节：{chapter_text}
试卷标题：{paper_title}
整卷难度系数：{overall_text}
题型配置：
{chr(10).join(cfg_lines)}

要求：
1) 仅输出 JSON，不要输出 Markdown。
2) 输出字段：type, question_text, options, correct_answer, explanation, difficulty_score。
3) 单选题/多选题给 4 个选项；判断题 options 固定为 ["A. 正确", "B. 错误"]。
4) difficulty_score 在 0~1 之间，保留 2 位小数。
5) 必须按题型数量输出足量题目，尽量不重复。

JSON 格式：
{{
  "questions": [
    {{
      "type": "single_choice|multiple_choice|judge|blank|qa",
      "question_text": "题干",
      "options": ["A. ...","B. ...","C. ...","D. ..."],
      "correct_answer": "A",
      "explanation": "解析",
      "difficulty_score": 0.8
    }}
  ]
}}"""


PAPER_DEDUP_RESERVE_MAX = 20
PAPER_SEMANTIC_DEDUP_CONF_THRESHOLD_DEFAULT = 0.85


def _build_paper_semantic_dedup_prompt(items: list[dict]) -> str:
    payload = []
    for idx, item in enumerate(items, start=1):
        payload.append(
            {
                "idx": idx,
                "question_type": str(item.get("question_type") or "").strip(),
                "question_text": str(item.get("question_text") or "").strip()[:240],
                "options": [str(x or "").strip()[:80] for x in (item.get("options") or [])[:4]],
                "correct_answer": str(item.get("correct_answer") or "").strip()[:64],
            }
        )
    return f"""你是试卷去重审核助手。请识别“语义重复题”。

语义重复定义（满足其一即可）：
1) 考查知识点与题目条件本质相同，仅换说法；
2) 解题思路与正确答案等价，学生作答能力要求基本一致。

不算重复：
1) 同知识点但题设条件明显不同；
2) 题型不同且作答能力要求明显不同。

请尽量保守，只有在“高度确定重复”时才判重复。
仅输出 JSON，不要解释。格式：
{{
  "duplicates": [
    {{
      "keep_idx": 1,
      "drop_idxs": [3, 5],
      "confidence": 0.93,
      "reason": "重复原因简述"
    }}
  ]
}}

待判定题目列表：
{json.dumps(payload, ensure_ascii=False)}
"""


def _paper_dedup_reserve_count(count: int) -> int:
    c = max(0, int(count))
    half = (c + 1) // 2
    return min(PAPER_DEDUP_RESERVE_MAX, max(5, half))


def _extract_paper_semantic_dedup_drop_indices(
    raw: str,
    total: int,
    conf_threshold: float = PAPER_SEMANTIC_DEDUP_CONF_THRESHOLD_DEFAULT,
) -> set[int]:
    text = (raw or "").strip()
    if not text or total <= 1:
        return set()
    candidates = [text]
    for pat in (r"\{[\s\S]*\}", r"\[[\s\S]*\]"):
        for m in re.finditer(pat, text):
            candidates.append(m.group(0))
    obj = None
    for c in candidates:
        try:
            obj = json.loads(c)
            break
        except Exception:
            continue
    if obj is None:
        return set()
    out: set[int] = set()
    rows = []
    if isinstance(obj, dict):
        if isinstance(obj.get("duplicates"), list):
            rows = obj["duplicates"]
        elif isinstance(obj.get("drop_indices"), list):
            rows = [{"keep_idx": -1, "drop_idxs": obj.get("drop_indices", []), "confidence": 1.0, "reason": "fallback"}]
    elif isinstance(obj, list):
        rows = obj
    for row in rows:
        if isinstance(row, int):
            if 1 <= row <= total:
                out.add(row - 1)
            continue
        if not isinstance(row, dict):
            continue
        try:
            conf = float(row.get("confidence", 0))
        except Exception:
            conf = 0.0
        if conf < conf_threshold:
            continue
        keep_idx = int(row.get("keep_idx", -1)) if str(row.get("keep_idx", "")).strip() else -1
        drop_idxs = row.get("drop_idxs")
        if not isinstance(drop_idxs, list):
            continue
        for x in drop_idxs:
            try:
                n = int(x)
            except Exception:
                continue
            if 1 <= n <= total and n != keep_idx:
                out.add(n - 1)
    return out


def _dedup_paper_questions_by_text(items: list[dict]) -> tuple[list[dict], int]:
    seen: set[str] = set()
    out: list[dict] = []
    removed = 0
    for item in items:
        key = _normalize_text_key(str(item.get("question_text") or ""))
        if not key:
            out.append(item)
            continue
        if key in seen:
            removed += 1
            continue
        seen.add(key)
        out.append(item)
    return out, removed


async def _dedup_paper_questions_by_semantic(
    items: list[dict],
    llm,
    max_tokens: int,
    conf_threshold: float = PAPER_SEMANTIC_DEDUP_CONF_THRESHOLD_DEFAULT,
) -> tuple[list[dict], int]:
    if len(items) <= 1:
        return items, 0
    prompt = _build_paper_semantic_dedup_prompt(items)
    try:
        raw = await asyncio.to_thread(
            llm.generate,
            prompt,
            max_tokens=max(600, int(max_tokens)),
            temperature=0.0,
        )
        drop_indices = _extract_paper_semantic_dedup_drop_indices(raw, len(items), conf_threshold=conf_threshold)
        if not drop_indices:
            return items, 0
        out = [item for i, item in enumerate(items) if i not in drop_indices]
        return out, len(items) - len(out)
    except Exception as e:
        logger.warning("paper_semantic_dedup_failed err=%s", str(e)[:300])
        return items, 0


def _sanitize_paper_question_item(item: dict) -> dict:
    return {k: v for k, v in item.items() if not str(k).startswith("_")}


def _normalize_internet_paper_candidate_item(
    item: dict,
    q_type: str,
    target_diff: float,
    score: float,
) -> dict | None:
    q_text = str(item.get("question_text") or "").strip()
    if not q_text:
        return None
    options: list[str] = []
    answer = _trim_answer(item.get("correct_answer"), max_len=32)
    if q_type == "single_choice":
        opts = _normalize_choice_options(item.get("options"))
        ans = _normalize_choice_answer(item.get("correct_answer"), opts)
        if len(opts) != 4 or not ans:
            return None
        options = [f"{chr(ord('A') + i)}. {x}" for i, x in enumerate(opts)]
        answer = ans
    elif q_type == "multiple_choice":
        opts = _normalize_choice_options(item.get("options"))
        ans = _normalize_multi_answer(item.get("correct_answer"))
        if len(opts) != 4 or len([x for x in ans.split(",") if x]) < 2:
            return None
        options = [f"{chr(ord('A') + i)}. {x}" for i, x in enumerate(opts)]
        answer = ans
    elif q_type == "judge":
        ans = _normalize_judge_answer(item.get("correct_answer"))
        if not ans:
            return None
        options = ["A. 正确", "B. 错误"]
        answer = ans
    elif not answer:
        return None
    return {
        "question_type": q_type,
        "question_text": q_text,
        "options": options,
        "correct_answer": answer,
        "explanation": str(item.get("explanation") or "").strip() or None,
        "difficulty_score": _normalize_difficulty_score(item.get("difficulty_score"), target_diff),
        "score": score,
        "source": "internet",
    }


async def _pick_local_questions_for_paper(
    db: AsyncSession,
    course_id: int,
    chapter_ids: list[int],
    configs: list[dict],
    overall_difficulty: float | None,
) -> tuple[list[dict], list[dict]]:
    from ..rag.config import get_rag_settings
    from ..rag.llm import get_llm

    settings = get_rag_settings()
    llm = get_llm(settings)
    semantic_max_tokens = max(1200, min(2600, int(settings.llm_max_tokens or 512)))
    semantic_conf_threshold = _normalize_difficulty_score(
        getattr(settings, "paper_semantic_dedup_conf_threshold", PAPER_SEMANTIC_DEDUP_CONF_THRESHOLD_DEFAULT),
        PAPER_SEMANTIC_DEDUP_CONF_THRESHOLD_DEFAULT,
    )
    desired_by_type: dict[str, int] = {}
    available_by_type: dict[str, int] = {}
    pool_by_type: dict[str, list[dict]] = {}
    for row in configs:
        q_type = row["type"]
        count = int(row["count"])
        if count <= 0:
            continue
        desired_by_type[q_type] = count
        target_diff = _normalize_difficulty_score(overall_difficulty if overall_difficulty is not None else row.get("difficulty", 0.8))
        r = await db.execute(
            select(Question)
            .where(
                Question.course_id == course_id,
                Question.chapter_id.in_(chapter_ids),
                Question.question_bank_type == "exam",
                Question.question_type == q_type,
                Question.is_active == True,
                Question.is_approved == True,
            )
            .order_by(Question.id.desc())
        )
        rows = list(r.scalars().all())
        rows.sort(key=lambda q: (abs(_normalize_difficulty_score(q.difficulty_score, 0.8) - target_diff), -int(q.id)))
        available_by_type[q_type] = len(rows)
        pool_by_type[q_type] = [
            {
                "question_type": q_type,
                "question_text": q.question_text,
                "options": _parse_question_options(q.options),
                "correct_answer": q.correct_answer,
                "explanation": q.explanation,
                "difficulty_score": _normalize_difficulty_score(q.difficulty_score, target_diff),
                "score": float(row.get("score") or 0),
                "source": "local",
                "_qid": int(q.id),
            }
            for q in rows
        ]

    reserve_by_type = {
        q_type: _paper_dedup_reserve_count(count)
        for q_type, count in desired_by_type.items()
    }
    take_by_type = {
        q_type: min(len(pool_by_type.get(q_type, [])), count + reserve_by_type.get(q_type, 5))
        for q_type, count in desired_by_type.items()
    }
    picked_by_type: dict[str, list[dict]] = {q_type: [] for q_type in desired_by_type.keys()}

    for _round in range(6):
        staged: list[dict] = []
        for row in configs:
            q_type = row["type"]
            if q_type not in desired_by_type:
                continue
            take_n = int(take_by_type.get(q_type, 0))
            staged.extend(pool_by_type.get(q_type, [])[:take_n])
        staged, _ = _dedup_paper_questions_by_text(staged)
        staged, _ = await _dedup_paper_questions_by_semantic(
            staged,
            llm=llm,
            max_tokens=semantic_max_tokens,
            conf_threshold=semantic_conf_threshold,
        )

        next_picked_by_type: dict[str, list[dict]] = {q_type: [] for q_type in desired_by_type.keys()}
        for item in staged:
            q_type = str(item.get("question_type") or "")
            if q_type not in desired_by_type:
                continue
            if len(next_picked_by_type[q_type]) >= desired_by_type[q_type]:
                continue
            next_picked_by_type[q_type].append(item)
        picked_by_type = next_picked_by_type

        missing_items = [
            (q_type, desired_by_type[q_type] - len(picked_by_type.get(q_type, [])))
            for q_type in desired_by_type.keys()
            if desired_by_type[q_type] - len(picked_by_type.get(q_type, [])) > 0
        ]
        if not missing_items:
            break
        expanded = False
        for q_type, missing in missing_items:
            current_take = int(take_by_type.get(q_type, 0))
            pool_size = len(pool_by_type.get(q_type, []))
            if current_take >= pool_size:
                continue
            inc = max(1, int(reserve_by_type.get(q_type, 5)))
            take_by_type[q_type] = min(pool_size, current_take + inc)
            expanded = True
        if not expanded:
            break

    preview_questions: list[dict] = []
    insufficient_types: list[dict] = []
    for row in configs:
        q_type = row["type"]
        count = desired_by_type.get(q_type, 0)
        if count <= 0:
            continue
        picked = picked_by_type.get(q_type, [])[:count]
        if len(picked) < count:
            insufficient_types.append(
                {
                    "question_type": q_type,
                    "requested": count,
                    "available": available_by_type.get(q_type, 0),
                    "missing": count - len(picked),
                }
            )
        preview_questions.extend([_sanitize_paper_question_item(x) for x in picked])
    return preview_questions, insufficient_types


async def _generate_internet_questions_for_paper(
    course_name: str,
    chapter_titles: list[str],
    paper_title: str,
    overall_difficulty: float | None,
    configs: list[dict],
) -> tuple[list[dict], list[dict]]:
    from ..rag.config import get_rag_settings
    from ..rag.llm import get_llm

    settings = get_rag_settings()
    llm = get_llm(settings)
    semantic_max_tokens = max(1200, min(2600, int(settings.llm_max_tokens or 512)))
    gen_max_tokens = max(4096, int(settings.llm_max_tokens or 512))
    semantic_conf_threshold = _normalize_difficulty_score(
        getattr(settings, "paper_semantic_dedup_conf_threshold", PAPER_SEMANTIC_DEDUP_CONF_THRESHOLD_DEFAULT),
        PAPER_SEMANTIC_DEDUP_CONF_THRESHOLD_DEFAULT,
    )
    # 估算生成输出 token，用于判定是否需要按题型分批调用模型。
    generation_token_est = {
        "single_choice": 190,
        "multiple_choice": 300,
        "judge": 105,
        "blank": 100,
        "qa": 140,
    }
    reserve_by_type = {
        str(row.get("type") or ""): _paper_dedup_reserve_count(int(row.get("count") or 0))
        for row in configs
    }
    prompt_limits_for_plan = {
        str(row.get("type") or ""): int(row.get("count") or 0) + reserve_by_type.get(str(row.get("type") or ""), 5) if int(row.get("count") or 0) > 0 else 0
        for row in configs
    }
    estimated_output_tokens = 0
    for q_type, count in prompt_limits_for_plan.items():
        if int(count) <= 0:
            continue
        estimated_output_tokens += int(count) * int(generation_token_est.get(q_type, 120))
    batch_output_budget = max(800, int(gen_max_tokens * 0.65))

    planned_batches: list[dict[str, int]] = []
    if estimated_output_tokens > batch_output_budget:
        planned_batches = _plan_question_generation_batches(prompt_limits_for_plan, batch_output_budget)
    if not planned_batches:
        planned_batches = [{k: int(v) for k, v in prompt_limits_for_plan.items() if int(v) > 0}]

    logger.info(
        "internet_paper_batch_plan course_name=%r paper_title=%r gen_max_tokens=%s estimated_tokens=%s batch_budget=%s batch_count=%s batches=%s",
        (course_name or "")[:80],
        (paper_title or "")[:80],
        gen_max_tokens,
        estimated_output_tokens,
        batch_output_budget,
        len(planned_batches),
        planned_batches,
    )

    def _shrink_batch_limits(limits: dict[str, int]) -> dict[str, int]:
        ordered_types = ["single_choice", "multiple_choice", "judge", "blank", "qa"]
        out: dict[str, int] = {}
        changed = False
        for q_type in ordered_types:
            n = int(limits.get(q_type, 0))
            if n <= 0:
                continue
            if n > 1:
                shrunk = max(1, (n + 1) // 2)
                if shrunk < n:
                    changed = True
                out[q_type] = shrunk
            else:
                out[q_type] = 1
        if changed:
            return out
        return {k: int(v) for k, v in limits.items() if int(v) > 0}

    max_batch_attempts = 4
    grouped: dict[str, list[dict]] = {"single_choice": [], "multiple_choice": [], "judge": [], "blank": [], "qa": []}
    for batch_idx, initial_batch_limits in enumerate(planned_batches, start=1):
        current_limits = {k: int(v) for k, v in initial_batch_limits.items() if int(v) > 0}
        if sum(current_limits.values()) <= 0:
            continue

        batch_ok = False
        last_reason = ""
        for attempt in range(1, max_batch_attempts + 1):
            batch_prompt_configs: list[dict] = []
            for row in configs:
                q_type = str(row.get("type") or "")
                batch_count = int(current_limits.get(q_type, 0))
                if batch_count <= 0:
                    continue
                batch_prompt_configs.append({**row, "count": batch_count})
            if not batch_prompt_configs:
                break

            prompt = _build_generate_paper_prompt(
                course_name=course_name,
                chapter_titles=chapter_titles,
                paper_title=paper_title,
                overall_difficulty=overall_difficulty,
                configs=batch_prompt_configs,
            )
            try:
                raw = await asyncio.to_thread(
                    llm.generate,
                    prompt,
                    max_tokens=gen_max_tokens,
                    temperature=0.2,
                )
            except Exception as e:
                last_reason = f"llm_call:{str(e)[:180]}"
                logger.warning(
                    "internet_paper_batch_retry course_name=%r paper_title=%r batch=%s/%s attempt=%s/%s reason=%r limits=%s",
                    (course_name or "")[:80],
                    (paper_title or "")[:80],
                    batch_idx,
                    len(planned_batches),
                    attempt,
                    max_batch_attempts,
                    last_reason,
                    current_limits,
                )
                if attempt < max_batch_attempts:
                    next_limits = _shrink_batch_limits(current_limits)
                    if next_limits == current_limits:
                        break
                    current_limits = next_limits
                    continue
                break

            candidates = _extract_json_payload(raw)
            if candidates:
                raw_len = len(str(raw or ""))
                logger.info(
                    "internet_paper_batch_generated course_name=%r paper_title=%r batch=%s/%s attempt=%s/%s requested=%s parsed_candidates=%s raw_len=%s",
                    (course_name or "")[:80],
                    (paper_title or "")[:80],
                    batch_idx,
                    len(planned_batches),
                    attempt,
                    max_batch_attempts,
                    current_limits,
                    len(candidates),
                    raw_len,
                )
                for item in candidates:
                    q_type = _to_question_type(str(item.get("type") or ""))
                    if not q_type:
                        continue
                    grouped[q_type].append(item)
                batch_ok = True
                break

            raw_len, raw_head, raw_tail = _summarize_llm_raw_for_log(raw)
            last_reason = "parse_failed"
            logger.warning(
                "internet_paper_generate_parse_failed course_name=%r paper_title=%r batch=%s/%s attempt=%s/%s prompt_len=%s raw_len=%s raw_head=%r raw_tail=%r batch_limits=%s",
                (course_name or "")[:80],
                (paper_title or "")[:80],
                batch_idx,
                len(planned_batches),
                attempt,
                max_batch_attempts,
                len(prompt or ""),
                raw_len,
                raw_head,
                raw_tail,
                current_limits,
            )
            if attempt < max_batch_attempts:
                next_limits = _shrink_batch_limits(current_limits)
                if next_limits == current_limits:
                    break
                current_limits = next_limits
                continue
            break

        if not batch_ok:
            logger.error(
                "internet_paper_batch_retry_exhausted course_name=%r paper_title=%r batch=%s/%s initial_limits=%s final_limits=%s last_reason=%r",
                (course_name or "")[:80],
                (paper_title or "")[:80],
                batch_idx,
                len(planned_batches),
                initial_batch_limits,
                current_limits,
                last_reason,
            )

    preview_questions: list[dict] = []
    insufficient_types: list[dict] = []
    for row in configs:
        q_type = row["type"]
        count = int(row["count"])
        if count <= 0:
            continue
        target_diff = _normalize_difficulty_score(overall_difficulty if overall_difficulty is not None else row.get("difficulty", 0.8))
        score = float(row.get("score") or 0)
        raw_pool = grouped.get(q_type, [])
        normalized_pool: list[dict] = []
        for item in raw_pool:
            normalized = _normalize_internet_paper_candidate_item(item, q_type=q_type, target_diff=target_diff, score=score)
            if normalized:
                normalized_pool.append(normalized)
        reserve = int(reserve_by_type.get(q_type, 5))
        take_n = min(len(normalized_pool), count + reserve)
        picked: list[dict] = []
        for _round in range(6):
            candidates_slice = normalized_pool[:take_n]
            candidates_slice, _ = _dedup_paper_questions_by_text(candidates_slice)
            candidates_slice, _ = await _dedup_paper_questions_by_semantic(
                candidates_slice,
                llm=llm,
                max_tokens=semantic_max_tokens,
                conf_threshold=semantic_conf_threshold,
            )
            picked = candidates_slice[:count]
            if len(picked) >= count or take_n >= len(normalized_pool):
                break
            take_n = min(
                len(normalized_pool),
                take_n + max(1, reserve),
            )
        if len(picked) < count:
            insufficient_types.append(
                {
                    "question_type": q_type,
                    "requested": count,
                    "available": len(normalized_pool),
                    "missing": count - len(picked),
                }
            )
        preview_questions.extend([_sanitize_paper_question_item(x) for x in picked])
    return preview_questions, insufficient_types


@router.post("/papers/generate", response_model=TeacherGeneratePaperOut)
async def generate_teacher_paper(
    body: TeacherGeneratePaperIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r_course = await db.execute(select(Course).where(Course.id == body.course_id, Course.owner_teacher_id == user.id))
    course = r_course.scalar_one_or_none()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在或无权限")

    chapter_ids = [int(x) for x in body.chapter_ids if int(x) > 0]
    chapter_ids = list(dict.fromkeys(chapter_ids))
    if not chapter_ids:
        raise HTTPException(status_code=400, detail="请至少选择一个章节")

    r_chapters = await db.execute(
        select(Chapter.id, Chapter.title).where(
            Chapter.course_id == course.id,
            Chapter.id.in_(chapter_ids),
        )
    )
    chapter_rows = r_chapters.all()
    chapter_map = {int(r[0]): str(r[1]) for r in chapter_rows}
    if len(chapter_map) != len(chapter_ids):
        raise HTTPException(status_code=400, detail="章节数据无效或无权限")
    chapter_titles = [chapter_map[cid] for cid in chapter_ids if cid in chapter_map]

    normalized_configs: list[dict] = []
    for row in body.configs:
        q_type = _to_question_type(row.type)
        if not q_type:
            continue
        normalized_configs.append(
            {
                "type": q_type,
                "count": int(row.count),
                "difficulty": _normalize_difficulty_score(row.difficulty if row.difficulty is not None else 0.8),
                "score": float(row.score),
            }
        )
    if not normalized_configs:
        raise HTTPException(status_code=400, detail="题型配置不能为空")
    if sum(int(x["count"]) for x in normalized_configs) <= 0:
        raise HTTPException(status_code=400, detail="请至少设置一种题型数量大于 0")

    paper_bank_type = _normalize_paper_bank_type(body.paper_bank_type)
    question_source = _normalize_question_source(body.question_source)
    target_overall_difficulty = _normalize_difficulty_score(body.overall_difficulty, 0.8) if body.overall_difficulty is not None else None

    has_preview_override = body.preview_questions_override is not None
    if has_preview_override:
        preview_questions: list[dict] = []
        for item in body.preview_questions_override or []:
            q_type = _to_question_type(item.question_type) or "qa"
            q_text = item.question_text.strip()
            if not q_text:
                continue
            opts = [str(x).strip() for x in (item.options or []) if str(x).strip()]
            preview_questions.append(
                _sanitize_paper_question_item(
                    {
                        "question_type": q_type,
                        "question_text": q_text,
                        "options": opts,
                        "correct_answer": (item.correct_answer or "").strip(),
                        "explanation": (item.explanation or "").strip() or None,
                        "difficulty_score": _normalize_difficulty_score(item.difficulty_score, 0.8),
                        "score": max(0.0, float(item.score or 0.0)),
                        "source": _normalize_question_source(item.source),
                    }
                )
            )
        if not preview_questions:
            raise HTTPException(status_code=400, detail="提交试卷库前请至少保留一道题目")
        insufficient_types: list[dict] = []
    elif question_source == "local":
        preview_questions, insufficient_types = await _pick_local_questions_for_paper(
            db=db,
            course_id=course.id,
            chapter_ids=chapter_ids,
            configs=normalized_configs,
            overall_difficulty=target_overall_difficulty,
        )
    else:
        preview_questions, insufficient_types = await _generate_internet_questions_for_paper(
            course_name=course.name,
            chapter_titles=chapter_titles,
            paper_title=body.paper_title.strip(),
            overall_difficulty=target_overall_difficulty,
            configs=normalized_configs,
        )

    is_partial = len(insufficient_types) > 0
    total_score = round(sum(float(x.get("score") or 0) for x in preview_questions), 2)
    weighted_difficulty_sum = sum(float(x.get("score") or 0) * _normalize_difficulty_score(x.get("difficulty_score"), 0.8) for x in preview_questions)
    computed_overall_difficulty = round((weighted_difficulty_sum / total_score), 2) if total_score > 0 else 0.0
    if has_preview_override and body.save_to_bank:
        message = "试卷已提交到试卷库"
    elif is_partial and question_source == "local":
        message = "题库里的习题数量不够生成试卷，请先生成习题"
    elif is_partial:
        message = "试卷未完全生成，已返回可预览内容"
    else:
        message = "试卷生成成功"

    paper_id: int | None = None
    if body.save_to_bank and ((not is_partial) or has_preview_override):
        paper = Paper(
            course_id=course.id,
            title=body.paper_title.strip(),
            paper_type="electronic",
            paper_bank_type=paper_bank_type,
            question_source=question_source,
            status="pending",
            is_partial=bool(is_partial),
            total_score=total_score,
            request_payload=json.dumps(
                {
                    "course_id": course.id,
                    "chapter_ids": chapter_ids,
                    "paper_title": body.paper_title.strip(),
                    "paper_bank_type": paper_bank_type,
                    "question_source": question_source,
                    "overall_difficulty": target_overall_difficulty,
                    "configs": normalized_configs,
                },
                ensure_ascii=False,
            ),
            overall_difficulty=computed_overall_difficulty,
            content_payload=json.dumps(
                {
                    "preview_questions": preview_questions,
                    "insufficient_types": insufficient_types,
                },
                ensure_ascii=False,
            ),
            error_message=None,
            created_by=user.id,
        )
        db.add(paper)
        await db.flush()
        paper_id = int(paper.id)

    return TeacherGeneratePaperOut(
        paper_id=paper_id,
        status=("partial" if is_partial else "generated"),
        is_partial=is_partial,
        message=message,
        insufficient_types=[TeacherPaperInsufficientOut(**x) for x in insufficient_types],
        preview_questions=[TeacherPaperPreviewQuestionOut(**x) for x in preview_questions],
        total_score=total_score,
        overall_difficulty=computed_overall_difficulty,
    )


@router.get("/papers", response_model=list[TeacherPaperListItemOut])
async def list_teacher_papers(
    course_id: int | None = Query(default=None),
    chapter_ids: list[int] = Query(default=[]),
    title_kw: str | None = Query(default=None),
    difficulty_min: float | None = Query(default=None, ge=0, le=1),
    difficulty_max: float | None = Query(default=None, ge=0, le=1),
    review_status: str | None = Query(default=None),
    paper_bank_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    items = await _list_teacher_papers_filtered(
        db=db,
        teacher_id=user.id,
        course_id=course_id,
        chapter_ids=chapter_ids,
        title_kw=title_kw,
        difficulty_min=difficulty_min,
        difficulty_max=difficulty_max,
        review_status=review_status,
        paper_bank_type=paper_bank_type,
        status=status,
    )
    return items


async def _list_teacher_papers_filtered(
    db: AsyncSession,
    teacher_id: int,
    course_id: int | None = None,
    chapter_ids: list[int] | None = None,
    title_kw: str | None = None,
    difficulty_min: float | None = None,
    difficulty_max: float | None = None,
    review_status: str | None = None,
    paper_bank_type: str | None = None,
    status: str | None = None,
) -> list[TeacherPaperListItemOut]:
    stmt = (
        select(Paper, Course)
        .join(Course, Course.id == Paper.course_id)
        .where(Course.owner_teacher_id == teacher_id)
        .order_by(Paper.id.desc())
    )
    if course_id is not None and course_id > 0:
        stmt = stmt.where(Paper.course_id == course_id)
    if (paper_bank_type or "").strip():
        stmt = stmt.where(Paper.paper_bank_type == _normalize_paper_bank_type(paper_bank_type))
    if (status or "").strip():
        stmt = stmt.where(Paper.status == _normalize_paper_status(status))
    if (title_kw or "").strip():
        kw = f"%{(title_kw or '').strip()}%"
        stmt = stmt.where(Paper.title.like(kw))
    r = await db.execute(stmt)
    rows = r.all()
    chapter_filter = {int(x) for x in (chapter_ids or []) if int(x) > 0}
    review_filter = (review_status or "").strip().lower()
    if review_filter not in {"", "pending", "reviewed"}:
        review_filter = ""
    out: list[TeacherPaperListItemOut] = []
    for p, c in rows:
        req_payload: dict = {}
        try:
            req_payload = json.loads(p.request_payload or "{}")
            if not isinstance(req_payload, dict):
                req_payload = {}
        except Exception:
            req_payload = {}
        paper_chapter_ids = [int(x) for x in (req_payload.get("chapter_ids") or []) if str(x).isdigit() and int(x) > 0]
        overall_difficulty = float(p.overall_difficulty or 0)
        if chapter_filter and not chapter_filter.intersection(set(paper_chapter_ids)):
            continue
        if difficulty_min is not None and overall_difficulty < float(difficulty_min):
            continue
        if difficulty_max is not None and overall_difficulty > float(difficulty_max):
            continue
        computed_review_status = _normalize_paper_status(p.status)
        if review_filter and computed_review_status != review_filter:
            continue
        paper_type_val = getattr(p, "paper_type", None) or "electronic"
        if paper_type_val not in ("electronic", "file"):
            paper_type_val = "electronic"
        out.append(
            TeacherPaperListItemOut(
                id=int(p.id),
                course_id=int(c.id),
                course_name=str(c.name),
                title=p.title,
                paper_type=paper_type_val,
                paper_bank_type=_normalize_paper_bank_type(p.paper_bank_type),
                question_source=_normalize_question_source(p.question_source),
                status=_normalize_paper_status(p.status),
                review_status=computed_review_status,
                is_partial=bool(p.is_partial),
                total_score=float(p.total_score or 0),
                overall_difficulty=round(overall_difficulty, 2),
                chapter_ids=paper_chapter_ids,
                created_at=p.created_at.isoformat() if p.created_at else None,
                updated_at=p.updated_at.isoformat() if p.updated_at else None,
            )
        )
    return out


@router.get("/papers/paged", response_model=TeacherPaperPageOut)
async def list_teacher_papers_paged(
    course_id: int | None = Query(default=None),
    chapter_ids: list[int] = Query(default=[]),
    title_kw: str | None = Query(default=None),
    difficulty_min: float | None = Query(default=None, ge=0, le=1),
    difficulty_max: float | None = Query(default=None, ge=0, le=1),
    review_status: str | None = Query(default=None),
    paper_bank_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    items = await _list_teacher_papers_filtered(
        db=db,
        teacher_id=user.id,
        course_id=course_id,
        chapter_ids=chapter_ids,
        title_kw=title_kw,
        difficulty_min=difficulty_min,
        difficulty_max=difficulty_max,
        review_status=review_status,
        paper_bank_type=paper_bank_type,
        status=status,
    )
    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    return TeacherPaperPageOut(items=items[start:end], total=total, page=page, page_size=page_size)


@router.post("/papers/batch-delete", response_model=TeacherPaperBatchDeleteOut)
async def batch_delete_teacher_papers(
    body: TeacherPaperBatchDeleteIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    ids = list({int(x) for x in body.paper_ids if int(x) > 0})
    if not ids:
        raise HTTPException(status_code=400, detail="paper_ids 不能为空")
    r = await db.execute(
        select(Paper)
        .join(Course, Course.id == Paper.course_id)
        .where(Paper.id.in_(ids), Course.owner_teacher_id == user.id)
    )
    rows = r.scalars().all()
    deleted = 0
    for p in rows:
        await db.execute(delete(PaperFile).where(PaperFile.paper_id == p.id))
        await db.delete(p)
        deleted += 1
    await db.flush()
    return TeacherPaperBatchDeleteOut(deleted=deleted)


async def _require_owned_file_paper(db: AsyncSession, teacher_id: int, paper_id: int) -> tuple[Paper, Course]:
    r = await db.execute(
        select(Paper, Course)
        .join(Course, Course.id == Paper.course_id)
        .where(Paper.id == paper_id, Course.owner_teacher_id == teacher_id)
    )
    row = r.first()
    if not row:
        raise HTTPException(status_code=404, detail="试卷不存在或无权限")
    p, c = row[0], row[1]
    paper_type_val = getattr(p, "paper_type", None) or "electronic"
    if paper_type_val != "file":
        raise HTTPException(status_code=400, detail="该试卷不是文件试卷，无法管理附件")
    return p, c


@router.get("/papers/{paper_id}/files", response_model=list[TeacherPaperFileOut])
async def list_teacher_paper_files(
    paper_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_file_paper(db, user.id, paper_id)
    r = await db.execute(select(PaperFile).where(PaperFile.paper_id == paper_id).order_by(PaperFile.id))
    files = r.scalars().all()
    return [
        TeacherPaperFileOut(
            id=int(f.id),
            paper_id=int(f.paper_id),
            file_name=f.file_name,
            created_at=f.created_at.isoformat() if f.created_at else None,
        )
        for f in files
    ]


@router.post("/papers/{paper_id}/files", response_model=TeacherPaperFileOut)
async def upload_teacher_paper_file(
    paper_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_file_paper(db, user.id, paper_id)
    if not file.filename or not file.filename.strip():
        raise HTTPException(status_code=400, detail="请选择文件")
    allowed = (".pdf", ".doc", ".docx")
    ext = (os.path.splitext(file.filename or "")[1] or "").lower()
    if ext not in allowed:
        raise HTTPException(status_code=400, detail="仅支持 .pdf、.doc、.docx 格式")
    binary = await file.read()
    if not binary:
        raise HTTPException(status_code=400, detail="文件内容为空")
    root = Path(settings.upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    subdir = root / "paper_files"
    subdir.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_upload_filename(file.filename)
    saved_name = f"p{paper_id}_{int(time.time())}_{safe_name}"
    abs_path = subdir / saved_name
    abs_path.write_bytes(binary)
    rel_path = f"paper_files/{saved_name}"
    pf = PaperFile(paper_id=paper_id, file_name=file.filename.strip(), file_path=rel_path)
    db.add(pf)
    await db.flush()
    await db.refresh(pf)
    return TeacherPaperFileOut(
        id=int(pf.id),
        paper_id=int(pf.paper_id),
        file_name=pf.file_name,
        created_at=pf.created_at.isoformat() if pf.created_at else None,
    )


@router.get("/papers/{paper_id}/files/{file_id}/download")
async def download_teacher_paper_file(
    paper_id: int,
    file_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_file_paper(db, user.id, paper_id)
    r = await db.execute(select(PaperFile).where(PaperFile.id == file_id, PaperFile.paper_id == paper_id))
    pf = r.scalars().one_or_none()
    if not pf:
        raise HTTPException(status_code=404, detail="文件不存在")
    abs_path = Path(settings.upload_dir) / pf.file_path
    if not abs_path.is_file():
        raise HTTPException(status_code=404, detail="文件已丢失")
    return FileResponse(path=abs_path, filename=pf.file_name, media_type="application/octet-stream")


@router.delete("/papers/{paper_id}/files/{file_id}")
async def delete_teacher_paper_file(
    paper_id: int,
    file_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_file_paper(db, user.id, paper_id)
    r = await db.execute(select(PaperFile).where(PaperFile.id == file_id, PaperFile.paper_id == paper_id))
    pf = r.scalars().one_or_none()
    if not pf:
        raise HTTPException(status_code=404, detail="文件不存在")
    abs_path = Path(settings.upload_dir) / pf.file_path
    if abs_path.is_file():
        try:
            abs_path.unlink()
        except Exception:
            pass
    await db.delete(pf)
    await db.flush()
    return {"ok": True}


class TeacherPaperImportOut(BaseModel):
    paper_id: int
    file_count: int


@router.post("/papers/import", response_model=TeacherPaperImportOut)
async def import_teacher_paper_files(
    course_id: int = Form(...),
    title: str = Form(..., min_length=1, max_length=128),
    paper_bank_type: str = Form(default="training"),
    chapter_ids: str = Form(default="[]"),
    files: list[UploadFile] = File(default=[]),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """导入文件试卷：创建一张 paper_type=file 的试卷并上传多个文件。"""
    course = (
        await db.execute(select(Course).where(Course.id == course_id, Course.owner_teacher_id == user.id))
    ).scalars().one_or_none()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在或无权限")
    paper_bank_type = _normalize_paper_bank_type(paper_bank_type)
    try:
        chapter_ids_list = json.loads(chapter_ids)
        if not isinstance(chapter_ids_list, list):
            chapter_ids_list = []
        chapter_ids_list = [int(x) for x in chapter_ids_list if isinstance(x, (int, float)) and int(x) > 0]
    except Exception:
        chapter_ids_list = []
    allowed = (".pdf", ".doc", ".docx")
    paper = Paper(
        course_id=course.id,
        title=title.strip()[:128],
        paper_type="file",
        paper_bank_type=paper_bank_type,
        question_source="local",
        status="pending",
        is_partial=False,
        total_score=0,
        overall_difficulty=0,
        request_payload=json.dumps({"chapter_ids": chapter_ids_list}, ensure_ascii=False),
        content_payload=None,
        created_by=user.id,
    )
    db.add(paper)
    await db.flush()
    paper_id = int(paper.id)
    root = Path(settings.upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    subdir = root / "paper_files"
    subdir.mkdir(parents=True, exist_ok=True)
    count = 0
    for f in files or []:
        if not f.filename or not (f.filename or "").strip():
            continue
        ext = (os.path.splitext(f.filename or "")[1] or "").lower()
        if ext not in allowed:
            continue
        binary = await f.read()
        if not binary:
            continue
        safe_name = _safe_upload_filename(f.filename)
        saved_name = f"p{paper_id}_{int(time.time())}_{count}_{safe_name}"
        abs_path = subdir / saved_name
        abs_path.write_bytes(binary)
        rel_path = f"paper_files/{saved_name}"
        pf = PaperFile(paper_id=paper_id, file_name=(f.filename or "").strip(), file_path=rel_path)
        db.add(pf)
        count += 1
    await db.flush()
    return TeacherPaperImportOut(paper_id=paper_id, file_count=count)


@router.get("/papers/export/csv")
async def export_teacher_papers_csv(
    course_id: int | None = Query(default=None),
    chapter_ids: list[int] = Query(default=[]),
    title_kw: str | None = Query(default=None),
    difficulty_min: float | None = Query(default=None, ge=0, le=1),
    difficulty_max: float | None = Query(default=None, ge=0, le=1),
    review_status: str | None = Query(default=None),
    paper_bank_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    rows = await _list_teacher_papers_filtered(
        db=db,
        teacher_id=user.id,
        course_id=course_id,
        chapter_ids=chapter_ids,
        title_kw=title_kw,
        difficulty_min=difficulty_min,
        difficulty_max=difficulty_max,
        review_status=review_status,
        paper_bank_type=paper_bank_type,
        status=status,
    )
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["ID", "试卷标题", "课程", "试卷库类型", "来源", "状态", "整卷难度", "总分", "更新时间"])
    for x in rows:
        writer.writerow([
            x.id,
            x.title,
            x.course_name,
            "训练库" if x.paper_bank_type == "training" else "正式题库",
            "本地题库" if x.question_source == "local" else "互联网",
            "待审核" if x.review_status == "pending" else "已审核",
            f"{x.overall_difficulty:.2f}",
            x.total_score,
            x.updated_at or "",
        ])
    content = output.getvalue()
    output.close()
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    headers = {"Content-Disposition": f'attachment; filename="papers_{timestamp}.csv"'}
    return StreamingResponse(iter([content]), media_type="text/csv; charset=utf-8", headers=headers)


@router.get("/papers/{paper_id}", response_model=TeacherPaperDetailOut)
async def get_teacher_paper_detail(
    paper_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(
        select(Paper, Course)
        .join(Course, Course.id == Paper.course_id)
        .where(Paper.id == paper_id, Course.owner_teacher_id == user.id)
    )
    row = r.first()
    if not row:
        raise HTTPException(status_code=404, detail="试卷不存在或无权限")
    p, c = row[0], row[1]
    req_payload: dict = {}
    content_payload: dict | None = None
    try:
        req_payload = json.loads(p.request_payload or "{}")
        if not isinstance(req_payload, dict):
            req_payload = {}
    except Exception:
        req_payload = {}
    try:
        content_payload = json.loads(p.content_payload) if p.content_payload else None
        if content_payload is not None and not isinstance(content_payload, dict):
            content_payload = None
    except Exception:
        content_payload = None
    paper_type_val = getattr(p, "paper_type", None) or "electronic"
    if paper_type_val not in ("electronic", "file"):
        paper_type_val = "electronic"
    return TeacherPaperDetailOut(
        id=int(p.id),
        course_id=int(c.id),
        course_name=str(c.name),
        title=p.title,
        paper_type=paper_type_val,
        paper_bank_type=_normalize_paper_bank_type(p.paper_bank_type),
        question_source=_normalize_question_source(p.question_source),
        status=_normalize_paper_status(p.status),
        review_status=_normalize_paper_status(p.status),
        is_partial=bool(p.is_partial),
        total_score=float(p.total_score or 0),
        overall_difficulty=round(float(p.overall_difficulty or 0), 2),
        chapter_ids=[int(x) for x in (req_payload.get("chapter_ids") or []) if str(x).isdigit() and int(x) > 0],
        request_payload=req_payload,
        content_payload=content_payload,
        error_message=p.error_message,
        created_at=p.created_at.isoformat() if p.created_at else None,
        updated_at=p.updated_at.isoformat() if p.updated_at else None,
    )


@router.put("/papers/{paper_id}", response_model=TeacherPaperDetailOut)
async def update_teacher_paper(
    paper_id: int,
    body: TeacherPaperUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(
        select(Paper, Course)
        .join(Course, Course.id == Paper.course_id)
        .where(Paper.id == paper_id, Course.owner_teacher_id == user.id)
    )
    row = r.first()
    if not row:
        raise HTTPException(status_code=404, detail="试卷不存在或无权限")
    p, c = row[0], row[1]
    if body.title is not None:
        t = body.title.strip()
        if not t:
            raise HTTPException(status_code=400, detail="试卷标题不能为空")
        p.title = t[:128]
    if body.status is not None:
        p.status = _normalize_paper_status(body.status)
        p.is_partial = False
    if body.paper_bank_type is not None:
        p.paper_bank_type = _normalize_paper_bank_type(body.paper_bank_type)
    if body.question_source is not None:
        p.question_source = _normalize_question_source(body.question_source)
    if body.total_score is not None:
        p.total_score = float(body.total_score)
    if body.overall_difficulty is not None:
        p.overall_difficulty = _normalize_difficulty_score(body.overall_difficulty, 0.0)
    if body.request_payload is not None:
        p.request_payload = json.dumps(body.request_payload, ensure_ascii=False)
    if body.content_payload is not None:
        p.content_payload = json.dumps(body.content_payload, ensure_ascii=False)
        preview_questions = (body.content_payload or {}).get("preview_questions") or []
        if isinstance(preview_questions, list):
            total_score = round(sum(float((q.get("score") or 0)) for q in preview_questions if isinstance(q, dict)), 2)
            p.total_score = total_score
            if total_score > 0:
                weighted = sum(
                    float((q.get("score") or 0)) * _normalize_difficulty_score(q.get("difficulty_score"), 0.8)
                    for q in preview_questions
                    if isinstance(q, dict)
                )
                p.overall_difficulty = _normalize_difficulty_score(round(weighted / total_score, 2), 0.0)
    if body.error_message is not None:
        p.error_message = (body.error_message or "").strip() or None
    await db.flush()
    req_payload: dict = {}
    content_payload: dict | None = None
    try:
        req_payload = json.loads(p.request_payload or "{}")
        if not isinstance(req_payload, dict):
            req_payload = {}
    except Exception:
        req_payload = {}
    try:
        content_payload = json.loads(p.content_payload) if p.content_payload else None
        if content_payload is not None and not isinstance(content_payload, dict):
            content_payload = None
    except Exception:
        content_payload = None
    paper_type_val = getattr(p, "paper_type", None) or "electronic"
    if paper_type_val not in ("electronic", "file"):
        paper_type_val = "electronic"
    return TeacherPaperDetailOut(
        id=int(p.id),
        course_id=int(c.id),
        course_name=str(c.name),
        title=p.title,
        paper_type=paper_type_val,
        paper_bank_type=_normalize_paper_bank_type(p.paper_bank_type),
        question_source=_normalize_question_source(p.question_source),
        status=_normalize_paper_status(p.status),
        review_status=_normalize_paper_status(p.status),
        is_partial=bool(p.is_partial),
        total_score=float(p.total_score or 0),
        overall_difficulty=round(float(p.overall_difficulty or 0), 2),
        chapter_ids=[int(x) for x in (req_payload.get("chapter_ids") or []) if str(x).isdigit() and int(x) > 0],
        request_payload=req_payload,
        content_payload=content_payload,
        error_message=p.error_message,
        created_at=p.created_at.isoformat() if p.created_at else None,
        updated_at=p.updated_at.isoformat() if p.updated_at else None,
    )


def _is_document_task_cancelled(task_id: int) -> bool:
    return task_id in _document_task_cancelled


async def _run_document_process_task(task_id: int):
    """文档处理任务：先用短事务标记「处理中」并读取文件，再在无 DB 占用下做解析，最后用新 session 写回并建索引，避免长时间占用 SQLite 导致其他请求 database is locked。"""
    doc_id: int | None = None
    course_id: int | None = None
    file_binary: bytes | None = None
    file_name = ""

    async with AsyncSessionLocal() as db:
        r = await db.execute(select(DocumentProcessTask).where(DocumentProcessTask.id == task_id))
        task = r.scalar_one_or_none()
        if not task:
            logger.warning("doc_task_missing task_id=%s", task_id)
            return
        if _is_document_task_cancelled(task_id):
            logger.info("doc_task_skipped_cancelled task_id=%s", task_id)
            return
        logger.info(
            "doc_task_start task_id=%s doc_id=%s chapter_id=%s course_id=%s teacher_id=%s",
            task.id, task.doc_id, task.chapter_id, task.course_id, task.teacher_id,
        )
        task.status = "running"
        task.error_message = None
        await db.commit()
        _document_task_running.add(task_id)

        if task.chapter_id is not None:
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
                task.status = "failed"
                task.error_message = "文档不存在或无权限"
                await db.commit()
                _document_task_running.discard(task_id)
                return
            doc, chapter, course = row[0], row[1], row[2]
        else:
            r_doc = await db.execute(
                select(KnowledgeDocument, Course)
                .join(Course, Course.id == KnowledgeDocument.course_id)
                .where(
                    KnowledgeDocument.id == task.doc_id,
                    Course.id == task.course_id,
                    Course.owner_teacher_id == task.teacher_id,
                )
            )
            row = r_doc.first()
            if not row:
                task.status = "failed"
                task.error_message = "文档不存在或无权限"
                await db.commit()
                _document_task_running.discard(task_id)
                return
            doc, course = row[0], row[1]
            chapter = None
        logger.info("doc_task_loaded task_id=%s doc_id=%s file=%s", task.id, doc.id, doc.file_name)
        if doc.source_type != "pdf_upload":
            task.status = "failed"
            task.error_message = "仅 PDF 讲义支持重新识别与切片"
            await db.commit()
            _document_task_running.discard(task_id)
            return
        if not doc.file_path:
            task.status = "failed"
            task.error_message = "文档原文件不存在，无法重新识别"
            await db.commit()
            _document_task_running.discard(task_id)
            return
        abs_path = Path(settings.upload_dir) / doc.file_path
        if not abs_path.exists():
            task.status = "failed"
            task.error_message = "文档文件不存在，无法重新识别"
            await db.commit()
            _document_task_running.discard(task_id)
            return
        binary = abs_path.read_bytes()
        if not binary:
            task.status = "failed"
            task.error_message = "文档文件为空，无法重新识别"
            await db.commit()
            _document_task_running.discard(task_id)
            return
        doc.parse_status = "processing"
        doc.parse_error = None
        doc.chunk_count = None
        await db.commit()
        doc_id = doc.id
        course_id = course.id
        file_binary = binary
        file_name = doc.file_name or doc.title or abs_path.name
    # 此处 DB 已释放，后续解析与索引构建不会长时间占用 SQLite

    if _is_document_task_cancelled(task_id):
        async with AsyncSessionLocal() as db:
            r = await db.execute(select(DocumentProcessTask).where(DocumentProcessTask.id == task_id))
            t = r.scalar_one_or_none()
            if t:
                t.status = "cancelled"
                t.error_message = "用户取消"
            rdoc = await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == doc_id))
            d = rdoc.scalar_one_or_none()
            if d:
                d.parse_status = "failed"
                d.parse_error = "用户取消"
            await db.commit()
        _document_task_running.discard(task_id)
        logger.info("doc_task_cancelled task_id=%s doc_id=%s", task_id, doc_id)
        return

    try:
        extracted_text, total_pages = _extract_pdf_text(file_binary, file_name)
    except Exception as e:
        err_msg = (e.detail if isinstance(e, HTTPException) and isinstance(e.detail, str) else str(e))
        async with AsyncSessionLocal() as db:
            r = await db.execute(select(DocumentProcessTask).where(DocumentProcessTask.id == task_id))
            t = r.scalar_one_or_none()
            if t:
                t.status = "failed"
                t.error_message = err_msg[:4000]
            rdoc = await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == doc_id))
            d = rdoc.scalar_one_or_none()
            if d:
                d.parse_status = "failed"
                d.parse_error = err_msg[:500]
            await db.commit()
        _document_task_running.discard(task_id)
        logger.exception("doc_task_failed task_id=%s doc_id=%s err=%s", task_id, doc_id, err_msg[:500])
        return
    logger.info("doc_task_parse_begin task_id=%s doc_id=%s path=%s", task_id, doc_id, file_name)

    if _is_document_task_cancelled(task_id):
        async with AsyncSessionLocal() as db:
            r = await db.execute(select(DocumentProcessTask).where(DocumentProcessTask.id == task_id))
            t = r.scalar_one_or_none()
            if t:
                t.status = "cancelled"
                t.error_message = "用户取消"
            rdoc = await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == doc_id))
            d = rdoc.scalar_one_or_none()
            if d:
                d.parse_status = "failed"
                d.parse_error = "用户取消"
            await db.commit()
        _document_task_running.discard(task_id)
        logger.info("doc_task_cancelled task_id=%s doc_id=%s", task_id, doc_id)
        return

    async with AsyncSessionLocal() as db:
        try:
            rdoc = await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == doc_id))
            doc = rdoc.scalar_one_or_none()
            if not doc:
                raise RuntimeError("文档不存在")
            doc.content = extracted_text
            doc.page_ref = f"{total_pages}页" if total_pages else None
            doc.parse_error = None
            doc.parse_status = "done"
            from ..rag import ChunkDocument
            from ..rag.chunking import chunk_documents
            preview_chunks = chunk_documents(
                [ChunkDocument(text=(doc.content or "").strip(), course_id=course_id, chapter_id=doc.chapter_id, title=doc.title, source_id=f"doc_{doc.id}")]
            )
            doc.chunk_count = len(preview_chunks)
            from ..services.rag_index_service import build_index_for_course
            try:
                await build_index_for_course(db, course_id)
            except Exception as idx_err:
                logger.exception("doc_reindex_failed file=%s course_id=%s doc_id=%s", file_name, course_id, doc_id)
                tip = f"索引失败: {str(idx_err)[:240]}"
                doc.parse_error = f"{doc.parse_error}；{tip}" if doc.parse_error else tip
            # 仅当文档关联单独一个章节时，自动提取解析内容生成知识点并写入该章节
            r_dc = await db.execute(
                select(DocumentChapter.chapter_id).where(DocumentChapter.doc_id == doc.id)
            )
            doc_chapter_ids = [row[0] for row in r_dc.all()]
            if len(doc_chapter_ids) == 1:
                r_ch = await db.execute(select(Chapter).where(Chapter.id == doc_chapter_ids[0]))
                chapter = r_ch.scalar_one_or_none()
                if chapter:
                    try:
                        await _auto_generate_and_save_kps_for_chapter(db, chapter, max_count=10)
                        logger.info(
                            "doc_task_auto_kp task_id=%s doc_id=%s chapter_id=%s",
                            task_id, doc_id, chapter.id,
                        )
                    except Exception as kp_err:
                        logger.warning(
                            "doc_task_auto_kp_failed task_id=%s doc_id=%s chapter_id=%s err=%s",
                            task_id, doc_id, chapter.id, str(kp_err)[:200],
                        )
            r = await db.execute(select(DocumentProcessTask).where(DocumentProcessTask.id == task_id))
            t = r.scalar_one_or_none()
            if t:
                t.status = "success"
                t.result_payload = json.dumps(
                    {"doc_id": doc.id, "parse_status": doc.parse_status, "chunk_count": doc.chunk_count},
                    ensure_ascii=False,
                )
                t.error_message = None
            await db.commit()
            _document_task_running.discard(task_id)
            logger.info("doc_task_success task_id=%s doc_id=%s chunk_count=%s", task_id, doc_id, doc.chunk_count)
        except Exception as e:
            err_msg = (e.detail if isinstance(e, HTTPException) and isinstance(e.detail, str) else str(e))
            logger.exception("doc_task_failed task_id=%s doc_id=%s err=%s", task_id, doc_id, err_msg[:500])
            r = await db.execute(select(DocumentProcessTask).where(DocumentProcessTask.id == task_id))
            t = r.scalar_one_or_none()
            if t:
                t.status = "failed"
                t.error_message = err_msg[:4000]
            rdoc = await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == doc_id))
            d = rdoc.scalar_one_or_none()
            if d:
                d.parse_status = "failed"
                d.parse_error = err_msg[:500]
            await db.commit()
            _document_task_running.discard(task_id)


def _run_document_process_task_thread(task_id: int):
    """在线程中运行文档处理任务，避免阻塞主事件循环。"""
    try:
        logger.info("doc_task_thread_start task_id=%s", task_id)
        asyncio.run(_run_document_process_task(task_id))
        logger.info("doc_task_thread_end task_id=%s", task_id)
    except Exception:
        logger.exception("doc_task_thread_crash task_id=%s", task_id)
        _document_task_running.discard(task_id)


def _parse_numeric_id_csv(value: str | None) -> list[int]:
    if not value:
        return []
    out: list[int] = []
    for part in str(value).split(","):
        p = part.strip()
        if p.isdigit():
            out.append(int(p))
    return out


@router.post("/questions/import/preview", response_model=TeacherImportQuestionsPreviewOut)
async def preview_import_teacher_questions(
    course_id: int = Form(...),
    chapter_ids: str = Form(...),
    question_bank_type: str = Form("training"),
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r_course = await db.execute(select(Course).where(Course.id == course_id, Course.owner_teacher_id == user.id))
    course = r_course.scalar_one_or_none()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在或无权限")
    try:
        parsed_ids = json.loads(chapter_ids)
        target_chapter_ids = sorted({int(x) for x in parsed_ids if int(x) > 0})
    except Exception:
        raise HTTPException(status_code=400, detail="chapter_ids 格式错误")
    if not target_chapter_ids:
        raise HTTPException(status_code=400, detail="请至少选择一个章节")
    r_ch = await db.execute(
        select(Chapter.id, Chapter.title)
        .where(Chapter.course_id == course.id, Chapter.id.in_(target_chapter_ids))
        .order_by(Chapter.id)
    )
    ch_rows = [(int(row[0]), str(row[1] or "")) for row in r_ch.all() if row[0] is not None]
    owned_ids = sorted({cid for cid, _ in ch_rows})
    if owned_ids != target_chapter_ids:
        raise HTTPException(status_code=400, detail="存在不属于当前课程的章节")
    chapter_options = [(cid, title) for cid, title in ch_rows if title]
    chapter_options_text = "\n".join([f"- {title}" for _, title in chapter_options]) or "（无）"
    normalized_bank_type = _normalize_question_bank_type(question_bank_type)
    if not files:
        raise HTTPException(status_code=400, detail="请上传文件")
    file_list: list[UploadFile] = list(files) if isinstance(files, (list, tuple)) else [files]

    extracted_docs: list[dict[str, object]] = []
    for f in file_list:
        file_name = (f.filename or "").strip()
        if not file_name:
            continue
        ext = Path(file_name).suffix.lower()
        binary = await f.read()
        if not binary:
            continue
        text = ""
        if ext == ".pdf":
            try:
                text, _ = _extract_pdf_text(binary, file_name)
            except Exception:
                text = ""
        elif ext == ".docx":
            text = _extract_docx_text(binary)
        elif ext == ".doc":
            text = _extract_legacy_word_text(binary)
        else:
            raise HTTPException(status_code=400, detail=f"不支持的文件格式: {file_name}")
        if not text.strip():
            continue
        body = text.strip()
        if len(body) > 16000:
            body = body[:16000]
        extracted_docs.append(
            {
                "idx": len(extracted_docs),
                "file_name": file_name,
                "text": body,
                "is_answer": bool(re.search(r"(答案|解析|answer|solution)", file_name, flags=re.IGNORECASE)),
            }
        )

    if not extracted_docs:
        raise HTTPException(status_code=400, detail="未从上传文件提取到可用文本")
    matched_pairs, unmatched_questions, unmatched_answers = _pair_documents_by_name(extracted_docs)

    try:
        from ..rag.config import get_rag_settings
        from ..rag.llm import get_llm

        settings = get_rag_settings()
        llm = get_llm(settings)
    except Exception as e:
        logger.exception("questions/import/preview: RAG/LLM 初始化失败")
        raise HTTPException(
            status_code=503,
            detail=f"题目解析依赖的 LLM 未配置或初始化失败，请到「管理后台 - RAG 配置」检查模型与 API 设置。错误摘要: {str(e)[:200]}",
        ) from e

    parse_jobs: list[tuple[str, str]] = []
    for q_doc, a_doc in matched_pairs:
        q_ctx = f"【文件：{q_doc['file_name']}】\n{q_doc['text']}"
        a_ctx = f"【文件：{a_doc['file_name']}】\n{a_doc['text']}"
        parse_jobs.append((q_ctx, a_ctx))
    for q_doc in unmatched_questions:
        q_ctx = f"【文件：{q_doc['file_name']}】\n{q_doc['text']}"
        parse_jobs.append((q_ctx, "（未单独提供答案文档）"))
    # 对未配对答案文档做兜底：按“单文档含题目+答案”场景解析，避免丢题。
    for a_doc in unmatched_answers:
        q_ctx = f"【文件：{a_doc['file_name']}】\n{a_doc['text']}"
        a_ctx = f"【文件：{a_doc['file_name']}】\n{a_doc['text']}"
        parse_jobs.append((q_ctx, a_ctx))
    if not parse_jobs:
        raise HTTPException(status_code=400, detail="未形成可解析的题目-答案文档配对")

    try:
        parsed_items: list[TeacherImportQuestionPreviewItemOut] = []
        for q_ctx, a_ctx in parse_jobs:
            prompt = _build_import_questions_prompt(
                question_context=q_ctx,
                answer_context=a_ctx,
                chapter_options_text=chapter_options_text,
            )
            raw = await asyncio.to_thread(
                llm.generate,
                prompt,
                max_tokens=max(1600, int(settings.llm_max_tokens or 512)),
                temperature=0.1,
            )
            candidates = _extract_json_payload(raw)
            parsed_items.extend(_normalize_import_questions(candidates, chapter_options=chapter_options))

        # 去重：按题干键合并，保留首次识别结果。
        dedup_items: list[TeacherImportQuestionPreviewItemOut] = []
        seen_keys: set[str] = set()
        for item in parsed_items:
            key = _normalize_text_key(item.question_text)
            if not key or key in seen_keys:
                continue
            seen_keys.add(key)
            dedup_items.append(item)
        items = dedup_items
        if not items:
            raise HTTPException(status_code=400, detail="未识别到有效题目，请检查文档内容或重试")
        return TeacherImportQuestionsPreviewOut(
            course_id=course.id,
            chapter_ids=target_chapter_ids,
            question_bank_type=normalized_bank_type,
            parsed_count=len(items),
            items=items,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("questions/import/preview: 解析或 LLM 调用失败")
        raise HTTPException(
            status_code=500,
            detail=f"题目解析失败（可能是 LLM 调用超时或返回格式异常）。请检查 RAG/LLM 配置或稍后重试。错误摘要: {str(e)[:200]}",
        ) from e


@router.post("/questions/import/confirm", response_model=TeacherImportConfirmOut)
async def confirm_import_teacher_questions(
    body: TeacherImportConfirmIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """将导入预览表格中的题目写入习题库，状态默认为待审核。"""
    r_course = await db.execute(select(Course).where(Course.id == body.course_id, Course.owner_teacher_id == user.id))
    course = r_course.scalar_one_or_none()
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在或无权限")
    if not body.items:
        raise HTTPException(status_code=400, detail="预览表格为空，请先上传并解析题目")
    chapter_ids = sorted({item.chapter_id for item in body.items})
    r_ch = await db.execute(
        select(Chapter.id).where(Chapter.course_id == course.id, Chapter.id.in_(chapter_ids))
    )
    owned_ch_ids = {int(row[0]) for row in r_ch.all() if row[0] is not None}
    if owned_ch_ids != set(chapter_ids):
        raise HTTPException(status_code=400, detail="存在不属于当前课程的章节")
    normalized_bank_type = _normalize_question_bank_type(body.question_bank_type)
    imported = 0
    for item in body.items:
        q_text = (item.question_text or "").strip()
        if not q_text:
            continue
        q_type = (item.question_type or "single_choice").strip() or "single_choice"
        if q_type not in ("single_choice", "multiple_choice", "judge", "blank", "qa"):
            q_type = "qa"
        options_json = json.dumps(item.options or [], ensure_ascii=False) if (item.options or []) else None
        diff_score = 0.8
        if item.difficulty_score is not None and 0 <= item.difficulty_score <= 1:
            diff_score = round(item.difficulty_score, 2)
        db.add(
            Question(
                course_id=course.id,
                chapter_id=item.chapter_id,
                question_bank_type=normalized_bank_type,
                difficulty_score=diff_score,
                difficulty=difficulty_from_score(diff_score),
                question_type=q_type,
                question_text=q_text,
                options=options_json,
                correct_answer=(item.correct_answer or "").strip() or "-",
                explanation=(item.explanation or "").strip() or None,
                is_active=True,
                is_approved=False,
            )
        )
        imported += 1
    await db.commit()
    return TeacherImportConfirmOut(imported_count=imported, message=f"已导入 {imported} 道题目到习题库，状态为待审核。")


@router.get("/chapters/{chapter_id}/questions", response_model=list[TeacherQuestionOut])
async def list_teacher_chapter_questions(
    chapter_id: int,
    knowledge_point_id: int | None = Query(None),
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
    if knowledge_point_id is not None:
        rows = [
            row
            for row in rows
            if knowledge_point_id in _parse_numeric_id_csv(row[0].knowledge_point_ids)
        ]

    kp_ids: set[int] = set()
    q_kp_map: dict[int, list[int]] = {}
    for q, _, _ in rows:
        ids = _parse_numeric_id_csv(q.knowledge_point_ids)
        q_kp_map[int(q.id)] = ids
        kp_ids.update(ids)
    kp_title_map: dict[int, str] = {}
    if kp_ids:
        r_kp = await db.execute(select(KnowledgePoint.id, KnowledgePoint.title).where(KnowledgePoint.id.in_(kp_ids)))
        kp_title_map = {int(row[0]): str(row[1]) for row in r_kp.all() if row[0] and row[1]}

    return [
        TeacherQuestionOut(
            id=q.id,
            course_id=q.course_id or c.id,
            course_name=c.name,
            chapter_id=ch.id,
            chapter_title=ch.title,
            question_type=(q.question_type or "single_choice"),
            question_bank_type=_normalize_question_bank_type(q.question_bank_type),
            difficulty=q.difficulty,
            difficulty_score=_normalize_difficulty_score(q.difficulty_score),
            question_text=q.question_text,
            options=q.options,
            correct_answer=q.correct_answer,
            explanation=q.explanation,
            remark=q.remark,
            is_approved=bool(q.is_approved),
            generated_time=q.generated_time.isoformat() if q.generated_time else None,
            edited_time=q.edited_time.isoformat() if q.edited_time else None,
            knowledge_point_ids=q.knowledge_point_ids,
            knowledge_points=[kp_title_map[kid] for kid in q_kp_map.get(int(q.id), []) if kid in kp_title_map],
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
    if body.question_bank_type is not None:
        q.question_bank_type = _normalize_question_bank_type(body.question_bank_type)
    if body.difficulty_score is not None:
        q.difficulty_score = _normalize_difficulty_score(body.difficulty_score)
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
    if body.remark is not None:
        q.remark = body.remark.strip()[:128] or None
    if body.is_approved is not None:
        q.is_approved = bool(body.is_approved)
    if body.knowledge_point_ids is not None:
        incoming_ids = sorted({int(x) for x in body.knowledge_point_ids if int(x) > 0})
        if incoming_ids:
            r_kp = await db.execute(
                select(KnowledgePoint.id).where(
                    KnowledgePoint.chapter_id == q.chapter_id,
                    KnowledgePoint.id.in_(incoming_ids),
                )
            )
            valid_ids = sorted({int(row[0]) for row in r_kp.all() if row[0] is not None})
            if len(valid_ids) != len(incoming_ids):
                raise HTTPException(status_code=400, detail="存在不属于当前章节的知识点")
            q.knowledge_point_ids = ",".join(str(x) for x in valid_ids)
        else:
            q.knowledge_point_ids = None
    q.edited_time = datetime.utcnow()
    q.course_id = c.id
    await db.commit()
    await db.refresh(q)
    kp_title_map: dict[int, str] = {}
    kp_ids = _parse_numeric_id_csv(q.knowledge_point_ids)
    if kp_ids:
        r_kp_titles = await db.execute(select(KnowledgePoint.id, KnowledgePoint.title).where(KnowledgePoint.id.in_(kp_ids)))
        kp_title_map = {int(row[0]): str(row[1]) for row in r_kp_titles.all() if row[0] and row[1]}
    return TeacherQuestionOut(
        id=q.id,
        course_id=q.course_id,
        course_name=c.name,
        chapter_id=ch.id,
        chapter_title=ch.title,
        question_type=(q.question_type or "single_choice"),
        question_bank_type=_normalize_question_bank_type(q.question_bank_type),
        difficulty=q.difficulty,
        difficulty_score=_normalize_difficulty_score(q.difficulty_score),
        question_text=q.question_text,
        options=q.options,
        correct_answer=q.correct_answer,
        explanation=q.explanation,
        remark=q.remark,
        is_approved=bool(q.is_approved),
        generated_time=q.generated_time.isoformat() if q.generated_time else None,
        edited_time=q.edited_time.isoformat() if q.edited_time else None,
        knowledge_point_ids=q.knowledge_point_ids,
        knowledge_points=[kp_title_map[kid] for kid in kp_ids if kid in kp_title_map],
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
    chapter_id = int(q.chapter_id)
    await db.delete(q)
    await db.flush()
    await _cleanup_orphan_knowledge_points_for_chapter(db, chapter_id)
    await db.commit()
    return {"ok": True}


async def _get_doc_chapter_ids(db: AsyncSession, doc_ids: list[int]) -> dict[int, list[int]]:
    if not doc_ids:
        return {}
    r = await db.execute(
        select(DocumentChapter.doc_id, DocumentChapter.chapter_id).where(DocumentChapter.doc_id.in_(doc_ids))
    )
    out: dict[int, list[int]] = {i: [] for i in doc_ids}
    for doc_id, ch_id in r.all():
        out.setdefault(doc_id, []).append(ch_id)
    for k in out:
        out[k] = sorted(out[k])
    return out


@router.get("/chapters/{chapter_id}/documents", response_model=list[TeacherKnowledgeDocumentOut])
async def list_teacher_chapter_documents(
    chapter_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_chapter(db, user.id, chapter_id)
    active_task_doc_ids = await _reconcile_document_process_tasks(db, user.id, chapter_id=chapter_id)
    dc_sub = select(DocumentChapter.doc_id).where(DocumentChapter.chapter_id == chapter_id).distinct()
    r = await db.execute(
        select(KnowledgeDocument)
        .where(or_(KnowledgeDocument.id.in_(dc_sub), KnowledgeDocument.chapter_id == chapter_id))
        .order_by(KnowledgeDocument.id.desc())
    )
    rows = r.scalars().all()
    doc_ids = [d.id for d in rows]
    chapter_ids_map = await _get_doc_chapter_ids(db, doc_ids)
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
            course_id=getattr(d, "course_id", None),
            source_type=d.source_type,
            title=d.title,
            page_ref=d.page_ref,
            file_name=d.file_name,
            file_size=d.file_size,
            parse_status="processing" if d.id in active_task_doc_ids else d.parse_status,
            parse_error=None if d.id in active_task_doc_ids else d.parse_error,
            chunk_count=d.chunk_count,
            student_visible=getattr(d, "student_visible", True) if getattr(d, "student_visible", None) is not None else True,
            downloadable=getattr(d, "downloadable", True) if getattr(d, "downloadable", None) is not None else True,
            chapter_ids=chapter_ids_map.get(d.id, []),
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
        course_id=chapter.course_id,
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
        student_visible=False,
        downloadable=False,
    )
    db.add(doc)
    await db.flush()
    db.add(DocumentChapter(doc_id=doc.id, chapter_id=chapter.id))

    await db.commit()
    await db.refresh(doc)
    return TeacherKnowledgeDocumentOut(
        id=doc.id,
        chapter_id=doc.chapter_id,
        course_id=doc.course_id,
        source_type=doc.source_type,
        title=doc.title,
        page_ref=doc.page_ref,
        file_name=doc.file_name,
        file_size=doc.file_size,
        parse_status=doc.parse_status,
        parse_error=doc.parse_error,
        chunk_count=doc.chunk_count,
        student_visible=doc.student_visible,
        downloadable=doc.downloadable,
        chapter_ids=[chapter.id],
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
        course_id=chapter.course_id,
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
        student_visible=False,
        downloadable=False,
    )
    db.add(doc)
    await db.flush()
    db.add(DocumentChapter(doc_id=doc.id, chapter_id=chapter.id))
    await db.commit()
    await db.refresh(doc)
    return TeacherKnowledgeDocumentOut(
        id=doc.id,
        chapter_id=doc.chapter_id,
        course_id=doc.course_id,
        source_type=doc.source_type,
        title=doc.title,
        page_ref=doc.page_ref,
        file_name=doc.file_name,
        file_size=doc.file_size,
        parse_status=doc.parse_status,
        parse_error=doc.parse_error,
        chunk_count=doc.chunk_count,
        student_visible=doc.student_visible,
        downloadable=doc.downloadable,
        chapter_ids=[chapter.id],
        created_at=doc.created_at.isoformat() if doc.created_at else None,
    )


@router.get("/documents/{doc_id}", response_model=TeacherKnowledgeDocumentDetailOut)
async def get_teacher_document_detail(
    doc_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    doc, chapter, course = await _require_owned_document(db, user.id, doc_id)
    chapter_ids_map = await _get_doc_chapter_ids(db, [doc.id])
    doc_chapter_ids = chapter_ids_map.get(doc.id, [])
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
    ch_id = (chapter.id if chapter else None) or doc.chapter_id or (doc_chapter_ids[0] if doc_chapter_ids else None)
    if doc.content and doc.parse_status == "done" and course and ch_id:
        from ..rag import ChunkDocument
        from ..rag.chunking import chunk_documents
        chunks = chunk_documents(
            [ChunkDocument(text=(doc.content or "").strip(), course_id=course.id, chapter_id=ch_id, title=doc.title, source_id=f"doc_{doc.id}")]
        )
        chunks_out = [TeacherDocumentChunkOut(index=i + 1, text=chunk[0]) for i, chunk in enumerate(chunks[:50])]
    preview = (doc.content or "").strip()
    if len(preview) > 4000:
        preview = preview[:4000] + "\n\n..."
    return TeacherKnowledgeDocumentDetailOut(
        id=doc.id,
        chapter_id=doc.chapter_id,
        course_id=getattr(doc, "course_id", None),
        source_type=doc.source_type,
        title=doc.title,
        page_ref=doc.page_ref,
        file_name=doc.file_name,
        file_size=doc.file_size,
        parse_status=effective_status,
        parse_error=effective_error,
        chunk_count=doc.chunk_count,
        student_visible=getattr(doc, "student_visible", True) if getattr(doc, "student_visible", None) is not None else True,
        downloadable=getattr(doc, "downloadable", True) if getattr(doc, "downloadable", None) is not None else True,
        chapter_ids=doc_chapter_ids,
        created_at=doc.created_at.isoformat() if doc.created_at else None,
        content_preview=preview,
        chunks=chunks_out,
    )


class TeacherDocumentPatchIn(BaseModel):
    student_visible: bool | None = None
    downloadable: bool | None = None
    chapter_ids: list[int] | None = None


@router.patch("/documents/{doc_id}", response_model=TeacherKnowledgeDocumentOut)
async def patch_teacher_document(
    doc_id: int,
    body: TeacherDocumentPatchIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    doc, chapter, course = await _require_owned_document(db, user.id, doc_id)
    if body.student_visible is not None:
        doc.student_visible = body.student_visible
    if body.downloadable is not None:
        doc.downloadable = body.downloadable
    if body.chapter_ids is not None:
        await db.execute(delete(DocumentChapter).where(DocumentChapter.doc_id == doc.id))
        for ch_id in body.chapter_ids:
            await _require_owned_chapter(db, user.id, ch_id)
            db.add(DocumentChapter(doc_id=doc.id, chapter_id=ch_id))
        doc.chapter_id = body.chapter_ids[0] if body.chapter_ids else None
        if course and body.chapter_ids:
            doc.course_id = course.id
    await db.commit()
    await db.refresh(doc)
    chapter_ids_map = await _get_doc_chapter_ids(db, [doc.id])
    return TeacherKnowledgeDocumentOut(
        id=doc.id,
        chapter_id=doc.chapter_id,
        course_id=getattr(doc, "course_id", None),
        source_type=doc.source_type,
        title=doc.title,
        page_ref=doc.page_ref,
        file_name=doc.file_name,
        file_size=doc.file_size,
        parse_status=doc.parse_status,
        parse_error=doc.parse_error,
        chunk_count=doc.chunk_count,
        student_visible=getattr(doc, "student_visible", True) if getattr(doc, "student_visible", None) is not None else True,
        downloadable=getattr(doc, "downloadable", True) if getattr(doc, "downloadable", None) is not None else True,
        chapter_ids=chapter_ids_map.get(doc.id, []),
        created_at=doc.created_at.isoformat() if doc.created_at else None,
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
    r_dc = await db.execute(select(DocumentChapter.chapter_id).where(DocumentChapter.doc_id == doc.id))
    dc_chapter_ids = [row[0] for row in r_dc.all()]
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
    ch_id = (chapter.id if chapter else None) or doc.chapter_id
    if not ch_id and dc_chapter_ids:
        ch_id = dc_chapter_ids[0]
    if not course:
        raise HTTPException(status_code=400, detail="文档未关联课程，无法处理")
    if doc.chapter_id is None and ch_id:
        doc.chapter_id = ch_id
        await db.flush()
    task = DocumentProcessTask(
        course_id=course.id,
        chapter_id=ch_id,  # 无章节时为 None，按课程维度解析
        doc_id=doc.id,
        teacher_id=user.id,
        status="pending",
        request_payload=json.dumps({"doc_id": doc.id}, ensure_ascii=False),
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    logger.info("doc_task_created task_id=%s doc_id=%s chapter_id=%s", task.id, doc.id, ch_id)
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
    # 内存优先：已取消或重启后未在运行中的任务不再显示为处理中
    if task_id in _document_task_cancelled:
        status, err = "cancelled", (task.error_message or "已取消")
    elif task_id in _document_task_running:
        status, err = task.status, task.error_message
    elif task.status in ("pending", "running"):
        status, err = "cancelled", "任务已停止或服务已重启"
    else:
        status, err = task.status, task.error_message
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
        status=status,
        request_payload=req_payload,
        result_payload=res_payload,
        error_message=err,
        created_at=task.created_at.isoformat() if task.created_at else None,
        updated_at=task.updated_at.isoformat() if task.updated_at else None,
    )


@router.post("/documents/tasks/{task_id}/cancel", response_model=TeacherDocumentProcessTaskStatusOut)
async def cancel_reprocess_teacher_document_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """停止正在进行的文档处理任务（仅内存标记，后台会在下次检查点退出）。"""
    r = await db.execute(select(DocumentProcessTask).where(DocumentProcessTask.id == task_id, DocumentProcessTask.teacher_id == user.id))
    task = r.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task.status not in ("pending", "running"):
        return await get_reprocess_teacher_document_task(task_id, db, user)
    _document_task_cancelled.add(task_id)
    return await get_reprocess_teacher_document_task(task_id, db, user)


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
    # 只查列表需要的列，减少 ORM 与 I/O；单表 + LEFT JOIN courses 取 name
    stmt = (
        select(
            Class.id,
            Class.name,
            Class.term,
            Class.course_id,
            Class.owner_teacher_id,
            Class.student_count,
            Class.created_at,
            Course.name.label("course_name"),
        )
        .select_from(Class)
        .outerjoin(Course, Class.course_id == Course.id)
        .where(Class.owner_teacher_id == user.id)
        .order_by(Class.id)
    )
    r = await db.execute(stmt)
    rows = r.all()
    return [
        TeacherClassOut(
            id=row.id,
            name=row.name,
            term=row.term,
            course_id=row.course_id,
            course_name=row.course_name,
            owner_teacher_id=row.owner_teacher_id,
            student_count=int(row.student_count or 0),
            created_at=row.created_at.isoformat() if row.created_at else None,
        )
        for row in rows
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
        student_count=int(c.student_count or 0),
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


# 批量导入学生模版文件（放在 app/static 下，表头：学号，姓名，学号不能为空）
_STUDENT_IMPORT_TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "static" / "学生导入模版.csv"


@router.get("/classes/students/import-template")
async def download_student_import_template(
    user: User = Depends(require_teacher),
):
    """下载批量导入学生用的电子表格模版文件，表头：学号，姓名。学号不能为空。"""
    if not _STUDENT_IMPORT_TEMPLATE_PATH.is_file():
        raise HTTPException(status_code=500, detail="模版文件不存在")
    return FileResponse(
        path=str(_STUDENT_IMPORT_TEMPLATE_PATH),
        filename="学生导入模版.csv",
        media_type="text/csv; charset=utf-8",
    )


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
    return [
        TeacherStudentOut(
            id=s.id, username=s.username, student_no=s.student_no, display_name=s.display_name,
            admin_class_or_dept=getattr(s, "admin_class_or_dept", None),
        )
        for s in r.scalars().all()
    ]


@router.post("/classes/{class_id}/students/assign")
async def assign_students_to_teacher_class(
    class_id: int,
    body: TeacherClassStudentsAssignIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    c = await _require_owned_class(db, user.id, class_id)
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
    if assigned > 0:
        c.student_count = (c.student_count or 0) + assigned
    await db.commit()
    return {"ok": True, "assigned": assigned}


@router.post("/classes/{class_id}/students/import")
async def import_students_to_teacher_class(
    class_id: int,
    file: UploadFile = File(..., description="CSV 或 Excel 表格，表头含学号、姓名，学号不能为空"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """通过上传填好的模版文件，按学号匹配用户表，将学生批量加入班级。匹配不到学号的行不导入。"""
    c = await _require_owned_class(db, user.id, class_id)
    if not file.filename:
        raise HTTPException(status_code=400, detail="请选择文件")
    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig").strip()
    except UnicodeDecodeError:
        try:
            text = raw.decode("gbk").strip()
        except Exception:
            raise HTTPException(status_code=400, detail="文件编码不支持，请使用 UTF-8 或 GBK 保存的 CSV")
    if not text:
        raise HTTPException(status_code=400, detail="文件为空")
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        raise HTTPException(status_code=400, detail="文件无有效行")
    # 首行表头，支持中英文
    header = [str(c).strip() for c in rows[0]]
    col_no = col_name = None
    for i, h in enumerate(header):
        if h in ("学号", "student_no", "学号 ", "student_no "):
            col_no = i
        if h in ("姓名", "name", "姓名 ", "name "):
            col_name = i
    if col_no is None:
        raise HTTPException(status_code=400, detail="表头需包含「学号」列")
    data_rows = rows[1:]
    student_nos = []
    for r in data_rows:
        if len(r) > col_no and r[col_no] is not None and str(r[col_no]).strip():
            student_nos.append(str(r[col_no]).strip())
    if not student_nos:
        return {"ok": True, "imported": 0, "skipped": 0, "not_found": [], "message": "文件中无有效学号（学号不能为空）"}
    # 按学号查用户表（学生角色）
    qry = select(User).where(
        User.role == UserRole.student.value,
        User.student_no.in_(student_nos),
    )
    r = await db.execute(qry)
    users_by_no = {u.student_no: u for u in r.scalars().all() if u.student_no}
    # 已有成员
    r_m = await db.execute(
        select(StudentClassMembership.student_id).where(StudentClassMembership.class_id == class_id)
    )
    existing_ids = {row[0] for row in r_m.all()}
    imported = 0
    not_found = []
    for no in student_nos:
        u = users_by_no.get(no)
        if not u:
            not_found.append(no)
            continue
        if u.id in existing_ids:
            continue
        db.add(StudentClassMembership(student_id=u.id, class_id=class_id))
        existing_ids.add(u.id)
        imported += 1
    if imported > 0:
        c.student_count = (c.student_count or 0) + imported
    await db.commit()
    return {
        "ok": True,
        "imported": imported,
        "skipped": len(student_nos) - imported - len(not_found),
        "not_found": not_found,
        "message": f"成功导入 {imported} 人" + (f"，以下学号在系统中未找到：{', '.join(not_found[:20])}" + (" …" if len(not_found) > 20 else "") if not_found else ""),
    }


@router.delete("/classes/{class_id}/students/{student_id}")
async def remove_student_from_teacher_class(
    class_id: int,
    student_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    c = await _require_owned_class(db, user.id, class_id)
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
    c.student_count = max(0, (c.student_count or 0) - 1)
    await db.commit()
    return {"ok": True}


@router.get("/students", response_model=list[TeacherStudentOut])
async def list_students_for_teacher(
    q: str | None = Query(None),
    student_no: str | None = Query(None),
    name: str | None = Query(None),
    admin_class_or_dept: str | None = Query(None, description="按行政班级筛选，学生角色的 admin_class_or_dept"),
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
    if admin_class_or_dept is not None and admin_class_or_dept.strip():
        qry = qry.where(User.admin_class_or_dept == admin_class_or_dept.strip())
    r = await db.execute(qry)
    return [
        TeacherStudentOut(
            id=s.id, username=s.username, student_no=s.student_no, display_name=s.display_name,
            admin_class_or_dept=getattr(s, "admin_class_or_dept", None),
        )
        for s in r.scalars().all()
    ]


@router.get("/students/admin-classes", response_model=list[str])
async def list_student_admin_classes(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """返回学生角色用户中「行政班级/部门」去重后的非空列表，供添加学生时按行政班级筛选。"""
    qry = (
        select(User.admin_class_or_dept)
        .where(User.role == UserRole.student.value, User.admin_class_or_dept.isnot(None), User.admin_class_or_dept != "")
        .distinct()
        .order_by(User.admin_class_or_dept)
    )
    r = await db.execute(qry)
    return [row[0].strip() for row in r.all() if row[0] and row[0].strip()]


async def _user_ids_by_class(db: AsyncSession, class_id: int | None):
    """若指定 class_id，返回该班级中仅学生角色的用户 id 列表；否则返回全部学生用户 id 列表。学情统计仅统计学生角色。"""
    if class_id is not None:
        r = await db.execute(
            select(StudentClassMembership.student_id)
            .join(User, User.id == StudentClassMembership.student_id)
            .where(StudentClassMembership.class_id == class_id, User.role == UserRole.student.value)
        )
        return [row[0] for row in r.all()]
    r = await db.execute(select(User.id).where(User.role == UserRole.student.value))
    return [row[0] for row in r.all()]


async def _course_student_pairs_for_overview(
    db: AsyncSession,
    scoped_course_ids: set[int] | None,
    class_id: int | None,
    user: User,
) -> list[tuple[int, int]]:
    """与学情课程统计详细表一致的 (course_id, student_id) 集合：来自 Class + StudentClassMembership，仅包含学生角色，用于概览 AI 提问数/无关数与详情表合计一致。"""
    if not scoped_course_ids:
        return []
    q = (
        select(Class.course_id, StudentClassMembership.student_id)
        .select_from(Class)
        .join(StudentClassMembership, StudentClassMembership.class_id == Class.id)
        .join(User, User.id == StudentClassMembership.student_id)
        .where(Class.course_id.in_(scoped_course_ids), User.role == UserRole.student.value)
    )
    if _is_teacher_scoped(user):
        q = q.where(Class.owner_teacher_id == user.id)
    if class_id is not None:
        q = q.where(Class.id == class_id)
    r = await db.execute(q)
    return [(int(row[0]), int(row[1])) for row in r.all()]


async def _student_count_in_scope(
    db: AsyncSession,
    class_id: int | None,
    user_ids: list[int] | None,
    scoped_course_ids: set[int] | None,
    teacher_id: int | None,
) -> int:
    """统计当前筛选范围内「选课学生总数」：选该班级或选该课程（或章节所属课程）的学生去重人数。"""
    if class_id is not None and user_ids is not None:
        return len(user_ids)
    if scoped_course_ids is None or not scoped_course_ids:
        return 0
    q_class = select(Class.id).where(Class.course_id.in_(scoped_course_ids))
    if teacher_id is not None:
        q_class = q_class.where(Class.owner_teacher_id == teacher_id)
    r_class = await db.execute(q_class)
    class_ids = [row[0] for row in r_class.all()]
    if not class_ids:
        return 0
    r = await db.execute(
        select(func.count(func.distinct(StudentClassMembership.student_id))).where(
            StudentClassMembership.class_id.in_(class_ids)
        )
    )
    return r.scalar() or 0


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
    # 先按 src 长度降序应用，避免「么」->「吗」把「是什么」变成「是什吗」导致「是什么」无法被替换
    for src, dst in sorted(replacements.items(), key=lambda x: -len(x[0])):
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
        cid = course_id if course_id is not None else -1
        aliases = course_synonym_maps.get(cid, {})
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
                "course_counts": {cid: int(count or 0)} if cid >= 0 else {},
            })
            continue
        hit["count"] += int(count or 0)
        if cid >= 0:
            hit["course_counts"][cid] = hit["course_counts"].get(cid, 0) + int(count or 0)
        if len(question) < len(hit["question"]):
            hit["question"] = question
        if len(key) < len(hit["key"]):
            hit["key"] = key
    merged = []
    for c in clusters:
        rep_course_id: int | None = None
        if c.get("course_counts"):
            rep_course_id = max(c["course_counts"], key=c["course_counts"].get)
            if rep_course_id == -1:
                rep_course_id = None
        merged.append({"question": c["question"], "count": c["count"], "course_id": rep_course_id})
    merged = sorted(merged, key=lambda x: (-x["count"], x["question"]))
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
    qa_hit_predicate = or_(
        QuestionAsked.rag_hit == True,
        and_(
            QuestionAsked.rag_hit == False,
            QuestionAsked.ppt_ref.is_not(None),
            func.trim(QuestionAsked.ppt_ref) != "",
            QuestionAsked.ppt_ref != "当前问题在知识库中没有参考答案",
        ),
    )
    if scoped_chapter_ids is not None:
        if not scoped_chapter_ids:
            return stmt.where(QuestionAsked.id == -1)
        return stmt.where(
            qa_hit_predicate,
            QuestionAsked.chapter_id.in_(scoped_chapter_ids),
        )
    if scoped_course_ids is not None:
        if not scoped_course_ids:
            return stmt.where(QuestionAsked.id == -1)
        return stmt.where(
            qa_hit_predicate,
            QuestionAsked.course_id.in_(scoped_course_ids),
        )
    return stmt.where(qa_hit_predicate)


@router.get("/stats/overview", response_model=StatsOverviewOut)
async def stats_overview(
    class_id: int | None = Query(None),
    course_id: int | None = Query(None),
    chapter_id: int | None = Query(None),
    start_date: str | None = Query(None, description="统计周期起日 YYYY-MM-DD，与学情课程统计详细表一致"),
    end_date: str | None = Query(None, description="统计周期止日 YYYY-MM-DD，与学情课程统计详细表一致"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    if class_id is not None and _is_teacher_scoped(user):
        await _require_owned_class(db, user.id, class_id)
    user_ids = await _user_ids_by_class(db, class_id)
    teacher_course_ids = await _teacher_course_ids(db, user.id) if _is_teacher_scoped(user) else set()
    if _is_teacher_scoped(user) and course_id is not None and course_id not in teacher_course_ids:
        raise HTTPException(status_code=404, detail="课程不存在或无权限")

    scoped_course_ids: set[int] | None = None
    if course_id is not None:
        scoped_course_ids = {course_id}
    elif _is_teacher_scoped(user):
        scoped_course_ids = teacher_course_ids

    time_filter = False
    start_dt = None
    end_dt = None
    if start_date and end_date:
        try:
            start_dt = datetime.strptime(start_date, "%Y-%m-%d")
            end_dt = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)
            time_filter = True
        except ValueError:
            pass

    # 与学情课程统计详细表一致的 (course, student) 对，使概览 AI 提问数/无关数 = 详情表合计
    course_student_pairs: list[tuple[int, int]] = []
    if scoped_course_ids:
        course_student_pairs = await _course_student_pairs_for_overview(db, scoped_course_ids, class_id, user)

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
    # 预习完成率 = 完成预习的学生数 / 选该课或该章节的学生总数（按班级/课程/章节筛选）
    total_students_in_scope = await _student_count_in_scope(
        db, class_id, user_ids, scoped_course_ids, user.id if _is_teacher_scoped(user) else None
    )
    # 分子：至少有一条 completed=true 的预习记录的去重学生数
    q_done_preview_students = select(func.count(func.distinct(PreviewRecord.user_id))).where(
        PreviewRecord.completed == True
    )
    if scoped_chapter_ids is not None:
        q_done_preview_students = q_done_preview_students.where(PreviewRecord.chapter_id.in_(scoped_chapter_ids))
    if user_ids is not None:
        q_done_preview_students = q_done_preview_students.where(PreviewRecord.user_id.in_(user_ids))
    if time_filter and start_dt is not None and end_dt is not None:
        q_done_preview_students = q_done_preview_students.where(
            PreviewRecord.completed_at >= start_dt, PreviewRecord.completed_at < end_dt
        )
    r_done_preview = await db.execute(q_done_preview_students)
    done_preview_student_count = r_done_preview.scalar() or 0
    preview_rate = (done_preview_student_count / total_students_in_scope * 100) if total_students_in_scope else 0.0

    # 预习学生数：有预习记录的去重用户数（与展示一致，表示「有做过预习的学生数」）
    q_preview_students = select(func.count(func.distinct(PreviewRecord.user_id)))
    if scoped_chapter_ids is not None:
        q_preview_students = q_preview_students.where(PreviewRecord.chapter_id.in_(scoped_chapter_ids))
    if user_ids is not None:
        q_preview_students = q_preview_students.where(PreviewRecord.user_id.in_(user_ids))
    if time_filter and start_dt is not None and end_dt is not None:
        q_preview_students = q_preview_students.where(
            PreviewRecord.completed_at >= start_dt, PreviewRecord.completed_at < end_dt
        )
    r_preview_students = await db.execute(q_preview_students)
    preview_student_count = r_preview_students.scalar() or 0

    # 高频问题
    top_q_stmt = (
        select(
            QuestionAsked.course_id,
            QuestionAsked.question_text,
            func.count(QuestionAsked.id).label("c"),
        )
        .group_by(QuestionAsked.course_id, QuestionAsked.question_text)
    )
    if _is_teacher_scoped(user):
        # 高频提问固定按课程口径，不随章节筛选变化。
        top_q_stmt = _apply_teacher_qa_scope(top_q_stmt, scoped_course_ids, None)
    else:
        if scoped_course_ids is not None:
            top_q_stmt = top_q_stmt.where(QuestionAsked.course_id.in_(scoped_course_ids))
        if scoped_chapter_ids is not None:
            top_q_stmt = top_q_stmt.where(QuestionAsked.chapter_id.in_(scoped_chapter_ids))
    if user_ids is not None:
        top_q_stmt = top_q_stmt.where(QuestionAsked.user_id.in_(user_ids))
    if time_filter and start_dt is not None and end_dt is not None:
        top_q_stmt = top_q_stmt.where(
            QuestionAsked.created_at >= start_dt, QuestionAsked.created_at < end_dt
        )
    top_q_stmt = top_q_stmt.order_by(func.count(QuestionAsked.id).desc()).limit(200)
    top_q = await db.execute(top_q_stmt)
    synonym_course_ids = scoped_course_ids if (scoped_course_ids is not None) else teacher_course_ids
    course_synonym_maps = await _load_course_synonym_maps(db, synonym_course_ids) if synonym_course_ids else {}
    top_asked = _merge_similar_questions([(r[1], r[2], r[0]) for r in top_q.all()], course_synonym_maps, limit=5)

    # AI提问数：所选课程 + 统计周期 + 学生角色提问数总和，与学情课程统计详细表同口径（全部 QuestionAsked，不限制 rag_hit），使概览数 = 详情表合计
    if not course_student_pairs:
        ai_ask_count = 0
    else:
        q_ai_ask_count = select(func.count(QuestionAsked.id)).where(
            tuple_(QuestionAsked.course_id, QuestionAsked.user_id).in_(course_student_pairs)
        )
        if time_filter and start_dt is not None and end_dt is not None:
            q_ai_ask_count = q_ai_ask_count.where(
                QuestionAsked.created_at >= start_dt, QuestionAsked.created_at < end_dt
            )
        r_ai_ask = await db.execute(q_ai_ask_count)
        ai_ask_count = r_ai_ask.scalar() or 0

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
    if time_filter and start_dt is not None and end_dt is not None:
        q_ans = q_ans.where(AnswerRecord.created_at >= start_dt, AnswerRecord.created_at < end_dt)
        q_ans_ok = q_ans_ok.where(AnswerRecord.created_at >= start_dt, AnswerRecord.created_at < end_dt)
    total_answers = await db.execute(q_ans)
    correct_answers = await db.execute(q_ans_ok)
    ans_total = total_answers.scalar() or 0
    ans_ok = correct_answers.scalar() or 0
    accuracy = (ans_ok / ans_total * 100) if ans_total else 0.0
    completed_question_count = ans_total

    # 反馈问题数：按课程( course_id )、班级( user_ids )筛选
    q_feedback = select(func.count(StudentFeedback.id))
    if scoped_course_ids is not None and scoped_course_ids:
        q_feedback = q_feedback.where(StudentFeedback.course_id.in_(scoped_course_ids))
    if user_ids is not None:
        q_feedback = q_feedback.where(StudentFeedback.user_id.in_(user_ids))
    if time_filter and start_dt is not None and end_dt is not None:
        q_feedback = q_feedback.where(
            StudentFeedback.created_at >= start_dt, StudentFeedback.created_at < end_dt
        )
    r_feedback = await db.execute(q_feedback)
    feedback_question_count = r_feedback.scalar() or 0

    # AI无关问题数：仅根据 course_irrelevant 标记位查询
    _irrelevant_predicate = QuestionAsked.course_irrelevant == True
    if not course_student_pairs:
        ai_irrelevant_count = 0
    else:
        q_irrelevant = select(func.count(QuestionAsked.id)).where(
            _irrelevant_predicate,
            tuple_(QuestionAsked.course_id, QuestionAsked.user_id).in_(course_student_pairs),
        )
        if time_filter and start_dt is not None and end_dt is not None:
            q_irrelevant = q_irrelevant.where(
                QuestionAsked.created_at >= start_dt, QuestionAsked.created_at < end_dt
            )
        r_irrelevant = await db.execute(q_irrelevant)
        ai_irrelevant_count = r_irrelevant.scalar() or 0

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
    if time_filter and start_dt is not None and end_dt is not None:
        wrong_q_ids = wrong_q_ids.where(
            AnswerRecord.created_at >= start_dt, AnswerRecord.created_at < end_dt
        )
    wrong_q_ids = wrong_q_ids.group_by(AnswerRecord.question_id)
    r_wrong = await db.execute(wrong_q_ids)
    wrong_rows = [(int(row[0]), int(row[1] or 0)) for row in r_wrong.all() if row[0] is not None]
    weak_titles: list[str] = []
    weak_course_ids: list[int | None] = []
    weak_wrong_counts: list[int] = []
    if wrong_rows:
        wqids = [qid for qid, _ in wrong_rows]
        wrong_count_by_qid = {qid: cnt for qid, cnt in wrong_rows}
        r_questions = await db.execute(select(Question).where(Question.id.in_(wqids)))
        questions = r_questions.scalars().all()
        # (kp_id, course_id) -> wrong_count，用于“全部”时每条薄弱知识点显示所属课程
        kp_course_counts: dict[tuple[int, int], int] = {}
        for q in questions:
            q_wrong = int(wrong_count_by_qid.get(int(q.id), 0))
            if q_wrong <= 0:
                continue
            cid = int(q.course_id) if q.course_id is not None else -1
            if q.knowledge_point_ids:
                for x in str(q.knowledge_point_ids).split(","):
                    x = x.strip()
                    if x.isdigit():
                        kp_id = int(x)
                        if cid >= 0:
                            key = (kp_id, cid)
                            kp_course_counts[key] = kp_course_counts.get(key, 0) + q_wrong
        # 按 kp_id 汇总总错题数，再按总错题数排序取 top5；每条取贡献最大的 course_id
        kp_total: dict[int, int] = {}
        for (kid, cid), cnt in kp_course_counts.items():
            kp_total[kid] = kp_total.get(kid, 0) + cnt
        if kp_total:
            kp_stmt = select(KnowledgePoint.id, KnowledgePoint.title).where(KnowledgePoint.id.in_(kp_total.keys()))
            if scoped_chapter_ids is not None:
                kp_stmt = kp_stmt.where(KnowledgePoint.chapter_id.in_(scoped_chapter_ids))
            elif scoped_course_ids is not None:
                kp_stmt = kp_stmt.join(Chapter, Chapter.id == KnowledgePoint.chapter_id).where(Chapter.course_id.in_(scoped_course_ids))
            r_kp = await db.execute(kp_stmt)
            kp_title_map = {int(row[0]): row[1] for row in r_kp.all() if row[1]}
            ranked = sorted(
                [(kid, kp_title_map[kid], kp_total[kid]) for kid in kp_total if kid in kp_title_map],
                key=lambda x: (-x[2], x[1]),
            )
            for kid, title, wrong_cnt in ranked[:5]:
                weak_titles.append(title)
                weak_wrong_counts.append(wrong_cnt)
                best_cid: int | None = None
                best_count = 0
                for (k, c), cnt in kp_course_counts.items():
                    if k == kid and cnt > best_count:
                        best_count = cnt
                        best_cid = c
                weak_course_ids.append(best_cid)
    if not weak_titles and ans_total:
        weak_titles = []
        weak_course_ids = []
        weak_wrong_counts = []

    return StatsOverviewOut(
        preview_completion_rate=round(preview_rate, 1),
        preview_student_count=int(preview_student_count),
        completed_question_count=int(completed_question_count),
        feedback_question_count=int(feedback_question_count),
        top_asked=top_asked,
        answer_accuracy_rate=round(accuracy, 1),
        ai_ask_count=int(ai_ask_count),
        ai_irrelevant_count=int(ai_irrelevant_count),
        weak_knowledge_points=weak_titles,
        weak_knowledge_point_course_ids=weak_course_ids,
        weak_knowledge_point_wrong_counts=weak_wrong_counts,
    )


@router.get("/stats/by-course-student", response_model=list[StatsByCourseStudentRowOut])
async def stats_by_course_student(
    course_id: int | None = Query(None),
    class_id: int | None = Query(None),
    student_id: int | None = Query(None),
    start_date: str | None = Query(None, description="统计周期起日 YYYY-MM-DD"),
    end_date: str | None = Query(None, description="统计周期止日 YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """学情课程统计详细表：按「课程+学生」维度返回真实统计。班级名称来自教师管理且关联该课程、该学生为其成员的班级（与 /teacher/classes 一致）。可选 start_date/end_date 按时间区间过滤。"""
    if class_id is not None and _is_teacher_scoped(user):
        await _require_owned_class(db, user.id, class_id)
    teacher_course_ids = await _teacher_course_ids(db, user.id) if _is_teacher_scoped(user) else set()
    scoped_course_ids: set[int] = set()
    if course_id is not None:
        if _is_teacher_scoped(user) and course_id not in teacher_course_ids:
            raise HTTPException(status_code=404, detail="课程不存在或无权限")
        scoped_course_ids = {course_id}
    else:
        scoped_course_ids = teacher_course_ids or set()
    if not scoped_course_ids:
        return []

    # (course_id, student_id) -> (class_name, course_name, student_no, student_name)，仅包含学生角色
    q_pairs = (
        select(
            Class.course_id,
            StudentClassMembership.student_id,
            Class.name.label("class_name"),
        )
        .select_from(Class)
        .join(StudentClassMembership, StudentClassMembership.class_id == Class.id)
        .join(User, User.id == StudentClassMembership.student_id)
        .where(Class.course_id.in_(scoped_course_ids), User.role == UserRole.student.value)
    )
    if _is_teacher_scoped(user):
        q_pairs = q_pairs.where(Class.owner_teacher_id == user.id)
    if class_id is not None:
        q_pairs = q_pairs.where(Class.id == class_id)
    if student_id is not None:
        q_pairs = q_pairs.where(StudentClassMembership.student_id == student_id)
    r_pairs = await db.execute(q_pairs)
    rows_pairs = r_pairs.all()
    if not rows_pairs:
        return []

    # 每个 (course_id, student_id) 只保留一个班级名（取第一个）
    pair_to_class: dict[tuple[int, int], str] = {}
    for r in rows_pairs:
        key = (int(r.course_id), int(r.student_id))
        if key not in pair_to_class:
            pair_to_class[key] = r.class_name or "—"

    return await _compute_stats_by_course_student(db, pair_to_class, start_date=start_date, end_date=end_date)


async def _compute_stats_by_course_student(
    db: AsyncSession,
    pair_to_class: dict[tuple[int, int], str],
    start_date: str | None = None,
    end_date: str | None = None,
) -> list["StatsByCourseStudentRowOut"]:
    """按 (course_id, student_id) 对计算学情统计，供教师端与学生端复用。可选 start_date/end_date（YYYY-MM-DD）按时间区间过滤。"""
    if not pair_to_class:
        return []
    time_filter = False
    start_dt = None
    end_dt = None
    if start_date and end_date:
        try:
            start_dt = datetime.strptime(start_date, "%Y-%m-%d")
            end_dt = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)  # 左闭右开
            time_filter = True
        except ValueError:
            pass

    course_ids = list({k[0] for k in pair_to_class})
    student_ids = list({k[1] for k in pair_to_class})
    r_courses = await db.execute(select(Course.id, Course.name).where(Course.id.in_(course_ids)))
    course_map = {row[0]: row[1] for row in r_courses.all()}
    r_users = await db.execute(
        select(User.id, User.student_no, User.display_name, User.username).where(User.id.in_(student_ids))
    )
    user_map = {row[0]: (row[1], row[2], row[3]) for row in r_users.all()}

    # 课程 -> 章节 id 列表（用于预习、习题范围）
    r_ch = await db.execute(select(Chapter.id, Chapter.course_id).where(Chapter.course_id.in_(course_ids)))
    chapters_by_course: dict[int, list[int]] = {}
    for row in r_ch.all():
        cid = int(row[1]) if row[1] is not None else 0
        if cid not in chapters_by_course:
            chapters_by_course[cid] = []
        chapters_by_course[cid].append(int(row[0]))
    for cid in course_ids:
        if cid not in chapters_by_course:
            chapters_by_course[cid] = []

    # 预习完成率：按 (course_id, user_id) 统计该课程下章节的 completed 比例
    preview_done: dict[tuple[int, int], int] = {}
    for cid, ch_ids in chapters_by_course.items():
        if not ch_ids:
            continue
        q_preview = (
            select(PreviewRecord.user_id, func.count(func.distinct(PreviewRecord.chapter_id)))
            .where(
                PreviewRecord.completed == True,
                PreviewRecord.chapter_id.in_(ch_ids),
                PreviewRecord.user_id.in_(student_ids),
            )
        )
        if time_filter and start_dt is not None and end_dt is not None:
            q_preview = q_preview.where(
                PreviewRecord.created_at >= start_dt,
                PreviewRecord.created_at < end_dt,
            )
        q_preview = q_preview.group_by(PreviewRecord.user_id)
        r_preview = await db.execute(q_preview)
        for row in r_preview.all():
            key = (cid, int(row[0]))
            if key in pair_to_class:
                preview_done[key] = int(row[1] or 0)
    total_chapters_per_course = {cid: len(ch_ids) for cid, ch_ids in chapters_by_course.items()}

    # 该学生在该课程下已完成预习的章节 id 列表（学情章节表按「本章是否完成」显示 100% 或 0%）
    preview_completed_chapter_ids_by_pair: dict[tuple[int, int], list[int]] = {}
    q_preview_chapters = (
        select(Chapter.course_id, PreviewRecord.user_id, PreviewRecord.chapter_id)
        .select_from(PreviewRecord)
        .join(Chapter, Chapter.id == PreviewRecord.chapter_id)
        .where(
            PreviewRecord.completed == True,
            PreviewRecord.user_id.in_(student_ids),
            Chapter.course_id.in_(course_ids),
        )
    )
    if time_filter and start_dt is not None and end_dt is not None:
        q_preview_chapters = q_preview_chapters.where(
            PreviewRecord.created_at >= start_dt,
            PreviewRecord.created_at < end_dt,
        )
    r_preview_ch = await db.execute(q_preview_chapters)
    for row in r_preview_ch.all():
        cid, uid, ch_id = int(row[0]), int(row[1]), int(row[2])
        if (cid, uid) not in pair_to_class:
            continue
        key = (cid, uid)
        if key not in preview_completed_chapter_ids_by_pair:
            preview_completed_chapter_ids_by_pair[key] = []
        preview_completed_chapter_ids_by_pair[key].append(ch_id)

    # 作答数、正确数：(course_id, user_id)
    q_ans = (
        select(
            Question.course_id,
            AnswerRecord.user_id,
            func.count(AnswerRecord.id).label("total"),
            func.count(AnswerRecord.id).filter(AnswerRecord.is_correct == True).label("ok"),
        )
        .select_from(AnswerRecord)
        .join(Question, Question.id == AnswerRecord.question_id)
        .where(Question.course_id.in_(course_ids), AnswerRecord.user_id.in_(student_ids))
    )
    if time_filter and start_dt is not None and end_dt is not None:
        q_ans = q_ans.where(
            AnswerRecord.created_at >= start_dt,
            AnswerRecord.created_at < end_dt,
        )
    q_ans = q_ans.group_by(Question.course_id, AnswerRecord.user_id)
    r_ans = await db.execute(q_ans)
    ans_stats: dict[tuple[int, int], tuple[int, int]] = {}
    for row in r_ans.all():
        key = (int(row[0]), int(row[1]))
        ans_stats[key] = (int(row[2] or 0), int(row[3] or 0))

    # 按 (course_id, chapter_id, user_id) 的完成习题数，供学情章节表每行显示真实 per-student per-chapter 数量
    q_ans_by_ch = (
        select(
            Question.course_id,
            Question.chapter_id,
            AnswerRecord.user_id,
            func.count(AnswerRecord.id).label("cnt"),
        )
        .select_from(AnswerRecord)
        .join(Question, Question.id == AnswerRecord.question_id)
        .where(Question.course_id.in_(course_ids), AnswerRecord.user_id.in_(student_ids))
    )
    if time_filter and start_dt is not None and end_dt is not None:
        q_ans_by_ch = q_ans_by_ch.where(
            AnswerRecord.created_at >= start_dt,
            AnswerRecord.created_at < end_dt,
        )
    q_ans_by_ch = q_ans_by_ch.group_by(Question.course_id, Question.chapter_id, AnswerRecord.user_id)
    r_ans_ch = await db.execute(q_ans_by_ch)
    ans_by_ch: dict[tuple[int, int, int], int] = {}
    for row in r_ans_ch.all():
        key = (int(row[0]), int(row[1]), int(row[2]))
        ans_by_ch[key] = int(row[3] or 0)

    # 按 (course_id, chapter_id, user_id) 的正确习题数，供学情章节表显示每章正确率
    q_ans_ok_by_ch = (
        select(
            Question.course_id,
            Question.chapter_id,
            AnswerRecord.user_id,
            func.count(AnswerRecord.id).label("cnt"),
        )
        .select_from(AnswerRecord)
        .join(Question, Question.id == AnswerRecord.question_id)
        .where(
            Question.course_id.in_(course_ids),
            AnswerRecord.user_id.in_(student_ids),
            AnswerRecord.is_correct == True,
        )
    )
    if time_filter and start_dt is not None and end_dt is not None:
        q_ans_ok_by_ch = q_ans_ok_by_ch.where(
            AnswerRecord.created_at >= start_dt,
            AnswerRecord.created_at < end_dt,
        )
    q_ans_ok_by_ch = q_ans_ok_by_ch.group_by(Question.course_id, Question.chapter_id, AnswerRecord.user_id)
    r_ans_ok_ch = await db.execute(q_ans_ok_by_ch)
    ans_ok_by_ch: dict[tuple[int, int, int], int] = {}
    for row in r_ans_ok_ch.all():
        key = (int(row[0]), int(row[1]), int(row[2]))
        ans_ok_by_ch[key] = int(row[3] or 0)

    # 反馈数
    q_fb = (
        select(StudentFeedback.course_id, StudentFeedback.user_id, func.count(StudentFeedback.id))
        .where(StudentFeedback.course_id.in_(course_ids), StudentFeedback.user_id.in_(student_ids))
    )
    if time_filter and start_dt is not None and end_dt is not None:
        q_fb = q_fb.where(
            StudentFeedback.created_at >= start_dt,
            StudentFeedback.created_at < end_dt,
        )
    q_fb = q_fb.group_by(StudentFeedback.course_id, StudentFeedback.user_id)
    r_fb = await db.execute(q_fb)
    feedback_count: dict[tuple[int, int], int] = {(int(row[0]), int(row[1])): int(row[2]) for row in r_fb.all()}

    # AI 提问数、无关数（无关：仅根据 course_irrelevant 标记位）
    _irr_predicate = QuestionAsked.course_irrelevant == True
    q_qa = (
        select(
            QuestionAsked.course_id,
            QuestionAsked.user_id,
            func.count(QuestionAsked.id).label("ask_count"),
            func.count(QuestionAsked.id).filter(_irr_predicate).label("irr_count"),
        )
        .where(QuestionAsked.course_id.in_(course_ids), QuestionAsked.user_id.in_(student_ids))
    )
    if time_filter and start_dt is not None and end_dt is not None:
        q_qa = q_qa.where(
            QuestionAsked.created_at >= start_dt,
            QuestionAsked.created_at < end_dt,
        )
    q_qa = q_qa.group_by(QuestionAsked.course_id, QuestionAsked.user_id)
    r_qa = await db.execute(q_qa)
    qa_stats: dict[tuple[int, int], tuple[int, int]] = {}
    for row in r_qa.all():
        key = (int(row[0]), int(row[1]))
        qa_stats[key] = (int(row[2] or 0), int(row[3] or 0))

    # 薄弱知识点：按 (course_id, user_id) 取错题关联知识点 Top5，学情课程表用
    weak_by_pair: dict[tuple[int, int], list[str]] = {}
    # 按 (course_id, chapter_id, user_id) 取错题关联知识点 Top5，学情章节表用
    weak_by_course_chapter_student: dict[tuple[int, int, int], list[str]] = {}
    wrong_q = (
        select(AnswerRecord.question_id, AnswerRecord.user_id, func.count(AnswerRecord.id).label("wrong_count"))
        .where(AnswerRecord.is_correct == False, AnswerRecord.user_id.in_(student_ids))
    )
    if time_filter and start_dt is not None and end_dt is not None:
        wrong_q = wrong_q.where(
            AnswerRecord.created_at >= start_dt,
            AnswerRecord.created_at < end_dt,
        )
    wrong_q = wrong_q.group_by(AnswerRecord.question_id, AnswerRecord.user_id)
    r_wrong = await db.execute(wrong_q)
    wrong_rows = [(int(row[0]), int(row[1]), int(row[2] or 0)) for row in r_wrong.all()]
    if wrong_rows:
        qids = list({r[0] for r in wrong_rows})
        r_q = await db.execute(
            select(Question.id, Question.course_id, Question.chapter_id, Question.knowledge_point_ids).where(Question.id.in_(qids))
        )
        q_course_chapter_kp: dict[int, tuple[int, int, str]] = {}
        for qrow in r_q.all():
            q_course_chapter_kp[int(qrow[0])] = (
                int(qrow[1]) if qrow[1] else 0,
                int(qrow[2]) if qrow[2] else 0,
                (qrow[3] or "").strip(),
            )
        kp_ids_set: set[int] = set()
        for qid, uid, wcnt in wrong_rows:
            cinfo = q_course_chapter_kp.get(qid)
            if not cinfo:
                continue
            cid, ch_id, kp_ids_str = cinfo
            if (cid, uid) not in pair_to_class:
                continue
            for x in kp_ids_str.split(",") if kp_ids_str else []:
                x = x.strip()
                if x.isdigit():
                    kp_ids_set.add(int(x))
        if kp_ids_set:
            r_kp = await db.execute(select(KnowledgePoint.id, KnowledgePoint.title).where(KnowledgePoint.id.in_(kp_ids_set)))
            kp_title = {int(row[0]): (row[1] or "").strip() for row in r_kp.all()}
            kp_wrong_by_pair: dict[tuple[int, int], dict[int, int]] = {}
            kp_wrong_by_triple: dict[tuple[int, int, int], dict[int, int]] = {}
            for qid, uid, wcnt in wrong_rows:
                cinfo = q_course_chapter_kp.get(qid)
                if not cinfo:
                    continue
                cid, ch_id, kp_ids_str = cinfo
                if (cid, uid) not in pair_to_class:
                    continue
                key2 = (cid, uid)
                if key2 not in kp_wrong_by_pair:
                    kp_wrong_by_pair[key2] = {}
                key3 = (cid, ch_id, uid)
                if key3 not in kp_wrong_by_triple:
                    kp_wrong_by_triple[key3] = {}
                for x in kp_ids_str.split(",") if kp_ids_str else []:
                    x = x.strip()
                    if x.isdigit():
                        kid = int(x)
                        kp_wrong_by_pair[key2][kid] = kp_wrong_by_pair[key2].get(kid, 0) + wcnt
                        kp_wrong_by_triple[key3][kid] = kp_wrong_by_triple[key3].get(kid, 0) + wcnt
            for key, kp_counts in kp_wrong_by_pair.items():
                ranked = sorted(kp_counts.items(), key=lambda t: -t[1])[:5]
                weak_by_pair[key] = [kp_title.get(kid, "") or f"知识点{kid}" for kid, _ in ranked if kp_title.get(kid)]
            for key, kp_counts in kp_wrong_by_triple.items():
                ranked = sorted(kp_counts.items(), key=lambda t: -t[1])[:5]
                weak_by_course_chapter_student[key] = [kp_title.get(kid, "") or f"知识点{kid}" for kid, _ in ranked if kp_title.get(kid)]

    out: list[StatsByCourseStudentRowOut] = []
    for (cid, uid) in sorted(pair_to_class.keys()):
        class_name = pair_to_class[(cid, uid)]
        course_name = course_map.get(cid, "—")
        u = user_map.get(uid)
        student_no = "—"
        student_name = "—"
        if u:
            student_no = (u[0] or u[2] or "—").strip() or "—"
            student_name = (u[1] or u[2] or "—").strip() or "—"

        total_ch = total_chapters_per_course.get(cid, 0)
        done_ch = preview_done.get((cid, uid), 0)
        preview_rate = f"{(done_ch / total_ch * 100):.1f}%" if total_ch else "—"

        total_a, ok_a = ans_stats.get((cid, uid), (0, 0))
        accuracy_rate = f"{(ok_a / total_a * 100):.1f}%" if total_a else "—"

        fb_count = feedback_count.get((cid, uid), 0)
        ask_count, irr_count = qa_stats.get((cid, uid), (0, 0))
        weak_list = weak_by_pair.get((cid, uid), []) if total_a > 0 else []
        weak_str = "; ".join(weak_list) if weak_list else "—"
        completed_ch_ids = preview_completed_chapter_ids_by_pair.get((cid, uid), [])
        count_by_ch = [
            {"chapter_id": ch_id, "count": cnt}
            for (c, ch_id, u), cnt in ans_by_ch.items()
            if (c, u) == (cid, uid)
        ]
        correct_count_by_ch = [
            {"chapter_id": ch_id, "count": cnt}
            for (c, ch_id, u), cnt in ans_ok_by_ch.items()
            if (c, u) == (cid, uid)
        ]
        weak_by_chapter = [
            {"chapter_id": ch_id, "weak_knowledge_points": "; ".join(titles) if titles else "—"}
            for (c, ch_id, u), titles in weak_by_course_chapter_student.items()
            if (c, u) == (cid, uid)
        ]

        out.append(
            StatsByCourseStudentRowOut(
                course_id=cid,
                course_name=course_name,
                student_id=uid,
                student_no=student_no,
                student_name=student_name,
                class_name=class_name,
                preview_rate=preview_rate,
                preview_completed_chapter_ids=completed_ch_ids,
                completed_question_count=total_a,
                completed_question_count_by_chapter=count_by_ch,
                correct_question_count_by_chapter=correct_count_by_ch,
                accuracy_rate=accuracy_rate,
                feedback_question_count=fb_count,
                ai_ask_count=ask_count,
                ai_irrelevant_count=irr_count,
                weak_knowledge_points=weak_str,
                weak_knowledge_points_by_chapter=weak_by_chapter,
            )
        )
    return out


class FeedbackListRowOut(BaseModel):
    """学情页「问题反馈列表」一行"""
    id: int
    course_name: str
    feedback_text: str
    student_no: str
    student_name: str
    class_name: str
    created_at: str  # 反馈时间 ISO
    reply_text: str = "—"
    status: str = "待处理"
    processed_at: str | None = None  # 处理回复时间 ISO，可选


@router.get("/feedback/list", response_model=list[FeedbackListRowOut])
async def list_feedback(
    course_id: int | None = Query(None),
    class_id: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """学情页「问题反馈列表」：按课程/班级筛选，仅返回教师有权限的课程下的反馈。班级列与学情课程统计一致：按「该反馈的课程 + 提交学生」从教师管理且关联该课程的班级中解析。"""
    if class_id is not None and _is_teacher_scoped(user):
        await _require_owned_class(db, user.id, class_id)
    user_ids = await _user_ids_by_class(db, class_id)
    teacher_course_ids = await _teacher_course_ids(db, user.id) if _is_teacher_scoped(user) else set()
    if _is_teacher_scoped(user) and course_id is not None and course_id not in teacher_course_ids:
        raise HTTPException(status_code=404, detail="课程不存在或无权限")
    scoped_course_ids: set[int] | None = {course_id} if course_id is not None else (teacher_course_ids if _is_teacher_scoped(user) else None)
    q = (
        select(
            StudentFeedback.id,
            StudentFeedback.course_id,
            StudentFeedback.user_id,
            Course.name.label("course_name"),
            StudentFeedback.content.label("feedback_text"),
            User.student_no,
            User.display_name,
            User.username,
            StudentFeedback.created_at,
            StudentFeedback.reply_text,
            StudentFeedback.status,
            StudentFeedback.processed_at,
        )
        .select_from(StudentFeedback)
        .outerjoin(Course, Course.id == StudentFeedback.course_id)
        .outerjoin(User, User.id == StudentFeedback.user_id)
        .order_by(StudentFeedback.created_at.desc())
    )
    if scoped_course_ids is not None:
        if not scoped_course_ids:
            return []
        q = q.where(StudentFeedback.course_id.in_(scoped_course_ids))
    if user_ids is not None:
        q = q.where(StudentFeedback.user_id.in_(user_ids))
    r = await db.execute(q.limit(500))
    rows = r.all()

    # 班级名称与学情课程统计一致：按 (course_id, user_id) 从教师管理且关联该课程的班级解析，不再用 User.class_id
    pair_to_class: dict[tuple[int, int], str] = {}
    if rows and scoped_course_ids:
        feedback_course_ids = list({int(row.course_id) for row in rows if row.course_id is not None})
        feedback_user_ids = list({int(row.user_id) for row in rows if row.user_id is not None})
        if feedback_course_ids and feedback_user_ids:
            q_pairs = (
                select(
                    Class.course_id,
                    StudentClassMembership.student_id,
                    Class.name.label("class_name"),
                )
                .select_from(Class)
                .join(StudentClassMembership, StudentClassMembership.class_id == Class.id)
                .where(Class.course_id.in_(feedback_course_ids), StudentClassMembership.student_id.in_(feedback_user_ids))
            )
            if _is_teacher_scoped(user):
                q_pairs = q_pairs.where(Class.owner_teacher_id == user.id)
            r_pairs = await db.execute(q_pairs)
            for rp in r_pairs.all():
                key = (int(rp.course_id), int(rp.student_id))
                if key not in pair_to_class:
                    pair_to_class[key] = rp.class_name or "—"

    out = []
    for row in rows:
        cid = int(row.course_id) if row.course_id is not None else None
        uid = int(row.user_id) if row.user_id is not None else None
        class_name = pair_to_class.get((cid, uid), "—") if (cid is not None and uid is not None) else "—"
        out.append(
            FeedbackListRowOut(
                id=row.id,
                course_name=row.course_name or "—",
                feedback_text=row.feedback_text or "",
                student_no=row.student_no or "—",
                student_name=(row.display_name or row.username) or "—",
                class_name=class_name,
                created_at=row.created_at.isoformat() if row.created_at else "",
                reply_text=row.reply_text if row.reply_text is not None else "—",
                status=row.status if row.status is not None else "待处理",
                processed_at=row.processed_at.isoformat() if row.processed_at else None,
            )
        )
    return out


class FeedbackDetailOut(BaseModel):
    """单条反馈详情（查看/编辑用）"""
    id: int
    course_name: str
    feedback_text: str
    student_no: str
    student_name: str
    class_name: str
    created_at: str
    reply_text: str | None
    status: str | None
    processed_at: str | None


async def _feedback_class_name_for_pair(
    db: AsyncSession, course_id: int | None, user_id: int | None, teacher_id: int | None, is_teacher_scoped: bool
) -> str:
    """按 (course_id, user_id) 从教师管理且关联该课程的班级解析班级名，与学情课程统计一致。"""
    if course_id is None or user_id is None:
        return "—"
    q_pairs = (
        select(Class.name)
        .select_from(Class)
        .join(StudentClassMembership, StudentClassMembership.class_id == Class.id)
        .where(Class.course_id == course_id, StudentClassMembership.student_id == user_id)
    )
    if is_teacher_scoped and teacher_id is not None:
        q_pairs = q_pairs.where(Class.owner_teacher_id == teacher_id)
    r_pairs = await db.execute(q_pairs.limit(1))
    row = r_pairs.first()
    return (row[0] or "—") if row else "—"


@router.get("/feedback/{feedback_id}", response_model=FeedbackDetailOut)
async def get_feedback(
    feedback_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """获取单条反馈详情（教师有权限的课程下的反馈）。班级名与问题反馈列表一致。"""
    teacher_course_ids = await _teacher_course_ids(db, user.id) if _is_teacher_scoped(user) else None
    q = (
        select(
            StudentFeedback.id,
            Course.name.label("course_name"),
            StudentFeedback.content.label("feedback_text"),
            User.student_no,
            User.display_name,
            User.username,
            StudentFeedback.created_at,
            StudentFeedback.reply_text,
            StudentFeedback.status,
            StudentFeedback.processed_at,
            StudentFeedback.course_id,
            StudentFeedback.user_id,
        )
        .select_from(StudentFeedback)
        .outerjoin(Course, Course.id == StudentFeedback.course_id)
        .outerjoin(User, User.id == StudentFeedback.user_id)
        .where(StudentFeedback.id == feedback_id)
    )
    r = await db.execute(q)
    row = r.one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="反馈不存在")
    if teacher_course_ids is not None and (row.course_id is None or row.course_id not in teacher_course_ids):
        raise HTTPException(status_code=404, detail="无权限查看该反馈")
    class_name = await _feedback_class_name_for_pair(
        db, row.course_id, row.user_id, user.id if _is_teacher_scoped(user) else None, _is_teacher_scoped(user)
    )
    return FeedbackDetailOut(
        id=row.id,
        course_name=row.course_name or "—",
        feedback_text=row.feedback_text or "",
        student_no=row.student_no or "—",
        student_name=(row.display_name or row.username) or "—",
        class_name=class_name,
        created_at=row.created_at.isoformat() if row.created_at else "",
        reply_text=row.reply_text,
        status=row.status,
        processed_at=row.processed_at.isoformat() if row.processed_at else None,
    )


class FeedbackUpdateIn(BaseModel):
    reply_text: str | None = None
    status: str | None = None  # 待处理 | 处理中 | 已处理


@router.put("/feedback/{feedback_id}", response_model=FeedbackDetailOut)
async def update_feedback(
    feedback_id: int,
    body: FeedbackUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """更新反馈的回复与状态；状态变化时更新 processed_at"""
    teacher_course_ids = await _teacher_course_ids(db, user.id) if _is_teacher_scoped(user) else None
    r = await db.execute(
        select(StudentFeedback).where(StudentFeedback.id == feedback_id)
    )
    fb = r.scalar_one_or_none()
    if not fb:
        raise HTTPException(status_code=404, detail="反馈不存在")
    if teacher_course_ids is not None and (fb.course_id is None or fb.course_id not in teacher_course_ids):
        raise HTTPException(status_code=404, detail="无权限编辑该反馈")
    old_status = fb.status
    if body.reply_text is not None:
        fb.reply_text = body.reply_text
    if body.status is not None:
        fb.status = body.status
        if body.status != old_status:
            fb.processed_at = datetime.utcnow()
    await db.flush()
    # 返回最新详情（班级名与列表一致，按课程+学生从教师管理班级解析）
    r2 = await db.execute(
        select(
            StudentFeedback.id,
            Course.name.label("course_name"),
            StudentFeedback.content.label("feedback_text"),
            User.student_no,
            User.display_name,
            User.username,
            StudentFeedback.created_at,
            StudentFeedback.reply_text,
            StudentFeedback.status,
            StudentFeedback.processed_at,
            StudentFeedback.course_id,
            StudentFeedback.user_id,
        )
        .select_from(StudentFeedback)
        .outerjoin(Course, Course.id == StudentFeedback.course_id)
        .outerjoin(User, User.id == StudentFeedback.user_id)
        .where(StudentFeedback.id == feedback_id)
    )
    row = r2.one()
    if teacher_course_ids is not None and (row.course_id is None or row.course_id not in teacher_course_ids):
        raise HTTPException(status_code=404, detail="无权限")
    class_name = await _feedback_class_name_for_pair(
        db, row.course_id, row.user_id, user.id if _is_teacher_scoped(user) else None, _is_teacher_scoped(user)
    )
    return FeedbackDetailOut(
        id=row.id,
        course_name=row.course_name or "—",
        feedback_text=row.feedback_text or "",
        student_no=row.student_no or "—",
        student_name=(row.display_name or row.username) or "—",
        class_name=class_name,
        created_at=row.created_at.isoformat() if row.created_at else "",
        reply_text=row.reply_text,
        status=row.status,
        processed_at=row.processed_at.isoformat() if row.processed_at else None,
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
    if class_id is not None and _is_teacher_scoped(user):
        await _require_owned_class(db, user.id, class_id)
    user_ids = await _user_ids_by_class(db, class_id)
    teacher_course_ids = await _teacher_course_ids(db, user.id) if _is_teacher_scoped(user) else set()
    if _is_teacher_scoped(user) and course_id is not None and course_id not in teacher_course_ids:
        raise HTTPException(status_code=404, detail="课程不存在或无权限")

    scoped_course_ids: set[int] | None = None
    if course_id is not None:
        scoped_course_ids = {course_id}
    elif _is_teacher_scoped(user):
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
        if _is_teacher_scoped(user):
            # 提问记录导出固定按课程口径，不随章节筛选变化。
            qry = _apply_teacher_qa_scope(qry, scoped_course_ids, None)
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
        writer.writerow(["answer_accuracy_rate", st.answer_accuracy_rate])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue().encode("utf-8-sig")]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=teacher_export.csv"},
    )
