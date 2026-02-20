"""问答题/填空题 LLM 判卷服务。"""
from __future__ import annotations

import json
import logging
import re

from pydantic import BaseModel

from ..rag.config import get_rag_settings
from ..rag.llm import get_llm

logger = logging.getLogger(__name__)


class LLMGradingResult(BaseModel):
    is_correct: bool
    confidence: float | None = None
    reason: str | None = None


_JSON_BLOCK_RE = re.compile(r"\{[\s\S]*\}")


def _extract_json(raw: str) -> dict | None:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    m = _JSON_BLOCK_RE.search(text)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def _coerce_confidence(value: object) -> float | None:
    if value is None:
        return None
    try:
        score = float(value)
    except Exception:
        return None
    if score < 0:
        return 0.0
    if score > 1:
        return 1.0
    return score


def grade_qa_or_blank(
    *,
    question_type: str,
    question_text: str,
    standard_answer: str,
    user_answer: str,
) -> LLMGradingResult | None:
    """
    对 qa/blank 题型进行语义判卷。
    失败时返回 None，由上层回退规则判卷。
    """
    qtype = (question_type or "").strip().lower()
    if qtype not in {"qa", "blank"}:
        return None
    std = (standard_answer or "").strip()
    usr = (user_answer or "").strip()
    if not std or not usr:
        return None

    settings = get_rag_settings()
    llm = get_llm(settings)

    prompt = f"""你是严格的阅卷助手。请根据“标准答案”判断“学生答案”是否正确。

题型：{qtype}
题目：{question_text}
标准答案：{std}
学生答案：{usr}

判定要求：
1) 仅依据题目与标准答案评分，禁止引入外部知识。
2) 判断语义是否等价或核心要点是否覆盖。
3) 填空题更严格：关键术语必须正确，近义表达仅在不改变术语含义时可判对。
4) 输出必须是 JSON，不要输出额外文字。

输出格式：
{{
  "is_correct": true,
  "confidence": 0.0,
  "reason": "不超过60字的判定理由"
}}"""
    try:
        raw = llm.generate(
            prompt,
            max_tokens=220,
            temperature=0.0,
        )
    except Exception as ex:
        logger.warning("[LLM-GRADE] llm_call_failed: %s", ex)
        return None

    obj = _extract_json(raw)
    if not obj:
        logger.warning("[LLM-GRADE] invalid_json_output: %r", raw[:300])
        return None

    value = obj.get("is_correct")
    if isinstance(value, bool):
        is_correct = value
    elif isinstance(value, str):
        is_correct = value.strip().lower() in {"true", "1", "yes", "y"}
    else:
        return None

    reason_raw = str(obj.get("reason") or "").strip()
    reason = reason_raw[:120] if reason_raw else None

    return LLMGradingResult(
        is_correct=is_correct,
        confidence=_coerce_confidence(obj.get("confidence")),
        reason=reason,
    )
