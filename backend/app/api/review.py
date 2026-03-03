"""课后复习：3分钟回忆卡 + 分层巩固练习"""
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from ..api.auth import get_current_user
from ..db import get_db
from ..db.models import Chapter, KnowledgePoint, Question, ReviewRecord, User
from ..services.difficulty import score_range_for_difficulty, difficulty_from_score
from ..services.llm_grading_service import grade_qa_or_blank

router = APIRouter(prefix="/review", tags=["review"])


class ReviewQuestionOut(BaseModel):
    id: int
    question_type: str | None
    difficulty: str
    question_text: str
    options: str | None


class ReviewTaskOut(BaseModel):
    chapter_id: int
    chapter_title: str
    key_points: list[str]
    recall_card_rule: str
    basic_questions: list[ReviewQuestionOut]
    variant_questions: list[ReviewQuestionOut]
    comprehensive_question: ReviewQuestionOut | None


class SubmitRecallIn(BaseModel):
    chapter_id: int
    recall_points: list[str]


class RecallItemResult(BaseModel):
    is_correct: bool | None  # None 表示未判（如 LLM 失败）
    reason: str | None


class SubmitRecallOut(BaseModel):
    ok: bool
    message: str
    reference_points: list[str]  # 参考答案（本章关键点）
    results: list[RecallItemResult]  # 每条的对错与理由


async def _get_chapter_key_points(chapter_id: int, db: AsyncSession) -> list[str]:
    """获取章节的 3 个关键点标题（与 get_review_task 一致），用于 LLM 判卷对比。"""
    kp_result = await db.execute(
        select(KnowledgePoint).where(KnowledgePoint.chapter_id == chapter_id).order_by(KnowledgePoint.order_index, KnowledgePoint.id)
    )
    key_points = [item.title for item in kp_result.scalars().all()][:3]
    while len(key_points) < 3:
        key_points.append(f"本章关键点 {len(key_points) + 1}")
    return key_points


async def _get_chapter_reference_display(chapter_id: int, db: AsyncSession) -> list[str]:
    """获取章节 3 个关键点的「参考答案」展示文案：仅用 content（详细说明），与页面上方关键点列表（title）区分；无 content 时提示参考上方。"""
    kp_result = await db.execute(
        select(KnowledgePoint).where(KnowledgePoint.chapter_id == chapter_id).order_by(KnowledgePoint.order_index, KnowledgePoint.id)
    )
    rows = list(kp_result.scalars().all())[:3]
    out: list[str] = []
    for item in rows:
        content = (item.content or "").strip()
        if content:
            out.append(content)
        else:
            out.append("（暂无详细说明，可参考上方关键点）")
    while len(out) < 3:
        out.append("（本章未配置该关键点详细说明）")
    return out


def _to_question_out(question: Question) -> ReviewQuestionOut:
    diff = difficulty_from_score(question.difficulty_score or 0.8)
    return ReviewQuestionOut(
        id=question.id,
        question_type=question.question_type,
        difficulty=diff,
        question_text=question.question_text,
        options=question.options,
    )


@router.get("/task/{chapter_id}", response_model=ReviewTaskOut)
async def get_review_task(chapter_id: int, db: AsyncSession = Depends(get_db)):
    ch_result = await db.execute(select(Chapter).where(Chapter.id == chapter_id))
    chapter = ch_result.scalar_one_or_none()
    if not chapter:
        raise HTTPException(status_code=404, detail="章节不存在")

    kp_result = await db.execute(
        select(KnowledgePoint).where(KnowledgePoint.chapter_id == chapter_id).order_by(KnowledgePoint.order_index, KnowledgePoint.id)
    )
    key_points = [item.title for item in kp_result.scalars().all()][:3]
    while len(key_points) < 3:
        key_points.append(f"本章关键点 {len(key_points) + 1}")

    basic_range = score_range_for_difficulty("basic") or (0.7, 1.0)
    applied_range = score_range_for_difficulty("applied") or (0.5, 0.7)
    extended_range = score_range_for_difficulty("extended") or (0.0, 0.5)
    basic_result = await db.execute(
        select(Question)
        .where(
            Question.chapter_id == chapter_id,
            Question.is_active == True,
            Question.is_approved == True,
            Question.question_bank_type == "training",
            and_(Question.difficulty_score > basic_range[0], Question.difficulty_score <= basic_range[1]),
        )
        .order_by(Question.id)
        .limit(4)
    )
    variant_result = await db.execute(
        select(Question)
        .where(
            Question.chapter_id == chapter_id,
            Question.is_active == True,
            Question.is_approved == True,
            Question.question_bank_type == "training",
            and_(Question.difficulty_score > applied_range[0], Question.difficulty_score <= applied_range[1]),
        )
        .order_by(Question.id)
        .limit(3)
    )
    comprehensive_result = await db.execute(
        select(Question)
        .where(
            Question.chapter_id == chapter_id,
            Question.is_active == True,
            Question.is_approved == True,
            Question.question_bank_type == "training",
            and_(Question.difficulty_score > extended_range[0], Question.difficulty_score <= extended_range[1]),
        )
        .order_by(Question.id)
        .limit(1)
    )
    basic_questions = [_to_question_out(q) for q in basic_result.scalars().all()]
    variant_questions = [_to_question_out(q) for q in variant_result.scalars().all()]
    comprehensive_question = comprehensive_result.scalar_one_or_none()
    if not comprehensive_question:
        fallback = await db.execute(
            select(Question)
            .where(
                Question.chapter_id == chapter_id,
                Question.is_active == True,
                Question.is_approved == True,
                Question.question_bank_type == "training",
                or_(
                    and_(Question.difficulty_score > applied_range[0], Question.difficulty_score <= applied_range[1]),
                    and_(Question.difficulty_score > basic_range[0], Question.difficulty_score <= basic_range[1]),
                ),
            )
            .order_by(Question.id.desc())
            .limit(1)
        )
        comprehensive_question = fallback.scalar_one_or_none()

    return ReviewTaskOut(
        chapter_id=chapter.id,
        chapter_title=chapter.title,
        key_points=key_points,
        recall_card_rule="请用 3 分钟写出本节 3 个关键点，每条不超过 30 字。",
        basic_questions=basic_questions,
        variant_questions=variant_questions,
        comprehensive_question=_to_question_out(comprehensive_question) if comprehensive_question else None,
    )


@router.post("/recall", response_model=SubmitRecallOut)
async def submit_recall_card(
    body: SubmitRecallIn,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
):
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")
    chapter_result = await db.execute(select(Chapter).where(Chapter.id == body.chapter_id))
    if not chapter_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="章节不存在")
    cleaned = [item.strip() for item in body.recall_points if item and item.strip()]
    if len(cleaned) != 3:
        raise HTTPException(status_code=400, detail="回忆卡必须填写 3 个关键点")

    key_points_for_grade = await _get_chapter_key_points(body.chapter_id, db)
    reference_points = await _get_chapter_reference_display(body.chapter_id, db)
    results: list[RecallItemResult] = []
    for i in range(3):
        std = key_points_for_grade[i] if i < len(key_points_for_grade) else ""
        usr = cleaned[i] if i < len(cleaned) else ""
        gr = grade_qa_or_blank(
            question_type="qa",
            question_text="本节关键点",
            standard_answer=std,
            user_answer=usr,
        )
        if gr is not None:
            results.append(RecallItemResult(is_correct=gr.is_correct, reason=gr.reason))
        else:
            results.append(RecallItemResult(is_correct=None, reason=None))

    record = ReviewRecord(
        user_id=user.id,
        chapter_id=body.chapter_id,
        recall_points=json.dumps(cleaned, ensure_ascii=False),
    )
    db.add(record)
    await db.commit()
    return SubmitRecallOut(
        ok=True,
        message="回忆卡已提交",
        reference_points=reference_points,
        results=results,
    )
