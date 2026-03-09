"""LLM 抽象：业务仅依赖 generate(prompt, **kwargs) -> str"""
from abc import ABC, abstractmethod
from typing import Any


class BaseLLM(ABC):
    @abstractmethod
    def generate(
        self,
        prompt: str,
        *,
        max_tokens: int = 512,
        temperature: float = 0.3,
        **kwargs: Any,
    ) -> str:
        """根据 prompt 生成文本。"""
        pass

    def generate_with_meta(
        self,
        prompt: str,
        *,
        max_tokens: int = 512,
        temperature: float = 0.3,
        **kwargs: Any,
    ) -> tuple[str, str | None]:
        """生成文本并返回结束原因（finish_reason）；默认实现不提供该元信息。"""
        return self.generate(prompt, max_tokens=max_tokens, temperature=temperature, **kwargs), None
