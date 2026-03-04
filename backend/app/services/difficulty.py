"""难度等级与难度系数的映射：基础 (0.7, 1.0]，应用 (0.5, 0.7]，拓展 (0, 0.5]。"""

# 难度等级 -> (min_exclusive, max_inclusive)，即左开右闭区间
DIFFICULTY_SCORE_RANGES: dict[str, tuple[float, float]] = {
    "basic": (0.7, 1.0),     # 基础: (0.7, 1.0]
    "applied": (0.5, 0.7),   # 应用: (0.5, 0.7]
    "extended": (0.0, 0.5),   # 拓展: (0, 0.5]
}


def difficulty_from_score(score: float) -> str:
    """根据难度系数 (0~1) 返回难度等级：basic / applied / extended。"""
    if not (0 <= score <= 1):
        return "basic"
    if score > 0.7:
        return "basic"
    if score > 0.5:
        return "applied"
    return "extended"


def score_range_for_difficulty(difficulty: str) -> tuple[float, float] | None:
    """返回难度等级对应的 (min_exclusive, max_inclusive)，用于 SQL 条件 score > min and score <= max。"""
    return DIFFICULTY_SCORE_RANGES.get(difficulty)
