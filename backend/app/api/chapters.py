"""章节与知识点：学生/教师共用"""
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..db import get_db
from ..db.models import Chapter, KnowledgePoint, Course

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


class CourseOut(BaseModel):
    id: int
    name: str
    code: str | None
    is_active: bool

    class Config:
        from_attributes = True


@router.get("/courses", response_model=list[CourseOut])
async def list_courses(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Course).where(Course.is_active == True).order_by(Course.id)
    )
    rows = result.scalars().all()
    return [CourseOut.model_validate(c) for c in rows]


@router.get("", response_model=list[ChapterOut])
async def list_chapters(
    course_id: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    qry = select(Chapter).order_by(Chapter.order_index, Chapter.id)
    if course_id is not None:
        qry = qry.where(Chapter.course_id == course_id)
    result = await db.execute(qry)
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
