"""数据层模型：知识库、题库、学习行为、用户"""
from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, Float, Boolean, DateTime, ForeignKey, Enum as SQLEnum
from sqlalchemy.orm import declarative_base, relationship
import enum


class Difficulty(str, enum.Enum):
    basic = "basic"      # 基础
    applied = "applied"  # 应用
    extended = "extended"  # 拓展


class UserRole(str, enum.Enum):
    student = "student"
    teacher = "teacher"
    admin = "admin"


Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(64), unique=True, nullable=False, index=True)
    hashed_password = Column(String(128), nullable=False)
    role = Column(String(20), default=UserRole.student.value, nullable=False)
    display_name = Column(String(64), nullable=True)
    class_id = Column(Integer, ForeignKey("classes.id"), nullable=True)  # 学生所属班级
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Class(Base):
    __tablename__ = "classes"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(64), nullable=False)
    term = Column(String(32), nullable=True)  # 学期
    created_at = Column(DateTime, default=datetime.utcnow)


# ---------- 课程（通用平台多课程） ----------
class Course(Base):
    __tablename__ = "courses"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(128), nullable=False)
    code = Column(String(32), unique=True, nullable=True, index=True)
    description = Column(Text, nullable=True)
    is_active = Column(Boolean, default=True)
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


class KnowledgeDocument(Base):
    """知识库文档：教材摘录、PPT 解析文本、电商案例"""
    __tablename__ = "knowledge_documents"
    id = Column(Integer, primary_key=True, autoincrement=True)
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=True)
    source_type = Column(String(32), nullable=False)  # textbook | ppt | ecommerce_case
    title = Column(String(256), nullable=False)
    content = Column(Text, nullable=False)
    page_ref = Column(String(64), nullable=True)  # PPT 页码等
    reviewed_at = Column(DateTime, nullable=True)  # 内容审核：复核通过后写入，先审后发
    created_at = Column(DateTime, default=datetime.utcnow)


# ---------- 习题题库 ----------
class Question(Base):
    __tablename__ = "questions"
    id = Column(Integer, primary_key=True, autoincrement=True)
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=False)
    knowledge_point_ids = Column(String(256), nullable=True)  # 逗号分隔考点 id
    difficulty = Column(String(20), default=Difficulty.basic.value)
    question_text = Column(Text, nullable=False)
    options = Column(Text, nullable=True)  # JSON: ["A选项","B选项",...]
    correct_answer = Column(String(32), nullable=False)  # 选项键或简答要点
    explanation = Column(Text, nullable=True)
    ppt_ref = Column(String(128), nullable=True)
    is_active = Column(Boolean, default=True)
    is_approved = Column(Boolean, default=True)  # 内容审核：教师复核后为 True，先审后发
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


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
    user_answer = Column(String(256), nullable=False)
    is_correct = Column(Boolean, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class QuestionAsked(Base):
    """学生提问记录（课中/课后答疑）"""
    __tablename__ = "questions_asked"
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    chapter_id = Column(Integer, ForeignKey("chapters.id"), nullable=True)
    question_text = Column(Text, nullable=False)
    answer_text = Column(Text, nullable=True)
    ppt_ref = Column(String(128), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


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
    content = Column(Text, nullable=False)
    source = Column(String(32), default="form")  # form | dialogue
    created_at = Column(DateTime, default=datetime.utcnow)
