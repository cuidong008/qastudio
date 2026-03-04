"""学生端：我的学情等"""
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..db.models import User, UserRole, Course, Class, Teaching, StudentClassMembership
from ..api.auth import get_current_user
from .teacher import _compute_stats_by_course_student

router = APIRouter(prefix="/student", tags=["student"])


async def _student_course_ids_async(db: AsyncSession, user: User) -> set[int]:
    """学生可访问的课程 id 集合（与 chapters list_courses 一致）。"""
    class_ids: set[int] = set()
    if user.class_id is not None:
        class_ids.add(user.class_id)
    r_m = await db.execute(
        select(StudentClassMembership.class_id).where(
            StudentClassMembership.student_id == user.id
        )
    )
    class_ids.update(row[0] for row in r_m.all())
    if not class_ids:
        return set()
    r_t = await db.execute(
        select(Teaching.course_id)
        .where(Teaching.class_id.in_(list(class_ids)), Teaching.is_active == True)
        .distinct()
    )
    return {row[0] for row in r_t.all()}


@router.get("/learning-stats")
async def student_learning_stats(
    course_id: int | None = Query(None, description="筛选课程，不传则全部"),
    start_date: str | None = Query(None, description="统计周期起日 YYYY-MM-DD"),
    end_date: str | None = Query(None, description="统计周期止日 YYYY-MM-DD"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """当前登录学生的学情数据（按课程+学生维度），与教师端学情课程统计详细表结构一致，供「我的学情」页使用。可选 start_date/end_date 按时间区间过滤。"""
    if user.role != UserRole.student.value:
        raise HTTPException(status_code=403, detail="仅学生可访问")
    scoped_course_ids = await _student_course_ids_async(db, user)
    if course_id is not None:
        if course_id not in scoped_course_ids:
            raise HTTPException(status_code=404, detail="课程不存在或无权限")
        scoped_course_ids = {course_id}
    if not scoped_course_ids:
        return []

    # (course_id, student_id) -> class_name；学生本人对每门课至多一个班级
    q_pairs = (
        select(Class.course_id, StudentClassMembership.student_id, Class.name.label("class_name"))
        .select_from(Class)
        .join(StudentClassMembership, StudentClassMembership.class_id == Class.id)
        .where(
            Class.course_id.in_(scoped_course_ids),
            StudentClassMembership.student_id == user.id,
        )
    )
    r_pairs = await db.execute(q_pairs)
    rows_pairs = r_pairs.all()
    pair_to_class: dict[tuple[int, int], str] = {}
    for r in rows_pairs:
        key = (int(r.course_id), int(r.student_id))
        if key not in pair_to_class:
            pair_to_class[key] = r.class_name or "—"
    # 若学生未加入任何班级，仍按「可访问课程」展示学情，班级名显示为 —
    for cid in scoped_course_ids:
        key = (cid, user.id)
        if key not in pair_to_class:
            pair_to_class[key] = "—"

    return await _compute_stats_by_course_student(db, pair_to_class, start_date=start_date, end_date=end_date)
