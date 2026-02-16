"""课程知识库清理：清空课程下的知识文档/知识点/PPT 及其文件。"""
from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db.models import Chapter, KnowledgeDocument, KnowledgePoint, PptFile, PptSlide

logger = logging.getLogger(__name__)


async def clear_course_knowledge(db: AsyncSession, course_id: int) -> dict[str, int]:
    """清空课程知识库，不删除课程与章节。"""
    stats = {
        "knowledge_documents": 0,
        "knowledge_points": 0,
        "ppt_files": 0,
        "ppt_slides": 0,
        "deleted_files": 0,
    }

    chapter_ids = [
        row[0]
        for row in (await db.execute(select(Chapter.id).where(Chapter.course_id == course_id))).all()
    ]
    if not chapter_ids:
        return stats

    kd_rows = (
        await db.execute(
            select(KnowledgeDocument.file_path).where(KnowledgeDocument.chapter_id.in_(chapter_ids))
        )
    ).all()
    ppt_rows = (
        await db.execute(
            select(PptFile.id, PptFile.file_path).where(PptFile.chapter_id.in_(chapter_ids))
        )
    ).all()
    ppt_ids = [pid for pid, _ in ppt_rows]
    file_paths = [fp for (fp,) in kd_rows if fp] + [fp for _, fp in ppt_rows if fp]

    if ppt_ids:
        stats["ppt_slides"] = (
            await db.execute(delete(PptSlide).where(PptSlide.ppt_id.in_(ppt_ids)))
        ).rowcount or 0
    stats["ppt_files"] = (
        await db.execute(delete(PptFile).where(PptFile.chapter_id.in_(chapter_ids)))
    ).rowcount or 0
    stats["knowledge_points"] = (
        await db.execute(delete(KnowledgePoint).where(KnowledgePoint.chapter_id.in_(chapter_ids)))
    ).rowcount or 0
    stats["knowledge_documents"] = (
        await db.execute(delete(KnowledgeDocument).where(KnowledgeDocument.chapter_id.in_(chapter_ids)))
    ).rowcount or 0

    root = Path(settings.upload_dir)
    for rel in file_paths:
        try:
            path = root / rel
            if path.exists() and path.is_file():
                path.unlink()
                stats["deleted_files"] += 1
        except Exception as e:
            logger.warning("clear_course_file_failed course_id=%s file=%s err=%s", course_id, rel, str(e))

    return stats
