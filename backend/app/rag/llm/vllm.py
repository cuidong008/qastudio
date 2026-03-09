"""vLLM 后端：OpenAI 兼容 API，自建服务"""
from openai import OpenAI

from .base import BaseLLM
from ..config import RAGSettings


class VLLM(BaseLLM):
    def __init__(self, settings: RAGSettings):
        base = settings.llm_vllm_base_url.rstrip("/")
        if not base.endswith("/v1"):
            base = base + "/v1"
        self._client = OpenAI(base_url=base, api_key=settings.llm_vllm_api_key or "not-needed")
        self._model = settings.llm_vllm_model or self._get_first_model()

    def _get_first_model(self) -> str:
        try:
            models = self._client.models.list()
            if models.data:
                return models.data[0].id
        except Exception:
            pass
        return "default"

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
