"""外部 Embedding API：OpenAI 兼容或指定 base_url + api_key"""
from openai import OpenAI

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

    @property
    def dimension(self) -> int:
        return self._dim

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        # 过滤空串，避免 API 报错
        non_empty = [t or " " for t in texts]
        resp = self._client.embeddings.create(model=self._model, input=non_empty)
        # 按 input 顺序返回
        by_idx = {item.index: item.embedding for item in resp.data}
        return [by_idx.get(i, [0.0] * self._dim) for i in range(len(non_empty))]
