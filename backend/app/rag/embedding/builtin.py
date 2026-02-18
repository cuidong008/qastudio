"""程序自带 Embedding：使用 sentence-transformers 本地模型"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

from .base import BaseEmbedding

logger = logging.getLogger(__name__)


def _cache_roots() -> list[str]:
    roots: list[str] = []
    for key in ("SENTENCE_TRANSFORMERS_HOME", "HF_HOME", "TRANSFORMERS_CACHE"):
        val = (os.getenv(key) or "").strip()
        if val:
            roots.append(str(Path(val).expanduser()))
    if not roots:
        roots.append(str((Path.home() / ".cache" / "huggingface").resolve()))
    # 去重并保持顺序
    seen: set[str] = set()
    out: list[str] = []
    for r in roots:
        if r not in seen:
            seen.add(r)
            out.append(r)
    return out


def _is_repo_cached(repo_id: str) -> bool:
    """尽力判断 HF 缓存中是否已有该 repo。"""
    try:
        from huggingface_hub import scan_cache_dir
    except Exception:
        return False
    try:
        info = scan_cache_dir()
        for repo in info.repos:
            if getattr(repo, "repo_id", "") == repo_id:
                return True
    except Exception:
        return False
    return False


class BuiltinEmbedding(BaseEmbedding):
    def __init__(self, model_name: str = "paraphrase-multilingual-MiniLM-L12-v2"):
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError:
            raise ImportError(
                "builtin embedding 需要安装 sentence-transformers: pip install sentence-transformers"
            )
        cache_roots = _cache_roots()
        model_name = (model_name or "").strip()
        is_local_path = "/" in model_name and Path(model_name).expanduser().exists()
        repo_cached_before = _is_repo_cached(model_name) if (model_name and not is_local_path) else False

        logger.warning(
            "[RAG-EMBED] 内置 Embedding 加载开始 model=%s is_local_path=%s cache_roots=%s",
            model_name,
            is_local_path,
            cache_roots,
        )
        if not is_local_path:
            if repo_cached_before:
                logger.warning("[RAG-EMBED] 检测到本地已有缓存，将直接加载 model=%s", model_name)
            else:
                logger.warning("[RAG-EMBED] 未检测到本地缓存，若网络可用将开始下载 model=%s", model_name)

        start = time.perf_counter()
        try:
            self._model = SentenceTransformer(model_name)
            self._dim = self._model.get_sentence_embedding_dimension()
            repo_cached_after = _is_repo_cached(model_name) if (model_name and not is_local_path) else False
            elapsed = time.perf_counter() - start
            if not is_local_path and (not repo_cached_before) and repo_cached_after:
                logger.warning(
                    "[RAG-EMBED] 模型下载并加载完成 model=%s dim=%s elapsed=%.2fs cache_roots=%s",
                    model_name,
                    self._dim,
                    elapsed,
                    cache_roots,
                )
            else:
                logger.warning(
                    "[RAG-EMBED] 模型加载完成 model=%s dim=%s elapsed=%.2fs cache_roots=%s",
                    model_name,
                    self._dim,
                    elapsed,
                    cache_roots,
                )
        except Exception as e:
            elapsed = time.perf_counter() - start
            logger.exception(
                "[RAG-EMBED] 模型加载失败 model=%s elapsed=%.2fs cache_roots=%s error=%s",
                model_name,
                elapsed,
                cache_roots,
                e,
            )
            raise

    @property
    def dimension(self) -> int:
        return self._dim

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        vecs = self._model.encode(texts, convert_to_numpy=True)
        return vecs.tolist()
