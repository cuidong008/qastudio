"""课前预习：任务获取、完成提交、薄弱点反馈"""
from datetime import datetime
import mimetypes
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_db
from ..db.models import User, Chapter, KnowledgePoint, PreviewRecord, Question, KnowledgeDocument, ChapterConfig
from ..api.auth import get_current_user

router = APIRouter(prefix="/preview", tags=["preview"])


class PreviewQuestionOut(BaseModel):
    id: int
    question_type: str | None
    question_text: str
    options: str | None


class PreviewMaterialOut(BaseModel):
    pdf_ready: bool
    pdf_count: int
    video_ready: bool
    video_url: str | None


class PreviewMaterialFileOut(BaseModel):
    id: int
    title: str
    file_name: str | None


class PreviewTaskOut(BaseModel):
    chapter_id: int
    chapter_title: str
    summary: str
    learning_goals: list[str]
    materials: PreviewMaterialOut
    pdf_materials: list[PreviewMaterialFileOut]
    video_materials: list[PreviewMaterialFileOut]
    preview_questions: list[PreviewQuestionOut]
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
    key_points = [p.title for p in points if (p.title or "").strip()]
    learning_goals = key_points if key_points else ["核心概念概览", "关键协议作用", "电商场景关联"]

    pdf_count_result = await db.execute(
        select(func.count(KnowledgeDocument.id)).where(
            KnowledgeDocument.chapter_id == chapter_id,
            KnowledgeDocument.source_type.in_(["pdf_upload", "ppt"]),
        )
    )
    pdf_count = int(pdf_count_result.scalar() or 0)
    pdf_rows = (
        await db.execute(
            select(KnowledgeDocument)
            .where(
                KnowledgeDocument.chapter_id == chapter_id,
                KnowledgeDocument.source_type.in_(["pdf_upload", "ppt"]),
                KnowledgeDocument.file_path.is_not(None),
            )
            .order_by(KnowledgeDocument.id.desc())
        )
    ).scalars().all()
    video_rows = (
        await db.execute(
            select(KnowledgeDocument)
            .where(
                KnowledgeDocument.chapter_id == chapter_id,
                KnowledgeDocument.source_type == "preview_video",
                KnowledgeDocument.file_path.is_not(None),
            )
            .order_by(KnowledgeDocument.id.desc())
        )
    ).scalars().all()

    cfg_result = await db.execute(select(ChapterConfig).where(ChapterConfig.chapter_id == chapter_id))
    cfg = cfg_result.scalar_one_or_none()
    video_url = (cfg.preview_video_url or "").strip() if cfg else ""

    question_result = await db.execute(
        select(Question)
        .where(
            Question.chapter_id == chapter_id,
            Question.is_active == True,
            Question.is_approved == True,
            Question.difficulty == "basic",
            Question.question_type.in_(["single_choice", "multiple_choice", "judge"]),
        )
        .order_by(Question.id)
        .limit(8)
    )
    questions = question_result.scalars().all()
    return PreviewTaskOut(
        chapter_id=chapter.id,
        chapter_title=chapter.title,
        summary=f"请先阅读已上传讲义 PDF，再完成预习题。重点包括：{'、'.join(learning_goals)}。",
        learning_goals=learning_goals,
        materials=PreviewMaterialOut(
            pdf_ready=pdf_count > 0,
            pdf_count=pdf_count,
            video_ready=bool(video_url or video_rows),
            video_url=video_url or None,
        ),
        pdf_materials=[PreviewMaterialFileOut(id=row.id, title=row.title, file_name=row.file_name) for row in pdf_rows],
        video_materials=[PreviewMaterialFileOut(id=row.id, title=row.title, file_name=row.file_name) for row in video_rows],
        preview_questions=[
            PreviewQuestionOut(
                id=q.id,
                question_type=q.question_type,
                question_text=q.question_text,
                options=q.options,
            )
            for q in questions
        ],
        duration_minutes=15,
    )


@router.get("/materials/{material_id}/file")
async def get_preview_material_file(
    material_id: int,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user),
):
    if not user:
        raise HTTPException(status_code=401, detail="请先登录")
    result = await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == material_id))
    doc = result.scalar_one_or_none()
    if not doc or not doc.file_path:
        raise HTTPException(status_code=404, detail="预习材料不存在")
    if doc.source_type not in {"pdf_upload", "ppt", "preview_video"}:
        raise HTTPException(status_code=400, detail="该材料不支持下载")
    abs_path = Path(settings.upload_dir) / doc.file_path
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    media_type = mimetypes.guess_type(str(abs_path))[0] or "application/octet-stream"
    return FileResponse(path=str(abs_path), media_type=media_type, filename=doc.file_name or abs_path.name)


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
