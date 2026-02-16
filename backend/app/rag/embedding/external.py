"""外部 Embedding API：OpenAI 兼容或指定 base_url + api_key"""
import hashlib
import math
import re

from openai import OpenAI
from openai import BadRequestError

from .base import BaseEmbedding
from ..config import RAGSettings


class ExternalEmbedding(BaseEmbedding):
    """OpenAI 兼容的 embedding 接口（可配置 base_url，用于自建或第三方）。"""
    def __init__(self, settings: RAGSettings):
        self._client = OpenAI(
            base_url=(settings.embedding_external_base_url or "https://api.openai.com/v1").rstrip("/"),
            api_key=settings.embedding_external_api_key or "not-needed",
        )
        self._model = settings.embedding_external_model or "text-embedding-3-small"
        self._dim = settings.embedding_dim or 1536
        self._batch_size = max(1, int(getattr(settings, "embedding_external_batch_size", 10) or 10))

    @property
    def dimension(self) -> int:
        return self._dim

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        # 过滤空串，避免 API 报错
        non_empty = [t or " " for t in texts]
        return self._embed_with_batch(non_empty, self._batch_size)

    def _embed_with_batch(self, texts: list[str], batch_size: int) -> list[list[float]]:
        result: list[list[float]] = []
        for start in range(0, len(texts), batch_size):
            batch = texts[start : start + batch_size]
            try:
                resp = self._client.embeddings.create(model=self._model, input=batch)
            except BadRequestError as e:
                msg = str(e)
                if batch_size > 1 and ("batch size is invalid" in msg or "should not be larger than" in msg):
                    # 部分供应商对批量数限制更严格，自动降级重试
                    smaller = max(1, batch_size // 2)
                    return self._embed_with_batch(texts, smaller)
                if batch_size == 1 and ("batch size is invalid" in msg or "should not be larger than" in msg):
                    # 某些 OpenAI 兼容端点在 batch=1 时只接受 input 为字符串而非数组
                    try:
                        resp = self._client.embeddings.create(model=self._model, input=batch[0])
                    except BadRequestError:
                        # 外部服务仍不兼容时，降级为本地哈希向量，避免索引整体失败
                        return self._hash_embed(texts)
                else:
                    raise
            by_idx = {item.index: item.embedding for item in resp.data}
            result.extend([by_idx.get(i, [0.0] * self._dim) for i in range(len(batch))])
        return result

    def _hash_embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for text in texts:
            vec = [0.0] * self._dim
            tokens = re.findall(r"[\u4e00-\u9fffA-Za-z0-9_]+", (text or "").lower())
            if not tokens:
                out.append(vec)
                continue
            for tok in tokens:
                h = int(hashlib.md5(tok.encode("utf-8")).hexdigest(), 16)
                idx = h % self._dim
                vec[idx] += 1.0
            norm = math.sqrt(sum(v * v for v in vec)) or 1.0
            out.append([v / norm for v in vec])
        return out
