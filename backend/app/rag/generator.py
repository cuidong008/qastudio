"""RAG 生成：检索结果 + 问题 -> LLM -> 答案与引用"""
import json
import logging
import re

from .config import get_rag_settings
from .schema import RetrievedChunk
from .llm import get_llm

logger = logging.getLogger(__name__)
_PAGE_RE = re.compile(r"(?:\[第\s*(\d+)\s*页\]|第\s*(\d+)\s*页|(\d+)\s*页)")
_REF_ANY_RE = re.compile(r"参考\s*[：:]\s*.*$", re.IGNORECASE | re.DOTALL)
_TOTAL_PAGES_RE = re.compile(r"^\s*(?:共?\s*)?\d+\s*页\s*$")
_ZH_TOKEN_RE = re.compile(r"[\u4e00-\u9fff]{2,}")
_EN_TOKEN_RE = re.compile(r"[a-z0-9]{3,}")

# 输出格式约定：模型尽量返回简洁答案；引用由上下文自动带出
RAG_SYSTEM_PROMPT = """你是一名课程助教。请仅根据下面「课程知识库片段」回答学生问题。
要求：
1. 答案简洁，不超纲，仅基于给定片段。
2. 不要在答案正文里输出“参考：xxx”、页码或文档名；引用由系统单独展示。
3. 若问题与课程内容无关或无法从片段中找到依据，请回答「该问题未在课程知识库中匹配到相关内容，请结合教材与课堂 PPT 复习。」。
4. 仅输出 JSON，不要输出其他文字。格式：
{"answer":"...","ref_pages":[7,8]}
- answer: 字符串
- ref_pages: 整数数组，若无法确定则 []"""


def _extractive_fallback(chunks: list[RetrievedChunk]) -> str:
    """
    当检索到片段但 LLM 返回“无答案”时，使用首片段做保底摘要，
    避免出现“明明命中了却显示无参考答案”。
    """
    if not chunks:
        return ""
    text = (chunks[0].text or "").replace("\n", " ").strip()
    if not text:
        return ""
    # 控制长度，优先给出可读结论
    return (text[:220] + "…") if len(text) > 220 else text


def _clean_answer_text(answer: str) -> str:
    text = (answer or "").strip()
    if not text:
        return text
    # 无论“参考：”出现在行首还是行中，统一剔除后续内容
    text = _REF_ANY_RE.sub("", text).strip()
    return text


def _extract_json_obj(raw: str) -> dict | None:
    text = (raw or "").strip()
    if not text:
        return None
    # 优先整段 JSON
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    # 兜底：提取首个 {...}
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def _parse_structured_llm_output(raw: str) -> tuple[str, list[int]]:
    obj = _extract_json_obj(raw)
    if not obj:
        return _clean_answer_text(raw), []
    answer = _clean_answer_text(str(obj.get("answer") or ""))
    pages_raw = obj.get("ref_pages") or []
    pages: list[int] = []
    if isinstance(pages_raw, list):
        for x in pages_raw:
            try:
                n = int(x)
            except Exception:
                continue
            if n > 0 and n not in pages:
                pages.append(n)
    pages.sort()
    return answer, pages[:4]


def _question_tokens(question: str) -> list[str]:
    q = (question or "").lower()
    toks = _ZH_TOKEN_RE.findall(q) + _EN_TOKEN_RE.findall(q)
    seen: set[str] = set()
    out: list[str] = []
    for t in toks:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out[:10]


def _collect_available_pages(chunks: list[RetrievedChunk], max_pages: int = 40) -> set[int]:
    pages: set[int] = set()
    for c in chunks[:8]:
        meta_page = str((c.metadata or {}).get("page_ref") or "").strip()
        if meta_page and not _TOTAL_PAGES_RE.match(meta_page):
            m = _PAGE_RE.search(meta_page)
            if m:
                for g in m.groups():
                    if g and g.isdigit():
                        pages.add(int(g))
                        break
        for m in _PAGE_RE.finditer(c.text or ""):
            for g in m.groups():
                if g and g.isdigit():
                    pages.add(int(g))
                    break
            if len(pages) >= max_pages:
                return pages
    return pages


def _extract_page_numbers(chunks: list[RetrievedChunk], question: str, max_pages: int = 2) -> list[int]:
    """
    从命中片段中按“页块与问题关键词匹配度”选页，避免粗扫导致页码漂移。
    """
    toks = _question_tokens(question)
    selected: list[tuple[int, int]] = []  # (score, page)
    seen_pages: set[int] = set()

    for c in chunks[:3]:
        text = c.text or ""
        parts = re.split(r"\[第\s*(\d+)\s*页\]", text)
        # parts: [prefix, page_num, page_text, page_num, page_text, ...]
        if len(parts) >= 3:
            best_page = None
            best_score = -1
            for i in range(1, len(parts) - 1, 2):
                page_s = (parts[i] or "").strip()
                page_text = (parts[i + 1] or "").lower()
                if not page_s.isdigit():
                    continue
                page_n = int(page_s)
                score = 0
                for t in toks:
                    if t in page_text:
                        score += 1
                # 即使 token 全未命中，也保留第一页作为弱兜底
                if score > best_score:
                    best_score = score
                    best_page = page_n
            if best_page and best_page not in seen_pages:
                seen_pages.add(best_page)
                selected.append((best_score, best_page))
                continue

        # 无页块时，尝试 metadata.page_ref（但过滤“总页数”）
        page_ref = str((c.metadata or {}).get("page_ref") or "").strip()
        if page_ref and not _TOTAL_PAGES_RE.match(page_ref):
            m = _PAGE_RE.search(page_ref)
            if m:
                for g in m.groups():
                    if g and g.isdigit():
                        p = int(g)
                        if p not in seen_pages:
                            seen_pages.add(p)
                            selected.append((0, p))
                        break

    # 优先高分页，再按页码排序保证展示稳定
    selected.sort(key=lambda x: (-x[0], x[1]))
    pages = [p for _, p in selected[:max_pages]]
    pages.sort()
    return pages


def _resolve_reference_doc(chunks: list[RetrievedChunk]) -> int | None:
    for c in chunks[:5]:
        sid = str((c.metadata or {}).get("source_id") or "").strip()
        if sid.startswith("doc_"):
            suffix = sid[4:]
            if suffix.isdigit():
                return int(suffix)
    return None


def build_prompt(question: str, chunks: list[RetrievedChunk]) -> str:
    context = "\n\n---\n\n".join([c.text for c in chunks[:5]])
    return f"{RAG_SYSTEM_PROMPT}\n\n【课程知识库片段】\n{context}\n\n【学生问题】\n{question}"


def generate_answer(
    question: str,
    chunks: list[RetrievedChunk],
) -> tuple[str, str | None, str | None, bool, int | None, int | None]:
    """
    根据检索结果生成答案。
    返回 (answer, ppt_ref, knowledge_point, in_scope)。
    """
    settings = get_rag_settings()
    if not chunks:
        return (
            "当前问题未在课程知识库中匹配到相关内容，请换一种问法或限定章节后再试。建议结合教材与课堂 PPT 复习。",
            None,
            None,
            True,
            None,
            None,
        )
    prompt = build_prompt(question, chunks)
    llm = get_llm(settings)
    raw = llm.generate(
        prompt,
        max_tokens=settings.llm_max_tokens,
        temperature=settings.llm_temperature,
    )
    answer, llm_pages = _parse_structured_llm_output(raw)
    if "未在课程知识库" in answer:
        fallback = _extractive_fallback(chunks)
        if fallback:
            logger.warning("[RAG-TRACE] generator_llm_miss_use_extractive_fallback")
            answer = fallback
    answer = _clean_answer_text(answer)
    # 从最高分 chunk 取引用信息
    best = chunks[0]
    meta = best.metadata or {}
    available_pages = _collect_available_pages(chunks)
    page_nums = [p for p in llm_pages if p in available_pages]
    if not page_nums:
        page_nums = _extract_page_numbers(chunks, question=question)
    ppt_ref = "、".join([f"第{n}页" for n in page_nums]) if page_nums else (meta.get("page_ref") or None)
    if isinstance(ppt_ref, str) and not ppt_ref.strip():
        ppt_ref = None
    knowledge_point = meta.get("title") or None
    if isinstance(knowledge_point, str) and not knowledge_point.strip():
        knowledge_point = None
    in_scope = True  # 我们只检索了课程内内容
    reference_doc_id = _resolve_reference_doc(chunks)
    reference_page = page_nums[0] if page_nums else None
    logger.warning(
        "[RAG-TRACE] generator_done chunks=%s llm_pages=%s available_pages=%s ppt_ref=%r knowledge_point=%r reference_doc_id=%r reference_page=%r answer_len=%s",
        len(chunks),
        llm_pages,
        sorted(list(available_pages))[:12],
        ppt_ref,
        knowledge_point,
        reference_doc_id,
        reference_page,
        len(answer),
    )
    return answer, ppt_ref, knowledge_point, in_scope, reference_doc_id, reference_page
