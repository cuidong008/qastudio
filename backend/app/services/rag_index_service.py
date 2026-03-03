"""
业务层：从 DB 加载课程知识库并调用 RAG 模块建索引。
RAG 模块不依赖 DB，此处负责将 ORM 转为 ChunkDocument。
含章节级与课程级（无 chapter_id）文档。
"""
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Chapter, KnowledgeDocument, KnowledgePoint, PptFile, PptSlide
from ..rag import ChunkDocument, indexer


def _knowledge_document_condition(course_id: int, chapter_ids: list[int]):
    """该课程下参与索引的文档：章节级或课程级。"""
    course_level = and_(
        KnowledgeDocument.course_id == course_id,
        KnowledgeDocument.chapter_id.is_(None),
    )
    if chapter_ids:
        return or_(course_level, KnowledgeDocument.chapter_id.in_(chapter_ids))
    return course_level


async def build_index_for_course(db: AsyncSession, course_id: int) -> int:
    """
    从数据库加载某课程下的知识库文档与 PPT 幻灯片文本（含课程级文档），提交给 RAG 索引。
    返回写入的 chunk 数量。
    """
    documents: list[ChunkDocument] = []
    ch_result = await db.execute(
        select(Chapter).where(Chapter.course_id == course_id).order_by(Chapter.order_index, Chapter.id)
    )
    chapters = list(ch_result.scalars().all())
    chapter_ids = [c.id for c in chapters]

    # KnowledgeDocument：章节级 + 课程级（course_id 且 chapter_id 为空）
    doc_cond = _knowledge_document_condition(course_id, chapter_ids)
    doc_result = await db.execute(select(KnowledgeDocument).where(doc_cond))
    for d in doc_result.scalars().all():
        if not d.content and not d.title:
            continue
        # 与 RAGFlow 一致：正文作为分块主体，标题放 metadata，避免每个 chunk 重复文件名。
        text = (d.content or d.title or "").strip()
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

    # KnowledgePoint、PptSlide 仅章节级
    if chapter_ids:
        kp_result = await db.execute(
            select(KnowledgePoint).where(KnowledgePoint.chapter_id.in_(chapter_ids)).order_by(KnowledgePoint.order_index)
        )
        for p in kp_result.scalars().all():
            text = (p.content or p.title or "").strip()
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
