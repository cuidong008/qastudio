"""教师端：教学内容配置、课程/班级管理、学情数据监控与导出"""
import base64
import csv
import io
import json
import logging
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Query, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse, FileResponse
from openai import OpenAI
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db import get_db
from ..db.models import (
    User, Class, Course, Chapter, Teaching, UserRole,
    StudentClassMembership,
    Question, KnowledgePoint, KnowledgeDocument, PreviewRecord,
    AnswerRecord, QuestionAsked, ChapterConfig,
)
from ..api.auth import require_teacher
from ..services.chapter_cleanup_service import cleanup_chapter_related_data
from ..services.course_knowledge_service import clear_course_knowledge

router = APIRouter(prefix="/teacher", tags=["teacher"])
logger = logging.getLogger(__name__)


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


class TeacherDocumentChunkOut(BaseModel):
    index: int
    text: str


class TeacherKnowledgeDocumentOut(BaseModel):
    id: int
    chapter_id: int | None
    source_type: str
    title: str
    page_ref: str | None
    file_name: str | None
    file_size: int | None
    parse_status: str | None
    parse_error: str | None
    chunk_count: int | None
    created_at: str | None


class TeacherKnowledgeDocumentDetailOut(TeacherKnowledgeDocumentOut):
    content_preview: str
    chunks: list[TeacherDocumentChunkOut]


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
    student_no: str | None
    display_name: str | None


class TeacherClassStudentsAssignIn(BaseModel):
    student_ids: list[int] = []
    student_no: str | None = None
    name: str | None = None


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


async def _require_owned_chapter(db: AsyncSession, teacher_id: int, chapter_id: int) -> tuple[Chapter, Course]:
    r = await db.execute(
        select(Chapter, Course)
        .join(Course, Course.id == Chapter.course_id)
        .where(Chapter.id == chapter_id, Course.owner_teacher_id == teacher_id)
    )
    row = r.first()
    if not row:
        raise HTTPException(status_code=404, detail="章节不存在或无权限")
    return row[0], row[1]


async def _require_owned_document(db: AsyncSession, teacher_id: int, doc_id: int) -> tuple[KnowledgeDocument, Chapter, Course]:
    r = await db.execute(
        select(KnowledgeDocument, Chapter, Course)
        .join(Chapter, Chapter.id == KnowledgeDocument.chapter_id)
        .join(Course, Course.id == Chapter.course_id)
        .where(KnowledgeDocument.id == doc_id, Course.owner_teacher_id == teacher_id)
    )
    row = r.first()
    if not row:
        raise HTTPException(status_code=404, detail="文档不存在或无权限")
    return row[0], row[1], row[2]


def _safe_pdf_filename(name: str) -> str:
    base, ext = os.path.splitext(name)
    safe = re.sub(r"[^\w\-.]", "_", base)[:96]
    final_ext = ext.lower() if ext.lower() == ".pdf" else ".pdf"
    return (safe or "document") + final_ext


def _pdf_extract_text(content: bytes) -> tuple[str, int]:
    try:
        from pypdf import PdfReader
    except ModuleNotFoundError as e:
        raise HTTPException(status_code=500, detail="缺少依赖 pypdf，请先安装后重试") from e
    try:
        reader = PdfReader(io.BytesIO(content))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PDF 解析失败: {str(e)}")
    pages = []
    for i, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if text:
            pages.append(f"[第{i}页]\n{text}")
    return "\n\n".join(pages).strip(), len(reader.pages)


def _looks_like_useful_text(text: str, prefer_chinese: bool = False) -> bool:
    if not text:
        return False
    stripped = text.strip()
    if len(stripped) < 20:
        return False
    # 至少有一定数量的中英文数字字符，避免只有 markdown 框架或图片链接
    visible_chars = re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", stripped)
    if len(visible_chars) < 15:
        return False
    if prefer_chinese and _cjk_char_count(stripped) < 20:
        return False
    if prefer_chinese:
        cjk = _cjk_char_count(stripped)
        latin = len(re.findall(r"[A-Za-z]", stripped))
        # 中文场景中，若英文字母显著多于中文，通常是 OCR 乱码
        if cjk * 3 < latin:
            return False
    return True


def _cjk_char_count(text: str) -> int:
    if not text:
        return 0
    return len(re.findall(r"[\u4e00-\u9fff]", text))


def _list_tesseract_langs() -> set[str]:
    try:
        proc = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=10)
        if proc.returncode != 0:
            return set()
        langs = set()
        for line in (proc.stdout or "").splitlines():
            s = line.strip()
            if not s or s.lower().startswith("list of available languages"):
                continue
            langs.add(s)
        return langs
    except Exception:
        return set()


def _pdf_extract_text_with_tesseract(content: bytes, prefer_chinese: bool = False) -> tuple[str, int | None]:
    try:
        import pypdfium2 as pdfium
    except ModuleNotFoundError as e:
        raise RuntimeError("缺少 pypdfium2，无法启用 tesseract OCR 兜底") from e
    langs = _list_tesseract_langs()
    has_chinese_lang = "chi_sim" in langs or "chi_tra" in langs
    if "chi_sim" in langs:
        lang = "chi_sim+eng"
    elif "chi_tra" in langs:
        lang = "chi_tra+eng"
    elif "eng" in langs:
        if prefer_chinese:
            raise RuntimeError("tesseract 未安装中文语言包（chi_sim/chi_tra），无法可靠识别中文扫描件")
        lang = "eng"
    else:
        raise RuntimeError("tesseract 缺少可用语言包，请安装 chi_sim 或 eng")

    doc = pdfium.PdfDocument(io.BytesIO(content))
    texts: list[str] = []
    page_count = len(doc)
    with tempfile.TemporaryDirectory(prefix="qastudio_tesseract_") as tmpdir:
        root = Path(tmpdir)
        for i in range(page_count):
            page = doc[i]
            pil_img = page.render(scale=2.2).to_pil()
            img_path = root / f"p{i + 1}.png"
            pil_img.save(img_path)
            cmd = ["tesseract", str(img_path), "stdout", "-l", lang, "--psm", "6"]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
            if proc.returncode != 0:
                logger.warning("tesseract_page_failed page=%s rc=%s stderr=%s", i + 1, proc.returncode, (proc.stderr or "")[:240])
                continue
            txt = (proc.stdout or "").strip()
            if txt:
                texts.append(f"[第{i + 1}页]\n{txt}")
    out = "\n\n".join(texts).strip()
    if not out:
        hint = ""
        if not has_chinese_lang:
            hint = "（当前 tesseract 未安装中文语言包，可安装 chi_sim）"
        raise RuntimeError(f"tesseract OCR 未提取到文本{hint}")
    if prefer_chinese and _cjk_char_count(out) < 20:
        raise RuntimeError("OCR 结果几乎不含中文，可能未安装中文语言包或图片质量过低")
    return out, page_count


def _pdf_extract_text_with_mineru(content: bytes, file_name: str, method: str | None = None) -> tuple[str, int | None]:
    safe_name = _safe_pdf_filename(file_name)
    with tempfile.TemporaryDirectory(prefix="qastudio_mineru_") as tmpdir:
        root = Path(tmpdir)
        in_pdf = root / safe_name
        out_dir = root / "out"
        in_pdf.write_bytes(content)
        out_dir.mkdir(parents=True, exist_ok=True)
        cmd = [
            "mineru",
            "-p",
            str(in_pdf),
            "-o",
            str(out_dir),
            "-m",
            (method or settings.mineru_method or "auto"),
            "-l",
            settings.mineru_lang or "ch",
            "-b",
            settings.mineru_backend or "pipeline",
            "-d",
            settings.mineru_device or "cpu",
            "--vram",
            str(settings.mineru_vram or 1),
            "--source",
            settings.mineru_source or "huggingface",
        ]
        logger.info(
            "mineru_start file=%s size=%s method=%s lang=%s backend=%s device=%s source=%s",
            file_name,
            len(content),
            (method or settings.mineru_method or "auto"),
            settings.mineru_lang or "ch",
            settings.mineru_backend or "pipeline",
            settings.mineru_device or "cpu",
            settings.mineru_source or "huggingface",
        )
        run_env = os.environ.copy()
        run_env.setdefault("MINERU_DEVICE_MODE", settings.mineru_device or "cpu")
        run_env.setdefault("MINERU_VIRTUAL_VRAM_SIZE", str(settings.mineru_vram or 1))
        run_env.setdefault("MINERU_MODEL_SOURCE", settings.mineru_source or "huggingface")
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=run_env)
        except FileNotFoundError as e:
            logger.exception("mineru_not_found file=%s", file_name)
            raise RuntimeError("mineru 命令不存在，请先安装 MinerU") from e
        logger.info(
            "mineru_done file=%s rc=%s stdout_len=%s stderr_len=%s",
            file_name,
            proc.returncode,
            len(proc.stdout or ""),
            len(proc.stderr or ""),
        )
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip()
            logger.error("mineru_failed file=%s detail=%s", file_name, detail[:500])
            if "No module named 'doclayout_yolo'" in detail or 'No module named "doclayout_yolo"' in detail:
                detail = f"{detail}\nHint: pip install doclayout-yolo"
            raise RuntimeError(detail or "MinerU 解析失败")
        out_files = [str(p.relative_to(out_dir)) for p in out_dir.rglob("*") if p.is_file()]
        logger.info("mineru_outputs file=%s count=%s files=%s", file_name, len(out_files), out_files[:30])
        text_candidates: list[str] = []
        for md in sorted(out_dir.rglob("*.md"), key=lambda p: p.stat().st_size, reverse=True):
            try:
                txt = md.read_text(encoding="utf-8", errors="ignore").strip()
                if txt:
                    text_candidates.append(txt)
            except Exception:
                pass
        for txtf in sorted(out_dir.rglob("*.txt"), key=lambda p: p.stat().st_size, reverse=True):
            try:
                txt = txtf.read_text(encoding="utf-8", errors="ignore").strip()
                if txt:
                    text_candidates.append(txt)
            except Exception:
                pass
        for js in sorted(out_dir.rglob("*.json"), key=lambda p: p.stat().st_size, reverse=True):
            try:
                obj = json.loads(js.read_text(encoding="utf-8", errors="ignore"))
            except Exception:
                continue
            pieces: list[str] = []

            def walk(v):
                if isinstance(v, dict):
                    for vv in v.values():
                        walk(vv)
                elif isinstance(v, list):
                    for vv in v:
                        walk(vv)
                elif isinstance(v, str):
                    s = v.strip()
                    if s:
                        pieces.append(s)

            walk(obj)
            if pieces:
                text_candidates.append("\n".join(pieces))
        best = max(text_candidates, key=len).strip() if text_candidates else ""
        logger.info(
            "mineru_text_candidates file=%s candidates=%s best_len=%s",
            file_name,
            len(text_candidates),
            len(best),
        )
        if not best:
            detail = (proc.stderr or proc.stdout or "").strip()
            logger.error("mineru_empty_text file=%s detail=%s", file_name, detail[:500])
            if "No module named 'doclayout_yolo'" in detail or 'No module named "doclayout_yolo"' in detail:
                detail = f"{detail}\nHint: pip install doclayout-yolo"
            raise RuntimeError(f"MinerU 解析后未提取到文本。{detail[:300]}")
        page_count: int | None = None
        try:
            from pypdf import PdfReader
            page_count = len(PdfReader(io.BytesIO(content)).pages)
        except Exception:
            page_count = None
        return best, page_count


def _resolve_pdf_parser_provider(default_pdf_parser: str) -> tuple[dict, str]:
    if not default_pdf_parser or ":" not in default_pdf_parser:
        raise RuntimeError("PDF 外部解析器配置无效（应为 provider_id:model）")
    provider_id, model_name = default_pdf_parser.split(":", 1)
    provider_id, model_name = provider_id.strip(), model_name.strip()
    if not provider_id or not model_name:
        raise RuntimeError("PDF 外部解析器配置无效（provider/model 为空）")

    from ..rag.config_store import get_providers_list_raw
    providers = get_providers_list_raw()
    provider = next((p for p in providers if (p.get("id") or "").strip() == provider_id), None)
    if not provider:
        raise RuntimeError("PDF 外部解析器配置的提供商不存在，请重新选择")
    return provider, model_name


def _create_vlm_client_from_provider(provider: dict) -> OpenAI:
    p_type = (provider.get("type") or "openai_compatible").strip().lower()
    base_url = (provider.get("base_url") or "").strip()
    api_key = (provider.get("api_key") or "").strip()

    if p_type == "openai_compatible":
        base = base_url or "https://api.openai.com/v1"
        if not base.endswith("/v1"):
            base = base.rstrip("/") + "/v1"
        return OpenAI(base_url=base, api_key=api_key or "not-needed")
    if p_type == "qianwen":
        return OpenAI(base_url="https://dashscope.aliyuncs.com/compatible-mode/v1", api_key=api_key)
    if p_type == "zhipu":
        base = base_url or "https://open.bigmodel.cn/api/paas/v4"
        return OpenAI(base_url=base, api_key=api_key)
    raise RuntimeError(f"不支持的提供商类型: {p_type}")


def _pdf_extract_text_with_external_vlm(
    content: bytes,
    file_name: str,
    default_pdf_parser: str,
    prefer_chinese: bool = False,
) -> tuple[str, int]:
    provider, model_name = _resolve_pdf_parser_provider(default_pdf_parser)
    client = _create_vlm_client_from_provider(provider)
    provider_name = provider.get("name") or provider.get("id") or "unknown"

    try:
        import pypdfium2 as pdfium
    except ModuleNotFoundError as e:
        raise RuntimeError("缺少 pypdfium2，无法使用外部模型解析 PDF") from e

    doc = pdfium.PdfDocument(io.BytesIO(content))
    page_count = len(doc)
    if page_count <= 0:
        raise RuntimeError("PDF 页数为 0")

    logger.info(
        "doc_parse_external_vlm_start file=%s provider=%s model=%s pages=%s",
        file_name,
        provider_name,
        model_name,
        page_count,
    )

    page_texts: list[str] = []
    ocr_prompt = (
        "你是 PDF OCR 提取器。请逐字提取图片中的正文文本与表格内容，"
        "保留原有段落与换行，不要总结，不要解释，不要添加额外内容。"
    )

    for i in range(page_count):
        page = doc[i]
        image = page.render(scale=2.0).to_pil()
        with io.BytesIO() as buf:
            image.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")

        # 不同 OpenAI 兼容网关对多模态消息格式要求不一致，做两种格式重试
        message_variants = [
            [
                {"role": "system", "content": ocr_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "请提取这一页的可见文字。"},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                    ],
                },
            ],
            [
                {"role": "system", "content": ocr_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "请提取这一页的可见文字。"},
                        {"type": "image_url", "image_url": f"data:image/png;base64,{b64}"},
                    ],
                },
            ],
        ]

        max_tokens = 1800
        resp = None
        last_err: Exception | None = None
        for messages in message_variants:
            try:
                resp = client.chat.completions.create(
                    model=model_name,
                    messages=messages,
                    temperature=0,
                    max_tokens=max_tokens,
                )
                break
            except Exception as e:
                last_err = e
                msg = str(e)
                m = re.search(r"Range of max_tokens should be \[1,\s*(\d+)\]", msg)
                if m:
                    upper = max(1, int(m.group(1)))
                    try:
                        resp = client.chat.completions.create(
                            model=model_name,
                            messages=messages,
                            temperature=0,
                            max_tokens=min(max_tokens, upper),
                        )
                        break
                    except Exception as e2:
                        last_err = e2
                        continue
                # 仅参数类错误尝试下一个格式，其它错误直接抛出
                if ("invalid_parameter" in msg.lower()) or ("Invalid parameter" in msg):
                    continue
                raise
        if resp is None:
            if last_err is not None:
                raise RuntimeError(f"外部模型请求失败（参数不兼容或模型不支持图像）: {last_err}") from last_err
            raise RuntimeError("外部模型请求失败（未知错误）")
        text = ""
        if resp.choices:
            msg = resp.choices[0].message
            content_obj = msg.content
            if isinstance(content_obj, str):
                text = content_obj.strip()
            elif isinstance(content_obj, list):
                parts = []
                for part in content_obj:
                    if isinstance(part, dict):
                        t = (part.get("text") or "").strip()
                        if t:
                            parts.append(t)
                text = "\n".join(parts).strip()
        if text:
            page_texts.append(f"[第{i + 1}页]\n{text}")

    output = "\n\n".join(page_texts).strip()
    if not _looks_like_useful_text(output, prefer_chinese=prefer_chinese):
        raise RuntimeError("外部模型解析完成，但文本质量不足")
    return output, page_count


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


@router.post("/courses/{course_id}/clear-knowledge")
async def clear_teacher_course_knowledge(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_course(db, user.id, course_id)
    stats = await clear_course_knowledge(db, course_id)
    await db.commit()
    from ..services.rag_index_service import build_index_for_course
    chunks = await build_index_for_course(db, course_id)
    return {"ok": True, "stats": stats, "chunks_indexed": chunks}


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
    ch, course = row[0], row[1]
    await cleanup_chapter_related_data(db, ch.id)
    await db.delete(ch)
    await db.commit()
    try:
        from ..services.rag_index_service import build_index_for_course
        await build_index_for_course(db, course.id)
    except Exception as e:
        logger.warning("delete_chapter_reindex_failed chapter_id=%s course_id=%s err=%s", ch.id, course.id, str(e))
    return {"ok": True}


@router.get("/chapters/{chapter_id}/documents", response_model=list[TeacherKnowledgeDocumentOut])
async def list_teacher_chapter_documents(
    chapter_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_chapter(db, user.id, chapter_id)
    r = await db.execute(
        select(KnowledgeDocument)
        .where(KnowledgeDocument.chapter_id == chapter_id)
        .order_by(KnowledgeDocument.id.desc())
    )
    rows = r.scalars().all()
    return [
        TeacherKnowledgeDocumentOut(
            id=d.id,
            chapter_id=d.chapter_id,
            source_type=d.source_type,
            title=d.title,
            page_ref=d.page_ref,
            file_name=d.file_name,
            file_size=d.file_size,
            parse_status=d.parse_status,
            parse_error=d.parse_error,
            chunk_count=d.chunk_count,
            created_at=d.created_at.isoformat() if d.created_at else None,
        )
        for d in rows
    ]


@router.post("/chapters/{chapter_id}/documents/upload", response_model=TeacherKnowledgeDocumentOut)
async def upload_teacher_chapter_document(
    chapter_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    chapter, course = await _require_owned_chapter(db, user.id, chapter_id)
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="请上传 PDF 文件")
    binary = await file.read()
    if not binary:
        raise HTTPException(status_code=400, detail="文件内容为空")
    root = Path(settings.upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    subdir = root / "knowledge"
    subdir.mkdir(parents=True, exist_ok=True)
    safe_name = _safe_pdf_filename(file.filename)
    saved_name = f"{chapter_id}_{int(time.time())}_{safe_name}"
    abs_path = subdir / saved_name
    abs_path.write_bytes(binary)
    rel_path = f"knowledge/{saved_name}"

    doc = KnowledgeDocument(
        chapter_id=chapter.id,
        source_type="pdf_upload",
        title=file.filename,
        content="",
        file_name=file.filename,
        file_path=rel_path,
        file_size=len(binary),
        parse_status="processing",
    )
    db.add(doc)
    await db.flush()

    try:
        engine = (settings.pdf_parse_engine or "mineru_then_pypdf").strip().lower()
        prefer_chinese = bool(re.search(r"[\u4e00-\u9fff]", file.filename or "")) or (settings.mineru_lang or "").startswith("ch")
        default_pdf_parser = ""
        try:
            from ..rag.config_store import get_default_pdf_parser
            default_pdf_parser = get_default_pdf_parser()
        except Exception:
            default_pdf_parser = ""
        logger.info(
            "doc_parse_start chapter_id=%s course_id=%s file=%s size=%s engine=%s default_pdf_parser=%s",
            chapter.id,
            course.id,
            file.filename,
            len(binary),
            engine,
            bool(default_pdf_parser),
        )
        extracted_text = ""
        total_pages: int | None = None
        mineru_errors: list[str] = []
        if default_pdf_parser:
            try:
                extracted_text, total_pages = _pdf_extract_text_with_external_vlm(
                    binary,
                    file.filename,
                    default_pdf_parser,
                    prefer_chinese=prefer_chinese,
                )
                logger.info(
                    "doc_parse_external_vlm_ok file=%s text_len=%s pages=%s",
                    file.filename,
                    len((extracted_text or "").strip()),
                    total_pages,
                )
            except Exception as e:
                logger.warning("doc_parse_external_vlm_failed file=%s err=%s", file.filename, str(e))
                # 已显式配置外部 PDF 解析器时，按配置严格执行，不再回退本地 MinerU/PyPDF
                raise HTTPException(status_code=400, detail=f"外部 PDF 解析失败: {str(e)}")
        if engine == "mineru":
            if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
                try:
                    extracted_text, total_pages = _pdf_extract_text_with_mineru(binary, file.filename, method=settings.mineru_method or "auto")
                except Exception as e:
                    logger.warning("doc_parse_mineru_auto_error file=%s err=%s", file.filename, str(e))
                    mineru_errors.append(str(e))
                if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
                    try:
                        extracted_text, total_pages = _pdf_extract_text_with_mineru(binary, file.filename, method="ocr")
                    except Exception as e:
                        logger.warning("doc_parse_mineru_ocr_error file=%s err=%s", file.filename, str(e))
                        mineru_errors.append(str(e))
        elif engine == "pypdf":
            if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
                logger.info("doc_parse_use_pypdf file=%s", file.filename)
                try:
                    extracted_text, total_pages = _pdf_extract_text(binary)
                except Exception as e:
                    mineru_errors.append(str(e))
                    extracted_text, total_pages = "", None
                if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
                    try:
                        logger.info("doc_parse_try_tesseract_after_pypdf file=%s", file.filename)
                        extracted_text, total_pages = _pdf_extract_text_with_tesseract(binary, prefer_chinese=prefer_chinese)
                    except Exception as e:
                        logger.warning("doc_parse_tesseract_after_pypdf_failed file=%s err=%s", file.filename, str(e))
                        mineru_errors.append(str(e))
        else:
            if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
                # 默认优先 MinerU（支持扫描版与中文 OCR），失败后降级 pypdf
                try:
                    extracted_text, total_pages = _pdf_extract_text_with_mineru(binary, file.filename, method=settings.mineru_method or "auto")
                    if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
                        logger.info("doc_parse_mineru_auto_low_quality file=%s retry=ocr", file.filename)
                        extracted_text, total_pages = _pdf_extract_text_with_mineru(binary, file.filename, method="ocr")
                except Exception as e:
                    logger.warning("doc_parse_mineru_fallback_to_pypdf file=%s err=%s", file.filename, str(e))
                    mineru_errors.append(str(e))
                    try:
                        extracted_text, total_pages = _pdf_extract_text(binary)
                    except Exception as e2:
                        mineru_errors.append(str(e2))
                        extracted_text, total_pages = "", None
                if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
                    try:
                        fallback_text, fallback_pages = _pdf_extract_text(binary)
                        if len(fallback_text.strip()) > len(extracted_text.strip()):
                            logger.info(
                                "doc_parse_use_pypdf_better_text file=%s mineru_len=%s pypdf_len=%s",
                                file.filename,
                                len(extracted_text.strip()),
                                len(fallback_text.strip()),
                            )
                            extracted_text, total_pages = fallback_text, fallback_pages
                    except Exception:
                        pass
                if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
                    try:
                        logger.info("doc_parse_try_tesseract_after_mineru_pypdf file=%s", file.filename)
                        extracted_text, total_pages = _pdf_extract_text_with_tesseract(binary, prefer_chinese=prefer_chinese)
                    except Exception as e:
                        logger.warning("doc_parse_tesseract_after_mineru_pypdf_failed file=%s err=%s", file.filename, str(e))
                        mineru_errors.append(str(e))
        logger.info(
            "doc_parse_result file=%s text_len=%s pages=%s usable=%s",
            file.filename,
            len((extracted_text or "").strip()),
            total_pages,
            _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese),
        )
        if not _looks_like_useful_text(extracted_text, prefer_chinese=prefer_chinese):
            hints = []
            all_err = "\n".join(mineru_errors)
            if "doclayout_yolo" in all_err:
                hints.append("请在 backend 虚拟环境执行: pip install doclayout-yolo")
            if "No module named 'torch'" in all_err or 'No module named "torch"' in all_err:
                hints.append("请在 backend 虚拟环境执行: pip install torch")
            if "tesseract 未安装中文语言包" in all_err or "几乎不含中文" in all_err:
                hints.append("请安装中文 OCR 语言包: brew install tesseract-lang（并确认 tesseract --list-langs 有 chi_sim）")
            hint_text = f"；建议: {'；'.join(hints)}" if hints else ""
            extra = f"；最后错误: {mineru_errors[-1][:220]}{hint_text}" if mineru_errors else ""
            logger.error("doc_parse_failed_no_text file=%s extra=%s", file.filename, extra)
            raise HTTPException(status_code=400, detail=f"未提取到可用文本，请检查 PDF 或 OCR 配置{extra}")
        doc.content = extracted_text
        doc.page_ref = f"{total_pages}页" if total_pages else None
        doc.parse_error = None
        doc.parse_status = "done"

        from ..rag import ChunkDocument
        from ..rag.chunking import chunk_documents
        preview_chunks = chunk_documents(
            [ChunkDocument(text=(doc.content or "").strip(), course_id=course.id, chapter_id=chapter.id, title=doc.title, source_id=f"doc_{doc.id}")]
        )
        doc.chunk_count = len(preview_chunks)

        from ..services.rag_index_service import build_index_for_course
        try:
            await build_index_for_course(db, course.id)
        except Exception as idx_err:
            # 文档解析成功时不阻断上传；索引异常作为提示返回，便于后续手动重建索引
            logger.exception("doc_reindex_failed file=%s course_id=%s", file.filename, course.id)
            msg = str(idx_err)
            tip = f"索引失败: {msg[:240]}"
            doc.parse_error = f"{doc.parse_error}；{tip}" if doc.parse_error else tip
    except HTTPException as e:
        doc.parse_status = "failed"
        doc.parse_error = e.detail if isinstance(e.detail, str) else str(e.detail)
        await db.commit()
        raise
    except Exception as e:
        logger.exception("doc_parse_unexpected_error file=%s", file.filename)
        doc.parse_status = "failed"
        doc.parse_error = str(e)
        await db.commit()
        raise HTTPException(status_code=400, detail=f"文档处理失败: {str(e)}")

    await db.commit()
    await db.refresh(doc)
    return TeacherKnowledgeDocumentOut(
        id=doc.id,
        chapter_id=doc.chapter_id,
        source_type=doc.source_type,
        title=doc.title,
        page_ref=doc.page_ref,
        file_name=doc.file_name,
        file_size=doc.file_size,
        parse_status=doc.parse_status,
        parse_error=doc.parse_error,
        chunk_count=doc.chunk_count,
        created_at=doc.created_at.isoformat() if doc.created_at else None,
    )


@router.get("/documents/{doc_id}", response_model=TeacherKnowledgeDocumentDetailOut)
async def get_teacher_document_detail(
    doc_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    doc, chapter, course = await _require_owned_document(db, user.id, doc_id)
    chunks_out: list[TeacherDocumentChunkOut] = []
    if doc.content and doc.parse_status == "done":
        from ..rag import ChunkDocument
        from ..rag.chunking import chunk_documents
        chunks = chunk_documents(
            [ChunkDocument(text=(doc.content or "").strip(), course_id=course.id, chapter_id=chapter.id, title=doc.title, source_id=f"doc_{doc.id}")]
        )
        chunks_out = [TeacherDocumentChunkOut(index=i + 1, text=chunk[0]) for i, chunk in enumerate(chunks[:50])]
    preview = (doc.content or "").strip()
    if len(preview) > 4000:
        preview = preview[:4000] + "\n\n..."
    return TeacherKnowledgeDocumentDetailOut(
        id=doc.id,
        chapter_id=doc.chapter_id,
        source_type=doc.source_type,
        title=doc.title,
        page_ref=doc.page_ref,
        file_name=doc.file_name,
        file_size=doc.file_size,
        parse_status=doc.parse_status,
        parse_error=doc.parse_error,
        chunk_count=doc.chunk_count,
        created_at=doc.created_at.isoformat() if doc.created_at else None,
        content_preview=preview,
        chunks=chunks_out,
    )


@router.get("/documents/{doc_id}/file")
async def get_teacher_document_file(
    doc_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    doc, _, _ = await _require_owned_document(db, user.id, doc_id)
    if not doc.file_path:
        raise HTTPException(status_code=404, detail="文档原文件不存在")
    abs_path = Path(settings.upload_dir) / doc.file_path
    if not abs_path.exists():
        raise HTTPException(status_code=404, detail="文档文件不存在")
    return FileResponse(
        path=str(abs_path),
        media_type="application/pdf",
        filename=doc.file_name or abs_path.name,
    )


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
            select(StudentClassMembership.class_id, func.count(StudentClassMembership.student_id))
            .where(StudentClassMembership.class_id.in_([c.id for c in rows]))
            .group_by(StudentClassMembership.class_id)
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
        select(func.count(StudentClassMembership.student_id)).where(StudentClassMembership.class_id == c.id)
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
    r_m = await db.execute(select(StudentClassMembership).where(StudentClassMembership.class_id == class_id))
    for m in r_m.scalars().all():
        await db.delete(m)
    await db.delete(c)
    await db.commit()
    return {"ok": True}


@router.get("/classes/{class_id}/students", response_model=list[TeacherStudentOut])
async def list_teacher_class_students(
    class_id: int,
    q: str | None = Query(None),
    student_no: str | None = Query(None),
    name: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_class(db, user.id, class_id)
    qry = (
        select(User)
        .join(StudentClassMembership, StudentClassMembership.student_id == User.id)
        .where(User.role == UserRole.student.value, StudentClassMembership.class_id == class_id)
        .order_by(User.id)
    )
    if q and q.strip():
        keyword = f"%{q.strip()}%"
        qry = qry.where((User.username.ilike(keyword)) | (User.display_name.ilike(keyword)) | (User.student_no.ilike(keyword)))
    if student_no and student_no.strip():
        qry = qry.where(User.student_no.ilike(f"%{student_no.strip()}%"))
    if name and name.strip():
        keyword = f"%{name.strip()}%"
        qry = qry.where((User.display_name.ilike(keyword)) | (User.username.ilike(keyword)))
    r = await db.execute(qry)
    return [TeacherStudentOut(id=s.id, username=s.username, student_no=s.student_no, display_name=s.display_name) for s in r.scalars().all()]


@router.post("/classes/{class_id}/students/assign")
async def assign_students_to_teacher_class(
    class_id: int,
    body: TeacherClassStudentsAssignIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_class(db, user.id, class_id)
    ids = [i for i in body.student_ids if isinstance(i, int)]
    qry = select(User).where(User.role == UserRole.student.value)
    if ids:
        qry = qry.where(User.id.in_(ids))
    else:
        if body.student_no and body.student_no.strip():
            qry = qry.where(User.student_no.ilike(f"%{body.student_no.strip()}%"))
        if body.name and body.name.strip():
            keyword = f"%{body.name.strip()}%"
            qry = qry.where((User.display_name.ilike(keyword)) | (User.username.ilike(keyword)))
        if not body.student_no and not body.name:
            raise HTTPException(status_code=400, detail="请填写学号/姓名或选择学生")
    r = await db.execute(qry)
    students = r.scalars().all()
    if not students:
        raise HTTPException(status_code=404, detail="学生不存在")
    assigned = 0
    for s in students:
        r_ex = await db.execute(
            select(StudentClassMembership).where(
                StudentClassMembership.student_id == s.id,
                StudentClassMembership.class_id == class_id,
            )
        )
        if not r_ex.scalar_one_or_none():
            db.add(StudentClassMembership(student_id=s.id, class_id=class_id))
            assigned += 1
    await db.commit()
    return {"ok": True, "assigned": assigned}


@router.delete("/classes/{class_id}/students/{student_id}")
async def remove_student_from_teacher_class(
    class_id: int,
    student_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    await _require_owned_class(db, user.id, class_id)
    r = await db.execute(
        select(StudentClassMembership).where(
            StudentClassMembership.class_id == class_id,
            StudentClassMembership.student_id == student_id,
        )
    )
    m = r.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="该学生不在班级中")
    await db.delete(m)
    await db.commit()
    return {"ok": True}


@router.get("/students", response_model=list[TeacherStudentOut])
async def list_students_for_teacher(
    q: str | None = Query(None),
    student_no: str | None = Query(None),
    name: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_teacher),
):
    qry = select(User).where(User.role == UserRole.student.value).order_by(User.id)
    if q and q.strip():
        keyword = f"%{q.strip()}%"
        qry = qry.where((User.username.ilike(keyword)) | (User.display_name.ilike(keyword)) | (User.student_no.ilike(keyword)))
    if student_no and student_no.strip():
        qry = qry.where(User.student_no.ilike(f"%{student_no.strip()}%"))
    if name and name.strip():
        keyword = f"%{name.strip()}%"
        qry = qry.where((User.display_name.ilike(keyword)) | (User.username.ilike(keyword)))
    r = await db.execute(qry)
    return [TeacherStudentOut(id=s.id, username=s.username, student_no=s.student_no, display_name=s.display_name) for s in r.scalars().all()]


async def _user_ids_by_class(db: AsyncSession, class_id: int | None):
    """若指定 class_id，返回该班级用户 id 列表，用于过滤统计；否则返回 None 表示不过滤"""
    if class_id is None:
        return None
    r = await db.execute(select(StudentClassMembership.student_id).where(StudentClassMembership.class_id == class_id))
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
