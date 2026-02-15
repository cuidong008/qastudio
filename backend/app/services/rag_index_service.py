"""
业务层：从 DB 加载课程知识库并调用 RAG 模块建索引。
RAG 模块不依赖 DB，此处负责将 ORM 转为 ChunkDocument。
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Chapter, KnowledgeDocument, KnowledgePoint, PptFile, PptSlide
from ..rag import ChunkDocument, indexer


async def build_index_for_course(db: AsyncSession, course_id: int) -> int:
    """
    从数据库加载某课程下的知识库文档与 PPT 幻灯片文本，提交给 RAG 索引。
    返回写入的 chunk 数量。
    """
    documents: list[ChunkDocument] = []
    # 该课程下所有章节
    ch_result = await db.execute(
        select(Chapter).where(Chapter.course_id == course_id).order_by(Chapter.order_index, Chapter.id)
    )
    chapters = list(ch_result.scalars().all())
    chapter_ids = [c.id for c in chapters]
    if not chapter_ids:
        return 0

    # KnowledgeDocument
    doc_result = await db.execute(
        select(KnowledgeDocument).where(KnowledgeDocument.chapter_id.in_(chapter_ids))
    )
    for d in doc_result.scalars().all():
        if not d.content and not d.title:
            continue
        text = f"{d.title or ''}\n\n{d.content or ''}".strip()
        if not text:
            continue
        documents.append(
            ChunkDocument(
                text=text,
                course_id=course_id,
                chapter_id=d.chapter_id,
                page_ref=d.page_ref,
                title=d.title,
                source_id=f"doc_{d.id}",
            )
        )

    # KnowledgePoint
    kp_result = await db.execute(
        select(KnowledgePoint).where(KnowledgePoint.chapter_id.in_(chapter_ids)).order_by(KnowledgePoint.order_index)
    )
    for p in kp_result.scalars().all():
        text = f"{p.title or ''}\n\n{p.content or ''}".strip()
        if not text:
            continue
        documents.append(
            ChunkDocument(
                text=text,
                course_id=course_id,
                chapter_id=p.chapter_id,
                page_ref=p.ppt_slide_ref,
                title=p.title,
                source_id=f"kp_{p.id}",
            )
        )

    # PptSlide（通过 PptFile 关联 chapter）
    ppt_result = await db.execute(
        select(PptFile).where(PptFile.chapter_id.in_(chapter_ids))
    )
    ppt_ids = [f.id for f in ppt_result.scalars().all()]
    if ppt_ids:
        slide_result = await db.execute(
            select(PptSlide, PptFile)
            .join(PptFile, PptSlide.ppt_id == PptFile.id)
            .where(PptSlide.ppt_id.in_(ppt_ids))
            .order_by(PptSlide.ppt_id, PptSlide.slide_index)
        )
        for row in slide_result.all():
            slide, ppt_file = row[0], row[1]
            text = (slide.text_content or "").strip()
            if not text:
                continue
            page_ref = f"第{slide.slide_index}页" if slide.slide_index else None
            documents.append(
                ChunkDocument(
                    text=text,
                    course_id=course_id,
                    chapter_id=ppt_file.chapter_id,
                    page_ref=page_ref,
                    title=ppt_file.file_name,
                    source_id=f"slide_{slide.id}",
                )
            )

    return indexer.index_course_documents(documents, course_id, replace=True)
