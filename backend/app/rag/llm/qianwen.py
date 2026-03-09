"""阿里千问：DashScope OpenAI 兼容 API"""
from openai import OpenAI

from .base import BaseLLM
from ..config import RAGSettings

# 阿里云 DashScope OpenAI 兼容端点
DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"


class QianwenLLM(BaseLLM):
    def __init__(self, settings: RAGSettings):
        self._client = OpenAI(
            base_url=DASHSCOPE_BASE,
            api_key=settings.llm_qianwen_api_key,
        )
        self._model = settings.llm_qianwen_model or "qwen-turbo"

    def generate(
        self,
        prompt: str,
        *,
        max_tokens: int = 512,
        temperature: float = 0.3,
        **kwargs,
    ) -> str:
        text, _ = self.generate_with_meta(prompt, max_tokens=max_tokens, temperature=temperature, **kwargs)
        return text

    def generate_with_meta(
        self,
        prompt: str,
        *,
        max_tokens: int = 512,
        temperature: float = 0.3,
        **kwargs,
    ) -> tuple[str, str | None]:
        resp = self._client.chat.completions.create(
            model=self._model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            temperature=temperature,
        )
        if not resp.choices:
            return "", None
        choice = resp.choices[0]
        return (choice.message.content or "").strip(), getattr(choice, "finish_reason", None)
