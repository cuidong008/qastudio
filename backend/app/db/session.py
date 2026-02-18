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


def _migrate_user_avatar_url(sync_conn):
    """为已有 users 表添加 avatar_url 列（SQLite）"""
    try:
        sync_conn.execute(text("ALTER TABLE users ADD COLUMN avatar_url TEXT"))
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


def _migrate_knowledge_documents_upload_fields(sync_conn):
    """为已有 knowledge_documents 表添加文档上传与解析状态列（SQLite）"""
    statements = [
        "ALTER TABLE knowledge_documents ADD COLUMN file_name VARCHAR(256)",
        "ALTER TABLE knowledge_documents ADD COLUMN file_path VARCHAR(512)",
        "ALTER TABLE knowledge_documents ADD COLUMN file_size INTEGER",
        "ALTER TABLE knowledge_documents ADD COLUMN parse_status VARCHAR(24)",
        "ALTER TABLE knowledge_documents ADD COLUMN parse_error VARCHAR(512)",
        "ALTER TABLE knowledge_documents ADD COLUMN chunk_count INTEGER",
    ]
    for sql in statements:
        try:
            sync_conn.execute(text(sql))
        except Exception:
            pass


def _migrate_questions_asked_course_and_rag(sync_conn):
    """为已有 questions_asked 表添加 course_id / rag_hit 列（SQLite）并尽力回填 course_id"""
    try:
        sync_conn.execute(text("ALTER TABLE questions_asked ADD COLUMN course_id INTEGER"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("ALTER TABLE questions_asked ADD COLUMN rag_hit BOOLEAN DEFAULT 0"))
    except Exception:
        pass
    try:
        sync_conn.execute(
            text(
                """
                UPDATE questions_asked
                SET course_id = (
                    SELECT chapters.course_id
                    FROM chapters
                    WHERE chapters.id = questions_asked.chapter_id
                )
                WHERE course_id IS NULL AND chapter_id IS NOT NULL
                """
            )
        )
    except Exception:
        pass


def _migrate_questions_course_and_type(sync_conn):
    """为已有 questions 表添加 course_id / question_type 列，并回填 course_id（SQLite）"""
    try:
        sync_conn.execute(text("ALTER TABLE questions ADD COLUMN course_id INTEGER"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("ALTER TABLE questions ADD COLUMN question_type VARCHAR(24) DEFAULT 'single_choice'"))
    except Exception:
        pass
    try:
        sync_conn.execute(
            text(
                """
                UPDATE questions
                SET course_id = (
                    SELECT chapters.course_id
                    FROM chapters
                    WHERE chapters.id = questions.chapter_id
                )
                WHERE course_id IS NULL
                """
            )
        )
    except Exception:
        pass


def _migrate_question_generation_tasks(sync_conn):
    """创建习题生成任务表（SQLite 兼容）"""
    try:
        sync_conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS question_generation_tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    course_id INTEGER NOT NULL,
                    chapter_id INTEGER NOT NULL,
                    teacher_id INTEGER NOT NULL,
                    status VARCHAR(24) NOT NULL DEFAULT 'pending',
                    request_payload TEXT NOT NULL DEFAULT '{}',
                    result_payload TEXT,
                    error_message TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_qgt_course_id ON question_generation_tasks (course_id)"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_qgt_chapter_id ON question_generation_tasks (chapter_id)"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_qgt_teacher_id ON question_generation_tasks (teacher_id)"))
    except Exception:
        pass


def _migrate_document_process_tasks(sync_conn):
    """创建文档处理任务表（SQLite 兼容）"""
    try:
        sync_conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS document_process_tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    course_id INTEGER NOT NULL,
                    chapter_id INTEGER NOT NULL,
                    doc_id INTEGER NOT NULL,
                    teacher_id INTEGER NOT NULL,
                    status VARCHAR(24) NOT NULL DEFAULT 'pending',
                    request_payload TEXT NOT NULL DEFAULT '{}',
                    result_payload TEXT,
                    error_message TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_dpt_course_id ON document_process_tasks (course_id)"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_dpt_chapter_id ON document_process_tasks (chapter_id)"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_dpt_doc_id ON document_process_tasks (doc_id)"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_dpt_teacher_id ON document_process_tasks (teacher_id)"))
    except Exception:
        pass


def _migrate_chapter_config_preview_video(sync_conn):
    """为 chapter_configs 添加 preview_video_url 列（SQLite）"""
    try:
        sync_conn.execute(text("ALTER TABLE chapter_configs ADD COLUMN preview_video_url VARCHAR(512)"))
    except Exception:
        pass


def _migrate_answer_records_scene_and_wrong_reason(sync_conn):
    """为 answer_records 添加 scene / wrong_reason 列（SQLite）"""
    try:
        sync_conn.execute(text("ALTER TABLE answer_records ADD COLUMN scene VARCHAR(24) DEFAULT 'exercise'"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("ALTER TABLE answer_records ADD COLUMN wrong_reason VARCHAR(32)"))
    except Exception:
        pass


def _migrate_review_records(sync_conn):
    """创建 review_records 表（SQLite 兼容）"""
    try:
        sync_conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS review_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    chapter_id INTEGER NOT NULL,
                    recall_points TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_review_records_user_id ON review_records (user_id)"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_review_records_chapter_id ON review_records (chapter_id)"))
    except Exception:
        pass


def _migrate_course_question_synonyms(sync_conn):
    """创建课程问句同义映射表（SQLite 兼容）"""
    try:
        sync_conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS course_question_synonyms (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    course_id INTEGER NOT NULL,
                    source_term VARCHAR(128) NOT NULL,
                    target_term VARCHAR(128) NOT NULL,
                    confidence FLOAT NOT NULL DEFAULT 0.8,
                    status VARCHAR(16) NOT NULL DEFAULT 'active',
                    auto_generated BOOLEAN NOT NULL DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )
    except Exception:
        pass
    try:
        sync_conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_course_question_synonym ON course_question_synonyms (course_id, source_term)"
            )
        )
    except Exception:
        pass
    try:
        sync_conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_course_question_synonyms_course_id ON course_question_synonyms (course_id)"
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
        await conn.run_sync(_migrate_user_avatar_url)
        await conn.run_sync(_backfill_student_class_memberships)
        await conn.run_sync(_migrate_knowledge_documents_upload_fields)
        await conn.run_sync(_migrate_questions_asked_course_and_rag)
        await conn.run_sync(_migrate_questions_course_and_type)
        await conn.run_sync(_migrate_question_generation_tasks)
        await conn.run_sync(_migrate_document_process_tasks)
        await conn.run_sync(_migrate_chapter_config_preview_video)
        await conn.run_sync(_migrate_answer_records_scene_and_wrong_reason)
        await conn.run_sync(_migrate_review_records)
        await conn.run_sync(_migrate_course_question_synonyms)
