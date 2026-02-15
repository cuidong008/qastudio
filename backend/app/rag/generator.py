"""RAG 生成：检索结果 + 问题 -> LLM -> 答案与引用"""
from .config import get_rag_settings
from .schema import RetrievedChunk
from .llm import get_llm

# 输出格式约定：模型尽量返回简洁答案；引用由上下文自动带出
RAG_SYSTEM_PROMPT = """你是一名课程助教。请仅根据下面「课程知识库片段」回答学生问题。
要求：
1. 答案简洁，不超纲，仅基于给定片段。
2. 若片段中有 PPT 页码或章节信息，回答末尾可注明「参考：xxx」。
3. 若问题与课程内容无关或无法从片段中找到依据，请回答「该问题未在课程知识库中匹配到相关内容，请结合教材与课堂 PPT 复习。」"""


def build_prompt(question: str, chunks: list[RetrievedChunk]) -> str:
    context = "\n\n---\n\n".join([c.text for c in chunks[:5]])
    return f"{RAG_SYSTEM_PROMPT}\n\n【课程知识库片段】\n{context}\n\n【学生问题】\n{question}"


def generate_answer(
    question: str,
    chunks: list[RetrievedChunk],
) -> tuple[str, str | None, str | None, bool]:
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
        )
    prompt = build_prompt(question, chunks)
    llm = get_llm(settings)
    raw = llm.generate(
        prompt,
        max_tokens=settings.llm_max_tokens,
        temperature=settings.llm_temperature,
    )
    answer = (raw or "").strip()
    # 从最高分 chunk 取引用信息
    best = chunks[0]
    meta = best.metadata or {}
    ppt_ref = meta.get("page_ref") or None
    if isinstance(ppt_ref, str) and not ppt_ref.strip():
        ppt_ref = None
    knowledge_point = meta.get("title") or None
    if isinstance(knowledge_point, str) and not knowledge_point.strip():
        knowledge_point = None
    in_scope = True  # 我们只检索了课程内内容
    return answer, ppt_ref, knowledge_point, in_scope
