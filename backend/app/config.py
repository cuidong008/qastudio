"""应用配置"""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "计算机网络基础课程智能体"
    debug: bool = False
    database_url: str = "sqlite+aiosqlite:///./qastudio.db"
    secret_key: str = "change-me-in-production"
    cors_origins: str = "http://localhost:5173,http://localhost:5174"
    upload_dir: str = "./uploads"

    # RAG
    rag_enabled: bool = False
    rag_llm_type: str = "qianwen"
    rag_llm_qianwen_api_key: str = ""
    rag_embedding_type: str = "external"
    rag_embedding_model: str = "text-embedding-3-small"
    rag_vector_store_path: str = "./rag_vector_store"
    rag_vector_store_chunk_size: int = 1000
    rag_vector_store_chunk_overlap: int = 100
    rag_vector_store_top_k: int = 10

    class Config:
        env_file = ".env"


settings = Settings()
