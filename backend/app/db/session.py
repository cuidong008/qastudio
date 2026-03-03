"""数据库会话"""
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from .models import Base
from ..config import settings

# SQLite 并发：延长锁等待时间，避免 PDF 解析/索引构建占用连接时其他请求报 database is locked
_connect_args = {}
if "sqlite" in settings.database_url:
    _connect_args["timeout"] = 120  # 秒，等待锁的最长时间

engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    connect_args=_connect_args,
)

# SQLite：在连接创建时（无事务）启用 WAL，不能在事务内执行 PRAGMA journal_mode
if "sqlite" in settings.database_url:

    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_wal(dbapi_conn, _connection_record):
        # 新连接尚未进入事务，此时才能改 journal_mode
        dbapi_conn.execute("PRAGMA journal_mode=WAL")

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


def _migrate_courses_remark(sync_conn):
    """为已有 courses 表添加 remark 列（SQLite），可选备注，最多 128 字符"""
    try:
        sync_conn.execute(text("ALTER TABLE courses ADD COLUMN remark VARCHAR(128)"))
    except Exception:
        pass  # 列已存在


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


def _migrate_user_username_changed_at(sync_conn):
    """为已有 users 表添加 username_changed_at 列（SQLite）"""
    try:
        sync_conn.execute(text("ALTER TABLE users ADD COLUMN username_changed_at DATETIME"))
    except Exception:
        pass


def _migrate_user_admin_class_or_dept(sync_conn):
    """为已有 users 表添加 admin_class_or_dept 列（行政班级/部门，可为空）"""
    try:
        sync_conn.execute(text("ALTER TABLE users ADD COLUMN admin_class_or_dept VARCHAR(128)"))
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


def _migrate_knowledge_documents_student_visible_downloadable(sync_conn):
    """为 knowledge_documents 表添加 student_visible、downloadable 列（SQLite）"""
    for col in ("student_visible", "downloadable"):
        try:
            sync_conn.execute(text(f"ALTER TABLE knowledge_documents ADD COLUMN {col} BOOLEAN DEFAULT 1"))
        except Exception:
            pass


def _migrate_knowledge_documents_course_id(sync_conn):
    """为 knowledge_documents 表添加 course_id 列并回填"""
    try:
        sync_conn.execute(text("ALTER TABLE knowledge_documents ADD COLUMN course_id INTEGER"))
    except Exception:
        pass
    try:
        sync_conn.execute(
            text(
                """
                UPDATE knowledge_documents
                SET course_id = (SELECT course_id FROM chapters WHERE chapters.id = knowledge_documents.chapter_id)
                WHERE course_id IS NULL AND chapter_id IS NOT NULL
                """
            )
        )
    except Exception:
        pass


def _migrate_document_chapters_table(sync_conn):
    """创建 document_chapters 表并回填：文档与章节多对多"""
    try:
        sync_conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS document_chapters (
                    id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                    doc_id INTEGER NOT NULL,
                    chapter_id INTEGER NOT NULL,
                    FOREIGN KEY(doc_id) REFERENCES knowledge_documents (id) ON DELETE CASCADE,
                    FOREIGN KEY(chapter_id) REFERENCES chapters (id) ON DELETE CASCADE,
                    UNIQUE (doc_id, chapter_id)
                )
                """
            )
        )
    except Exception:
        pass
    try:
        sync_conn.execute(
            text(
                """
                INSERT OR IGNORE INTO document_chapters (doc_id, chapter_id)
                SELECT id, chapter_id FROM knowledge_documents WHERE chapter_id IS NOT NULL
                """
            )
        )
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


def _migrate_questions_asked_course_irrelevant(sync_conn):
    """为 questions_asked 表添加 course_irrelevant 列：大模型判断该问题是否与课程无关"""
    try:
        sync_conn.execute(text("ALTER TABLE questions_asked ADD COLUMN course_irrelevant BOOLEAN"))
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


def _migrate_questions_bank_and_difficulty_score(sync_conn):
    """为已有 questions 表添加 question_bank_type / difficulty_score / remark 列（SQLite）"""
    try:
        sync_conn.execute(text("ALTER TABLE questions ADD COLUMN question_bank_type VARCHAR(20) DEFAULT 'training'"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("ALTER TABLE questions ADD COLUMN difficulty_score FLOAT DEFAULT 0.8"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("ALTER TABLE questions ADD COLUMN remark VARCHAR(128)"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("UPDATE questions SET question_bank_type = 'training' WHERE question_bank_type IS NULL OR TRIM(question_bank_type) = ''"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("UPDATE questions SET difficulty_score = 0.8 WHERE difficulty_score IS NULL"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("UPDATE questions SET remark = NULL WHERE remark IS NULL"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("ALTER TABLE questions ADD COLUMN generated_time DATETIME"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("ALTER TABLE questions ADD COLUMN edited_time DATETIME"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("UPDATE questions SET generated_time = created_at WHERE generated_time IS NULL"))
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


def _migrate_document_process_tasks_chapter_nullable(sync_conn):
    """允许 document_process_tasks.chapter_id 为 NULL（无章节时按课程解析）"""
    try:
        r = sync_conn.execute(text("PRAGMA table_info(document_process_tasks)"))
        rows = r.fetchall()
        if not rows:
            return
        chapter_col = next((r for r in rows if r[1] == "chapter_id"), None)
        if chapter_col is None or chapter_col[3] == 0:
            return
    except Exception:
        return
    try:
        sync_conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS document_process_tasks_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    course_id INTEGER NOT NULL,
                    chapter_id INTEGER,
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
        sync_conn.execute(text("INSERT INTO document_process_tasks_new SELECT id, course_id, chapter_id, doc_id, teacher_id, status, request_payload, result_payload, error_message, created_at, updated_at FROM document_process_tasks"))
        sync_conn.execute(text("DROP TABLE document_process_tasks"))
        sync_conn.execute(text("ALTER TABLE document_process_tasks_new RENAME TO document_process_tasks"))
        for idx in ("ix_dpt_course_id", "ix_dpt_chapter_id", "ix_dpt_doc_id", "ix_dpt_teacher_id"):
            try:
                sync_conn.execute(text(f"CREATE INDEX IF NOT EXISTS {idx} ON document_process_tasks ({idx.replace('ix_dpt_', '')})"))
            except Exception:
                pass
    except Exception:
        pass


def _migrate_course_reindex_tasks(sync_conn):
    """创建课程重建索引任务表（SQLite 兼容）"""
    try:
        sync_conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS course_reindex_tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    course_id INTEGER NOT NULL,
                    requested_by_id INTEGER,
                    requested_by_role VARCHAR(24),
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
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_crt_course_id ON course_reindex_tasks (course_id)"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_crt_requested_by_id ON course_reindex_tasks (requested_by_id)"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_crt_status ON course_reindex_tasks (status)"))
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


def _migrate_papers(sync_conn):
    """创建试卷库表（SQLite 兼容）"""
    try:
        sync_conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS papers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    course_id INTEGER NOT NULL,
                    title VARCHAR(128) NOT NULL,
                    paper_bank_type VARCHAR(20) NOT NULL DEFAULT 'training',
                    question_source VARCHAR(20) NOT NULL DEFAULT 'local',
                    status VARCHAR(24) NOT NULL DEFAULT 'pending',
                    is_partial BOOLEAN NOT NULL DEFAULT 0,
                    total_score FLOAT NOT NULL DEFAULT 0,
                    overall_difficulty FLOAT NOT NULL DEFAULT 0,
                    request_payload TEXT NOT NULL DEFAULT '{}',
                    content_payload TEXT,
                    error_message TEXT,
                    created_by INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_papers_course_id ON papers (course_id)"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_papers_created_by ON papers (created_by)"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_papers_status ON papers (status)"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("ALTER TABLE papers ADD COLUMN overall_difficulty FLOAT DEFAULT 0"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("UPDATE papers SET overall_difficulty = 0 WHERE overall_difficulty IS NULL"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("ALTER TABLE papers ADD COLUMN paper_type VARCHAR(20) DEFAULT 'electronic'"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("UPDATE papers SET paper_type = 'electronic' WHERE paper_type IS NULL OR paper_type = ''"))
    except Exception:
        pass


def _migrate_paper_files(sync_conn):
    """创建试卷附件表（文件试卷下的多文件）"""
    try:
        sync_conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS paper_files (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    paper_id INTEGER NOT NULL,
                    file_name VARCHAR(256) NOT NULL,
                    file_path VARCHAR(512) NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (paper_id) REFERENCES papers (id)
                )
                """
            )
        )
    except Exception:
        pass
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_paper_files_paper_id ON paper_files (paper_id)"))
    except Exception:
        pass


def _migrate_student_feedbacks_course_id(sync_conn):
    """为已有 student_feedbacks 表添加 course_id 列（SQLite）"""
    try:
        sync_conn.execute(text("ALTER TABLE student_feedbacks ADD COLUMN course_id INTEGER"))
    except Exception:
        pass  # 列已存在


def _migrate_student_feedbacks_reply_and_status(sync_conn):
    """为已有 student_feedbacks 表添加 reply_text、status 列"""
    try:
        sync_conn.execute(text("ALTER TABLE student_feedbacks ADD COLUMN reply_text TEXT"))
    except Exception:
        pass
    try:
        sync_conn.execute(text("ALTER TABLE student_feedbacks ADD COLUMN status VARCHAR(32)"))
    except Exception:
        pass


def _migrate_student_feedbacks_processed_at(sync_conn):
    """为已有 student_feedbacks 表添加 processed_at 列（处理回复时间）"""
    try:
        sync_conn.execute(text("ALTER TABLE student_feedbacks ADD COLUMN processed_at DATETIME"))
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
        await conn.run_sync(_migrate_courses_remark)
        await conn.run_sync(_migrate_class_course_owner)
        await conn.run_sync(_migrate_user_student_no)
        await conn.run_sync(_migrate_user_avatar_url)
        await conn.run_sync(_migrate_user_username_changed_at)
        await conn.run_sync(_migrate_user_admin_class_or_dept)
        await conn.run_sync(_backfill_student_class_memberships)
        await conn.run_sync(_migrate_knowledge_documents_upload_fields)
        await conn.run_sync(_migrate_knowledge_documents_student_visible_downloadable)
        await conn.run_sync(_migrate_knowledge_documents_course_id)
        await conn.run_sync(_migrate_document_chapters_table)
        await conn.run_sync(_migrate_questions_asked_course_and_rag)
        await conn.run_sync(_migrate_questions_asked_course_irrelevant)
        await conn.run_sync(_migrate_questions_course_and_type)
        await conn.run_sync(_migrate_questions_bank_and_difficulty_score)
        await conn.run_sync(_migrate_question_generation_tasks)
        await conn.run_sync(_migrate_document_process_tasks)
        await conn.run_sync(_migrate_document_process_tasks_chapter_nullable)
        await conn.run_sync(_migrate_course_reindex_tasks)
        await conn.run_sync(_migrate_chapter_config_preview_video)
        await conn.run_sync(_migrate_answer_records_scene_and_wrong_reason)
        await conn.run_sync(_migrate_review_records)
        await conn.run_sync(_migrate_course_question_synonyms)
        await conn.run_sync(_migrate_papers)
        await conn.run_sync(_migrate_paper_files)
        await conn.run_sync(_migrate_student_feedbacks_course_id)
        await conn.run_sync(_migrate_student_feedbacks_reply_and_status)
        await conn.run_sync(_migrate_student_feedbacks_processed_at)
