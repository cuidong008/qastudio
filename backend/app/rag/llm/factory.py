"""根据配置返回 LLM 实例"""
from ..config import RAGSettings
from .base import BaseLLM
from .vllm import VLLM
from .qianwen import QianwenLLM
from .zhipu import ZhipuLLM


def get_llm(settings: RAGSettings | None = None) -> BaseLLM:
    from ..config import get_rag_settings
    s = settings or get_rag_settings()
    t = (s.llm_type or "vllm").strip().lower()
    if t == "qianwen":
        return QianwenLLM(s)
    if t == "zhipu":
        return ZhipuLLM(s)
    return VLLM(s)
