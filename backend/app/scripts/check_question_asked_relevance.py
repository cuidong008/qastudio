"""查询指定学号/提问内容的 QuestionAsked 记录，检查 course_irrelevant 等字段。用法: python -m app.scripts.check_question_asked_relevance"""
import asyncio
import sys
from sqlalchemy import select
from app.db.session import AsyncSessionLocal
from app.db.models import QuestionAsked, User


async def main():
    # 学号 S0001、提问含「口红」
    student_no = "S0001"
    keyword = "口红"
    async with AsyncSessionLocal() as session:
        # 先查 S0001 的 user_id
        r_user = await session.execute(select(User.id).where(User.student_no == student_no))
        user_id_row = r_user.one_or_none()
        if not user_id_row:
            print(f"未找到学号为 {student_no!r} 的用户")
            return
        user_id = user_id_row[0]
        # 查该用户的提问，且问题文本含 keyword
        r = await session.execute(
            select(QuestionAsked)
            .where(
                QuestionAsked.user_id == user_id,
                QuestionAsked.question_text.like(f"%{keyword}%"),
            )
            .order_by(QuestionAsked.created_at.desc())
        )
        rows = r.scalars().all()
        if not rows:
            print(f"未找到学号 {student_no!r} 且问题含 {keyword!r} 的提问记录")
            return
        print(f"找到 {len(rows)} 条记录（学号={student_no}, 关键词={keyword!r}）:\n")
        for q in rows:
            print(f"  id={q.id}")
            print(f"  question_text={q.question_text!r}")
            print(f"  course_id={q.course_id}")
            print(f"  course_irrelevant={q.course_irrelevant!r}  (True=与课程无关, False=有关, None=未判断)")
            print(f"  rag_hit={q.rag_hit}")
            print(f"  ppt_ref={q.ppt_ref!r}")
            print(f"  created_at={q.created_at}")
            print()


if __name__ == "__main__":
    asyncio.run(main())
    sys.exit(0)
