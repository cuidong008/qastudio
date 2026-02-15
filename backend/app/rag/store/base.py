"""向量存储抽象：按 course_id 隔离，支持 add / search"""
from abc import ABC, abstractmethod
from typing import Any


class BaseVectorStore(ABC):
    @abstractmethod
    def add(
        self,
        course_id: int,
        ids: list[str],
        texts: list[str],
        metadatas: list[dict[str, Any]],
        embeddings: list[list[float]],
    ) -> None:
        """写入一批 chunk。ids 唯一；metadatas 可含 chapter_id, page_ref, title 等。"""
        pass

    @abstractmethod
    def search(
        self,
        course_id: int,
        query_embedding: list[float],
        top_k: int = 5,
        *,
        chapter_id: int | None = None,
    ) -> list[tuple[str, str, dict[str, Any], float]]:
        """检索。返回 [(id, text, metadata, score), ...]。"""
        pass

    @abstractmethod
    def delete_by_course(self, course_id: int) -> None:
        """删除某课程下全部向量，用于重建索引。"""
        pass
