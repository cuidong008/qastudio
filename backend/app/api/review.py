"""课后复习：3分钟回忆卡 + 分层巩固练习"""
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..api.auth import get_current_user
from ..db import get_db
from ..db.models import Chapter, KnowledgePoint, Question, ReviewRecord, User

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


def _to_question_out(question: Question) -> ReviewQuestionOut:
    return ReviewQuestionOut(
        id=question.id,
        question_type=question.question_type,
        difficulty=question.difficulty,
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

    basic_result = await db.execute(
        select(Question)
        .where(
            Question.chapter_id == chapter_id,
            Question.is_active == True,
            Question.is_approved == True,
            Question.difficulty == "basic",
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
            Question.difficulty == "applied",
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
            Question.difficulty == "extended",
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
                Question.difficulty.in_(["applied", "basic"]),
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


@router.post("/recall", response_model=dict)
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
    record = ReviewRecord(
        user_id=user.id,
        chapter_id=body.chapter_id,
        recall_points=json.dumps(cleaned, ensure_ascii=False),
    )
    db.add(record)
    await db.commit()
    return {"ok": True, "message": "回忆卡已提交"}
