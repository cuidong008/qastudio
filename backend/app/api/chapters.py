"""章节与知识点：学生/教师共用"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..db import get_db
from ..db.models import Chapter, KnowledgePoint

router = APIRouter(prefix="/chapters", tags=["chapters"])


class ChapterOut(BaseModel):
    id: int
    title: str
    order_index: int
    syllabus_ref: str | None

    class Config:
        from_attributes = True


class KnowledgePointOut(BaseModel):
    id: int
    chapter_id: int
    title: str
    content: str | None
    ppt_slide_ref: str | None
    order_index: int

    class Config:
        from_attributes = True


class ChapterDetailOut(ChapterOut):
    knowledge_points: list[KnowledgePointOut] = []


@router.get("", response_model=list[ChapterOut])
async def list_chapters(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Chapter).order_by(Chapter.order_index, Chapter.id)
    )
    chapters = result.scalars().all()
    return [ChapterOut.model_validate(c) for c in chapters]


@router.get("/{chapter_id}", response_model=ChapterDetailOut)
async def get_chapter(chapter_id: int, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Chapter).where(Chapter.id == chapter_id)
    )
    chapter = result.scalar_one_or_none()
    if not chapter:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="章节不存在")
    pts_result = await db.execute(
        select(KnowledgePoint).where(KnowledgePoint.chapter_id == chapter_id).order_by(KnowledgePoint.order_index)
    )
    points = pts_result.scalars().all()
    return ChapterDetailOut(
        **ChapterOut.model_validate(chapter).model_dump(),
        knowledge_points=[KnowledgePointOut.model_validate(p) for p in points],
    )
