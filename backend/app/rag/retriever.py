"""检索：多路 Query Rewrite + HyDE + 向量/BM25 混合召回 + RRF 融合 + 轻量重排"""
from __future__ import annotations

import math
import logging
import re
import uuid
from dataclasses import dataclass

from .config import get_rag_settings, RAGSettings
from .schema import RetrievedChunk
from .embedding import get_embedding
from .llm import get_llm
from .store.chroma_store import ChromaVectorStore

_ZH_WORD_RE = re.compile(r"[\u4e00-\u9fff]{2,}")
_LATIN_WORD_RE = re.compile(r"[a-z0-9_]{2,}")
_SPACE_RE = re.compile(r"\s+")

_QUERY_SYNONYMS = {
    "局域网络": "局域网",
    "广域网络": "广域网",
    "城域网络": "城域网",
    "有哪些特点": "特点",
    "有什么特点": "特点",
    "有何特点": "特点",
    "的特点是什么": "特点",
    "特点是什么": "特点",
    "是什么特点": "特点",
    "主要特点": "特点",
    "特征": "特点",
}

_QUERY_FILLERS = (
    "请问",
    "一下",
    "下",
    "呢",
    "吗",
    "么",
    "呀",
    "啊",
)

logger = logging.getLogger(__name__)

_GUARD_SPLIT_RE = re.compile(r"(什么|怎么|为何|为什么|有何|有哪些|有什么|是否|是不是|吗|呢|请问|一下|今年|这个|那个|的|是)")
_GUARD_MIN_KEYWORD_LEN = 2
_GUARD_STOP_TOKENS = {
    "什么",
    "怎么",
    "为何",
    "为什么",
    "有何",
    "有哪些",
    "有什么",
    "是否",
    "是不是",
    "请问",
    "一下",
    "这个",
    "那个",
    "今年",
}


@dataclass
class _Hit:
    chunk_id: str
    text: str
    metadata: dict
    score: float
    rank: int
    source: str


def _m(meta: dict, key: str) -> str:
    v = (meta or {}).get(key)
    if v is None:
        return ""
    s = str(v).strip()
    return s[:80] if s else ""


def _fmt_hit(h: _Hit) -> str:
    title = _m(h.metadata, "title")
    page = _m(h.metadata, "page_ref")
    return f"id={h.chunk_id} score={h.score:.4f} rank={h.rank} src={h.source} title={title} page={page}"


def _fmt_chunk(c: RetrievedChunk) -> str:
    meta = c.metadata or {}
    title = _m(meta, "title")
    page = _m(meta, "page_ref")
    return f"id={c.chunk_id} score={c.score:.4f} title={title} page={page}"


def _extract_guard_keywords(question: str) -> list[str]:
    """
    相关性守门关键词：
    - 先做同义词归一
    - 按疑问词/虚词切分，保留内容词
    """
    q = _normalize_query(question)
    parts = [p.strip() for p in _GUARD_SPLIT_RE.split(q) if p and not _GUARD_SPLIT_RE.fullmatch(p)]
    out: list[str] = []
    seen: set[str] = set()
    for p in parts:
        if len(p) < _GUARD_MIN_KEYWORD_LEN:
            continue
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out[:8]


def _guard_tokens(question: str) -> list[str]:
    """
    守门 token（比整串关键词更鲁棒）：
    - 基于 normalize 后问句提取 token
    - 过滤疑问/虚词
    """
    q = _normalize_query(question)
    toks = _tokenize_zh(q)
    out: list[str] = []
    seen: set[str] = set()
    for t in toks:
        tt = (t or "").strip()
        if len(tt) < _GUARD_MIN_KEYWORD_LEN:
            continue
        if tt in _GUARD_STOP_TOKENS:
            continue
        if tt not in seen:
            seen.add(tt)
            out.append(tt)
    return out


def _has_keyword_evidence(question: str, ranked: list[RetrievedChunk], check_top_n: int = 3) -> tuple[bool, list[str], list[str]]:
    guard_kws = _extract_guard_keywords(question)
    q_tokens = _guard_tokens(question)
    if not q_tokens:
        # 没有可用 token 时放行，避免过杀
        return True, [], guard_kws
    joined = "\n".join([(c.text or "") for c in ranked[:max(1, check_top_n)]])
    matched_tokens = [t for t in q_tokens if t in joined]
    # 只要有 1 个实词 token 命中即可；比“整串命中”稳定很多
    return bool(matched_tokens), matched_tokens[:10], guard_kws


def _normalize_query(text: str) -> str:
    q = _SPACE_RE.sub(" ", (text or "").strip())
    if not q:
        return ""
    for src, dst in _QUERY_SYNONYMS.items():
        q = q.replace(src, dst)
    for w in _QUERY_FILLERS:
        q = q.replace(w, "")
    q = _SPACE_RE.sub(" ", q).strip(" ，。！？?!.")
    return q


def _rewrite_queries(question: str, settings: RAGSettings) -> list[str]:
    base = (question or "").strip()
    if not base:
        return []
    if not settings.query_rewrite_enabled:
        return [base]

    normalized = _normalize_query(base)
    variants = [base]
    if normalized and normalized != base:
        variants.append(normalized)

    if "有什么特点" in base:
        variants.append(base.replace("有什么特点", "的特点"))
    if "有何特点" in base:
        variants.append(base.replace("有何特点", "特点"))
    if "的特点是什么" in base:
        variants.append(base.replace("的特点是什么", "特点"))
    if "特点是什么" in base:
        variants.append(base.replace("特点是什么", "特点"))
    if normalized and "特点" in normalized and not normalized.endswith("特点"):
        variants.append(f"{normalized} 的特点")
    if normalized and ("什么是" in normalized or normalized.startswith("什么")):
        variants.append(normalized.replace("什么是", "").replace("什么", "").strip())

    dedup: list[str] = []
    seen: set[str] = set()
    for q in variants:
        qq = _SPACE_RE.sub(" ", (q or "").strip())
        if qq and qq not in seen:
            seen.add(qq)
            dedup.append(qq)
    limit = max(1, int(settings.query_rewrite_count))
    return dedup[:limit]


def _build_hyde(question: str, settings: RAGSettings) -> str:
    if not settings.hyde_enabled:
        return ""
    try:
        llm = get_llm(settings)
        prompt = (
            "你是检索辅助器。请根据问题写一段 80~160 字的中文知识性短文，"
            "要求：只写事实陈述，不要解释来源，不要加标题。\n"
            f"问题：{question}"
        )
        text = llm.generate(
            prompt,
            max_tokens=max(64, min(settings.hyde_max_tokens, 320)),
            temperature=max(0.0, min(settings.hyde_temperature, 0.8)),
        )
        return (text or "").strip()
    except Exception:
        return ""


def _tokenize_zh(text: str) -> list[str]:
    if not text:
        return []
    t = text.lower()
    words = _ZH_WORD_RE.findall(t) + _LATIN_WORD_RE.findall(t)
    # 追加中文 bi-gram，提升“局域网/局域网络”等近似匹配效果
    cjk_chars = [c for c in t if "\u4e00" <= c <= "\u9fff"]
    bigrams = [cjk_chars[i] + cjk_chars[i + 1] for i in range(len(cjk_chars) - 1)]
    return words + bigrams


def _bm25_scores(query: str, docs: list[tuple[str, list[str]]], k1: float = 1.5, b: float = 0.75) -> list[float]:
    q_tokens = _tokenize_zh(query)
    if not q_tokens or not docs:
        return [0.0] * len(docs)

    n_docs = len(docs)
    doc_lens = [max(1, len(toks)) for _, toks in docs]
    avg_dl = sum(doc_lens) / max(1, n_docs)

    df: dict[str, int] = {}
    for _, toks in docs:
        for tok in set(toks):
            df[tok] = df.get(tok, 0) + 1

    idf: dict[str, float] = {}
    for tok, freq in df.items():
        idf[tok] = math.log(1.0 + (n_docs - freq + 0.5) / (freq + 0.5))

    scores: list[float] = []
    for i, (_, toks) in enumerate(docs):
        tf: dict[str, int] = {}
        for tok in toks:
            tf[tok] = tf.get(tok, 0) + 1
        dl = doc_lens[i]
        s = 0.0
        for tok in q_tokens:
            f = tf.get(tok, 0)
            if f <= 0:
                continue
            denom = f + k1 * (1.0 - b + b * dl / max(avg_dl, 1e-6))
            s += idf.get(tok, 0.0) * (f * (k1 + 1.0) / max(denom, 1e-6))
        scores.append(s)
    return scores


def _vector_recall(
    store: ChromaVectorStore,
    settings: RAGSettings,
    course_id: int,
    chapter_id: int | None,
    query_texts: list[str],
) -> list[_Hit]:
    emb = get_embedding(settings)
    hits: list[_Hit] = []
    per_query_top_k = max(1, int(settings.vector_recall_k))
    for query_idx, query in enumerate(query_texts):
        q = (query or "").strip()
        if not q:
            continue
        qv = emb.embed_one(q)
        rows = store.search(
            course_id=course_id,
            query_embedding=qv,
            top_k=per_query_top_k,
            chapter_id=chapter_id,
        )
        for rank, row in enumerate(rows, start=1):
            hits.append(
                _Hit(
                    chunk_id=row[0],
                    text=row[1],
                    metadata=row[2] or {},
                    score=float(row[3]),
                    rank=rank,
                    source=f"vector:{query_idx}",
                )
            )
    return hits


def _sparse_recall(
    store: ChromaVectorStore,
    settings: RAGSettings,
    course_id: int,
    chapter_id: int | None,
    query_texts: list[str],
) -> list[_Hit]:
    corpus = store.list_by_course(course_id=course_id, chapter_id=chapter_id)
    if not corpus:
        return []

    docs = [(cid, _tokenize_zh(text)) for cid, text, _ in corpus]
    meta_by_id = {cid: (text, meta or {}) for cid, text, meta in corpus}

    agg: dict[str, float] = {}
    for q in query_texts:
        scores = _bm25_scores(q, docs)
        for i, (cid, _) in enumerate(docs):
            agg[cid] = max(agg.get(cid, 0.0), float(scores[i]))

    ranked = sorted(agg.items(), key=lambda x: x[1], reverse=True)
    top_n = max(1, int(settings.sparse_recall_k))
    out: list[_Hit] = []
    for rank, (cid, score) in enumerate(ranked[:top_n], start=1):
        text, meta = meta_by_id.get(cid, ("", {}))
        out.append(
            _Hit(
                chunk_id=cid,
                text=text,
                metadata=meta,
                score=score,
                rank=rank,
                source="sparse",
            )
        )
    return out


def _rrf_fuse(hits: list[_Hit], settings: RAGSettings) -> list[tuple[str, float]]:
    rrf_k = max(1, int(settings.rrf_k))
    # 每个来源独立排名，避免一类结果过多时压制其他来源
    by_source: dict[str, list[_Hit]] = {}
    for h in hits:
        by_source.setdefault(h.source, []).append(h)
    for source in by_source:
        by_source[source].sort(key=lambda x: x.rank)

    fused: dict[str, float] = {}
    for source_hits in by_source.values():
        for rank, h in enumerate(source_hits, start=1):
            fused[h.chunk_id] = fused.get(h.chunk_id, 0.0) + 1.0 / (rrf_k + rank)
    return sorted(fused.items(), key=lambda x: x[1], reverse=True)


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    if union == 0:
        return 0.0
    return inter / union


def _rerank(
    question: str,
    fused: list[tuple[str, float]],
    hit_map: dict[str, _Hit],
    settings: RAGSettings,
    final_top_k: int,
) -> list[RetrievedChunk]:
    if not fused:
        return []

    q_tokens = set(_tokenize_zh(question))
    fused_map = dict(fused)
    cand_ids = [cid for cid, _ in fused[: max(1, int(settings.rerank_top_n))]]
    scored: list[tuple[str, float]] = []
    for cid in cand_ids:
        h = hit_map[cid]
        doc_tokens = set(_tokenize_zh(h.text[:1800]))
        lexical = _jaccard(q_tokens, doc_tokens)
        semantic = float(h.score)
        semantic = semantic / (1.0 + abs(semantic))
        # 轻量重排：语义得分优先 + 词面重合 + RRF 候选位置
        final_score = 0.65 * semantic + 0.25 * lexical + 0.10 * fused_map.get(cid, 0.0)
        scored.append((cid, final_score))

    scored.sort(key=lambda x: x[1], reverse=True)
    out: list[RetrievedChunk] = []
    for cid, score in scored[:final_top_k]:
        h = hit_map[cid]
        out.append(
            RetrievedChunk(
                chunk_id=h.chunk_id,
                text=h.text,
                metadata=h.metadata or {},
                score=float(score),
            )
        )
    return out


def retrieve(
    question: str,
    course_id: int,
    *,
    chapter_id: int | None = None,
    top_k: int | None = None,
) -> list[RetrievedChunk]:
    """
    在指定课程知识库中检索与问题最相关的 chunk。
    流程：
    1) 多路 query rewrite（规则）；
    2) 可选 HyDE 伪文档扩展；
    3) 向量召回 + 稀疏 BM25 召回；
    4) RRF 融合；
    5) 轻量重排并返回 top_k。
    """
    settings = get_rag_settings()
    trace_id = uuid.uuid4().hex[:8]
    final_top_k = max(1, int(top_k if top_k is not None and top_k > 0 else settings.top_k))

    q = (question or "").strip()
    if not q:
        return []

    rewrites = _rewrite_queries(q, settings)
    hyde_text = _build_hyde(q, settings) if settings.hyde_enabled else ""
    if hyde_text:
        rewrites.append(hyde_text)
    logger.warning(
        "[RAG-TRACE][%s] start q=%r course_id=%s chapter_id=%s top_k=%s hybrid=%s rewrite=%s hyde=%s rerank=%s",
        trace_id,
        q,
        course_id,
        chapter_id,
        final_top_k,
        settings.hybrid_enabled,
        settings.query_rewrite_enabled,
        bool(hyde_text),
        settings.rerank_enabled,
    )
    logger.warning("[RAG-TRACE][%s] rewrites=%s", trace_id, [x[:120] for x in rewrites])

    store = ChromaVectorStore(settings)

    vector_hits = _vector_recall(store, settings, course_id, chapter_id, rewrites)
    logger.warning(
        "[RAG-TRACE][%s] vector_hits=%s sample=%s",
        trace_id,
        len(vector_hits),
        [_fmt_hit(h) for h in vector_hits[:5]],
    )
    sparse_hits: list[_Hit] = []
    if settings.hybrid_enabled:
        sparse_hits = _sparse_recall(store, settings, course_id, chapter_id, rewrites)
    logger.warning(
        "[RAG-TRACE][%s] sparse_hits=%s sample=%s",
        trace_id,
        len(sparse_hits),
        [_fmt_hit(h) for h in sparse_hits[:5]],
    )

    all_hits = vector_hits + sparse_hits
    if not all_hits:
        logger.warning("[RAG-TRACE][%s] no_hits", trace_id)
        return []

    # 对同一 chunk 取最强命中作为基础特征
    hit_map: dict[str, _Hit] = {}
    for h in all_hits:
        prev = hit_map.get(h.chunk_id)
        if prev is None or h.score > prev.score:
            hit_map[h.chunk_id] = h

    fused = _rrf_fuse(all_hits, settings)
    fused = fused[: max(1, int(settings.fused_top_n))]
    logger.warning(
        "[RAG-TRACE][%s] fused=%s sample=%s",
        trace_id,
        len(fused),
        [f"id={cid} rrf={score:.4f}" for cid, score in fused[:8]],
    )

    if settings.rerank_enabled:
        ranked = _rerank(q, fused, hit_map, settings, final_top_k)
    else:
        ranked = [
            RetrievedChunk(
                chunk_id=cid,
                text=hit_map[cid].text,
                metadata=hit_map[cid].metadata,
                score=float(score),
            )
            for cid, score in fused[:final_top_k]
        ]
    logger.warning(
        "[RAG-TRACE][%s] ranked=%s top=%s",
        trace_id,
        len(ranked),
        [_fmt_chunk(c) for c in ranked[:5]],
    )

    if not ranked:
        logger.warning("[RAG-TRACE][%s] ranked_empty", trace_id)
        return []
    ok, matched, guard_kws = _has_keyword_evidence(q, ranked, check_top_n=3)
    if not ok:
        logger.warning(
            "[RAG-TRACE][%s] guard_reject_no_keyword_evidence keywords=%s matched_tokens=%s",
            trace_id,
            guard_kws,
            matched,
        )
        return []
    logger.warning("[RAG-TRACE][%s] guard_pass matched_tokens=%s", trace_id, matched)
    # 低分兜底：若强相关度过低，放宽返回条数，避免直接“无答案”
    if ranked[0].score < max(0.0, float(settings.no_answer_threshold)):
        out = ranked[: max(1, min(3, len(ranked)))]
        logger.warning(
            "[RAG-TRACE][%s] low_score_fallback threshold=%.4f top_score=%.4f out=%s",
            trace_id,
            float(settings.no_answer_threshold),
            ranked[0].score,
            len(out),
        )
        return out
    logger.warning("[RAG-TRACE][%s] done out=%s", trace_id, len(ranked))
    return ranked
