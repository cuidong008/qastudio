"""种子数据：示例章节、知识点、题目、班级、知识库文档（便于本地运行）"""
import asyncio
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from .session import (
    AsyncSessionLocal,
    engine,
    _migrate_chapter_course_id,
    _migrate_course_owner_teacher_id,
    _migrate_class_course_owner,
    _migrate_user_student_no,
    _migrate_user_avatar_url,
    _backfill_student_class_memberships,
    _migrate_questions_asked_course_and_rag,
    _migrate_questions_course_and_type,
    _migrate_question_generation_tasks,
    _migrate_document_process_tasks,
    _migrate_chapter_config_preview_video,
    _migrate_answer_records_scene_and_wrong_reason,
    _migrate_review_records,
    _migrate_course_question_synonyms,
)
from .models import (
    Base, Chapter, Class, Course, Teaching, KnowledgeDocument,
    Question, User, UserRole, ChapterConfig,
)
import bcrypt


async def seed(session: AsyncSession):
    # 确保存在默认课程（通用平台）
    r_course = await session.execute(select(Course).limit(1))
    default_course = r_course.scalar_one_or_none()
    if not default_course:
        default_course = Course(id=1, name="计算机网络基础", code="CS-NET", description="经管电商专业课程", is_active=True)
        session.add(default_course)
        await session.flush()

    # 班级（多班级/多学期支撑）
    r_cls = await session.execute(select(Class).limit(1))
    if not r_cls.scalar_one_or_none():
        cls1 = Class(id=1, name="电商2024秋", term="2024-秋")
        session.add(cls1)
        await session.flush()

    # 章节（归属课程）
    r = await session.execute(select(Chapter).limit(1))
    if r.scalar_one_or_none():
        # 已有数据：迁移 course_id + 确保管理员存在
        await session.execute(update(Chapter).where(Chapter.course_id == None).values(course_id=default_course.id))
        r_admin = await session.execute(select(User).where(User.username == "admin"))
        if not r_admin.scalar_one_or_none():
            _hash = lambda p: bcrypt.hashpw(p.encode(), bcrypt.gensalt()).decode("utf-8")
            session.add(User(username="admin", student_no="A0001", hashed_password=_hash("admin"), role=UserRole.admin.value, display_name="管理员", class_id=None))
        await session.commit()
        return
    ch1 = Chapter(id=1, course_id=default_course.id, title="第1章 计算机网络概述", order_index=1, syllabus_ref="教学大纲 1.1")
    ch2 = Chapter(id=2, course_id=default_course.id, title="第2章 网络协议与电商应用", order_index=2, syllabus_ref="教学大纲 2.1")
    session.add_all([ch1, ch2])
    await session.flush()

    # 知识库文档（教材+PPT+电商案例，供问答检索）
    session.add_all([
        KnowledgeDocument(chapter_id=1, source_type="textbook", title="计算机网络概述-教材摘要",
                         content="计算机网络主要功能包括数据共享、分布式处理、资源共享。电商平台依赖网络实现订单同步、支付与物流跟踪。", page_ref="第1章"),
        KnowledgeDocument(chapter_id=1, source_type="ecommerce_case", title="电商网络架构案例",
                         content="典型电商架构：用户端-负载均衡-应用服务器-数据库与缓存，涉及网络支付安全、HTTPS 与证书。", page_ref=None),
        KnowledgeDocument(chapter_id=2, source_type="ppt", title="网络协议与电商应用-PPT",
                         content="网络协议可类比电商交易规则。应用层协议如 HTTP、HTTPS 用于网页与支付；TCP 保证可靠传输。", page_ref="第2章 第2-10页"),
    ])
    await session.flush()

    # 题目（基础/应用/拓展）
    session.add_all([
        Question(chapter_id=1, difficulty="basic", question_text="计算机网络的主要功能不包括（ ）。",
                 options='["A. 数据共享","B. 提高单机算力","C. 分布式处理","D. 资源共享"]',
                 correct_answer="B", explanation="提高单机算力是本地计算机范畴。", ppt_ref="第1章 第5页"),
        Question(chapter_id=1, difficulty="applied", question_text="电商平台中，用户下单请求通常经过哪些网络层次？",
                 options='["A. 仅应用层","B. 应用层、传输层、网络层等","C. 仅物理层","D. 仅网络层"]',
                 correct_answer="B", explanation="端到端通信经过协议栈各层。", ppt_ref="第1章 第12页"),
        Question(chapter_id=2, difficulty="basic", question_text="下列属于应用层协议的是（ ）。",
                 options='["A. IP","B. TCP","C. HTTP","D. Ethernet"]',
                 correct_answer="C", explanation="HTTP 是应用层协议。", ppt_ref="第2章 第4页"),
    ])
    # 教师章节配置默认
    session.add_all([
        ChapterConfig(chapter_id=1, preview_enabled=True, question_limit=20),
        ChapterConfig(chapter_id=2, preview_enabled=True, question_limit=20),
    ])
    # 演示用户（学生关联班级）
    def _hash(pwd: str) -> str:
        return bcrypt.hashpw(pwd.encode(), bcrypt.gensalt()).decode("utf-8")

    for u in [
        User(username="admin", student_no="A0001", hashed_password=_hash("admin"), role=UserRole.admin.value, display_name="管理员", class_id=None),
        User(username="teacher", student_no="T0001", hashed_password=_hash("teacher"), role=UserRole.teacher.value, display_name="教师", class_id=None),
        User(username="student", student_no="S0001", hashed_password=_hash("student"), role=UserRole.student.value, display_name="学生", class_id=1),
    ]:
        session.add(u)
    await session.commit()


async def run_seed():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_migrate_chapter_course_id)
        await conn.run_sync(_migrate_course_owner_teacher_id)
        await conn.run_sync(_migrate_class_course_owner)
        await conn.run_sync(_migrate_user_student_no)
        await conn.run_sync(_migrate_user_avatar_url)
        await conn.run_sync(_backfill_student_class_memberships)
        await conn.run_sync(_migrate_questions_asked_course_and_rag)
        await conn.run_sync(_migrate_questions_course_and_type)
        await conn.run_sync(_migrate_question_generation_tasks)
        await conn.run_sync(_migrate_document_process_tasks)
        await conn.run_sync(_migrate_chapter_config_preview_video)
        await conn.run_sync(_migrate_answer_records_scene_and_wrong_reason)
        await conn.run_sync(_migrate_review_records)
        await conn.run_sync(_migrate_course_question_synonyms)
    async with AsyncSessionLocal() as session:
        await seed(session)


if __name__ == "__main__":
    asyncio.run(run_seed())
