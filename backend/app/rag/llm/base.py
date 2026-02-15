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
