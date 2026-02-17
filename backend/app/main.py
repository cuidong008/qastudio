"""计算机网络基础课程智能体 - 后端入口"""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .db import init_db
from .db.session import AsyncSessionLocal
from .api import auth, chapters, questions, preview, qa, teacher, ppt, feedback, admin, review


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
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
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api")
app.include_router(chapters.router, prefix="/api")
app.include_router(questions.router, prefix="/api")
app.include_router(preview.router, prefix="/api")
app.include_router(review.router, prefix="/api")
app.include_router(qa.router, prefix="/api")
app.include_router(teacher.router, prefix="/api")
app.include_router(ppt.router, prefix="/api")
app.include_router(feedback.router, prefix="/api")
app.include_router(admin.router, prefix="/api")


@app.get("/")
def root():
    return {"app": settings.app_name, "docs": "/docs"}
