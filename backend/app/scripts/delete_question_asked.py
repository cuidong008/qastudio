"""一次性脚本：从 questions_asked 表中删除指定提问文本的记录。"""
import asyncio
import sys
from sqlalchemy import select, delete, or_
from app.db.session import AsyncSessionLocal
from app.db.models import QuestionAsked


async def main():
    target = "今年什颜色口红卖的比较好?"
    async with AsyncSessionLocal() as session:
        r = await session.execute(
            select(QuestionAsked).where(
                or_(
                    QuestionAsked.question_text == target,
                    QuestionAsked.question_text.like("%今年什%口红%"),
                )
            )
        )
        rows = r.scalars().all()
        if not rows:
            print(f"未找到匹配的提问记录: {target}")
            return
        ids = [q.id for q in rows]
        for q in rows:
            print(f"删除 id={q.id} question_text={q.question_text!r}")
        await session.execute(delete(QuestionAsked).where(QuestionAsked.id.in_(ids)))
        await session.commit()
        print(f"已删除 {len(rows)} 条记录。")


if __name__ == "__main__":
    asyncio.run(main())
    sys.exit(0)
