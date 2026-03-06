"""应用配置"""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "课程智能体"
    debug: bool = False
    database_url: str = "sqlite+aiosqlite:///./qastudio.db"
    secret_key: str = "change-me-in-production"
    # 静态文件目录（前端构建产物）。空则用 backend/static；可设绝对路径
    static_dir: str = ""
    cors_origins: str = "http://localhost:5173,http://localhost:5174"
    # 通过本机 IP 访问时设为 "https?://.*" 以允许任意 Origin（仅建议本地/内网使用）
    cors_origin_regex: str = ""
    upload_dir: str = "./uploads"
    pdf_parse_engine: str = "mineru_then_pypdf"  # mineru | pypdf | mineru_then_pypdf
    mineru_lang: str = "ch"  # 中文 OCR
    mineru_backend: str = "pipeline"  # pipeline | vlm-transformers | vlm-sglang-engine
    mineru_source: str = "huggingface"  # huggingface | modelscope | local
    mineru_method: str = "auto"  # auto | txt | ocr
    mineru_device: str = "cpu"  # cpu | cuda | mps ...
    mineru_vram: int = 1

    # RAG
    rag_enabled: bool = False
    rag_llm_type: str = "qianwen"
    rag_llm_qianwen_api_key: str = ""
    rag_embedding_type: str = "external"
    rag_embedding_model: str = "text-embedding-3-small"
    rag_embedding_external_batch_size: int = 10
    rag_vector_store_path: str = "./rag_vector_store"
    rag_vector_store_chunk_size: int = 1000
    rag_vector_store_chunk_overlap: int = 100
    rag_vector_store_top_k: int = 10

    # 生成习题页「题目类型配置」表格默认值（最大数量、难度系数）
    exercise_default_single_choice_max: int = 10
    exercise_default_multiple_choice_max: int = 10
    exercise_default_judge_max: int = 10
    exercise_default_blank_max: int = 10
    exercise_default_qa_max: int = 5
    exercise_default_difficulty: str = "0.8"

    # 生成试卷页「题型数量&难度配置」表格默认值（数量、难度系数、每题分数）
    paper_default_single_choice_count: int = 10
    paper_default_multiple_choice_count: int = 10
    paper_default_judge_count: int = 10
    paper_default_blank_count: int = 10
    paper_default_qa_count: int = 5
    paper_default_difficulty: str = "0.8"
    paper_default_single_choice_score: float = 2
    paper_default_multiple_choice_score: float = 4
    paper_default_judge_score: float = 1
    paper_default_blank_score: float = 2
    paper_default_qa_score: float = 10

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
