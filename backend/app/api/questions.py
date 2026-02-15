"""习题：列表、作答、错题本"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..db.models import User, Question, AnswerRecord
from ..api.auth import get_current_user

router = APIRouter(prefix="/questions", tags=["questions"])


class QuestionOut(BaseModel):
    id: int
    chapter_id: int
    difficulty: str
    question_text: str
    options: str | None
    explanation: str | None
    ppt_ref: str | None

    class Config:
        from_attributes = True


class SubmitAnswerIn(BaseModel):
    question_id: int
    user_answer: str


class SubmitAnswerOut(BaseModel):
    is_correct: bool
    correct_answer: str
    explanation: str | None
    ppt_ref: str | None


@router.get("", response_model=list[QuestionOut])
async def list_questions(
    chapter_id: int | None = Query(None),
    difficulty: str | None = Query(None),
    limit: int = Query(20, le=50),
    db: AsyncSession = Depends(get_db),
):
    q = select(Question).where(Question.is_active == True, Question.is_approved == True)
    if chapter_id is not None:
        q = q.where(Question.chapter_id == chapter_id)
    if difficulty:
        q = q.where(Question.difficulty == difficulty)
    q = q.order_by(Question.id).limit(limit)
    result = await db.execute(q)
    items = result.scalars().all()
    return [QuestionOut.model_validate(x) for x in items]


@router.post("/submit", response_model=SubmitAnswerOut)
async def submit_answer(
    body: SubmitAnswerIn,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
):
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")
    result = await db.execute(select(Question).where(Question.id == body.question_id))
    question = result.scalar_one_or_none()
    if not question:
        raise HTTPException(status_code=404, detail="题目不存在")
    is_correct = question.correct_answer.strip().lower() == body.user_answer.strip().lower()
    record = AnswerRecord(
        user_id=user.id,
        question_id=question.id,
        user_answer=body.user_answer,
        is_correct=is_correct,
    )
    db.add(record)
    await db.commit()
    return SubmitAnswerOut(
        is_correct=is_correct,
        correct_answer=question.correct_answer,
        explanation=question.explanation,
        ppt_ref=question.ppt_ref,
    )


@router.get("/wrong", response_model=list[QuestionOut])
async def wrong_questions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")
    subq = select(AnswerRecord.question_id).where(
        AnswerRecord.user_id == user.id,
        AnswerRecord.is_correct == False,
    ).distinct()
    result = await db.execute(select(Question).where(Question.id.in_(subq), Question.is_active == True, Question.is_approved == True))
    items = result.scalars().all()
    return [QuestionOut.model_validate(x) for x in items]
