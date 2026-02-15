"""学生反馈：产品内建反馈入口（问卷/表单）；对话模式收集的反馈也可写入此处"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..db.models import User, StudentFeedback, QuestionAsked
from ..api.auth import get_current_user

router = APIRouter(prefix="/feedback", tags=["feedback"])


class FeedbackIn(BaseModel):
    content: str
    source: str = "form"  # form | dialogue


class FeedbackFromQaIn(BaseModel):
    question_asked_id: int


@router.post("/from-qa", response_model=dict)
async def submit_feedback_from_qa(
    body: FeedbackFromQaIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """将某次课中/课后答疑对话记为学习反馈（仅允许提交本人提问记录）"""
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")
    r = await db.execute(
        select(QuestionAsked).where(QuestionAsked.id == body.question_asked_id)
    )
    qa_record = r.scalar_one_or_none()
    if not qa_record:
        raise HTTPException(status_code=404, detail="未找到该条答疑记录")
    if qa_record.user_id != user.id:
        raise HTTPException(status_code=403, detail="只能将本人的提问提交为反馈")
    content = f"Q: {qa_record.question_text}\nA: {qa_record.answer_text or '(无)'}"
    feedback = StudentFeedback(
        user_id=user.id,
        content=content,
        source="dialogue",
    )
    db.add(feedback)
    await db.flush()
    return {"ok": True, "id": feedback.id}


@router.post("", response_model=dict)
async def submit_feedback(
    body: FeedbackIn,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
):
    """提交反馈（表单入口或对话中收集）；学习数据策略：保存 6 个月，标识匿名化"""
    content = (body.content or "").strip()
    if not content:
        return {"ok": False, "message": "反馈内容不能为空"}
    source = body.source if body.source in ("form", "dialogue") else "form"
    feedback = StudentFeedback(
        user_id=user.id if user else None,
        content=content,
        source=source,
    )
    db.add(feedback)
    await db.flush()
    return {"ok": True, "id": feedback.id}
