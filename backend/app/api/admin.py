"""后管台 API：用户、班级、课程、开课管理（仅 admin）"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..db.models import User, UserRole, Class, Course, Teaching, Chapter
from ..api.auth import require_admin
from ..services.chapter_cleanup_service import cleanup_chapter_related_data
from ..services.course_knowledge_service import clear_course_knowledge
import bcrypt

router = APIRouter(prefix="/admin", tags=["admin"])
logger = logging.getLogger(__name__)


# ---------- RAG 配置（Web 界面配置，存库优先于 .env）----------
class RAGStatusOut(BaseModel):
    enabled: bool
    llm_type: str
    embedding_type: str
    top_k: int
    chunk_size: int
    chunk_overlap: int
    config_note: str = "可在本页「RAG 配置」中通过表单修改，无需改 .env"


@router.get("/rag/status", response_model=RAGStatusOut)
async def get_rag_status(user: User = Depends(require_admin)):
    """获取 RAG 当前状态（与 get_rag_settings 一致，含 Web 配置）"""
    from ..rag.config import get_rag_settings
    s = get_rag_settings()
    return RAGStatusOut(
        enabled=s.enabled,
        llm_type=s.llm_type,
        embedding_type=s.embedding_type,
        top_k=s.top_k,
        chunk_size=s.chunk_size,
        chunk_overlap=s.chunk_overlap,
    )


# 全量 RAG 配置（GET 时敏感项返回 ***）
class RAGConfigOut(BaseModel):
    enabled: bool
    llm_type: str
    llm_vllm_base_url: str
    llm_vllm_model: str
    llm_vllm_api_key: str
    llm_qianwen_api_key: str
    llm_qianwen_model: str
    llm_zhipu_api_key: str
    llm_zhipu_model: str
    llm_zhipu_base_url: str
    embedding_type: str
    embedding_dim: int
    embedding_builtin_model: str
    embedding_external_api_key: str
    embedding_external_base_url: str
    embedding_external_model: str
    embedding_qianwen_api_key: str
    embedding_zhipu_api_key: str
    vector_store_path: str
    vector_collection_name: str
    top_k: int
    chunk_size: int
    chunk_overlap: int
    llm_max_tokens: int
    llm_temperature: float


class RAGConfigUpdateIn(BaseModel):
    """PUT 时仅提交要改的字段；API Key 若传 *** 或空表示不修改"""
    enabled: bool | None = None
    llm_type: str | None = None
    llm_vllm_base_url: str | None = None
    llm_vllm_model: str | None = None
    llm_vllm_api_key: str | None = None
    llm_qianwen_api_key: str | None = None
    llm_qianwen_model: str | None = None
    llm_zhipu_api_key: str | None = None
    llm_zhipu_model: str | None = None
    llm_zhipu_base_url: str | None = None
    embedding_type: str | None = None
    embedding_dim: int | None = None
    embedding_builtin_model: str | None = None
    embedding_external_api_key: str | None = None
    embedding_external_base_url: str | None = None
    embedding_external_model: str | None = None
    embedding_qianwen_api_key: str | None = None
    embedding_zhipu_api_key: str | None = None
    vector_store_path: str | None = None
    vector_collection_name: str | None = None
    top_k: int | None = None
    chunk_size: int | None = None
    chunk_overlap: int | None = None
    llm_max_tokens: int | None = None
    llm_temperature: float | None = None


def _mask_secrets(d: dict) -> None:
    from ..rag.config_store import SECRET_KEYS, MASKED_PLACEHOLDER
    for k in SECRET_KEYS:
        if d.get(k) and (d[k] or "").strip():
            d[k] = MASKED_PLACEHOLDER


@router.get("/rag/config", response_model=RAGConfigOut)
async def get_rag_config(user: User = Depends(require_admin)):
    """获取完整 RAG 配置（敏感项已脱敏为 ***），供 Web 表单编辑"""
    from ..rag.config import get_rag_settings

    s = get_rag_settings()
    d = s.model_dump()
    _mask_secrets(d)
    return RAGConfigOut(**d)


@router.put("/rag/config", response_model=RAGConfigOut)
async def put_rag_config(
    body: RAGConfigUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """保存 RAG 配置到数据库（Web 界面提交）；敏感项传 *** 表示不修改"""
    from ..rag.config_store import save_to_db, MASKED_PLACEHOLDER

    updates = {}
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is None:
            continue
        if k in ("llm_vllm_api_key", "llm_qianwen_api_key", "llm_zhipu_api_key",
                 "embedding_external_api_key", "embedding_qianwen_api_key", "embedding_zhipu_api_key"):
            if v == MASKED_PLACEHOLDER or (isinstance(v, str) and not v.strip()):
                continue
        updates[k] = v
    if updates:
        await save_to_db(db, updates)
    from ..rag.config import get_rag_settings
    s = get_rag_settings()
    d = s.model_dump()
    _mask_secrets(d)
    return RAGConfigOut(**d)


# ---------- RAG 模型提供商（RAGFlow 风格：先配提供商，再选默认 LLM/Embedding/VLM/Rerank）----------
# 提供商类型与可选模型名（供前端下拉，与 RAGFlow 常用模型对齐）
RAG_PROVIDER_TYPES = [
    {"id": "openai_compatible", "name": "OpenAI 兼容 / vLLM", "need_base_url": True},
    {"id": "qianwen", "name": "阿里千问", "need_base_url": False},
    {"id": "zhipu", "name": "智谱 GLM", "need_base_url": False},
]
RAG_LLM_MODELS_BY_TYPE = {
    "openai_compatible": [
        "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo",
        "qwen2.5:7b", "qwen2.5:14b", "qwen2.5:32b", "qwen2.5:72b",
        "deepseek-chat", "deepseek-coder", "custom",
    ],
    "qianwen": [
        "qwen-turbo", "qwen-plus", "qwen-max", "qwen-long",
        "qwen2.5-turbo", "qwen2.5-plus", "qwen2.5-max",
        "qwen2.5-7b-instruct", "qwen2.5-14b-instruct", "qwen2.5-32b-instruct", "qwen2.5-72b-instruct",
        "qwen-max-longcontext", "custom",
    ],
    "zhipu": [
        "glm-4-flash", "glm-4", "glm-4-long", "glm-4-air", "glm-4-airx",
        "glm-4v-flash", "glm-4v-plus", "glm-3-turbo", "custom",
    ],
}
RAG_EMBEDDING_MODELS_BY_TYPE = {
    "openai_compatible": [
        "text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002",
        "bge-m3", "bge-large-zh-v1.5", "custom",
    ],
    "qianwen": [
        "text-embedding-v3", "text-embedding-v2", "text-embedding-v1",
    ],
    "zhipu": [
        "embedding-2", "embedding-3",
    ],
}
RAG_VLM_MODELS_BY_TYPE = {
    "openai_compatible": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4-vision", "custom"],
    "qianwen": ["qwen-vl-max", "qwen-vl-plus", "qwen2-vl-7b-instruct", "qwen2-vl-72b-instruct"],
    "zhipu": ["glm-4v-flash", "glm-4v-plus", "glm-4v", "custom"],
}
RAG_RERANK_MODELS_BY_TYPE = {
    "openai_compatible": ["gpt-4o-mini", "bge-reranker-v2-m3", "custom"],
    "qianwen": ["gte-rerank", "gte-rerank-hybrid", "bge-reranker-v2-m3"],
    "zhipu": ["rerank-2", "bge-reranker-v2-m3"],
}


class RAGProviderOut(BaseModel):
    id: str
    type: str
    name: str
    base_url: str = ""
    api_key: str = ""


class RAGProvidersGetOut(BaseModel):
    providers: list[RAGProviderOut]
    default_llm: str
    default_embedding: str
    default_vlm: str
    default_rerank: str
    default_pdf_parser: str
    provider_types: list[dict]
    llm_models_by_type: dict
    embedding_models_by_type: dict
    vlm_models_by_type: dict
    rerank_models_by_type: dict


class RAGProviderIn(BaseModel):
    id: str | None = None
    type: str = "openai_compatible"
    name: str = ""
    base_url: str = ""
    api_key: str = ""


class RAGProvidersPutIn(BaseModel):
    providers: list[RAGProviderIn]
    default_llm: str = ""
    default_embedding: str = ""
    default_vlm: str = ""
    default_rerank: str = ""
    default_pdf_parser: str = ""


@router.get("/rag/providers", response_model=RAGProvidersGetOut)
async def get_rag_providers(user: User = Depends(require_admin)):
    """获取模型提供商列表与默认模型选择（用于 RAG 配置页「模型提供商」）"""
    from ..rag.config_store import (
        get_providers_list,
        get_default_llm,
        get_default_embedding,
        get_default_vlm,
        get_default_rerank,
        get_default_pdf_parser,
    )
    providers = get_providers_list()
    return RAGProvidersGetOut(
        providers=[RAGProviderOut(id=p["id"], type=p["type"], name=p["name"], base_url=p.get("base_url", ""), api_key=p.get("api_key", "")) for p in providers],
        default_llm=get_default_llm(),
        default_embedding=get_default_embedding(),
        default_vlm=get_default_vlm(),
        default_rerank=get_default_rerank(),
        default_pdf_parser=get_default_pdf_parser(),
        provider_types=RAG_PROVIDER_TYPES,
        llm_models_by_type=RAG_LLM_MODELS_BY_TYPE,
        embedding_models_by_type=RAG_EMBEDDING_MODELS_BY_TYPE,
        vlm_models_by_type=RAG_VLM_MODELS_BY_TYPE,
        rerank_models_by_type=RAG_RERANK_MODELS_BY_TYPE,
    )


@router.put("/rag/providers", response_model=RAGProvidersGetOut)
async def put_rag_providers(
    body: RAGProvidersPutIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """保存模型提供商与默认 LLM/Embedding/VLM/Rerank/PDF 解析器 选择"""
    from ..rag.config_store import save_providers_and_defaults
    providers = [{"id": p.id, "type": p.type, "name": p.name, "base_url": p.base_url or "", "api_key": p.api_key or ""} for p in body.providers]
    await save_providers_and_defaults(
        db, providers,
        body.default_llm, body.default_embedding,
        body.default_vlm, body.default_rerank, body.default_pdf_parser,
    )
    from ..rag.config_store import (
        get_providers_list,
        get_default_llm,
        get_default_embedding,
        get_default_vlm,
        get_default_rerank,
        get_default_pdf_parser,
    )
    providers_out = get_providers_list()
    return RAGProvidersGetOut(
        providers=[RAGProviderOut(id=p["id"], type=p["type"], name=p["name"], base_url=p.get("base_url", ""), api_key=p.get("api_key", "")) for p in providers_out],
        default_llm=get_default_llm(),
        default_embedding=get_default_embedding(),
        default_vlm=get_default_vlm(),
        default_rerank=get_default_rerank(),
        default_pdf_parser=get_default_pdf_parser(),
        provider_types=RAG_PROVIDER_TYPES,
        llm_models_by_type=RAG_LLM_MODELS_BY_TYPE,
        embedding_models_by_type=RAG_EMBEDDING_MODELS_BY_TYPE,
        vlm_models_by_type=RAG_VLM_MODELS_BY_TYPE,
        rerank_models_by_type=RAG_RERANK_MODELS_BY_TYPE,
    )


# ---------- 用户 ----------
class UserListOut(BaseModel):
    id: int
    username: str
    role: str
    display_name: str | None
    student_no: str | None
    created_at: str | None

    class Config:
        from_attributes = True


class UserCreateIn(BaseModel):
    username: str
    password: str = "123456"
    role: str = "student"
    display_name: str | None = None
    student_no: str | None = None


class UserUpdateIn(BaseModel):
    password: str | None = None
    role: str | None = None
    display_name: str | None = None
    student_no: str | None = None


@router.get("/users", response_model=list[UserListOut])
async def list_users(
    role: str | None = Query(None),
    q: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    qry = select(User).order_by(User.id)
    if role:
        qry = qry.where(User.role == role)
    if q and q.strip():
        from sqlalchemy import or_
        pat = f"%{q.strip()}%"
        qry = qry.where(or_(User.username.ilike(pat), User.display_name.ilike(pat)))
    r = await db.execute(qry)
    rows = r.scalars().all()
    return [
        UserListOut(
            id=u.id, username=u.username, role=u.role, display_name=u.display_name,
            student_no=u.student_no, created_at=u.created_at.isoformat() if u.created_at else None,
        )
        for u in rows
    ]


@router.post("/users", response_model=UserListOut)
async def create_user(
    body: UserCreateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    if body.role not in ("student", "teacher", "admin"):
        raise HTTPException(status_code=400, detail="role 须为 student / teacher / admin")
    r = await db.execute(select(User).where(User.username == body.username.strip()))
    if r.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="用户名已存在")
    if body.student_no:
        r = await db.execute(select(User).where(User.student_no == body.student_no.strip()))
        if r.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="学号/工号已存在")
    raw = (body.password or "123456").encode()
    hashed = bcrypt.hashpw(raw, bcrypt.gensalt()).decode("utf-8")
    u = User(
        username=body.username.strip(),
        hashed_password=hashed,
        role=body.role,
        display_name=body.display_name or body.username.strip(),
        student_no=body.student_no.strip() if body.student_no else None,
    )
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return UserListOut(
        id=u.id, username=u.username, role=u.role, display_name=u.display_name,
        student_no=u.student_no, created_at=u.created_at.isoformat() if u.created_at else None,
    )


@router.get("/users/{user_id}", response_model=UserListOut)
async def get_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(User).where(User.id == user_id))
    u = r.scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    return UserListOut(
        id=u.id, username=u.username, role=u.role, display_name=u.display_name,
        student_no=u.student_no, created_at=u.created_at.isoformat() if u.created_at else None,
    )


@router.put("/users/{user_id}", response_model=UserListOut)
async def update_user(
    user_id: int,
    body: UserUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(User).where(User.id == user_id))
    u = r.scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    if body.password is not None and body.password != "":
        u.hashed_password = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode("utf-8")
    if body.role is not None:
        if body.role not in ("student", "teacher", "admin"):
            raise HTTPException(status_code=400, detail="role 须为 student / teacher / admin")
        u.role = body.role
    if body.display_name is not None:
        u.display_name = body.display_name
    if body.student_no is not None:
        next_no = body.student_no.strip() if body.student_no else None
        if next_no:
            r_dup = await db.execute(select(User).where(User.student_no == next_no, User.id != u.id))
            if r_dup.scalar_one_or_none():
                raise HTTPException(status_code=400, detail="学号/工号已存在")
        u.student_no = next_no
    await db.commit()
    await db.refresh(u)
    return UserListOut(
        id=u.id, username=u.username, role=u.role, display_name=u.display_name,
        student_no=u.student_no, created_at=u.created_at.isoformat() if u.created_at else None,
    )


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    if user_id == user.id:
        raise HTTPException(status_code=400, detail="不能删除当前登录账号")
    r = await db.execute(select(User).where(User.id == user_id))
    u = r.scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")
    await db.delete(u)
    await db.commit()
    return {"ok": True}


# ---------- 班级 ----------
class ClassOut(BaseModel):
    id: int
    name: str
    term: str | None
    created_at: str | None

    class Config:
        from_attributes = True


class ClassCreateIn(BaseModel):
    name: str
    term: str | None = None


class ClassUpdateIn(BaseModel):
    name: str | None = None
    term: str | None = None


@router.get("/classes", response_model=list[ClassOut])
async def list_classes(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Class).order_by(Class.id))
    rows = r.scalars().all()
    return [ClassOut(id=c.id, name=c.name, term=c.term, created_at=c.created_at.isoformat() if c.created_at else None) for c in rows]


@router.post("/classes", response_model=ClassOut)
async def create_class(
    body: ClassCreateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    c = Class(name=body.name.strip(), term=body.term)
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return ClassOut(id=c.id, name=c.name, term=c.term, created_at=c.created_at.isoformat() if c.created_at else None)


@router.get("/classes/{class_id}", response_model=ClassOut)
async def get_class(
    class_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Class).where(Class.id == class_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="班级不存在")
    return ClassOut(id=c.id, name=c.name, term=c.term, created_at=c.created_at.isoformat() if c.created_at else None)


@router.put("/classes/{class_id}", response_model=ClassOut)
async def update_class(
    class_id: int,
    body: ClassUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Class).where(Class.id == class_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="班级不存在")
    if body.name is not None:
        c.name = body.name.strip()
    if body.term is not None:
        c.term = body.term
    await db.commit()
    await db.refresh(c)
    return ClassOut(id=c.id, name=c.name, term=c.term, created_at=c.created_at.isoformat() if c.created_at else None)


@router.delete("/classes/{class_id}")
async def delete_class(
    class_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Class).where(Class.id == class_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="班级不存在")
    # 可选：检查是否有学生或开课引用
    await db.delete(c)
    await db.commit()
    return {"ok": True}


# ---------- 课程 ----------
class CourseOut(BaseModel):
    id: int
    name: str
    code: str | None
    description: str | None
    is_active: bool
    created_at: str | None

    class Config:
        from_attributes = True


class CourseCreateIn(BaseModel):
    name: str
    code: str | None = None
    description: str | None = None
    is_active: bool = True


class CourseUpdateIn(BaseModel):
    name: str | None = None
    code: str | None = None
    description: str | None = None
    is_active: bool | None = None


@router.get("/courses", response_model=list[CourseOut])
async def list_courses(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Course).order_by(Course.id))
    rows = r.scalars().all()
    return [CourseOut(id=c.id, name=c.name, code=c.code, description=c.description, is_active=c.is_active, created_at=c.created_at.isoformat() if c.created_at else None) for c in rows]


@router.post("/courses", response_model=CourseOut)
async def create_course(
    body: CourseCreateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    if body.code:
        r = await db.execute(select(Course).where(Course.code == body.code.strip()))
        if r.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="课程代码已存在")
    c = Course(name=body.name.strip(), code=body.code.strip() if body.code else None, description=body.description, is_active=body.is_active)
    db.add(c)
    await db.commit()
    await db.refresh(c)
    return CourseOut(id=c.id, name=c.name, code=c.code, description=c.description, is_active=c.is_active, created_at=c.created_at.isoformat() if c.created_at else None)


@router.get("/courses/{course_id}", response_model=CourseOut)
async def get_course(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Course).where(Course.id == course_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="课程不存在")
    return CourseOut(id=c.id, name=c.name, code=c.code, description=c.description, is_active=c.is_active, created_at=c.created_at.isoformat() if c.created_at else None)


@router.put("/courses/{course_id}", response_model=CourseOut)
async def update_course(
    course_id: int,
    body: CourseUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Course).where(Course.id == course_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="课程不存在")
    if body.name is not None:
        c.name = body.name.strip()
    if body.code is not None:
        c.code = body.code.strip() if body.code else None
    if body.description is not None:
        c.description = body.description
    if body.is_active is not None:
        c.is_active = body.is_active
    await db.commit()
    await db.refresh(c)
    return CourseOut(id=c.id, name=c.name, code=c.code, description=c.description, is_active=c.is_active, created_at=c.created_at.isoformat() if c.created_at else None)


@router.delete("/courses/{course_id}")
async def delete_course(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Course).where(Course.id == course_id))
    c = r.scalar_one_or_none()
    if not c:
        raise HTTPException(status_code=404, detail="课程不存在")
    await db.delete(c)
    await db.commit()
    return {"ok": True}


@router.post("/courses/{course_id}/reindex")
async def reindex_course(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    """重建该课程 RAG 向量索引（从知识库文档、知识点、PPT 幻灯片拉取）"""
    r = await db.execute(select(Course).where(Course.id == course_id))
    if not r.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="课程不存在")
    from ..services.rag_index_service import build_index_for_course
    count = await build_index_for_course(db, course_id)
    return {"ok": True, "chunks_indexed": count}


@router.post("/courses/{course_id}/clear-knowledge")
async def clear_course_knowledge_endpoint(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Course).where(Course.id == course_id))
    if not r.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="课程不存在")
    stats = await clear_course_knowledge(db, course_id)
    await db.commit()
    from ..services.rag_index_service import build_index_for_course
    chunks = await build_index_for_course(db, course_id)
    return {"ok": True, "stats": stats, "chunks_indexed": chunks}


# ---------- 章节（按课程） ----------
class ChapterOut(BaseModel):
    id: int
    course_id: int | None
    title: str
    order_index: int
    syllabus_ref: str | None

    class Config:
        from_attributes = True


class ChapterCreateIn(BaseModel):
    title: str
    order_index: int = 0
    syllabus_ref: str | None = None


class ChapterUpdateIn(BaseModel):
    title: str | None = None
    order_index: int | None = None
    syllabus_ref: str | None = None


@router.get("/courses/{course_id}/chapters", response_model=list[ChapterOut])
async def list_course_chapters(
    course_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Course).where(Course.id == course_id))
    if not r.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="课程不存在")
    r = await db.execute(select(Chapter).where(Chapter.course_id == course_id).order_by(Chapter.order_index, Chapter.id))
    rows = r.scalars().all()
    return [ChapterOut(id=ch.id, course_id=ch.course_id, title=ch.title, order_index=ch.order_index, syllabus_ref=ch.syllabus_ref) for ch in rows]


@router.post("/courses/{course_id}/chapters", response_model=ChapterOut)
async def create_chapter(
    course_id: int,
    body: ChapterCreateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Course).where(Course.id == course_id))
    if not r.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="课程不存在")
    ch = Chapter(course_id=course_id, title=body.title.strip(), order_index=body.order_index, syllabus_ref=body.syllabus_ref)
    db.add(ch)
    await db.commit()
    await db.refresh(ch)
    return ChapterOut(id=ch.id, course_id=ch.course_id, title=ch.title, order_index=ch.order_index, syllabus_ref=ch.syllabus_ref)


@router.put("/chapters/{chapter_id}", response_model=ChapterOut)
async def update_chapter(
    chapter_id: int,
    body: ChapterUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Chapter).where(Chapter.id == chapter_id))
    ch = r.scalar_one_or_none()
    if not ch:
        raise HTTPException(status_code=404, detail="章节不存在")
    if body.title is not None:
        ch.title = body.title.strip()
    if body.order_index is not None:
        ch.order_index = body.order_index
    if body.syllabus_ref is not None:
        ch.syllabus_ref = body.syllabus_ref
    await db.commit()
    await db.refresh(ch)
    return ChapterOut(id=ch.id, course_id=ch.course_id, title=ch.title, order_index=ch.order_index, syllabus_ref=ch.syllabus_ref)


@router.delete("/chapters/{chapter_id}")
async def delete_chapter(
    chapter_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Chapter).where(Chapter.id == chapter_id))
    ch = r.scalar_one_or_none()
    if not ch:
        raise HTTPException(status_code=404, detail="章节不存在")
    course_id = ch.course_id
    await cleanup_chapter_related_data(db, ch.id)
    await db.delete(ch)
    await db.commit()
    if course_id:
        try:
            from ..services.rag_index_service import build_index_for_course
            await build_index_for_course(db, course_id)
        except Exception as e:
            logger.warning("admin_delete_chapter_reindex_failed chapter_id=%s course_id=%s err=%s", ch.id, course_id, str(e))
    return {"ok": True}


# ---------- 开课 ----------
class TeachingOut(BaseModel):
    id: int
    course_id: int
    class_id: int
    teacher_id: int
    term: str | None
    is_active: bool
    course_name: str | None = None
    class_name: str | None = None
    teacher_name: str | None = None

    class Config:
        from_attributes = True


class TeachingCreateIn(BaseModel):
    course_id: int
    class_id: int
    teacher_id: int
    term: str | None = None
    is_active: bool = True


class TeachingUpdateIn(BaseModel):
    teacher_id: int | None = None
    term: str | None = None
    is_active: bool | None = None


class TeachingBatchCreateIn(BaseModel):
    """一门课程批量开给多个班级（同一教师）"""
    course_id: int
    teacher_id: int
    class_ids: list[int]
    term: str | None = None
    is_active: bool = True


@router.get("/teachings", response_model=list[TeachingOut])
async def list_teachings(
    course_id: int | None = Query(None),
    class_id: int | None = Query(None),
    teacher_id: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    qry = select(Teaching).order_by(Teaching.id)
    if course_id is not None:
        qry = qry.where(Teaching.course_id == course_id)
    if class_id is not None:
        qry = qry.where(Teaching.class_id == class_id)
    if teacher_id is not None:
        qry = qry.where(Teaching.teacher_id == teacher_id)
    r = await db.execute(qry)
    rows = r.scalars().all()
    # 加载名称
    course_ids = list({t.course_id for t in rows})
    class_ids = list({t.class_id for t in rows})
    user_ids = list({t.teacher_id for t in rows})
    courses = {}
    if course_ids:
        r_c = await db.execute(select(Course).where(Course.id.in_(course_ids)))
        for c in r_c.scalars().all():
            courses[c.id] = c.name
    classes = {}
    if class_ids:
        r_c = await db.execute(select(Class).where(Class.id.in_(class_ids)))
        for c in r_c.scalars().all():
            classes[c.id] = c.name
    users = {}
    if user_ids:
        r_u = await db.execute(select(User).where(User.id.in_(user_ids)))
        for u in r_u.scalars().all():
            users[u.id] = u.display_name or u.username
    return [
        TeachingOut(
            id=t.id, course_id=t.course_id, class_id=t.class_id, teacher_id=t.teacher_id,
            term=t.term, is_active=t.is_active,
            course_name=courses.get(t.course_id), class_name=classes.get(t.class_id), teacher_name=users.get(t.teacher_id),
        )
        for t in rows
    ]


@router.post("/teachings", response_model=TeachingOut)
async def create_teaching(
    body: TeachingCreateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Course).where(Course.id == body.course_id))
    if not r.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="课程不存在")
    r = await db.execute(select(Class).where(Class.id == body.class_id))
    if not r.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="班级不存在")
    r = await db.execute(select(User).where(User.id == body.teacher_id, User.role == UserRole.teacher.value))
    if not r.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="授课人须为教师角色")
    r = await db.execute(
        select(Teaching).where(
            Teaching.course_id == body.course_id,
            Teaching.class_id == body.class_id,
            Teaching.term == (body.term or ""),
        )
    )
    if r.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="同一课程、班级、学期已存在开课")
    t = Teaching(course_id=body.course_id, class_id=body.class_id, teacher_id=body.teacher_id, term=body.term, is_active=body.is_active)
    db.add(t)
    await db.commit()
    await db.refresh(t)
    r_c = await db.execute(select(Course).where(Course.id == t.course_id))
    r_cl = await db.execute(select(Class).where(Class.id == t.class_id))
    r_u = await db.execute(select(User).where(User.id == t.teacher_id))
    c = r_c.scalar_one_or_none()
    cl = r_cl.scalar_one_or_none()
    u = r_u.scalar_one_or_none()
    return TeachingOut(
        id=t.id, course_id=t.course_id, class_id=t.class_id, teacher_id=t.teacher_id,
        term=t.term, is_active=t.is_active,
        course_name=c.name if c else None, class_name=cl.name if cl else None, teacher_name=(u.display_name or u.username) if u else None,
    )


class TeachingBatchCreateOut(BaseModel):
    created: list[TeachingOut]
    skipped: list[dict]


@router.post("/teachings/batch", response_model=TeachingBatchCreateOut)
async def create_teachings_batch(
    body: TeachingBatchCreateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    if not body.class_ids:
        raise HTTPException(status_code=400, detail="请至少选择一个班级")
    r = await db.execute(select(Course).where(Course.id == body.course_id))
    if not r.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="课程不存在")
    r = await db.execute(select(User).where(User.id == body.teacher_id, User.role == UserRole.teacher.value))
    if not r.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="授课人须为教师角色")
    created: list[TeachingOut] = []
    skipped: list[dict] = []
    term_val = body.term or ""
    for class_id in body.class_ids:
        r = await db.execute(select(Class).where(Class.id == class_id))
        cl = r.scalar_one_or_none()
        if not cl:
            skipped.append({"class_id": class_id, "reason": "班级不存在"})
            continue
        r = await db.execute(
            select(Teaching).where(
                Teaching.course_id == body.course_id,
                Teaching.class_id == class_id,
                Teaching.term == term_val,
            )
        )
        if r.scalar_one_or_none():
            skipped.append({"class_id": class_id, "class_name": cl.name, "reason": "该课程、班级、学期已存在开课"})
            continue
        t = Teaching(
            course_id=body.course_id,
            class_id=class_id,
            teacher_id=body.teacher_id,
            term=body.term,
            is_active=body.is_active,
        )
        db.add(t)
        await db.flush()
        await db.refresh(t)
        r_c = await db.execute(select(Course).where(Course.id == t.course_id))
        r_u = await db.execute(select(User).where(User.id == t.teacher_id))
        c = r_c.scalar_one_or_none()
        u = r_u.scalar_one_or_none()
        created.append(
            TeachingOut(
                id=t.id,
                course_id=t.course_id,
                class_id=t.class_id,
                teacher_id=t.teacher_id,
                term=t.term,
                is_active=t.is_active,
                course_name=c.name if c else None,
                class_name=cl.name,
                teacher_name=(u.display_name or u.username) if u else None,
            )
        )
    await db.commit()
    return TeachingBatchCreateOut(created=created, skipped=skipped)


@router.get("/teachings/{teaching_id}", response_model=TeachingOut)
async def get_teaching(
    teaching_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Teaching).where(Teaching.id == teaching_id))
    t = r.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="开课不存在")
    r_c = await db.execute(select(Course).where(Course.id == t.course_id))
    r_cl = await db.execute(select(Class).where(Class.id == t.class_id))
    r_u = await db.execute(select(User).where(User.id == t.teacher_id))
    c, cl, u = r_c.scalar_one_or_none(), r_cl.scalar_one_or_none(), r_u.scalar_one_or_none()
    return TeachingOut(
        id=t.id, course_id=t.course_id, class_id=t.class_id, teacher_id=t.teacher_id,
        term=t.term, is_active=t.is_active,
        course_name=c.name if c else None, class_name=cl.name if cl else None, teacher_name=(u.display_name or u.username) if u else None,
    )


@router.put("/teachings/{teaching_id}", response_model=TeachingOut)
async def update_teaching(
    teaching_id: int,
    body: TeachingUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Teaching).where(Teaching.id == teaching_id))
    t = r.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="开课不存在")
    if body.teacher_id is not None:
        r_u = await db.execute(select(User).where(User.id == body.teacher_id, User.role == UserRole.teacher.value))
        if not r_u.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="授课人须为教师角色")
        t.teacher_id = body.teacher_id
    if body.term is not None:
        t.term = body.term
    if body.is_active is not None:
        t.is_active = body.is_active
    await db.commit()
    await db.refresh(t)
    r_c = await db.execute(select(Course).where(Course.id == t.course_id))
    r_cl = await db.execute(select(Class).where(Class.id == t.class_id))
    r_u = await db.execute(select(User).where(User.id == t.teacher_id))
    c, cl, u = r_c.scalar_one_or_none(), r_cl.scalar_one_or_none(), r_u.scalar_one_or_none()
    return TeachingOut(
        id=t.id, course_id=t.course_id, class_id=t.class_id, teacher_id=t.teacher_id,
        term=t.term, is_active=t.is_active,
        course_name=c.name if c else None, class_name=cl.name if cl else None, teacher_name=(u.display_name or u.username) if u else None,
    )


@router.delete("/teachings/{teaching_id}")
async def delete_teaching(
    teaching_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_admin),
):
    r = await db.execute(select(Teaching).where(Teaching.id == teaching_id))
    t = r.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="开课不存在")
    await db.delete(t)
    await db.commit()
    return {"ok": True}
