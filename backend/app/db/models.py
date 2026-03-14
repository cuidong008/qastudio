"""数据层模型：知识库、题库、学习行为、用户"""
from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, Float, Boolean, DateTime, ForeignKey, Enum as SQLEnum, UniqueConstraint
from sqlalchemy.orm import declarative_base, relationship
import enum


class Difficulty(str, enum.Enum):
    basic = "basic"      # 基础
    applied = "applied"  # 应用
    extended = "extended"  # 拓展


class UserRole(str, enum.Enum):
    student = "student"
    teacher = "teacher"
    teaching_leader = "teaching_leader"  # 教研组长，权限同教师
    admin = "admin"


Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    student_no = Column(String(32), unique=True, nullable=True, index=True)  # 学号（教师则为工号）
    hashed_password = Column(String(128), nullable=False)
    role = Column(String(20), default=UserRole.student.value, nullable=False)
    display_name = Column(String(64), nullable=True)
    avatar_url = Column(Text, nullable=True)
    username_changed_at = Column(DateTime, nullable=True)  # 非管理员仅可修改一次登录名，修改后记录时间
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=True)  # 学生所属班级
    admin_class_or_dept = Column(String(128), nullable=True)  # 学生：行政班级；教师：部门；可为空
    gender = Column(String(10), nullable=True)  # male / female，可为空
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Class(Base):
    __tablename__ = "classes"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(64), nullable=False)
    term = Column(String(32), nullable=True)  # 学期
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=True, index=True)  # 班级关联课程，列表 JOIN 用
    owner_teacher_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)  # 管理教师，列表按此过滤
    student_count = Column(Integer, default=0, nullable=False)  # 冗余计数，增删学生时同步更新，列表查询免子查询
    created_at = Column(DateTime, default=datetime.utcnow)


class StudentClassMembership(Base):
    """学生与班级多对多关系"""
    __tablename__ = "student_class_memberships"
    __table_args__ = (UniqueConstraint("student_id", "class_id", name="uq_student_class_membership"),)
    id = Column(Integer, primary_key=True, autoincrement=True)
    student_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


# ---------- 课程（通用平台多课程） ----------
class Course(Base):
    __tablename__ = "courses"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(128), nullable=False)
    code = Column(String(32), unique=True, nullable=True, index=True)
    description = Column(Text, nullable=True)
    remark = Column(String(128), nullable=True)  # 备注，可选，最多 128 字符
    is_active = Column(Boolean, default=True)
    owner_teacher_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # 课程归属教师
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Teaching(Base):
    """开课：某课程在某学期对某班级开设，由某教师授课"""
    __tablename__ = "teachings"
    id = Column(Integer, primary_key=True, autoincrement=True)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=False)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=False)
    teacher_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    term = Column(String(32), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


# ---------- 课程知识库 ----------
class Chapter(Base):
    __tablename__ = "chapters"
    id = Column(Integer, primary_key=True, autoincrement=True)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=True)  # 归属课程；迁移后必填
    title = Column(String(128), nullable=False)
    order_index = Column(Integer, default=0)
    syllabus_ref = Column(String(256), nullable=True)  # 教学大纲对应
    created_at = Column(DateTime, default=datetime.utcnow)


class KnowledgePoint(Base):
    __tablename__ = "knowledge_points"
    id = Column(Integer, primary_key=True, autoincrement=True)
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=False)
    title = Column(String(256), nullable=False)
    content = Column(Text, nullable=True)
    ppt_slide_ref = Column(String(128), nullable=True)  # 如 "第3章 第12页"
    order_index = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class DocumentChapter(Base):
    """文档与章节多对多：一个资料可对应多个章节或整门课程（全部）"""
    __tablename__ = "document_chapters"
    __table_args__ = (UniqueConstraint("doc_id", "chapter_id", name="uq_document_chapter"),)
    id = Column(Integer, primary_key=True, autoincrement=True)
    doc_id = Column(Integer, ForeignKey("knowledge_documents.id", ondelete="CASCADE"), nullable=False, index=True)
    chapter_id = Column(Integer, ForeignKey("chapters.id", ondelete="CASCADE"), nullable=False, index=True)


class KnowledgeDocument(Base):
    """知识库文档：教材摘录、PPT 解析文本、电商案例"""
    __tablename__ = "knowledge_documents"
    id = Column(Integer, primary_key=True, autoincrement=True)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=True, index=True)  # 课程（课程级资料或用于列表）
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=True)  # 主章节（兼容/展示用，实际关联以 document_chapters 为准）
    source_type = Column(String(32), nullable=False)  # textbook | ppt | ecommerce_case
    title = Column(String(256), nullable=False)
    content = Column(Text, nullable=False)
    page_ref = Column(String(64), nullable=True)  # PPT 页码等
    file_name = Column(String(256), nullable=True)
    file_path = Column(String(512), nullable=True)
    file_size = Column(Integer, nullable=True)
    parse_status = Column(String(24), nullable=True)  # processing | done | failed
    parse_error = Column(String(512), nullable=True)
    chunk_count = Column(Integer, nullable=True)
    reviewed_at = Column(DateTime, nullable=True)  # 内容审核：复核通过后写入，先审后发
    student_visible = Column(Boolean, default=True)  # 在学生对话窗口、预习页中是否可见
    downloadable = Column(Boolean, default=True)  # 在学生对话窗口、预习页中是否可下载
    created_at = Column(DateTime, default=datetime.utcnow)


# ---------- 习题题库 ----------
class Question(Base):
    __tablename__ = "questions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=True, index=True)
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=False)
    knowledge_point_ids = Column(String(256), nullable=True)  # 逗号分隔考点 id
    question_bank_type = Column(String(20), nullable=False, default="training")  # training | exam
    difficulty_score = Column(Float, nullable=False, default=0.8)  # (0,1)
    difficulty = Column(String(20), default=Difficulty.basic.value)
    question_type = Column(String(24), default="single_choice", nullable=False)  # single_choice | multiple_choice | judge | qa | blank
    question_text = Column(Text, nullable=False)
    options = Column(Text, nullable=True)  # JSON: ["A选项","B选项",...]
    correct_answer = Column(String(32), nullable=False)  # 选项键或简答要点
    explanation = Column(Text, nullable=True)
    remark = Column(String(128), nullable=True)
    ppt_ref = Column(String(128), nullable=True)
    is_active = Column(Boolean, default=True)
    is_approved = Column(Boolean, default=True)  # 内容审核：教师复核后为 True，先审后发
    generated_time = Column(DateTime, default=datetime.utcnow)
    edited_time = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class QuestionGenerationTask(Base):
    __tablename__ = "question_generation_tasks"
    id = Column(Integer, primary_key=True, autoincrement=True)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=False, index=True)
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=False, index=True)
    teacher_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    status = Column(String(24), nullable=False, default="pending")  # pending | running | success | failed
    request_payload = Column(Text, nullable=False, default="{}")
    result_payload = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class DocumentProcessTask(Base):
    __tablename__ = "document_process_tasks"
    id = Column(Integer, primary_key=True, autoincrement=True)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=False, index=True)
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=True, index=True)  # 无章节时按课程解析
    doc_id = Column(Integer, ForeignKey("knowledge_documents.id"), nullable=False, index=True)
    teacher_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    status = Column(String(24), nullable=False, default="pending")  # pending | running | success | failed
    request_payload = Column(Text, nullable=False, default="{}")
    result_payload = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class CourseReindexTask(Base):
    __tablename__ = "course_reindex_tasks"
    id = Column(Integer, primary_key=True, autoincrement=True)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=False, index=True)
    requested_by_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    requested_by_role = Column(String(24), nullable=True)  # teacher | admin
    status = Column(String(24), nullable=False, default="pending")  # pending | running | success | failed
    request_payload = Column(Text, nullable=False, default="{}")
    result_payload = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Paper(Base):
    __tablename__ = "papers"
    id = Column(Integer, primary_key=True, autoincrement=True)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=False, index=True)
    title = Column(String(128), nullable=False)
    paper_type = Column(String(20), nullable=False, default="electronic")  # electronic | file
    paper_bank_type = Column(String(20), nullable=False, default="training")  # training | formal
    question_source = Column(String(20), nullable=False, default="local")  # local | internet
    status = Column(String(24), nullable=False, default="pending")  # pending | reviewed
    is_partial = Column(Boolean, nullable=False, default=False)
    total_score = Column(Float, nullable=False, default=0)
    overall_difficulty = Column(Float, nullable=False, default=0)  # 0~1，值越大越简单
    request_payload = Column(Text, nullable=False, default="{}")
    content_payload = Column(Text, nullable=True)  # 试卷预览内容（JSON）
    error_message = Column(Text, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class PaperFile(Base):
    """文件试卷下的附件（支持多文件：题目与材料可能分布在多个文件中）"""
    __tablename__ = "paper_files"
    id = Column(Integer, primary_key=True, autoincrement=True)
    paper_id = Column(Integer, ForeignKey("papers.id"), nullable=False, index=True)
    file_name = Column(String(256), nullable=False)  # 原始文件名
    file_path = Column(String(512), nullable=False)  # 相对 upload_dir 的路径
    created_at = Column(DateTime, default=datetime.utcnow)


# ---------- PPT 元数据（联动检索） ----------
class PptFile(Base):
    __tablename__ = "ppt_files"
    id = Column(Integer, primary_key=True, autoincrement=True)
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=True)
    file_name = Column(String(256), nullable=False)
    file_path = Column(String(512), nullable=False)
    total_slides = Column(Integer, default=0)
    uploaded_at = Column(DateTime, default=datetime.utcnow)


class PptSlide(Base):
    __tablename__ = "ppt_slides"
    id = Column(Integer, primary_key=True, autoincrement=True)
    ppt_id = Column(Integer, ForeignKey("ppt_files.id"), nullable=False)
    slide_index = Column(Integer, nullable=False)
    text_content = Column(Text, nullable=True)
    keywords = Column(String(512), nullable=True)  # 逗号分隔
    knowledge_point_ids = Column(String(256), nullable=True)


# ---------- 教师章节配置（教学内容配置） ----------
class ChapterConfig(Base):
    __tablename__ = "chapter_configs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=False, unique=True)
    preview_enabled = Column(Boolean, default=True)
    preview_video_url = Column(String(512), nullable=True)  # 课前预习视频地址
    difficulty_filter = Column(String(128), nullable=True)  # 逗号分隔: basic,applied,extended
    question_limit = Column(Integer, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ---------- 学习行为数据 ----------
class PreviewRecord(Base):
    __tablename__ = "preview_records"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=False)
    completed = Column(Boolean, default=False)
    weak_points = Column(Text, nullable=True)  # JSON 薄弱点
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class AnswerRecord(Base):
    __tablename__ = "answer_records"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    question_id = Column(Integer, ForeignKey("questions.id"), nullable=False)
    scene = Column(String(24), default="exercise", nullable=False)  # preview | review | exercise
    user_answer = Column(String(256), nullable=False)
    is_correct = Column(Boolean, nullable=False)
    wrong_reason = Column(String(32), nullable=True)  # concept | reading | calculation
    created_at = Column(DateTime, default=datetime.utcnow)


class ReviewRecord(Base):
    __tablename__ = "review_records"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=False)
    recall_points = Column(Text, nullable=False)  # JSON: ["关键点1","关键点2","关键点3"]
    created_at = Column(DateTime, default=datetime.utcnow)


class QuestionAsked(Base):
    """学生提问记录（课中/课后答疑）"""
    __tablename__ = "questions_asked"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=True, index=True)
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=True)
    question_text = Column(Text, nullable=False)
    answer_text = Column(Text, nullable=True)
    ppt_ref = Column(String(128), nullable=True)
    rag_hit = Column(Boolean, nullable=False, default=False)
    # 仅当本地知识库未命中、由大模型回答后，由大模型判断：True=与课程无关，False=与课程有关，None=未判断（如 RAG 命中）
    course_irrelevant = Column(Boolean, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class CourseQuestionSynonym(Base):
    """课程问句同义映射：自动学习/维护，用于高频问题归并"""
    __tablename__ = "course_question_synonyms"
    __table_args__ = (UniqueConstraint("course_id", "source_term", name="uq_course_question_synonym"),)
    id = Column(Integer, primary_key=True, autoincrement=True)
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=False, index=True)
    source_term = Column(String(128), nullable=False)
    target_term = Column(String(128), nullable=False)
    confidence = Column(Float, nullable=False, default=0.8)
    status = Column(String(16), nullable=False, default="active")  # active | disabled
    auto_generated = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ---------- 系统配置（如 RAG 通过 Web 界面配置，存库优先于 .env）----------
class RagConfig(Base):
    """RAG 等系统配置：key-value，Web 界面编辑后写入此处，get_rag_settings 优先读库"""
    __tablename__ = "rag_config"
    key = Column(String(128), primary_key=True)
    value = Column(Text, nullable=True)


class StudentFeedback(Base):
    """学生反馈（产品内建反馈入口 + 问卷/对话收集）；展示与导出时采用标识匿名化"""
    __tablename__ = "student_feedbacks"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # 可选，匿名化时用内部 id 替代展示
    course_id = Column(Integer, ForeignKey("courses.id"), nullable=True, index=True)  # 关联课程（课中提交时带当前课程）
    content = Column(Text, nullable=False)
    source = Column(String(32), default="form")  # form | dialogue
    reply_text = Column(Text, nullable=True)  # 教师/管理员回复内容
    status = Column(String(32), nullable=True, default="待处理")  # 待处理 | 处理中 | 已处理
    created_at = Column(DateTime, default=datetime.utcnow)  # 反馈时间
    processed_at = Column(DateTime, nullable=True)  # 处理回复时间：状态变更时更新
