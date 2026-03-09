# 我的班级页面 · 首屏查询说明

本文说明打开「我的班级」页面（`http://localhost:5173/teacher/classes`）时，首屏涉及的前后端操作与查询内容。

---

## 一、前端首屏操作

### 1. 页面挂载与发起的请求

| 步骤 | 位置 | 操作 |
|------|------|------|
| 1 | `TeacherClasses.tsx` 挂载 | `useEffect` 执行 `load()` |
| 2 | `load()` | **仅发起 1 个接口**：`GET /api/teacher/classes`（班级列表） |
| 3 | 收到班级列表 | `setClasses(classList)`、`setLoading(false)`，表格展示班级数据 |

说明：

- **课程列表（`/api/teacher/courses`）不在首屏请求**，只在用户点击「新建班级」或「编辑」时按需调用 `loadCoursesIfNeeded()`。
- 首屏表格只依赖「班级列表」这一条接口。

### 2. 与全局 Auth 的关系

- 用户信息由 `AuthProvider` 在应用首次加载时通过 `GET /api/auth/me` 拉取（与是否在「我的班级」页无关）。
- 进入「我的班级」时，**不再**为当前用户单独发请求，只发上面的 `GET /api/teacher/classes`。

---

## 二、后端首屏处理（针对 GET /api/teacher/classes）

一次 `GET /api/teacher/classes` 请求在后端的完整链路如下。

### 1. 请求与依赖注入

```
GET /api/teacher/classes
  → FastAPI 路由: teacher.list_teacher_classes
  → 依赖: get_db, require_teacher
```

### 2. 鉴权：require_teacher → get_current_user

| 步骤 | 说明 | 数据库操作 |
|------|------|------------|
| 1 | 从请求中取 JWT（Cookie/Header） | - |
| 2 | 解码 JWT 得到 `user_id` | - |
| 3 | `get_current_user` 根据 `user_id` 查用户 | **1 次查询**：`SELECT * FROM users WHERE id = ?` |
| 4 | `require_teacher` 校验角色（teacher / teaching_leader / admin） | - |

### 3. 业务：list_teacher_classes

| 步骤 | 说明 | 数据库操作 |
|------|------|------------|
| 1 | 按当前教师查班级，并带上课程名、学生数 | **1 次查询**（见下） |
| 2 | 组装 `TeacherClassOut` 列表并返回 | - |

使用的 SQL 逻辑（单条查询，只选列表所需列）：

```sql
SELECT
  classes.id, classes.name, classes.term, classes.course_id,
  classes.owner_teacher_id, classes.student_count, classes.created_at,
  courses.name AS course_name
FROM classes
LEFT OUTER JOIN courses ON classes.course_id = courses.id
WHERE classes.owner_teacher_id = :user_id
ORDER BY classes.id
```

- 不查 `classes.*`，只查列表用到的列，减少 ORM 与 I/O。
- 学生数来自 **`classes.student_count`** 冗余列，不再对 `student_class_memberships` 做子查询或二次统计。

---

## 三、首屏数据库查询汇总（仅「我的班级」页）

打开「我的班级」页面且仅考虑该页首屏触发的接口时：

| # | 接口 | 触发方 | 数据库查询 |
|---|------|--------|------------|
| 1 | `GET /api/teacher/classes` | TeacherClasses.load() | ① `users` 按 id 查当前用户（鉴权）<br>② `classes` LEFT JOIN `courses`，按 `owner_teacher_id` 过滤，读 `student_count` |

即：**1 个 HTTP 请求 → 2 次数据库查询**（1 次鉴权 + 1 次班级列表）。

---

## 四、涉及的表结构（列表用到的列）

- **classes**：id, name, term, course_id, owner_teacher_id, **student_count**, created_at  
  - 索引：owner_teacher_id、course_id（用于 JOIN）
- **courses**：仅用 id、name（通过 `classes.course_id` JOIN）
- **users**：鉴权时按 id 查当前用户

---

## 五、流程简图

```
[浏览器] 打开 /teacher/classes
    │
    ├─ (若应用刚加载) AuthProvider 已发 GET /api/auth/me，拿到 user
    │
    └─ TeacherClasses 挂载
         │
         └─ load() → GET /api/teacher/classes
              │
              [后端]
              │  1. get_current_user → SELECT users WHERE id=?
              │  2. list_teacher_classes → SELECT classes + courses (LEFT JOIN), 读 student_count
              │
              ← 返回 JSON: [{ id, name, term, course_id, course_name, student_count, ... }, ...]
         │
         setClasses(classList), setLoading(false)
         │
         [页面] 表格展示班级列表
```

---

**总结**：首屏「查询的内容」就是「当前教师的班级列表（含关联课程名、学生数）」。前端只发 1 个接口；后端在该接口内做 1 次鉴权查询 + 1 次 Class+Course 的列表查询，学生数来自 `classes.student_count`，无额外聚合查询。
