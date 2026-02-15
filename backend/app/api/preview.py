"""课前预习：任务获取、完成提交、薄弱点反馈"""
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..db.models import User, Chapter, KnowledgePoint, PreviewRecord
from ..api.auth import get_current_user

router = APIRouter(prefix="/preview", tags=["preview"])


class PreviewTaskOut(BaseModel):
    chapter_id: int
    chapter_title: str
    summary: str
    key_points: list[str]
    self_check_questions: list[str]
    duration_minutes: int = 15


class SubmitPreviewIn(BaseModel):
    chapter_id: int
    weak_points: list[str] | None = None


@router.get("/task/{chapter_id}", response_model=PreviewTaskOut)
async def get_preview_task(chapter_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Chapter).where(Chapter.id == chapter_id))
    chapter = result.scalar_one_or_none()
    if not chapter:
        raise HTTPException(status_code=404, detail="章节不存在")
    pts_result = await db.execute(
        select(KnowledgePoint).where(KnowledgePoint.chapter_id == chapter_id).order_by(KnowledgePoint.order_index)
    )
    points = pts_result.scalars().all()
    key_points = [p.title for p in points] if points else ["核心概念概览", "与电商场景的关联"]
    self_check = [
        "简述本章与电商网络的关系。",
        "列出 2 个关键术语。",
    ]
    if points:
        self_check = [f"请简述：{points[0].title}。" if points else "请简述本章要点。"] + self_check[:1]
    return PreviewTaskOut(
        chapter_id=chapter.id,
        chapter_title=chapter.title,
        summary=f"本章节核心内容概览，请结合教材与PPT预习。{(' 重点包括：' + '、'.join(key_points[:3])) if key_points else ''}",
        key_points=key_points,
        self_check_questions=self_check[:3],
        duration_minutes=15,
    )


@router.post("/submit", response_model=dict)
async def submit_preview(
    body: SubmitPreviewIn,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
):
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")
    result = await db.execute(select(Chapter).where(Chapter.id == body.chapter_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="章节不存在")
    import json
    weak = json.dumps(body.weak_points or [], ensure_ascii=False) if body.weak_points else None
    record = PreviewRecord(
        user_id=user.id,
        chapter_id=body.chapter_id,
        completed=True,
        weak_points=weak,
        completed_at=datetime.utcnow(),
    )
    db.add(record)
    await db.commit()
    return {"ok": True, "message": "预习记录已保存"}
