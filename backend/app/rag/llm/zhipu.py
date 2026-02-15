"""智谱 GLM：OpenAI 兼容 API"""
from openai import OpenAI

from .base import BaseLLM
from ..config import RAGSettings


class ZhipuLLM(BaseLLM):
    def __init__(self, settings: RAGSettings):
        base = (settings.llm_zhipu_base_url or "https://open.bigmodel.cn/api/paas/v4").rstrip("/")
        self._client = OpenAI(
            base_url=base,
            api_key=settings.llm_zhipu_api_key,
        )
        self._model = settings.llm_zhipu_model or "glm-4-flash"

    def generate(
        self,
        prompt: str,
        *,
        max_tokens: int = 512,
        temperature: float = 0.3,
        **kwargs,
    ) -> str:
        resp = self._client.chat.completions.create(
            model=self._model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            temperature=temperature,
        )
        if not resp.choices:
            return ""
        return (resp.choices[0].message.content or "").strip()
