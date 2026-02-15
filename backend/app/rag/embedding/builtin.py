"""程序自带 Embedding：使用 sentence-transformers 本地模型"""
from .base import BaseEmbedding


class BuiltinEmbedding(BaseEmbedding):
    def __init__(self, model_name: str = "paraphrase-multilingual-MiniLM-L12-v2"):
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError:
            raise ImportError(
                "builtin embedding 需要安装 sentence-transformers: pip install sentence-transformers"
            )
        self._model = SentenceTransformer(model_name)
        self._dim = self._model.get_sentence_embedding_dimension()

    @property
    def dimension(self) -> int:
        return self._dim

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        vecs = self._model.encode(texts, convert_to_numpy=True)
        return vecs.tolist()
