"""RAG 分块：按段落/句子切分后再按 token 预算合并，支持重叠窗口。"""
from __future__ import annotations

import re

from .schema import ChunkDocument
from .config import RAGSettings, get_rag_settings

_SENTENCE_SPLIT = re.compile(r"(?<=[。！？!?；;])\s+|(?<=[\.\!\?])\s+")
_PAGE_MARKER = re.compile(r"^\[第\d+页\]$")
_LATIN_WORD = re.compile(r"[A-Za-z0-9_]+")
_CJK_CHAR = re.compile(r"[\u4e00-\u9fff]")


def _estimate_tokens(text: str) -> int:
    """轻量 token 估算：中文按字、英文按词。"""
    if not text:
        return 0
    cjk = len(_CJK_CHAR.findall(text))
    latin = len(_LATIN_WORD.findall(text))
    # 标点/其他字符给一点权重，避免超长连续符号段
    extra = max(0, len(text) // 80)
    return cjk + latin + extra


def _hard_split_long_unit(text: str, limit: int) -> list[str]:
    if not text:
        return []
    if limit <= 0:
        return [text]
    out: list[str] = []
    start = 0
    n = len(text)
    while start < n:
        end = min(n, start + limit * 2)
        out.append(text[start:end].strip())
        start = end
    return [x for x in out if x]


def _split_to_units(text: str) -> list[str]:
    """先按段落，再按句子拆分；保留页标记与结构边界。"""
    norm = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not norm:
        return []

    blocks = [b.strip() for b in re.split(r"\n{2,}", norm) if b.strip()]
    units: list[str] = []
    for block in blocks:
        # 页标记独立成段，方便引用与定位
        if _PAGE_MARKER.match(block):
            units.append(block)
            continue
        # 标题（markdown）单独作为一个分块单元
        if block.startswith("#"):
            units.append(block)
            continue

        sents = [s.strip() for s in _SENTENCE_SPLIT.split(block) if s.strip()]
        if not sents:
            units.append(block)
            continue
        units.extend(sents)
    return units


def _merge_units(units: list[str], size: int, overlap: int) -> list[str]:
    if not units:
        return []
    if size <= 0:
        return ["\n".join(units).strip()]

    merged: list[str] = []
    current_units: list[str] = []
    current_tokens = 0

    def flush() -> None:
        nonlocal current_units, current_tokens
        chunk = "\n".join(current_units).strip()
        if chunk:
            merged.append(chunk)

    for unit in units:
        ut = _estimate_tokens(unit)
        if ut > size * 2:
            pieces = _hard_split_long_unit(unit, size)
            for p in pieces:
                pt = _estimate_tokens(p)
                if current_units and current_tokens + pt > size:
                    flush()
                    # 构造 overlap 窗口（按 token）
                    if overlap > 0:
                        ov: list[str] = []
                        ov_tokens = 0
                        for prev in reversed(current_units):
                            prev_tokens = _estimate_tokens(prev)
                            if ov and ov_tokens + prev_tokens > overlap:
                                break
                            ov.insert(0, prev)
                            ov_tokens += prev_tokens
                            if ov_tokens >= overlap:
                                break
                        if not ov and current_units:
                            ov = [current_units[-1]]
                        current_units = ov
                        current_tokens = _estimate_tokens("\n".join(ov))
                    else:
                        current_units = []
                        current_tokens = 0
                current_units.append(p)
                current_tokens += pt
            continue

        if current_units and current_tokens + ut > size:
            flush()
            if overlap > 0:
                ov = []
                ov_tokens = 0
                for prev in reversed(current_units):
                    prev_tokens = _estimate_tokens(prev)
                    if ov and ov_tokens + prev_tokens > overlap:
                        break
                    ov.insert(0, prev)
                    ov_tokens += prev_tokens
                    if ov_tokens >= overlap:
                        break
                if not ov and current_units:
                    ov = [current_units[-1]]
                current_units = ov
                current_tokens = _estimate_tokens("\n".join(ov))
            else:
                current_units = []
                current_tokens = 0

        current_units.append(unit)
        current_tokens += ut

    if current_units:
        flush()

    return merged


def chunk_documents(
    documents: list[ChunkDocument],
    chunk_size: int | None = None,
    chunk_overlap: int | None = None,
    settings: RAGSettings | None = None,
) -> list[tuple[str, dict]]:
    """
    将文档切分为 (text, metadata)。
    分块策略参考 RAGFlow 的 Naive 分块流程：
    1) 先按结构边界（段落/句子）切单元；
    2) 再按 chunk_size 合并；
    3) chunk_overlap 作为尾部重叠窗口。
    """
    s = settings or get_rag_settings()
    size = max(32, int(chunk_size if chunk_size is not None else s.chunk_size))
    overlap = max(0, int(chunk_overlap if chunk_overlap is not None else s.chunk_overlap))

    out: list[tuple[str, dict]] = []
    for doc in documents:
        meta = {
            "course_id": doc.course_id,
            "chapter_id": doc.chapter_id,
            "page_ref": doc.page_ref,
            "title": doc.title,
            "source_id": doc.source_id,
        }
        text = (doc.text or "").strip()
        if not text:
            continue

        units = _split_to_units(text)
        chunks = _merge_units(units, size=size, overlap=overlap)
        if not chunks:
            chunks = [text]

        for idx, ck in enumerate(chunks):
            out.append((ck, {**meta, "chunk_index": idx}))
    return out
