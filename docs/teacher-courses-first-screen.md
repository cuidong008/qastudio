# 我的课程页面 · 首屏查询逻辑

本文说明打开「我的课程」页面（`http://localhost:5173/teacher/courses`）时，**课程表首屏显示**涉及的前后端查询逻辑。

---

## 一、前端首屏操作

### 1. 页面挂载与首屏展示

| 步骤 | 位置 | 操作 |
|------|------|------|
| 1 | `TeacherCourses` 挂载 | `useEffect` 执行 `load()` |
| 2 | `load()` | `setLoading(true)`，发起 **`GET /api/teacher/courses`**（课程列表） |
| 3 | 接口返回 | `setList(rows)`、`setLoading(false)` → **课程表立即展示** |
| 4 | 同上（不阻塞） | 后台异步执行：`recoverCachedReindexTasks` → `syncActiveReindexTasks` → `recoverCachedQuestionTasks` → `syncActiveQuestionTasks`（仅用于「重建索引」「生成习题」任务状态，不参与首屏表格内容） |

结论：**首屏课程表内容只依赖「课程列表」这一条接口**；表格一有数据就渲染，索引/习题任务状态在后台慢慢同步。

### 2. 首屏不触发的请求

- **章节列表**：只有用户点击某课程的「章节」展开时，才请求 `GET /api/teacher/courses/:courseId/chapters`，首屏不请求。
- **课程列表**：首屏只请求一次 `GET /api/teacher/courses`，无其他课程相关接口。

### 3. 定时轮询（与首屏表格无关）

- 每 5 秒执行一次：`syncActiveReindexTasks()`、`syncActiveQuestionTasks()`，用于更新「重建索引」「生成习题」的进行中状态，**不参与课程表行数据的首屏展示**。

---

## 二、后端首屏处理（针对 GET /api/teacher/courses）

### 1. 请求与依赖

```
GET /api/teacher/courses
  → 路由: teacher.list_teacher_courses
  → 依赖: get_db, require_teacher
```

### 2. 鉴权：require_teacher → get_current_user

| 步骤 | 说明 | 数据库操作 |
|------|------|------------|
| 1 | 从请求取 JWT，解码得到 `user_id` | - |
| 2 | `get_current_user` 按 id 查用户 | **1 次**：`SELECT * FROM users WHERE id = ?` |
| 3 | `require_teacher` 校验角色 | - |

### 3. 业务：list_teacher_courses

| 步骤 | 说明 | 数据库操作 |
|------|------|------------|
| 1 | 按当前教师查课程列表 | **1 次**：见下 |
| 2 | 组装 `TeacherCourseOut` 列表返回 | - |

使用的查询：

```sql
SELECT * FROM courses
WHERE owner_teacher_id = :user_id
ORDER BY id
```

- 只查 **courses** 表，无 JOIN、无子查询；返回字段：id, name, code, description, remark, is_active, owner_teacher_id, created_at。

---

## 三、首屏数据库查询汇总

打开「我的课程」页面且仅考虑**课程表首屏显示**时：

| # | 接口 | 触发方 | 数据库查询 |
|---|------|--------|------------|
| 1 | `GET /api/teacher/courses` | TeacherCourses.load() | ① 鉴权：`users` 按 id 查当前用户<br>② 列表：`courses` 按 `owner_teacher_id` 查并排序 |

即：**1 个 HTTP 请求 → 2 次数据库查询**（1 次鉴权 + 1 次课程列表）。

---

## 四、涉及的表与字段（首屏课程表）

- **users**：鉴权时按 `id` 查当前用户（仅此一处）。
- **courses**：列表用到的列 — id, name, code, description, remark, is_active, owner_teacher_id, created_at；条件为 `owner_teacher_id = 当前教师`，按 `id` 排序。

---

## 五、流程简图

```
[浏览器] 打开 /teacher/courses
    │
    └─ TeacherCourses 挂载
         │
         └─ load()
              │
              ├─ setLoading(true)
              │
              └─ GET /api/teacher/courses
                   │
                   [后端]
                   │  1. get_current_user → SELECT users WHERE id=?
                   │  2. list_teacher_courses → SELECT courses WHERE owner_teacher_id=? ORDER BY id
                   │
                   ← 返回 JSON: [{ id, name, code, description, remark, is_active, ... }, ...]
              │
              setList(rows), setLoading(false)  →  课程表首屏展示
              │
              └─ 后台异步（不阻塞表格）：
                   recoverCachedReindexTasks → syncActiveReindexTasks
                   recoverCachedQuestionTasks → syncActiveQuestionTasks
                   （仅更新「重建索引」「生成习题」状态）
```

---

## 六、与「我的班级」页面对比

| 项目 | 我的课程 | 我的班级 |
|------|----------|----------|
| 首屏唯一接口 | GET /api/teacher/courses | GET /api/teacher/classes |
| 后端列表查询 | 单表 `courses`，按 owner_teacher_id | `classes` LEFT JOIN `courses`，读 student_count |
| 首屏 DB 查询数 | 2（鉴权 + 课程列表） | 2（鉴权 + 班级列表） |

**总结**：首屏「课程表里的内容」只来自 **GET /api/teacher/courses**；后端在该接口内做 1 次鉴权查询 + 1 次按 `owner_teacher_id` 查 `courses`，无 JOIN、无子查询。
