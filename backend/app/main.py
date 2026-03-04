"""计算机网络基础课程智能体 - 后端入口"""
import logging
from pathlib import Path

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .config import settings

logger = logging.getLogger(__name__)
from .db import init_db
from .db.session import AsyncSessionLocal
from .api import auth, chapters, questions, preview, qa, teacher, ppt, feedback, admin, review, teacher_pipeline, student


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    # 文档处理任务：将 DB 中未完成任务标为已取消，重启后不再显示「处理中」
    try:
        from .api.teacher import reset_document_process_tasks_on_startup
        await reset_document_process_tasks_on_startup()
    except Exception:
        pass
    # 加载 Web 界面配置的 RAG 到内存（数据库优先于 .env）
    try:
        from .rag.config_store import load_from_db
        async with AsyncSessionLocal() as session:
            await load_from_db(session)
    except Exception:
        pass
    yield
    # shutdown if needed


app = FastAPI(
    title=settings.app_name,
    lifespan=lifespan,
)
_cors_kw: dict = {
    "allow_origins": [o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    "allow_credentials": True,
    "allow_methods": ["*"],
    "allow_headers": ["*"],
}
if getattr(settings, "cors_origin_regex", None) and settings.cors_origin_regex.strip():
    _cors_kw["allow_origin_regex"] = settings.cors_origin_regex.strip()
app.add_middleware(CORSMiddleware, **_cors_kw)

app.include_router(auth.router, prefix="/api")
app.include_router(chapters.router, prefix="/api")
app.include_router(questions.router, prefix="/api")
app.include_router(preview.router, prefix="/api")
app.include_router(review.router, prefix="/api")
app.include_router(qa.router, prefix="/api")
app.include_router(teacher.router, prefix="/api")
app.include_router(teacher_pipeline.router, prefix="/api")
app.include_router(ppt.router, prefix="/api")
app.include_router(feedback.router, prefix="/api")
app.include_router(student.router, prefix="/api")
app.include_router(admin.router, prefix="/api")

# 静态目录：支持环境变量 STATIC_DIR（绝对路径或相对 backend 目录），未设则用 backend/static
_default_static = Path(__file__).resolve().parent.parent / "static"
STATIC_DIR = Path(settings.static_dir).resolve() if settings.static_dir.strip() else _default_static.resolve()
INDEX_PATH = STATIC_DIR / "index.html"
ASSETS_DIR = STATIC_DIR / "assets"

if INDEX_PATH.exists():
    logger.info("静态前端: 使用目录 %s，GET / 与 SPA 路由返回 index.html", STATIC_DIR)

    @app.get("/", response_class=FileResponse)
    def serve_index():
        return FileResponse(INDEX_PATH, media_type="text/html")

    if ASSETS_DIR.is_dir():
        app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")

    @app.get("/{full_path:path}", response_class=FileResponse)
    def spa_fallback(full_path: str):
        """SPA：非 /api、非 /assets 的 GET 均返回 index.html"""
        return FileResponse(INDEX_PATH, media_type="text/html")
else:
    logger.warning("未找到 %s，仅提供 API，GET / 返回 JSON。请执行 build 并确认 backend/static 存在。", INDEX_PATH)

    @app.get("/")
    def root():
        return {"app": settings.app_name, "docs": "/docs"}
