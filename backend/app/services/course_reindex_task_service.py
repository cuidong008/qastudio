"""课程重建索引任务执行器。"""
import asyncio
import json
import logging

from sqlalchemy import select

from ..db.models import CourseReindexTask
from ..db.session import AsyncSessionLocal
from .rag_index_service import build_index_for_course

logger = logging.getLogger(__name__)


async def run_course_reindex_task(task_id: int):
    async with AsyncSessionLocal() as db:
        r = await db.execute(select(CourseReindexTask).where(CourseReindexTask.id == task_id))
        task = r.scalar_one_or_none()
        if not task:
            logger.warning("course_reindex_task_missing task_id=%s", task_id)
            return
        task.status = "running"
        task.error_message = None
        await db.commit()
        try:
            chunks = await build_index_for_course(db, task.course_id)
            task.status = "success"
            task.result_payload = json.dumps({"chunks_indexed": int(chunks)}, ensure_ascii=False)
            task.error_message = None
            logger.info("course_reindex_task_success task_id=%s course_id=%s chunks=%s", task.id, task.course_id, chunks)
        except Exception as e:
            err_msg = str(e)
            task.status = "failed"
            task.error_message = err_msg[:4000]
            logger.exception("course_reindex_task_failed task_id=%s course_id=%s err=%s", task.id, task.course_id, err_msg[:500])
        await db.commit()


def run_course_reindex_task_thread(task_id: int):
    try:
        logger.info("course_reindex_task_thread_start task_id=%s", task_id)
        asyncio.run(run_course_reindex_task(task_id))
        logger.info("course_reindex_task_thread_end task_id=%s", task_id)
    except Exception:
        logger.exception("course_reindex_task_thread_crash task_id=%s", task_id)
