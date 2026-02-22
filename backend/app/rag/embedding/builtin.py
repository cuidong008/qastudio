"""程序自带 Embedding：使用 sentence-transformers 本地模型"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

# 必须在首次 import sentence_transformers / huggingface_hub 之前设置 HF_ENDPOINT，
# 否则 huggingface_hub 在 import 时已读走默认的 huggingface.co，后续再设无效。
def _set_hf_endpoint_early() -> None:
    endpoint = (os.getenv("RAG_HF_ENDPOINT") or "").strip()
    if not endpoint:
        try:
            from ..config import get_rag_settings
            endpoint = (getattr(get_rag_settings(), "hf_endpoint", None) or "").strip()
        except Exception:
            pass
    if endpoint:
        os.environ["HF_ENDPOINT"] = endpoint.rstrip("/")

_set_hf_endpoint_early()

from .base import BaseEmbedding

logger = logging.getLogger(__name__)


def _apply_hf_endpoint() -> None:
    """若 RAG 配置中设置了 Hugging Face 镜像，则设置 HF_ENDPOINT（国内可用 hf-mirror.com）"""
    try:
        from ..config import get_rag_settings
        s = get_rag_settings()
        endpoint = (getattr(s, "hf_endpoint", None) or "").strip()
        if endpoint:
            os.environ["HF_ENDPOINT"] = endpoint.rstrip("/")
            logger.info("[RAG-EMBED] 使用 Hugging Face 镜像: %s", os.environ["HF_ENDPOINT"])
    except Exception:
        pass


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


def _hub_cache_dir() -> Path:
    """HF hub 缓存根目录（与 huggingface_hub 默认一致）。"""
    for key in ("HF_HUB_CACHE", "HF_HOME"):
        val = (os.getenv(key) or "").strip()
        if val:
            p = Path(val).expanduser()
            if key == "HF_HOME":
                p = p / "hub"
            return p.resolve()
    return (Path.home() / ".cache" / "huggingface" / "hub").resolve()


def _is_repo_cached(repo_id: str) -> bool:
    """判断 HF 缓存中是否已有该 repo：先 scan_cache_dir，再按目录结构兜底。"""
    try:
        from huggingface_hub import scan_cache_dir
        info = scan_cache_dir()
        for repo in info.repos:
            if getattr(repo, "repo_id", "") == repo_id:
                return True
    except Exception:
        pass
    # 兜底：按 HF 缓存目录 models--Org--name 检查是否存在
    try:
        dir_name = "models--" + repo_id.replace("/", "--")
        cache_root = _hub_cache_dir()
        repo_dir = cache_root / dir_name
        if repo_dir.is_dir():
            snapshots = repo_dir / "snapshots"
            if snapshots.is_dir() and any(snapshots.iterdir()):
                return True
    except Exception:
        pass
    return False


def _load_sentence_transformer(model_name: str, local_files_only: bool):
    from sentence_transformers import SentenceTransformer
    if local_files_only:
        return SentenceTransformer(model_name, model_kwargs={"local_files_only": True})
    return SentenceTransformer(model_name)


class BuiltinEmbedding(BaseEmbedding):
    def __init__(self, model_name: str = "paraphrase-multilingual-MiniLM-L12-v2"):
        try:
            from sentence_transformers import SentenceTransformer  # noqa: F401
        except ImportError:
            raise ImportError(
                "builtin embedding 需要安装 sentence-transformers: pip install sentence-transformers"
            )
        _apply_hf_endpoint()
        cache_roots = _cache_roots()
        model_name = (model_name or "").strip()
        is_local_path = "/" in model_name and Path(model_name).expanduser().exists()
        repo_cached_before = _is_repo_cached(model_name) if (model_name and not is_local_path) else False

        logger.warning(
            "[RAG-EMBED] 内置 Embedding 加载开始 model=%s is_local_path=%s repo_cached=%s cache_roots=%s",
            model_name,
            is_local_path,
            repo_cached_before,
            cache_roots,
        )
        if not is_local_path and repo_cached_before:
            logger.warning("[RAG-EMBED] 检测到本地已有缓存，将优先仅从本地加载不请求 Hugging Face model=%s", model_name)

        start = time.perf_counter()
        try:
            # 非本地路径时一律先尝试仅用本地缓存，避免对 adapter_config.json 等发 HEAD/GET
            if is_local_path:
                self._model = _load_sentence_transformer(model_name, local_files_only=True)
            else:
                try:
                    self._model = _load_sentence_transformer(model_name, local_files_only=True)
                except Exception as e1:
                    logger.warning("[RAG-EMBED] 仅本地加载失败，尝试联网下载 model=%s error=%s", model_name, e1)
                    self._model = _load_sentence_transformer(model_name, local_files_only=False)
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
