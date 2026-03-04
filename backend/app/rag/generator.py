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

# 判定是否为“课件原文”而非简洁回答：含页码块、多页结构、学校/课程标题等
_RAW_SLIDE_PAGE_MARKERS = re.compile(r"\[第\s*\d+\s*页\]")
_RAW_SLIDE_PAGE_FULLWIDTH = re.compile(r"[【\[]\s*第\s*\d+\s*页\s*[】\]]")  # 【第1页】或 [第1页]
_RAW_SLIDE_HEADER_HINTS = re.compile(r"(西发航空学院|Year-end\s+SUMMARY|^\d+min\s|局域网技术概述)", re.IGNORECASE | re.MULTILINE)
_RAW_SLIDE_ANY_PAGE = re.compile(r"第\s*\d+\s*页")

# 输出格式约定：模型尽量返回简洁答案；引用由上下文自动带出
RAG_SYSTEM_PROMPT = """你是一名课程助教。请仅根据下面「课程知识库片段」回答学生问题。
要求：
1. 答案简洁，不超纲，仅基于给定片段；用 2～5 句直接回答，不要照抄课件原文。
2. 答案正文中不要包含：页码（如 [第1页]）、学校/课程标题、日程（如 15min）、无关排版；引用由系统单独展示。
3. 若问题与课程内容无关或无法从片段中找到依据，请仅回答「无法匹配到合适答案」（answer 字段只填这一句，ref_pages 填 []）。
4. 仅输出 JSON，不要输出其他文字。格式：
{"answer":"...","ref_pages":[7,8]}
- answer: 字符串（仅简洁回答，勿带课件结构）
- ref_pages: 整数数组，若无法确定则 []"""

# 无 chunks 时返回的引用文案（前端会展示为「参考文档：当前问题在知识库中没有参考答案」）
NO_CHUNKS_REF = "当前问题在知识库中没有参考答案"

def _clean_answer_text(answer: str) -> str:
    text = (answer or "").strip()
    if not text:
        return text
    # 无论“参考：”出现在行首还是行中，统一剔除后续内容
    text = _REF_ANY_RE.sub("", text).strip()
    return text


def _looks_like_raw_slide(text: str) -> bool:
    """若答案像课件原文（含页码块、多页结构、无关标题），应交给大模型蒸馏成简洁回答。"""
    t = (text or "").strip()
    if not t:
        logger.warning("[RAG-TRACE] looks_like_raw_slide: empty text -> False")
        return False
    # 含有 [第N页] 或 【第N页】 这类页码块
    if _RAW_SLIDE_PAGE_MARKERS.search(t) or _RAW_SLIDE_PAGE_FULLWIDTH.search(t):
        logger.warning("[RAG-TRACE] looks_like_raw_slide: page_markers matched -> True (len=%s)", len(t))
        return True
    # 含有课程/学校标题、日程等无关信息
    if _RAW_SLIDE_HEADER_HINTS.search(t):
        logger.warning("[RAG-TRACE] looks_like_raw_slide: header_hints matched -> True (len=%s)", len(t))
        return True
    # 任意“第X页”出现至少一次且篇幅较长，视为原文
    if _RAW_SLIDE_ANY_PAGE.search(t) and len(t) > 200:
        logger.warning("[RAG-TRACE] looks_like_raw_slide: any_page+long matched -> True (len=%s)", len(t))
        return True
    # 多处“第X页”
    if len(_RAW_SLIDE_ANY_PAGE.findall(t)) >= 2:
        logger.warning("[RAG-TRACE] looks_like_raw_slide: multi_page matched -> True (len=%s)", len(t))
        return True
    # 兜底：很长且同时含“页”和分段/标题感（多换行或含 [】）
    if len(t) > 350 and "页" in t and ("第" in t or "[" in t or "【" in t):
        logger.warning("[RAG-TRACE] looks_like_raw_slide: fallback long+page matched -> True (len=%s)", len(t))
        return True
    logger.warning("[RAG-TRACE] looks_like_raw_slide: no rule matched -> False (len=%s preview=%r)", len(t), t[:120])
    return False


def _distill_raw_content(question: str, raw_content: str, llm, max_tokens: int = 420, temperature: float = 0.3) -> str:
    """
    用大模型把课件原文针对用户问题提炼成简洁回答，去掉页码、标题、学校名等无用信息。
    """
    logger.warning("[RAG-TRACE] distill_raw_content enter raw_len=%s", len(raw_content or ""))
    prompt = f"""你是一名课程助教。用户的问题是：「{question}」

下面是从课件/PPT 中摘录的原始片段（可能包含页码标记、课件标题、学校名、日程等无关信息）。
请仅根据该片段，针对用户问题给出简洁、直接的回答。
要求：
1. 去掉所有 [第N页]、学校名、课程标题、日程（如 15min）、无关排版，只保留与问题相关的知识点。
2. 用 2～10 句中文作答，不要照抄大段原文。
3. 不要输出「根据片段」「根据课件」等前缀，直接给答案。
4. 若片段中确实没有与问题相关的内容，请简短说明「该片段中未直接涉及该问题」即可。

【原始片段】
{raw_content[:3200]}

【简洁回答】
"""
    try:
        out = llm.generate(prompt, max_tokens=max_tokens, temperature=temperature)
        cleaned = (out or "").strip()
        if cleaned:
            result = _clean_answer_text(cleaned)
            logger.warning("[RAG-TRACE] distill_raw_content success result_len=%s", len(result))
            return result
    except Exception as e:
        logger.warning("[RAG-TRACE] distill_raw_content_failed: %s", e)
    logger.warning("[RAG-TRACE] distill_raw_content fallback to truncated raw")
    return _clean_answer_text(raw_content[:500] + "…") if len((raw_content or "").strip()) > 500 else _clean_answer_text(raw_content or "")


def distill_answer_if_raw(question: str, answer: str) -> str:
    """
    若 answer 像课件原文则用大模型蒸馏成简洁回答，否则原样返回。
    供 RAG 与非 RAG 路径统一使用。
    """
    a = answer or ""
    logger.warning("[RAG-TRACE] distill_answer_if_raw enter answer_len=%s preview=%r", len(a), a[:150])
    if not _looks_like_raw_slide(a):
        logger.warning("[RAG-TRACE] distill_answer_if_raw skip (not raw_slide) return as-is")
        return a.strip()
    logger.warning("[RAG-TRACE] distill_answer_if_raw calling _distill_raw_content")
    try:
        settings = get_rag_settings()
        llm = get_llm(settings)
        return _distill_raw_content(
            question, answer or "", llm,
            max_tokens=min(getattr(settings, "llm_max_tokens", 512), 420),
            temperature=getattr(settings, "llm_temperature", 0.3),
        )
    except Exception as e:
        logger.warning("[RAG-TRACE] distill_answer_if_raw_failed: %s", e)
        logger.warning("[RAG-TRACE] distill_answer_if_raw return original answer on error")
        return (answer or "").strip()


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
) -> tuple[str, str | None, str | None, bool, int | None, int | None, str | None]:
    """
    根据检索结果生成答案。
    返回 (answer, ppt_ref, knowledge_point, in_scope, reference_doc_id, reference_page, source_title)。
    source_title：仅当来源为 doc_/slide_ 时的 chunk 标题（文档名/PPT 文件名），供「参考文档」展示用；kp_ 时为 None。
    """
    settings = get_rag_settings()
    llm = get_llm(settings)
    logger.warning("[RAG-TRACE] generate_answer enter chunks=%s question=%r", len(chunks or []), (question or "")[:80])
    if not chunks:
        # 无 chunks 时不在此处调 LLM，由 qa.py 统一调用 _try_llm_answer_or_no_match，与情况 1、3 一致
        logger.warning("[RAG-TRACE] generate_answer no_chunks -> return None for qa to try LLM, ref=%s", NO_CHUNKS_REF)
        return (None, NO_CHUNKS_REF, None, True, None, None, None)
    prompt = build_prompt(question, chunks)
    raw = llm.generate(
        prompt,
        max_tokens=settings.llm_max_tokens,
        temperature=settings.llm_temperature,
    )
    answer, llm_pages = _parse_structured_llm_output(raw)
    logger.warning(
        "[RAG-TRACE] generate_answer after_parse answer_len=%s preview=%r",
        len(answer or ""),
        (answer or "")[:180],
    )
    looks_raw = _looks_like_raw_slide(answer)
    logger.warning("[RAG-TRACE] generate_answer looks_like_raw_slide=%s", looks_raw)
    # 若答案仍像课件原文（页码、标题等），用大模型蒸馏成针对问题的简洁回答
    if looks_raw:
        logger.warning("[RAG-TRACE] generate_answer doing distill (answer_looks_like_raw_slide)")
        answer = _distill_raw_content(
            question, answer, llm,
            max_tokens=min(settings.llm_max_tokens, 420),
            temperature=settings.llm_temperature,
        )
        answer = _clean_answer_text(answer)
        logger.warning("[RAG-TRACE] generate_answer after_distill answer_len=%s", len(answer or ""))
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
    # 仅当命中来源为知识点（kp_）时，关联知识点才用其 title；doc_/slide_ 的 title 是文档名/文件名，不作为知识点展示
    source_id = str(meta.get("source_id") or "").strip()
    knowledge_point = (meta.get("title") or None) if source_id.startswith("kp_") else None
    if isinstance(knowledge_point, str) and not knowledge_point.strip():
        knowledge_point = None
    # 参考文档名称：仅当来源为 doc_/slide_ 时取 chunk 标题（文档名或 PPT 文件名），用于「参考文档：xxx，第xx页」展示
    source_title = None
    if source_id.startswith("doc_") or source_id.startswith("slide_"):
        t = meta.get("title")
        source_title = (t or "").strip() or None
    in_scope = True  # 我们只检索了课程内内容
    reference_doc_id = _resolve_reference_doc(chunks)
    reference_page = page_nums[0] if page_nums else None
    logger.warning(
        "[RAG-TRACE] generator_done chunks=%s llm_pages=%s available_pages=%s ppt_ref=%r knowledge_point=%r reference_doc_id=%r reference_page=%r source_title=%r answer_len=%s",
        len(chunks),
        llm_pages,
        sorted(list(available_pages))[:12],
        ppt_ref,
        knowledge_point,
        reference_doc_id,
        reference_page,
        source_title,
        len(answer),
    )
    return answer, ppt_ref, knowledge_point, in_scope, reference_doc_id, reference_page, source_title
