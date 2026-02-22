"""章节删除清理：删除章节关联数据与上传文件。"""
from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db.models import (
    AnswerRecord,
    ChapterConfig,
    DocumentProcessTask,
    KnowledgeDocument,
    KnowledgePoint,
    PptFile,
    PptSlide,
    PreviewRecord,
    Question,
    QuestionAsked,
)

logger = logging.getLogger(__name__)


async def cleanup_chapter_related_data(db: AsyncSession, chapter_id: int) -> dict[str, int]:
    """删除章节关联业务数据与上传文件，返回删除统计。"""
    stats = {
        "knowledge_documents": 0,
        "knowledge_points": 0,
        "ppt_files": 0,
        "ppt_slides": 0,
        "questions": 0,
        "answer_records": 0,
        "preview_records": 0,
        "question_asked": 0,
        "chapter_configs": 0,
        "deleted_files": 0,
    }

    # 先收集文件路径，删除 DB 记录后再尝试删除磁盘文件。
    kd_rows = (
        await db.execute(
            select(KnowledgeDocument.id, KnowledgeDocument.file_path).where(
                KnowledgeDocument.chapter_id == chapter_id
            )
        )
    ).all()
    ppt_rows = (
        await db.execute(
            select(PptFile.id, PptFile.file_path).where(PptFile.chapter_id == chapter_id)
        )
    ).all()
    file_paths = [p for _, p in kd_rows if p] + [p for _, p in ppt_rows if p]
    ppt_ids = [pid for pid, _ in ppt_rows]

    q_ids = [
        row[0]
        for row in (await db.execute(select(Question.id).where(Question.chapter_id == chapter_id))).all()
    ]

    if q_ids:
        stats["answer_records"] = (
            await db.execute(delete(AnswerRecord).where(AnswerRecord.question_id.in_(q_ids)))
        ).rowcount or 0
    stats["questions"] = (
        await db.execute(delete(Question).where(Question.chapter_id == chapter_id))
    ).rowcount or 0

    stats["preview_records"] = (
        await db.execute(delete(PreviewRecord).where(PreviewRecord.chapter_id == chapter_id))
    ).rowcount or 0
    stats["question_asked"] = (
        await db.execute(delete(QuestionAsked).where(QuestionAsked.chapter_id == chapter_id))
    ).rowcount or 0
    stats["chapter_configs"] = (
        await db.execute(delete(ChapterConfig).where(ChapterConfig.chapter_id == chapter_id))
    ).rowcount or 0

    # 章节级文档处理任务随章节删除
    await db.execute(delete(DocumentProcessTask).where(DocumentProcessTask.chapter_id == chapter_id))

    if ppt_ids:
        stats["ppt_slides"] = (
            await db.execute(delete(PptSlide).where(PptSlide.ppt_id.in_(ppt_ids)))
        ).rowcount or 0
    stats["ppt_files"] = (
        await db.execute(delete(PptFile).where(PptFile.chapter_id == chapter_id))
    ).rowcount or 0

    stats["knowledge_points"] = (
        await db.execute(delete(KnowledgePoint).where(KnowledgePoint.chapter_id == chapter_id))
    ).rowcount or 0
    stats["knowledge_documents"] = (
        await db.execute(delete(KnowledgeDocument).where(KnowledgeDocument.chapter_id == chapter_id))
    ).rowcount or 0

    # 删除上传文件（最佳努力，不阻断删除流程）
    root = Path(settings.upload_dir)
    for rel in file_paths:
        try:
            path = root / rel
            if path.exists() and path.is_file():
                path.unlink()
                stats["deleted_files"] += 1
        except Exception as e:
            logger.warning("cleanup_chapter_file_failed chapter_id=%s file=%s err=%s", chapter_id, rel, str(e))

    return stats
