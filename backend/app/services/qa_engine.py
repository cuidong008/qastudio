"""智能问答引擎（能力层）：基于知识库检索的简洁答案 + PPT 引用，不超纲"""
from __future__ import annotations
from typing import List
from pydantic import BaseModel


class QAResponse(BaseModel):
    answer: str
    ppt_ref: str | None = None
    knowledge_point: str | None = None
    in_scope: bool = True  # 是否在课程范围内，超纲则 False


def _truncate(s: str, max_len: int = 400) -> str:
    s = (s or "").strip()
    if len(s) <= max_len:
        return s
    return s[: max_len - 3].rstrip() + "…"


def answer_from_documents(
    question: str,
    documents: list[tuple[str, str | None, str | None]],
) -> QAResponse:
    """
    根据检索到的知识库文档生成答案。documents: [(content, page_ref, title), ...]
    严格限定在课程范围内，仅基于给定文档生成简洁答案。
    """
    if not documents:
        return QAResponse(
            answer="当前问题未在课程知识库中匹配到相关内容，请换一种问法或限定章节后再试。建议结合教材与课堂 PPT 复习。",
            ppt_ref=None,
            knowledge_point=None,
            in_scope=True,
        )
    content, page_ref, title = documents[0]
    answer = _truncate(content or "")
    if title and "电商" in (title or ""):
        answer = f"（与电商场景相关）{answer}"
    return QAResponse(
        answer=answer or "请参考教材与课堂 PPT 对应章节。",
        ppt_ref=page_ref,
        knowledge_point=title,
        in_scope=True,
    )


def answer_question(question: str, context_chapter_id: int | None = None) -> QAResponse:
    """
    占位：无 DB 时使用。实际由 API 层做检索后调用 answer_from_documents。
    """
    return QAResponse(
        answer="根据课程内容，可从「网络协议」与「电商交易规则」类比理解。具体请参考教材对应小节与课堂 PPT。",
        ppt_ref="第2章 第2页",
        knowledge_point="网络协议",
        in_scope=True,
    )
