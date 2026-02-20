import React, { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { toast } from "../../utils/toast";

type CourseItem = {
  id: number;
  name: string;
  code: string | null;
  description: string | null;
  is_active: boolean;
  created_at: string | null;
};

type ChapterItem = {
  id: number;
  course_id: number | null;
  title: string;
  order_index: number;
  syllabus_ref: string | null;
  question_count: number;
};

type KnowledgePointDraft = {
  title: string;
  content: string;
  ppt_slide_ref: string;
  order_index: number;
};

type CachedQuestionTask = {
  taskId: number;
  chapterId: number;
  courseId: number | null;
  updatedAt: number;
};

const QUESTION_TASK_CACHE_KEY = "teacher:question-task-cache";

const readCachedQuestionTasks = (): CachedQuestionTask[] => {
  try {
    const raw = localStorage.getItem(QUESTION_TASK_CACHE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => ({
        taskId: Number(x?.taskId || 0),
        chapterId: Number(x?.chapterId || 0),
        courseId: x?.courseId == null ? null : Number(x.courseId || 0),
        updatedAt: Number(x?.updatedAt || 0),
      }))
      .filter((x) => x.taskId > 0 && x.chapterId > 0)
      .slice(-30);
  } catch {
    return [];
  }
};

const writeCachedQuestionTasks = (items: CachedQuestionTask[]) => {
  try {
    localStorage.setItem(QUESTION_TASK_CACHE_KEY, JSON.stringify(items.slice(-30)));
  } catch {
    // ignore cache write failure
  }
};

const upsertCachedQuestionTask = (item: CachedQuestionTask) => {
  const curr = readCachedQuestionTasks();
  const next = [...curr.filter((x) => x.taskId !== item.taskId), item];
  writeCachedQuestionTasks(next);
};

const removeCachedQuestionTask = (taskId: number) => {
  const curr = readCachedQuestionTasks();
  writeCachedQuestionTasks(curr.filter((x) => x.taskId !== taskId));
};

export default function TeacherCourses() {
  const [list, setList] = useState<CourseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", code: "", description: "", is_active: true });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [expandCourseId, setExpandCourseId] = useState<number | null>(null);
  const [chapters, setChapters] = useState<ChapterItem[]>([]);
  const [chapterForm, setChapterForm] = useState({ title: "", order_index: 0, syllabus_ref: "" });
  const [addingChapter, setAddingChapter] = useState(false);
  const [chapterEditModal, setChapterEditModal] = useState(false);
  const [editingChapterId, setEditingChapterId] = useState<number | null>(null);
  const [chapterEditForm, setChapterEditForm] = useState({ title: "", order_index: 0, syllabus_ref: "" });
  const [chapterKnowledgePoints, setChapterKnowledgePoints] = useState<KnowledgePointDraft[]>([]);
  const [chapterSaving, setChapterSaving] = useState(false);
  const [reindexTaskByCourse, setReindexTaskByCourse] = useState<Record<number, { taskId: number; status: string }>>({});
  const [clearingId, setClearingId] = useState<number | null>(null);
  const [questionGenModalChapter, setQuestionGenModalChapter] = useState<ChapterItem | null>(null);
  const [questionTaskByChapter, setQuestionTaskByChapter] = useState<Record<number, { taskId: number; status: string }>>({});
  const [questionGenForm, setQuestionGenForm] = useState({
    single_choice_max: 5,
    multiple_choice_max: 2,
    judge_max: 3,
    qa_max: 2,
    blank_max: 2,
  });
  const pollingReindexTaskIdsRef = useRef<Set<number>>(new Set());
  const notifiedReindexTaskIdsRef = useRef<Set<number>>(new Set());
  const pollingQuestionTaskIdsRef = useRef<Set<number>>(new Set());
  const notifiedQuestionTaskIdsRef = useRef<Set<number>>(new Set());
  const questionTaskByChapterRef = useRef<Record<number, { taskId: number; status: string }>>({});
  const aliveRef = useRef(true);

  useEffect(() => {
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    questionTaskByChapterRef.current = questionTaskByChapter;
  }, [questionTaskByChapter]);

  const pollReindexTask = async (courseId: number, taskId: number) => {
    if (taskId <= 0) return;
    if (pollingReindexTaskIdsRef.current.has(taskId)) return;
    pollingReindexTaskIdsRef.current.add(taskId);
    const maxPoll = 180;
    try {
      for (let i = 0; i < maxPoll; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!aliveRef.current) return;
        try {
          const task = await api.teacher.courses.getReindexTask(taskId);
          setReindexTaskByCourse((prev) => ({ ...prev, [courseId]: { taskId, status: task.status } }));
          if (task.status === "success") {
            if (!notifiedReindexTaskIdsRef.current.has(taskId)) {
              notifiedReindexTaskIdsRef.current.add(taskId);
              toast(`索引完成，共 ${task.result_payload?.chunks_indexed ?? 0} 个切片。`, "success");
            }
            setReindexTaskByCourse((prev) => {
              if (prev[courseId]?.taskId !== taskId) return prev;
              const next = { ...prev };
              delete next[courseId];
              return next;
            });
            return;
          }
          if (task.status === "failed") {
            if (!notifiedReindexTaskIdsRef.current.has(taskId)) {
              notifiedReindexTaskIdsRef.current.add(taskId);
              toast(task.error_message || "重建索引任务失败", "error");
            }
            setReindexTaskByCourse((prev) => {
              if (prev[courseId]?.taskId !== taskId) return prev;
              const next = { ...prev };
              delete next[courseId];
              return next;
            });
            return;
          }
        } catch {
          // ignore and keep polling
        }
      }
      if (!notifiedReindexTaskIdsRef.current.has(taskId)) {
        notifiedReindexTaskIdsRef.current.add(taskId);
        toast("重建索引任务仍在处理中，请稍后再看。");
      }
    } finally {
      pollingReindexTaskIdsRef.current.delete(taskId);
    }
  };

  const syncActiveQuestionTasks = async () => {
    try {
      const activeQuestionTasks = await api.teacher.courses.listActiveQuestionTasks();
      const activeByChapter: Record<number, { taskId: number; status: string }> = {};
      activeQuestionTasks.forEach((t) => {
        activeByChapter[t.chapter_id] = { taskId: t.task_id, status: t.status };
        upsertCachedQuestionTask({
          taskId: t.task_id,
          chapterId: t.chapter_id,
          courseId: t.course_id,
          updatedAt: Date.now(),
        });
      });
      const disappeared = Object.entries(questionTaskByChapterRef.current)
        .map(([chapterId, item]) => ({ chapterId: Number(chapterId), ...item }))
        .filter((item) => (item.status === "pending" || item.status === "running") && !activeByChapter[item.chapterId]);
      await Promise.all(
        disappeared.map(async (item) => {
          try {
            const task = await api.teacher.courses.getQuestionTask(item.taskId);
            if (task.status === "success") {
              if (!notifiedQuestionTaskIdsRef.current.has(item.taskId)) {
                notifiedQuestionTaskIdsRef.current.add(item.taskId);
                const byType = task.result_payload?.by_type;
                toast(
                  `生成完成：共 ${task.result_payload?.created ?? 0} 题（单选 ${byType?.single_choice ?? 0}，多选 ${byType?.multiple_choice ?? 0}，判断 ${byType?.judge ?? 0}，问答 ${byType?.qa ?? 0}，填空 ${byType?.blank ?? 0}），跳过 ${task.result_payload?.skipped ?? 0} 题。`,
                  "success"
                );
              }
              removeCachedQuestionTask(item.taskId);
            }
            if (task.status === "failed") {
              if (!notifiedQuestionTaskIdsRef.current.has(item.taskId)) {
                notifiedQuestionTaskIdsRef.current.add(item.taskId);
                toast(task.error_message || "生成任务失败", "error");
              }
              removeCachedQuestionTask(item.taskId);
            }
          } catch {
            // ignore transient task query failures
          }
        })
      );
      setQuestionTaskByChapter((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((k) => {
          const chapterId = Number(k);
          const item = next[chapterId];
          if ((item?.status === "pending" || item?.status === "running") && !activeByChapter[chapterId]) {
            delete next[chapterId];
          }
        });
        Object.keys(activeByChapter).forEach((k) => {
          const chapterId = Number(k);
          next[chapterId] = activeByChapter[chapterId];
        });
        return next;
      });
      activeQuestionTasks.forEach((t) => {
        void pollQuestionTask(t.chapter_id, t.task_id, t.course_id);
      });
    } catch {
      // ignore active task recovery failure
    }
  };

  const recoverCachedQuestionTasks = async () => {
    const cached = readCachedQuestionTasks();
    if (cached.length === 0) return;
    await Promise.all(
      cached.map(async (item) => {
        try {
          const task = await api.teacher.courses.getQuestionTask(item.taskId);
          if (task.status === "pending" || task.status === "running") {
            setQuestionTaskByChapter((prev) => ({
              ...prev,
              [task.chapter_id]: { taskId: task.id, status: task.status },
            }));
            void pollQuestionTask(task.chapter_id, task.id, task.course_id);
            return;
          }
          if (task.status === "success") {
            if (!notifiedQuestionTaskIdsRef.current.has(task.id)) {
              notifiedQuestionTaskIdsRef.current.add(task.id);
              const byType = task.result_payload?.by_type;
              toast(
                `生成完成：共 ${task.result_payload?.created ?? 0} 题（单选 ${byType?.single_choice ?? 0}，多选 ${byType?.multiple_choice ?? 0}，判断 ${byType?.judge ?? 0}，问答 ${byType?.qa ?? 0}，填空 ${byType?.blank ?? 0}），跳过 ${task.result_payload?.skipped ?? 0} 题。`,
                "success"
              );
            }
            removeCachedQuestionTask(task.id);
            return;
          }
          if (task.status === "failed") {
            if (!notifiedQuestionTaskIdsRef.current.has(task.id)) {
              notifiedQuestionTaskIdsRef.current.add(task.id);
              toast(task.error_message || "生成任务失败", "error");
            }
            removeCachedQuestionTask(task.id);
          }
        } catch {
          // ignore and wait next sync
        }
      })
    );
  };

  const load = () => {
    setLoading(true);
    api.teacher.courses
      .list()
      .then(async (rows) => {
        setList(rows);
        try {
          const activeTasks = await api.teacher.courses.listActiveReindexTasks();
          const next: Record<number, { taskId: number; status: string }> = {};
          activeTasks.forEach((t) => {
            next[t.course_id] = { taskId: t.task_id, status: t.status };
          });
          setReindexTaskByCourse(next);
          activeTasks.forEach((t) => {
            void pollReindexTask(t.course_id, t.task_id);
          });
        } catch {
          // ignore active task recovery failure
        }
        await recoverCachedQuestionTasks();
        await syncActiveQuestionTasks();
      })
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void syncActiveQuestionTasks();
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (expandCourseId == null) {
      setChapters([]);
      return;
    }
    api.teacher.courses.chapters(expandCourseId).then(setChapters).catch(() => setChapters([]));
  }, [expandCourseId]);

  const openCreate = () => {
    setForm({ name: "", code: "", description: "", is_active: true });
    setModal("create");
    setError("");
  };
  const openEdit = (c: CourseItem) => {
    setEditId(c.id);
    setForm({ name: c.name, code: c.code || "", description: c.description || "", is_active: c.is_active });
    setModal("edit");
    setError("");
  };

  const submitCreate = () => {
    setSaving(true);
    setError("");
    api.teacher.courses
      .create({
        name: form.name.trim(),
        code: form.code.trim() || undefined,
        description: form.description.trim() || undefined,
        is_active: form.is_active,
      })
      .then(() => {
        setModal(null);
        load();
      })
      .catch((e) => setError(e?.message || "创建失败"))
      .finally(() => setSaving(false));
  };

  const submitEdit = () => {
    if (editId == null) return;
    setSaving(true);
    setError("");
    api.teacher.courses
      .update(editId, {
        name: form.name.trim(),
        code: form.code.trim() || undefined,
        description: form.description.trim() || undefined,
        is_active: form.is_active,
      })
      .then(() => {
        setModal(null);
        setEditId(null);
        load();
      })
      .catch((e) => setError(e?.message || "保存失败"))
      .finally(() => setSaving(false));
  };

  const doDelete = (id: number) => {
    if (!confirm("确定删除该课程？")) return;
    api.teacher.courses.delete(id).then(load).catch((e) => alert(e?.message || "删除失败"));
  };

  const addChapter = () => {
    if (expandCourseId == null) return;
    if (!chapterForm.title.trim()) {
      alert("请填写章节标题");
      return;
    }
    setAddingChapter(true);
    api.teacher.courses
      .createChapter(expandCourseId, {
        title: chapterForm.title.trim(),
        order_index: chapterForm.order_index,
        syllabus_ref: chapterForm.syllabus_ref.trim() || undefined,
      })
      .then(async () => {
        setChapterForm({ title: "", order_index: chapters.length + 1, syllabus_ref: "" });
        return api.teacher.courses.chapters(expandCourseId!);
      })
      .then(setChapters)
      .catch((e) => alert(e?.message || "添加失败"))
      .finally(() => setAddingChapter(false));
  };

  const deleteChapter = (chapterId: number) => {
    if (!confirm("确定删除该章节？")) return;
    api.teacher.courses
      .deleteChapter(chapterId)
      .then(() => {
        if (expandCourseId != null) {
          return api.teacher.courses.chapters(expandCourseId).then(setChapters);
        }
      })
      .catch((e) => alert(e?.message || "删除失败"));
  };

  const openEditChapter = (ch: ChapterItem) => {
    setEditingChapterId(ch.id);
    setChapterEditForm({
      title: ch.title,
      order_index: ch.order_index,
      syllabus_ref: ch.syllabus_ref || "",
    });
    setChapterEditModal(true);
    setChapterKnowledgePoints([]);
    api.teacher.courses
      .chapterKnowledgePoints(ch.id)
      .then((rows) =>
        setChapterKnowledgePoints(
          rows.map((kp, idx) => ({
            title: kp.title || "",
            content: kp.content || "",
            ppt_slide_ref: kp.ppt_slide_ref || "",
            order_index: kp.order_index || idx + 1,
          }))
        )
      )
      .catch(() => setChapterKnowledgePoints([]));
  };

  const submitEditChapter = () => {
    if (editingChapterId == null || expandCourseId == null) return;
    setChapterSaving(true);
    const cleanedPoints = chapterKnowledgePoints
      .map((kp, idx) => ({
        title: kp.title.trim(),
        content: kp.content.trim() || undefined,
        ppt_slide_ref: kp.ppt_slide_ref.trim() || undefined,
        order_index: kp.order_index || idx + 1,
      }))
      .filter((kp) => kp.title);
    api.teacher.courses
      .updateChapter(editingChapterId, {
        title: chapterEditForm.title.trim(),
        order_index: chapterEditForm.order_index,
        syllabus_ref: chapterEditForm.syllabus_ref.trim() || undefined,
      })
      .then(() =>
        api.teacher.courses.saveChapterKnowledgePoints(editingChapterId, {
          knowledge_points: cleanedPoints,
        })
      )
      .then(() => api.teacher.courses.chapters(expandCourseId))
      .then((rows) => {
        setChapters(rows);
        setChapterEditModal(false);
        setEditingChapterId(null);
      })
      .catch((e) => alert(e?.message || "修改章节失败"))
      .finally(() => setChapterSaving(false));
  };

  const updateKnowledgePoint = (idx: number, patch: Partial<KnowledgePointDraft>) => {
    setChapterKnowledgePoints((prev) => prev.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
  };

  const removeKnowledgePoint = (idx: number) => {
    setChapterKnowledgePoints((prev) => prev.filter((_, i) => i !== idx).map((item, i) => ({ ...item, order_index: i + 1 })));
  };

  const doReindex = (courseId: number, courseName: string) => {
    if (!confirm(`确定为「${courseName}」重建 RAG 向量索引？`)) return;
    setReindexTaskByCourse((prev) => ({ ...prev, [courseId]: { taskId: -1, status: "pending" } }));
    api.teacher.courses
      .reindex(courseId)
      .then((r) => {
        setReindexTaskByCourse((prev) => ({ ...prev, [courseId]: { taskId: r.task_id, status: r.status } }));
        toast("重建索引任务已提交，系统将在后台处理。");
        void pollReindexTask(courseId, r.task_id);
      })
      .catch((e) => {
        toast(e?.message || "重建索引失败", "error");
        setReindexTaskByCourse((prev) => {
          const next = { ...prev };
          delete next[courseId];
          return next;
        });
      });
  };

  const doClearKnowledge = (courseId: number, courseName: string) => {
    if (!confirm(`确定清空「${courseName}」知识库？将删除该课程下全部章节文档、知识点、PPT 解析结果。`)) return;
    setClearingId(courseId);
    api.teacher.courses
      .clearKnowledge(courseId)
      .then((r) =>
        alert(
          `清理完成：文档 ${r.stats.knowledge_documents}、知识点 ${r.stats.knowledge_points}、PPT ${r.stats.ppt_files}、PPT页 ${r.stats.ppt_slides}、文件 ${r.stats.deleted_files}；索引剩余 ${r.chunks_indexed} 个切片。`
        )
      )
      .catch((e) => alert(e?.message || "一键清理失败"))
      .finally(() => setClearingId(null));
  };

  const openGenerateQuestionsModal = (ch: ChapterItem) => {
    setQuestionGenModalChapter(ch);
    setQuestionGenForm({ single_choice_max: 5, multiple_choice_max: 2, judge_max: 3, qa_max: 2, blank_max: 2 });
  };

  const pollQuestionTask = async (chapterId: number, taskId: number, courseId: number | null) => {
    if (taskId <= 0) return;
    if (pollingQuestionTaskIdsRef.current.has(taskId)) return;
    pollingQuestionTaskIdsRef.current.add(taskId);
    const maxPoll = 180;
    try {
      for (let i = 0; i < maxPoll; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        if (!aliveRef.current) return;
        try {
          const task = await api.teacher.courses.getQuestionTask(taskId);
          setQuestionTaskByChapter((prev) => ({ ...prev, [chapterId]: { taskId, status: task.status } }));
          if (task.status === "success") {
            if (courseId != null) {
              await api.teacher.courses.chapters(courseId).then(setChapters).catch(() => undefined);
            }
            if (!notifiedQuestionTaskIdsRef.current.has(taskId)) {
              notifiedQuestionTaskIdsRef.current.add(taskId);
              const byType = task.result_payload?.by_type;
              toast(
                `生成完成：共 ${task.result_payload?.created ?? 0} 题（单选 ${byType?.single_choice ?? 0}，多选 ${byType?.multiple_choice ?? 0}，判断 ${byType?.judge ?? 0}，问答 ${byType?.qa ?? 0}，填空 ${byType?.blank ?? 0}），跳过 ${task.result_payload?.skipped ?? 0} 题。`,
                "success"
              );
            }
            removeCachedQuestionTask(taskId);
            setQuestionTaskByChapter((prev) => {
              if (prev[chapterId]?.taskId !== taskId) return prev;
              const next = { ...prev };
              delete next[chapterId];
              return next;
            });
            return;
          }
          if (task.status === "failed") {
            if (!notifiedQuestionTaskIdsRef.current.has(taskId)) {
              notifiedQuestionTaskIdsRef.current.add(taskId);
              toast(task.error_message || "生成任务失败", "error");
            }
            removeCachedQuestionTask(taskId);
            setQuestionTaskByChapter((prev) => {
              if (prev[chapterId]?.taskId !== taskId) return prev;
              const next = { ...prev };
              delete next[chapterId];
              return next;
            });
            return;
          }
        } catch {
          // ignore and keep polling
        }
      }
      toast("生成任务仍在处理中，请稍后再看。");
    } finally {
      pollingQuestionTaskIdsRef.current.delete(taskId);
    }
  };

  const submitGenerateQuestions = () => {
    if (!questionGenModalChapter) return;
    const total =
      questionGenForm.single_choice_max + questionGenForm.multiple_choice_max + questionGenForm.judge_max + questionGenForm.qa_max + questionGenForm.blank_max;
    if (total <= 0) {
      alert("请至少设置一种题型数量大于 0");
      return;
    }
    const chapter = questionGenModalChapter;
    api.teacher.courses
      .generateChapterQuestions(chapter.id, questionGenForm)
      .then((r) => {
        setQuestionTaskByChapter((prev) => ({ ...prev, [chapter.id]: { taskId: r.task_id, status: r.status } }));
        upsertCachedQuestionTask({
          taskId: r.task_id,
          chapterId: chapter.id,
          courseId: chapter.course_id,
          updatedAt: Date.now(),
        });
        setQuestionGenModalChapter(null);
        toast("习题生成任务已提交，系统将在后台处理。");
        pollQuestionTask(chapter.id, r.task_id, chapter.course_id);
      })
      .catch((e) => toast(e?.message || "生成失败", "error"))
      .finally(() => undefined);
  };

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>我的课程</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 20, fontSize: 15 }}>由你创建与维护的课程与章节</p>
      <div style={{ marginBottom: 20 }}>
        <button type="button" className="btn-primary" onClick={openCreate}>
          新建课程
        </button>
      </div>
      {loading ? (
        <p style={{ color: "var(--text-muted)" }}>加载中…</p>
      ) : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>ID</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>名称</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>代码</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>状态</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <React.Fragment key={c.id}>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "10px 12px" }}>{c.id}</td>
                    <td style={{ padding: "10px 12px" }}>{c.name}</td>
                    <td style={{ padding: "10px 12px" }}>{c.code || "—"}</td>
                    <td style={{ padding: "10px 12px" }}>{c.is_active ? "启用" : "停用"}</td>
                    <td style={{ padding: "10px 12px" }}>
                      <button type="button" className="btn-ghost" style={{ marginRight: 8 }} onClick={() => openEdit(c)}>
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ marginRight: 8 }}
                        onClick={() => setExpandCourseId(expandCourseId === c.id ? null : c.id)}
                      >
                        {expandCourseId === c.id ? "收起章节" : "章节"}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ marginRight: 8 }}
                        onClick={() => doReindex(c.id, c.name)}
                        disabled={!!reindexTaskByCourse[c.id] || clearingId !== null}
                      >
                        {reindexTaskByCourse[c.id] ? "索引中…" : "重建索引"}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ marginRight: 8, color: "var(--danger, #c00)" }}
                        onClick={() => doClearKnowledge(c.id, c.name)}
                        disabled={!!reindexTaskByCourse[c.id] || clearingId !== null}
                      >
                        {clearingId === c.id ? "清理中…" : "一键清理"}
                      </button>
                      <button type="button" className="btn-ghost" style={{ color: "var(--danger, #c00)" }} onClick={() => doDelete(c.id)}>
                        删除
                      </button>
                    </td>
                  </tr>
                  {expandCourseId === c.id && (
                    <tr>
                      <td colSpan={5} style={{ padding: "12px 24px", background: "var(--bg-muted)", borderBottom: "1px solid var(--border)" }}>
                        <div style={{ marginBottom: 6, fontWeight: 600 }}>章节列表</div>
                        <p style={{ marginTop: 0, marginBottom: 12, color: "var(--text-muted)", fontSize: 13 }}>
                          点每个章节右侧“资料（讲义/视频）”进入独立资料页面，再分别上传 PDF 讲义和教学视频。
                        </p>
                        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                          <input
                            type="text"
                            placeholder="章节标题"
                            value={chapterForm.title}
                            onChange={(e) => setChapterForm((f) => ({ ...f, title: e.target.value }))}
                            style={{ padding: "6px 10px", width: 220 }}
                          />
                          <input
                            type="number"
                            placeholder="排序"
                            value={chapterForm.order_index}
                            onChange={(e) => setChapterForm((f) => ({ ...f, order_index: parseInt(e.target.value, 10) || 0 }))}
                            style={{ padding: "6px 10px", width: 80 }}
                          />
                          <button type="button" className="btn-primary" onClick={addChapter} disabled={addingChapter}>
                            {addingChapter ? "处理中…" : "添加章节"}
                          </button>
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 20 }}>
                          {chapters.map((ch) => (
                            <li key={ch.id} style={{ marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <span>{ch.title}（排序 {ch.order_index}）</span>
                              <span style={{ display: "inline-flex", gap: 6 }}>
                                <button
                                  type="button"
                                  className="btn-ghost"
                                  style={{ fontSize: 13 }}
                                  onClick={() => {
                                    const target = `/teacher/chapter-materials?chapterId=${ch.id}&chapterTitle=${encodeURIComponent(ch.title)}&courseName=${encodeURIComponent(c.name)}`;
                                    window.open(target, "_blank", "noopener,noreferrer");
                                  }}
                                >
                                  资料（讲义/视频）
                                </button>
                                <button type="button" className="btn-ghost" style={{ fontSize: 13 }} onClick={() => openEditChapter(ch)}>
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  className="btn-ghost"
                                  style={{ fontSize: 13 }}
                                  onClick={() => openGenerateQuestionsModal(ch)}
                                  disabled={questionTaskByChapter[ch.id]?.status === "running" || questionTaskByChapter[ch.id]?.status === "pending"}
                                >
                                  {questionTaskByChapter[ch.id]?.status === "running" || questionTaskByChapter[ch.id]?.status === "pending" ? "生成中…" : "生成习题"}
                                </button>
                                {(ch.question_count > 0 || questionTaskByChapter[ch.id]?.status === "success") && (
                                  <button
                                    type="button"
                                    className="btn-ghost"
                                    style={{ fontSize: 13 }}
                                    onClick={() => window.open(`/teacher/chapter-questions?chapterId=${ch.id}`, "_blank", "noopener,noreferrer")}
                                  >
                                    查看习题
                                  </button>
                                )}
                                <button type="button" className="btn-ghost" style={{ color: "var(--danger, #c00)", fontSize: 13 }} onClick={() => deleteChapter(ch.id)}>
                                  删除
                                </button>
                              </span>
                            </li>
                          ))}
                          {chapters.length === 0 && <li style={{ color: "var(--text-muted)" }}>暂无章节</li>}
                        </ul>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
          onClick={() => !saving && setModal(null)}
        >
          <div className="card" style={{ minWidth: 720, width: "min(960px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 16 }}>{modal === "create" ? "新建课程" : "编辑课程"}</h3>
            {error && <p style={{ color: "var(--danger, #c00)", marginBottom: 12, fontSize: 14 }}>{error}</p>}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>名称</span>
                <input type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} style={{ width: "100%" }} />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>代码（可选）</span>
                <input type="text" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} style={{ width: "100%" }} />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>简介（可选）</span>
                <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} style={{ width: "100%" }} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))} />
                <span style={{ fontSize: 14 }}>启用</span>
              </label>
            </div>
            <div style={{ marginTop: 20, display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="btn-ghost" onClick={() => setModal(null)} disabled={saving}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={modal === "create" ? submitCreate : submitEdit} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {chapterEditModal && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}
          onClick={() => !chapterSaving && setChapterEditModal(false)}
        >
          <div className="card" style={{ minWidth: 360 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 16 }}>编辑章节</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>章节标题</span>
                <input
                  type="text"
                  value={chapterEditForm.title}
                  onChange={(e) => setChapterEditForm((f) => ({ ...f, title: e.target.value }))}
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>排序</span>
                <input
                  type="number"
                  value={chapterEditForm.order_index}
                  onChange={(e) => setChapterEditForm((f) => ({ ...f, order_index: parseInt(e.target.value, 10) || 0 }))}
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>教学大纲引用（可选）</span>
                <input
                  type="text"
                  value={chapterEditForm.syllabus_ref}
                  onChange={(e) => setChapterEditForm((f) => ({ ...f, syllabus_ref: e.target.value }))}
                  style={{ width: "100%" }}
                />
              </label>
              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>知识点</div>
                <div style={{ maxHeight: 320, overflowY: "auto", paddingRight: 4 }}>
                  {chapterKnowledgePoints.map((kp, idx) => (
                    <div key={idx} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginBottom: 8 }}>
                      <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>知识点 {idx + 1}：{kp.title}</div>
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ color: "var(--danger, #c00)", fontSize: 12 }}
                          onClick={() => removeKnowledgePoint(idx)}
                          disabled={chapterSaving}
                        >
                          删除知识点
                        </button>
                      </div>
                      <textarea
                        placeholder="知识点解释（可选）"
                        rows={2}
                        value={kp.content}
                        onChange={(e) => updateKnowledgePoint(idx, { content: e.target.value })}
                        style={{ width: "100%" }}
                      />
                    </div>
                  ))}
                  {chapterKnowledgePoints.length === 0 && <p style={{ color: "var(--text-muted)", margin: 0 }}>暂无知识点。生成习题时会自动生成（每章最多 10 条）。</p>}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 20, display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="btn-ghost" onClick={() => setChapterEditModal(false)} disabled={chapterSaving}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={submitEditChapter} disabled={chapterSaving}>
                {chapterSaving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {questionGenModalChapter && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 125 }}
          onClick={() => setQuestionGenModalChapter(null)}
        >
          <div className="card" style={{ minWidth: 420, width: "min(560px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 8 }}>生成习题</h3>
            <p style={{ marginTop: 0, marginBottom: 14, color: "var(--text-muted)", fontSize: 14 }}>{questionGenModalChapter.title}</p>
            <p style={{ marginTop: 0, marginBottom: 14, color: "var(--text-muted)", fontSize: 13 }}>
              开始生成后会先自动生成该章节知识点（由模型决定数量，每章最多 10 条），再按知识点生成习题。
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>单选题最大数量</span>
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={questionGenForm.single_choice_max}
                  onChange={(e) => setQuestionGenForm((f) => ({ ...f, single_choice_max: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>多选题最大数量</span>
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={questionGenForm.multiple_choice_max}
                  onChange={(e) => setQuestionGenForm((f) => ({ ...f, multiple_choice_max: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>判断题最大数量</span>
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={questionGenForm.judge_max}
                  onChange={(e) => setQuestionGenForm((f) => ({ ...f, judge_max: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>问答题最大数量</span>
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={questionGenForm.qa_max}
                  onChange={(e) => setQuestionGenForm((f) => ({ ...f, qa_max: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>填空题最大数量</span>
                <input
                  type="number"
                  min={0}
                  max={30}
                  value={questionGenForm.blank_max}
                  onChange={(e) => setQuestionGenForm((f) => ({ ...f, blank_max: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                  style={{ width: "100%" }}
                />
              </label>
            </div>
            <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn-ghost" onClick={() => setQuestionGenModalChapter(null)}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={submitGenerateQuestions}>
                开始生成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
