"""教师端：教学内容配置、学情数据监控、教学决策支持与导出"""
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
import io
import csv

from ..db import get_db
from ..db.models import (
    User, Class, Chapter, Question, KnowledgePoint, KnowledgeDocument,
    PreviewRecord, AnswerRecord, QuestionAsked, ChapterConfig,
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
    r_ch = await db.execute(select(Chapter).order_by(Chapter.order_index, Chapter.id))
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
    from fastapi import HTTPException
    r = await db.execute(select(Chapter).where(Chapter.id == body.chapter_id))
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
