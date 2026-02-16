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


def _migrate_user_student_no(sync_conn):
    """为已有 users 表添加 student_no 列（SQLite）"""
    try:
        sync_conn.execute(text("ALTER TABLE users ADD COLUMN student_no VARCHAR(32)"))
    except Exception:
        pass


def _backfill_student_class_memberships(sync_conn):
    """将历史 users.class_id 数据回填到多对多关系表"""
    try:
        sync_conn.execute(
            text(
                """
                INSERT OR IGNORE INTO student_class_memberships (student_id, class_id, created_at)
                SELECT id, class_id, CURRENT_TIMESTAMP
                FROM users
                WHERE role = 'student' AND class_id IS NOT NULL
                """
            )
        )
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
        await conn.run_sync(_migrate_user_student_no)
        await conn.run_sync(_backfill_student_class_memberships)
