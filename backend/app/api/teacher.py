"""教师端：教学内容配置、课程/班级管理、学情数据监控与导出"""
from fastapi import APIRouter, Depends, Query, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
import io
import csv

from ..db import get_db
from ..db.models import (
    User, Class, Course, Chapter, Teaching, UserRole,
    Question, KnowledgePoint, KnowledgeDocument, PreviewRecord,
    AnswerRecord, QuestionAsked, ChapterConfig,
)
from ..api.auth import require_teacher

router = APIRouter(prefix="/teacher", tags=["teacher"])


class ConfigChapterIn(BaseModel):
    chapter_id: int
    preview_enabled: bool = True
    difficulty_filter: list[str] | None = None  # 只开放某几种难度
    question_limit: int | None = None


class ChapterConfigOut(BaseModel):
    chapter_id: int
    title: str
    preview_enabled: bool
    difficulty_filter: list[str]  # 解析后的列表
    question_limit: int | None


class StatsOverviewOut(BaseModel):
    preview_completion_rate: float
    total_questions_asked: int
    top_asked: list[dict]
    answer_accuracy_rate: float
    weak_knowledge_points: list[str]


@router.get("/config/chapters", response_model=list[ChapterConfigOut])
async def list_chapter_configs(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """获取所有章节及其配置（用于教师端配置页）"""
    chapter_qry = select(Chapter).order_by(Chapter.order_index, Chapter.id)
    if user.role == UserRole.teacher.value:
        chapter_qry = (
            select(Chapter)
            .join(Course, Course.id == Chapter.course_id)
            .where(Course.owner_teacher_id == user.id)
            .order_by(Chapter.order_index, Chapter.id)
        )
    r_ch = await db.execute(chapter_qry)
    chapters = r_ch.scalars().all()
    r_cfg = await db.execute(select(ChapterConfig))
    configs = {c.chapter_id: c for c in r_cfg.scalars().all()}
    out = []
    for ch in chapters:
        cfg = configs.get(ch.id)
        df = (cfg.difficulty_filter or "").strip()
        difficulty_filter = [x.strip() for x in df.split(",") if x.strip()] if df else []
        out.append(ChapterConfigOut(
            chapter_id=ch.id,
            title=ch.title,
            preview_enabled=cfg.preview_enabled if cfg else True,
            difficulty_filter=difficulty_filter,
            question_limit=cfg.question_limit if cfg else None,
        ))
    return out


@router.put("/config/chapter")
async def config_chapter(
    body: ConfigChapterIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """持久化章节配置：预习开关、难度筛选、题量限制"""
    chapter_qry = select(Chapter).where(Chapter.id == body.chapter_id)
    if user.role == UserRole.teacher.value:
        chapter_qry = (
            select(Chapter)
            .join(Course, Course.id == Chapter.course_id)
            .where(Chapter.id == body.chapter_id, Course.owner_teacher_id == user.id)
        )
    r = await db.execute(chapter_qry)
    if not r.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="章节不存在")
    r = await db.execute(select(ChapterConfig).where(ChapterConfig.chapter_id == body.chapter_id))
    cfg = r.scalar_one_or_none()
    difficulty_str = ",".join(body.difficulty_filter) if body.difficulty_filter else None
    if cfg:
        cfg.preview_enabled = body.preview_enabled
        cfg.difficulty_filter = difficulty_str
        cfg.question_limit = body.question_limit
    else:
        cfg = ChapterConfig(
            chapter_id=body.chapter_id,
            preview_enabled=body.preview_enabled,
            difficulty_filter=difficulty_str,
            question_limit=body.question_limit,
        )
        db.add(cfg)
    await db.commit()
    return {"ok": True, "chapter_id": body.chapter_id}


class TeacherCourseOut(BaseModel):
    id: int
    name: str
    code: str | None
    description: str | None
    is_active: bool
    owner_teacher_id: int | None
    created_at: str | None


class TeacherCourseCreateIn(BaseModel):
    name: str
    code: str | None = None
    description: str | None = None
    is_active: bool = True


class TeacherCourseUpdateIn(BaseModel):
    name: str | None = None
    code: str | None = None
    description: str | None = None
    is_active: bool | None = None


class TeacherChapterOut(BaseModel):
    id: int
    course_id: int | None
    title: str
    order_index: int
    syllabus_ref: str | None


class TeacherChapterCreateIn(BaseModel):
    title: str
    order_index: int = 0
    syllabus_ref: str | None = None


class TeacherChapterUpdateIn(BaseModel):
    title: str | None = None
    order_index: int | None = None
    syllabus_ref: str | None = None


class TeacherClassOut(BaseModel):
    id: int
    name: str
    term: str | None
    course_id: int | None
    course_name: str | None = None
    owner_teacher_id: int | None
    student_count: int = 0
    created_at: str | None


class TeacherClassCreateIn(BaseModel):
    name: str
    term: str | None = None
    course_id: int


class TeacherClassUpdateIn(BaseModel):
    name: str | None = None
    term: str | None = None
    course_id: int | None = None


class TeacherStudentOut(BaseModel):
    id: int
    username: str
    display_name: str | None
    class_id: int | None


class TeacherClassStudentsAssignIn(BaseModel):
    student_ids: list[int]


async def _require_owned_course(db: AsyncSession, teacher_id: int, course_id: int) -> Course:
    r = await db.execute(select(Course).where(Course.id == course_id, Course.owner_teacher_id == teacher_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="课程不存在或无权限")
    return c


async def _require_owned_class(db: AsyncSession, teacher_id: int, class_id: int) -> Class:
    r = await db.execute(select(Class).where(Class.id == class_id, Class.owner_teacher_id == teacher_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="班级不存在或无权限")
    return c


@router.get("/courses", response_model=list[TeacherCourseOut])
async def list_teacher_courses(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(select(Course).where(Course.owner_teacher_id == user.id).order_by(Course.id))
    rows = r.scalars().all()
    return [
        TeacherCourseOut(
            id=c.id,
            name=c.name,
            code=c.code,
            description=c.description,
            is_active=c.is_active,
            owner_teacher_id=c.owner_teacher_id,
            created_at=c.created_at.isoformat() if c.created_at else None,
        )
        for c in rows
    ]


@router.post("/courses", response_model=TeacherCourseOut)
async def create_teacher_course(
    body: TeacherCourseCreateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    if body.code:
        r = await db.execute(select(Course).where(Course.code == body.code.strip()))
        if r.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="课程代码已存在")
    c = Course(
        name=body.name.strip(),
        code=body.code.strip() if body.code else None,
        description=body.description,
        is_active=body.is_active,
        owner_teacher_id=user.id,
    )
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return TeacherCourseOut(
        id=c.id,
        name=c.name,
        code=c.code,
        description=c.description,
        is_active=c.is_active,
        owner_teacher_id=c.owner_teacher_id,
        created_at=c.created_at.isoformat() if c.created_at else None,
    )


@router.put("/courses/{course_id}", response_model=TeacherCourseOut)
async def update_teacher_course(
    course_id: int,
    body: TeacherCourseUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    c = await _require_owned_course(db, user.id, course_id)
    if body.name is not None:
        c.name = body.name.strip()
    if body.code is not None:
        code = body.code.strip() if body.code else None
        if code and code != c.code:
            r_dup = await db.execute(select(Course).where(Course.code == code, Course.id != c.id))
            if r_dup.scalar_one_or_none():
                raise HTTPException(status_code=400, detail="课程代码已存在")
        c.code = code
    if body.description is not None:
        c.description = body.description
    if body.is_active is not None:
        c.is_active = body.is_active
    await db.commit()
    await db.refresh(c)
    return TeacherCourseOut(
        id=c.id,
        name=c.name,
        code=c.code,
        description=c.description,
        is_active=c.is_active,
        owner_teacher_id=c.owner_teacher_id,
        created_at=c.created_at.isoformat() if c.created_at else None,
    )


@router.delete("/courses/{course_id}")
async def delete_teacher_course(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    c = await _require_owned_course(db, user.id, course_id)
    await db.delete(c)
    await db.commit()
    return {"ok": True}


@router.post("/courses/{course_id}/reindex")
async def reindex_teacher_course(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_course(db, user.id, course_id)
    from ..services.rag_index_service import build_index_for_course
    count = await build_index_for_course(db, course_id)
    return {"ok": True, "chunks_indexed": count}


@router.get("/courses/{course_id}/chapters", response_model=list[TeacherChapterOut])
async def list_teacher_course_chapters(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_course(db, user.id, course_id)
    r = await db.execute(select(Chapter).where(Chapter.course_id == course_id).order_by(Chapter.order_index, Chapter.id))
    rows = r.scalars().all()
    return [TeacherChapterOut(id=ch.id, course_id=ch.course_id, title=ch.title, order_index=ch.order_index, syllabus_ref=ch.syllabus_ref) for ch in rows]


@router.post("/courses/{course_id}/chapters", response_model=TeacherChapterOut)
async def create_teacher_chapter(
    course_id: int,
    body: TeacherChapterCreateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_course(db, user.id, course_id)
    ch = Chapter(course_id=course_id, title=body.title.strip(), order_index=body.order_index, syllabus_ref=body.syllabus_ref)
    db.add(ch)
    await db.commit()
    await db.refresh(ch)
    return TeacherChapterOut(id=ch.id, course_id=ch.course_id, title=ch.title, order_index=ch.order_index, syllabus_ref=ch.syllabus_ref)


@router.put("/chapters/{chapter_id}", response_model=TeacherChapterOut)
async def update_teacher_chapter(
    chapter_id: int,
    body: TeacherChapterUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(
        select(Chapter, Course)
        .join(Course, Course.id == Chapter.course_id)
        .where(Chapter.id == chapter_id, Course.owner_teacher_id == user.id)
    )
    row = r.first()
    if not row:
        raise HTTPException(status_code=404, detail="章节不存在或无权限")
    ch = row[0]
    if body.title is not None:
        ch.title = body.title.strip()
    if body.order_index is not None:
        ch.order_index = body.order_index
    if body.syllabus_ref is not None:
        ch.syllabus_ref = body.syllabus_ref
    await db.commit()
    await db.refresh(ch)
    return TeacherChapterOut(id=ch.id, course_id=ch.course_id, title=ch.title, order_index=ch.order_index, syllabus_ref=ch.syllabus_ref)


@router.delete("/chapters/{chapter_id}")
async def delete_teacher_chapter(
    chapter_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(
        select(Chapter, Course)
        .join(Course, Course.id == Chapter.course_id)
        .where(Chapter.id == chapter_id, Course.owner_teacher_id == user.id)
    )
    row = r.first()
    if not row:
        raise HTTPException(status_code=404, detail="章节不存在或无权限")
    ch = row[0]
    await db.delete(ch)
    await db.commit()
    return {"ok": True}


@router.get("/classes", response_model=list[TeacherClassOut])
async def list_teacher_classes(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    r = await db.execute(select(Class).where(Class.owner_teacher_id == user.id).order_by(Class.id))
    rows = r.scalars().all()
    course_ids = [c.course_id for c in rows if c.course_id is not None]
    courses: dict[int, str] = {}
    if course_ids:
        r_course = await db.execute(select(Course).where(Course.id.in_(course_ids)))
        courses = {c.id: c.name for c in r_course.scalars().all()}
    counts: dict[int, int] = {}
    if rows:
        r_count = await db.execute(
            select(User.class_id, func.count(User.id))
            .where(User.role == UserRole.student.value, User.class_id.in_([c.id for c in rows]))
            .group_by(User.class_id)
        )
        counts = {cid: cnt for cid, cnt in r_count.all()}
    return [
        TeacherClassOut(
            id=c.id,
            name=c.name,
            term=c.term,
            course_id=c.course_id,
            course_name=courses.get(c.course_id) if c.course_id else None,
            owner_teacher_id=c.owner_teacher_id,
            student_count=counts.get(c.id, 0),
            created_at=c.created_at.isoformat() if c.created_at else None,
        )
        for c in rows
    ]


@router.post("/classes", response_model=TeacherClassOut)
async def create_teacher_class(
    body: TeacherClassCreateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    course = await _require_owned_course(db, user.id, body.course_id)
    c = Class(
        name=body.name.strip(),
        term=body.term,
        course_id=course.id,
        owner_teacher_id=user.id,
    )
    db.add(c)
    await db.flush()
    r_teaching = await db.execute(
        select(Teaching).where(
            Teaching.course_id == course.id,
            Teaching.class_id == c.id,
            Teaching.teacher_id == user.id,
        )
    )
    if not r_teaching.scalar_one_or_none():
        db.add(
            Teaching(
                course_id=course.id,
                class_id=c.id,
                teacher_id=user.id,
                term=body.term,
                is_active=True,
            )
        )
    await db.commit()
    await db.refresh(c)
    return TeacherClassOut(
        id=c.id,
        name=c.name,
        term=c.term,
        course_id=c.course_id,
        course_name=course.name,
        owner_teacher_id=c.owner_teacher_id,
        student_count=0,
        created_at=c.created_at.isoformat() if c.created_at else None,
    )


@router.put("/classes/{class_id}", response_model=TeacherClassOut)
async def update_teacher_class(
    class_id: int,
    body: TeacherClassUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    c = await _require_owned_class(db, user.id, class_id)
    next_course: Course | None = None
    if body.course_id is not None:
        next_course = await _require_owned_course(db, user.id, body.course_id)
        c.course_id = next_course.id
    if body.name is not None:
        c.name = body.name.strip()
    if body.term is not None:
        c.term = body.term
    if c.course_id is not None:
        # 保证班级与课程存在本教师授课关系
        r_teaching = await db.execute(
            select(Teaching).where(
                Teaching.course_id == c.course_id,
                Teaching.class_id == c.id,
                Teaching.teacher_id == user.id,
            )
        )
        if not r_teaching.scalar_one_or_none():
            db.add(
                Teaching(
                    course_id=c.course_id,
                    class_id=c.id,
                    teacher_id=user.id,
                    term=c.term,
                    is_active=True,
                )
            )
    await db.commit()
    await db.refresh(c)
    r_count = await db.execute(
        select(func.count(User.id)).where(User.role == UserRole.student.value, User.class_id == c.id)
    )
    student_count = r_count.scalar() or 0
    if not next_course and c.course_id is not None:
        r_course = await db.execute(select(Course).where(Course.id == c.course_id))
        next_course = r_course.scalar_one_or_none()
    return TeacherClassOut(
        id=c.id,
        name=c.name,
        term=c.term,
        course_id=c.course_id,
        course_name=next_course.name if next_course else None,
        owner_teacher_id=c.owner_teacher_id,
        student_count=student_count,
        created_at=c.created_at.isoformat() if c.created_at else None,
    )


@router.delete("/classes/{class_id}")
async def delete_teacher_class(
    class_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    c = await _require_owned_class(db, user.id, class_id)
    await db.delete(c)
    await db.commit()
    return {"ok": True}


@router.get("/classes/{class_id}/students", response_model=list[TeacherStudentOut])
async def list_teacher_class_students(
    class_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_class(db, user.id, class_id)
    r = await db.execute(
        select(User)
        .where(User.role == UserRole.student.value, User.class_id == class_id)
        .order_by(User.id)
    )
    return [TeacherStudentOut(id=s.id, username=s.username, display_name=s.display_name, class_id=s.class_id) for s in r.scalars().all()]


@router.post("/classes/{class_id}/students/assign")
async def assign_students_to_teacher_class(
    class_id: int,
    body: TeacherClassStudentsAssignIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_class(db, user.id, class_id)
    ids = [i for i in body.student_ids if isinstance(i, int)]
    if not ids:
        raise HTTPException(status_code=400, detail="请选择学生")
    r = await db.execute(select(User).where(User.id.in_(ids), User.role == UserRole.student.value))
    students = r.scalars().all()
    if not students:
        raise HTTPException(status_code=404, detail="学生不存在")
    for s in students:
        s.class_id = class_id
    await db.commit()
    return {"ok": True, "assigned": len(students)}


@router.get("/students", response_model=list[TeacherStudentOut])
async def list_students_for_teacher(
    q: str | None = Query(None),
    only_unassigned: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    qry = select(User).where(User.role == UserRole.student.value).order_by(User.id)
    if q:
        keyword = f"%{q.strip()}%"
        qry = qry.where((User.username.like(keyword)) | (User.display_name.like(keyword)))
    if only_unassigned:
        qry = qry.where(User.class_id == None)
    r = await db.execute(qry)
    return [TeacherStudentOut(id=s.id, username=s.username, display_name=s.display_name, class_id=s.class_id) for s in r.scalars().all()]


async def _user_ids_by_class(db: AsyncSession, class_id: int | None):
    """若指定 class_id，返回该班级用户 id 列表，用于过滤统计；否则返回 None 表示不过滤"""
    if class_id is None:
        return None
    r = await db.execute(select(User.id).where(User.class_id == class_id))
    return [row[0] for row in r.all()]


@router.get("/stats/overview", response_model=StatsOverviewOut)
async def stats_overview(
    class_id: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    if class_id is not None and user.role == UserRole.teacher.value:
        await _require_owned_class(db, user.id, class_id)
    user_ids = await _user_ids_by_class(db, class_id)

    # 预习完成率（可选按班级）
    q_pr = select(func.count(PreviewRecord.id))
    q_pr_done = select(func.count(PreviewRecord.id)).where(PreviewRecord.completed == True)
    if user_ids is not None:
        q_pr = q_pr.where(PreviewRecord.user_id.in_(user_ids))
        q_pr_done = q_pr_done.where(PreviewRecord.user_id.in_(user_ids))
    total_preview = await db.execute(q_pr)
    completed_preview = await db.execute(q_pr_done)
    pr_total = total_preview.scalar() or 0
    pr_done = completed_preview.scalar() or 0
    preview_rate = (pr_done / pr_total * 100) if pr_total else 0.0

    # 提问总数与高频问题
    q_qa = select(func.count(QuestionAsked.id))
    if user_ids is not None:
        q_qa = q_qa.where(QuestionAsked.user_id.in_(user_ids))
    qa_total = await db.execute(q_qa)
    total_asked = qa_total.scalar() or 0
    top_q_stmt = (
        select(QuestionAsked.question_text, func.count(QuestionAsked.id).label("c"))
        .group_by(QuestionAsked.question_text)
        .order_by(func.count(QuestionAsked.id).desc())
        .limit(5)
    )
    if user_ids is not None:
        top_q_stmt = top_q_stmt.where(QuestionAsked.user_id.in_(user_ids))
    top_q = await db.execute(top_q_stmt)
    top_asked = [{"question": r[0], "count": r[1]} for r in top_q.all()]

    # 作答正确率
    q_ans = select(func.count(AnswerRecord.id))
    q_ans_ok = select(func.count(AnswerRecord.id)).where(AnswerRecord.is_correct == True)
    if user_ids is not None:
        q_ans = q_ans.where(AnswerRecord.user_id.in_(user_ids))
        q_ans_ok = q_ans_ok.where(AnswerRecord.user_id.in_(user_ids))
    total_answers = await db.execute(q_ans)
    correct_answers = await db.execute(q_ans_ok)
    ans_total = total_answers.scalar() or 0
    ans_ok = correct_answers.scalar() or 0
    accuracy = (ans_ok / ans_total * 100) if ans_total else 0.0

    # 薄弱知识点：从错题对应的题目考点（knowledge_point_ids）解析出知识点标题
    wrong_q_ids = (
        select(AnswerRecord.question_id)
        .where(AnswerRecord.is_correct == False)
    )
    if user_ids is not None:
        wrong_q_ids = wrong_q_ids.where(AnswerRecord.user_id.in_(user_ids))
    wrong_q_ids = wrong_q_ids.distinct()
    r_wrong = await db.execute(wrong_q_ids)
    wqids = [row[0] for row in r_wrong.all()]
    weak_titles: list[str] = []
    if wqids:
        r_questions = await db.execute(select(Question).where(Question.id.in_(wqids)))
        questions = r_questions.scalars().all()
        kp_ids = set()
        for q in questions:
            if q.knowledge_point_ids:
                for x in str(q.knowledge_point_ids).split(","):
                    x = x.strip()
                    if x.isdigit():
                        kp_ids.add(int(x))
        if kp_ids:
            r_kp = await db.execute(select(KnowledgePoint.title).where(KnowledgePoint.id.in_(kp_ids)))
            weak_titles = [row[0] for row in r_kp.all()]
    if not weak_titles and (ans_total or total_asked):
        weak_titles = []  # 无错题时留空，不再写死

    return StatsOverviewOut(
        preview_completion_rate=round(preview_rate, 1),
        total_questions_asked=total_asked,
        top_asked=top_asked,
        answer_accuracy_rate=round(accuracy, 1),
        weak_knowledge_points=weak_titles,
    )


class ApproveContentIn(BaseModel):
    type: str  # "question" | "document"
    id: int


@router.post("/content/approve")
async def approve_content(
    body: ApproveContentIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    """内容安全与审核：教师复核通过题目或知识库文档（先审后发占位流程）"""
    from datetime import datetime
    from fastapi import HTTPException
    if body.type == "question":
        r = await db.execute(select(Question).where(Question.id == body.id))
        q = r.scalar_one_or_none()
        if not q:
            raise HTTPException(status_code=404, detail="题目不存在")
        q.is_approved = True
    elif body.type == "document":
        r = await db.execute(select(KnowledgeDocument).where(KnowledgeDocument.id == body.id))
        doc = r.scalar_one_or_none()
        if not doc:
            raise HTTPException(status_code=404, detail="知识库文档不存在")
        doc.reviewed_at = datetime.utcnow()
    else:
        raise HTTPException(status_code=400, detail="type 须为 question 或 document")
    await db.commit()
    return {"ok": True, "type": body.type, "id": body.id}


@router.get("/export/csv")
async def export_csv(
    report: str = Query("overview", description="overview | preview | answers | qa"),
    user: User = Depends(require_teacher),
    db: AsyncSession = Depends(get_db),
):
    """导出学情数据为 CSV"""
    output = io.StringIO()
    writer = csv.writer(output)

    if report == "preview":
        writer.writerow(["user_id", "chapter_id", "completed", "completed_at"])
        result = await db.execute(
            select(PreviewRecord).order_by(PreviewRecord.created_at.desc()).limit(500)
        )
        for r in result.scalars().all():
            writer.writerow([r.user_id, r.chapter_id, r.completed, r.completed_at])
    elif report == "answers":
        writer.writerow(["user_id", "question_id", "user_answer", "is_correct", "created_at"])
        result = await db.execute(
            select(AnswerRecord).order_by(AnswerRecord.created_at.desc()).limit(500)
        )
        for r in result.scalars().all():
            writer.writerow([r.user_id, r.question_id, r.user_answer, r.is_correct, r.created_at])
    elif report == "qa":
        writer.writerow(["user_id", "chapter_id", "question_text", "answer_text", "created_at"])
        result = await db.execute(
            select(QuestionAsked).order_by(QuestionAsked.created_at.desc()).limit(500)
        )
        for r in result.scalars().all():
            writer.writerow([r.user_id, r.chapter_id, r.question_text, r.answer_text, r.created_at])
    else:
        writer.writerow(["metric", "value"])
        st = await stats_overview(db=db, user=user)
        writer.writerow(["preview_completion_rate", st.preview_completion_rate])
        writer.writerow(["total_questions_asked", st.total_questions_asked])
        writer.writerow(["answer_accuracy_rate", st.answer_accuracy_rate])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue().encode("utf-8-sig")]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=teacher_export.csv"},
    )
