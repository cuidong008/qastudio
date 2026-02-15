"""Embedding 抽象：embed(texts) -> list[list[float]]"""
from abc import ABC, abstractmethod


class BaseEmbedding(ABC):
    @property
    @abstractmethod
    def dimension(self) -> int:
        """向量维度。"""
        pass

    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]:
        """批量将文本转为向量，与 texts 一一对应。"""
        pass

    def embed_one(self, text: str) -> list[float]:
        """单条文本。"""
        return self.embed([text])[0]
