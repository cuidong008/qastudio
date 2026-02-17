"""单机向量库：Chroma 持久化"""
from pathlib import Path
from typing import Any

import chromadb
from chromadb.config import Settings as ChromaSettings

from .base import BaseVectorStore
from ..config import RAGSettings


class ChromaVectorStore(BaseVectorStore):
    def __init__(self, settings: RAGSettings | None = None):
        from ..config import get_rag_settings
        s = settings or get_rag_settings()
        path = Path(s.vector_store_path)
        path.mkdir(parents=True, exist_ok=True)
        self._client = chromadb.PersistentClient(
            path=str(path),
            settings=ChromaSettings(anonymized_telemetry=False),
        )
        self._collection_name = s.vector_collection_name
        self._coll = self._client.get_or_create_collection(
            name=self._collection_name,
            metadata={"description": "QAStudio course chunks"},
        )

    def add(
        self,
        course_id: int,
        ids: list[str],
        texts: list[str],
        metadatas: list[dict[str, Any]],
        embeddings: list[list[float]],
    ) -> None:
        # Chroma 要求 metadata 值为 str | int | float | bool
        safe_meta = []
        for m in metadatas:
            safe = {"course_id": course_id}
            for k, v in (m or {}).items():
                if v is None:
                    continue
                if isinstance(v, (str, int, float, bool)):
                    safe[k] = v
                else:
                    safe[k] = str(v)
            safe_meta.append(safe)
        self._coll.add(
            ids=ids,
            documents=texts,
            metadatas=safe_meta,
            embeddings=embeddings,
        )

    def search(
        self,
        course_id: int,
        query_embedding: list[float],
        top_k: int = 5,
        *,
        chapter_id: int | None = None,
    ) -> list[tuple[str, str, dict[str, Any], float]]:
        where: dict[str, Any] = {"course_id": course_id}
        if chapter_id is not None:
            where["chapter_id"] = chapter_id
        result = self._coll.query(
            query_embeddings=[query_embedding],
            n_results=top_k,
            where=where,
            include=["documents", "metadatas", "distances"],
        )
        out = []
        if result["ids"] and result["ids"][0]:
            ids = result["ids"][0]
            docs = result["documents"][0]
            metas = result["metadatas"][0]
            dists = result["distances"][0]
            # Chroma 返回 distance：L2 越小越相似；转为相似度可 1/(1+d) 或 -d
            for i, id_ in enumerate(ids):
                doc = docs[i] if i < len(docs) else ""
                meta = metas[i] if metas and i < len(metas) else {}
                d = dists[i] if dists and i < len(dists) else 0.0
                score = 1.0 / (1.0 + float(d))  # 近似相似度
                out.append((id_, doc, meta or {}, score))
        return out

    def delete_by_course(self, course_id: int) -> None:
        self._coll.delete(where={"course_id": course_id})

    def list_by_course(
        self,
        course_id: int,
        *,
        chapter_id: int | None = None,
    ) -> list[tuple[str, str, dict[str, Any]]]:
        where: dict[str, Any] = {"course_id": course_id}
        if chapter_id is not None:
            where["chapter_id"] = chapter_id
        result = self._coll.get(
            where=where,
            include=["documents", "metadatas"],
        )
        out: list[tuple[str, str, dict[str, Any]]] = []
        ids = result.get("ids") or []
        docs = result.get("documents") or []
        metas = result.get("metadatas") or []
        for i, chunk_id in enumerate(ids):
            text = docs[i] if i < len(docs) else ""
            meta = metas[i] if i < len(metas) else {}
            out.append((chunk_id, text or "", meta or {}))
        return out
