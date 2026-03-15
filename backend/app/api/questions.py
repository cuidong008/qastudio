"""习题：列表、作答、错题本"""
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..db.models import User, Question, AnswerRecord
from ..api.auth import get_current_user
from ..services.llm_grading_service import grade_qa_or_blank
from ..services.difficulty import score_range_for_difficulty

router = APIRouter(prefix="/questions", tags=["questions"])


class QuestionOut(BaseModel):
    id: int
    course_id: int | None
    chapter_id: int
    difficulty: str
    question_type: str | None
    question_text: str
    options: str | None
    explanation: str | None
    ppt_ref: str | None

    class Config:
        from_attributes = True


class SubmitAnswerIn(BaseModel):
    question_id: int
    user_answer: str
    scene: str = "exercise"


class SubmitAnswerOut(BaseModel):
    answer_record_id: int
    is_correct: bool
    correct_answer: str
    question_type: str
    explanation: str | None
    ppt_ref: str | None
    grading_source: str | None = None  # rule | llm
    grading_confidence: float | None = None
    grading_reason: str | None = None


class UpdateWrongReasonIn(BaseModel):
    wrong_reason: str


class SimilarQuestionOut(BaseModel):
    id: int
    chapter_id: int
    difficulty: str
    question_type: str | None
    question_text: str
    options: str | None
    explanation: str | None


def _normalize_multi_answer(value: str) -> str:
    parts = re.split(r"[,，、\s]+", (value or "").strip().upper())
    letters = sorted({p for p in parts if p in {"A", "B", "C", "D"}})
    return ",".join(letters)


@router.get("", response_model=list[QuestionOut])
async def list_questions(
    chapter_id: int | None = Query(None),
    difficulty: str | None = Query(None),
    question_types: str | None = Query(None, description="逗号分隔：single_choice,multiple_choice,judge,qa,blank,analysis"),
    limit: int = Query(20, le=50),
    db: AsyncSession = Depends(get_db),
):
    q = select(Question).where(
        Question.is_active == True,
        Question.is_approved == True,
        Question.question_bank_type == "training",
    )
    if chapter_id is not None:
        q = q.where(Question.chapter_id == chapter_id)
    if difficulty and difficulty.strip() in ("basic", "applied", "extended"):
        r = score_range_for_difficulty(difficulty.strip())
        if r:
            min_excl, max_incl = r
            q = q.where(and_(Question.difficulty_score > min_excl, Question.difficulty_score <= max_incl))
    if question_types:
        normalized_types = [t.strip() for t in question_types.split(",") if t.strip()]
        if normalized_types:
            q = q.where(Question.question_type.in_(normalized_types))
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
    scene = body.scene if body.scene in {"preview", "review", "exercise"} else "exercise"
    question_type = (question.question_type or "single_choice").strip().lower()
    grading_source = "rule"
    grading_confidence: float | None = None
    grading_reason: str | None = None
    if question_type == "multiple_choice":
        is_correct = _normalize_multi_answer(question.correct_answer) == _normalize_multi_answer(body.user_answer)
    else:
        is_correct = question.correct_answer.strip().lower() == body.user_answer.strip().lower()
    if question_type in {"qa", "blank", "analysis"}:
        graded = grade_qa_or_blank(
            question_type=question_type,
            question_text=question.question_text or "",
            standard_answer=question.correct_answer or "",
            user_answer=body.user_answer or "",
        )
        if graded is not None:
            is_correct = graded.is_correct
            grading_source = "llm"
            grading_confidence = graded.confidence
            grading_reason = graded.reason
    record = AnswerRecord(
        user_id=user.id,
        question_id=question.id,
        scene=scene,
        user_answer=body.user_answer,
        is_correct=is_correct,
    )
    db.add(record)
    await db.flush()
    await db.commit()
    return SubmitAnswerOut(
        answer_record_id=record.id,
        is_correct=is_correct,
        correct_answer=question.correct_answer,
        question_type=question_type,
        explanation=question.explanation,
        ppt_ref=question.ppt_ref,
        grading_source=grading_source,
        grading_confidence=grading_confidence,
        grading_reason=grading_reason,
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


@router.post("/answer-records/{record_id}/wrong-reason", response_model=dict)
async def update_wrong_reason(
    record_id: int,
    body: UpdateWrongReasonIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")
    if body.wrong_reason not in {"concept", "reading", "calculation"}:
        raise HTTPException(status_code=400, detail="错因类型不合法")
    result = await db.execute(select(AnswerRecord).where(AnswerRecord.id == record_id, AnswerRecord.user_id == user.id))
    record = result.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="作答记录不存在")
    if record.is_correct:
        raise HTTPException(status_code=400, detail="正确题目不需要标注错因")
    record.wrong_reason = body.wrong_reason
    await db.commit()
    return {"ok": True}


def _parse_kp_ids(value: str | None) -> set[str]:
    if not value:
        return set()
    return {x.strip() for x in value.split(",") if x.strip()}


@router.get("/{question_id}/similar", response_model=list[SimilarQuestionOut])
async def similar_questions(
    question_id: int,
    limit: int = Query(2, ge=1, le=5),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Question).where(Question.id == question_id))
    source = result.scalar_one_or_none()
    if not source:
        raise HTTPException(status_code=404, detail="题目不存在")
    source_kps = _parse_kp_ids(source.knowledge_point_ids)
    q = (
        select(Question)
        .where(
            Question.id != question_id,
            Question.chapter_id == source.chapter_id,
            Question.is_active == True,
            Question.is_approved == True,
            Question.question_type == source.question_type,
            Question.difficulty == source.difficulty,
        )
        .order_by(Question.id)
        .limit(20)
    )
    candidates = (await db.execute(q)).scalars().all()
    ranked = sorted(
        candidates,
        key=lambda item: len(source_kps.intersection(_parse_kp_ids(item.knowledge_point_ids))),
        reverse=True,
    )
    return [
        SimilarQuestionOut(
            id=item.id,
            chapter_id=item.chapter_id,
            difficulty=item.difficulty,
            question_type=item.question_type,
            question_text=item.question_text,
            options=item.options,
            explanation=item.explanation,
        )
        for item in ranked[:limit]
    ]
