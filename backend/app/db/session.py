"""数据库会话"""
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from .models import Base
from ..config import settings

engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


def _migrate_chapter_course_id(sync_conn):
    """为已有 chapters 表添加 course_id 列（SQLite）"""
    try:
        sync_conn.execute(text("ALTER TABLE chapters ADD COLUMN course_id INTEGER"))
    except Exception:
        pass  # 列已存在


def _migrate_course_owner_teacher_id(sync_conn):
    """为已有 courses 表添加 owner_teacher_id 列（SQLite）"""
    try:
        sync_conn.execute(text("ALTER TABLE courses ADD COLUMN owner_teacher_id INTEGER"))
    except Exception:
        pass


def _migrate_class_course_owner(sync_conn):
    """为已有 classes 表添加 course_id / owner_teacher_id 列（SQLite）"""
    try:
        sync_conn.execute(text("ALTER TABLE classes ADD COLUMN course_id INTEGER"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("ALTER TABLE classes ADD COLUMN owner_teacher_id INTEGER"))
    except Exception:
        pass


async def get_db():
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_migrate_chapter_course_id)
        await conn.run_sync(_migrate_course_owner_teacher_id)
        await conn.run_sync(_migrate_class_course_owner)
