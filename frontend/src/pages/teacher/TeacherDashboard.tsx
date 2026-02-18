import { useState, useEffect } from "react";
import { api } from "../../api/client";

export default function TeacherDashboard() {
  const [stats, setStats] = useState<{
    preview_completion_rate: number;
    top_asked: { question: string; count: number }[];
    answer_accuracy_rate: number;
    weak_knowledge_points: string[];
  } | null>(null);
  const [courses, setCourses] = useState<{ id: number; name: string }[]>([]);
  const [chapters, setChapters] = useState<{ id: number; title: string }[]>([]);
  const [courseId, setCourseId] = useState<number | undefined>(undefined);
  const [chapterId, setChapterId] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.teacher.courses.list()
      .then((list) => setCourses(list.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => setCourses([]));
  }, []);

  useEffect(() => {
    if (courseId == null) {
      setChapters([]);
      setChapterId(undefined);
      return;
    }
    api.teacher.courses.chapters(courseId)
      .then((list) => setChapters(list.map((ch) => ({ id: ch.id, title: ch.title }))))
      .catch(() => setChapters([]));
    setChapterId(undefined);
  }, [courseId]);

  useEffect(() => {
    setLoading(true);
    api.teacher.stats({ courseId, chapterId }).then((data) => {
      setStats(data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [courseId, chapterId]);

  const handleExport = (report: string) => {
    const params = new URLSearchParams({ report });
    if (courseId != null) params.set("course_id", String(courseId));
    if (chapterId != null) params.set("chapter_id", String(chapterId));
    const url = (import.meta.env.VITE_API_BASE || "http://localhost:8000/api") + "/teacher/export/csv?" + params.toString();
    const token = localStorage.getItem("token");
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "teacher_export.csv";
        a.click();
        URL.revokeObjectURL(a.href);
      });
  };

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 200,
          color: "var(--text-muted)",
        }}
      >
        加载学情数据…
      </div>
    );
  }
  if (!stats) {
    return (
      <p style={{ color: "var(--text-muted)" }}>暂无数据或加载失败</p>
    );
  }

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>
        学情数据监控
      </h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 28, fontSize: 15 }}>
        班级整体学习画像与教学决策参考
      </p>
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "var(--text-muted)" }}>课程</span>
            <select
              value={courseId ?? ""}
              onChange={(e) => setCourseId(e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">全部课程</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ color: "var(--text-muted)" }}>章节</span>
            <select
              value={chapterId ?? ""}
              onChange={(e) => setChapterId(e.target.value ? Number(e.target.value) : undefined)}
              disabled={courseId == null}
            >
              <option value="">全部章节</option>
              {chapters.map((ch) => (
                <option key={ch.id} value={ch.id}>{ch.title}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: 20,
          marginBottom: 28,
        }}
      >
        <div className="card">
          <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 4 }}>
            预习完成率
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "var(--text-primary)" }}>
            {stats.preview_completion_rate}%
          </div>
        </div>
        <div className="card">
          <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 4 }}>
            习题正确率
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "var(--text-primary)" }}>
            {stats.answer_accuracy_rate}%
          </div>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginTop: 0, marginBottom: 16, fontSize: 17, fontWeight: 600 }}>
          薄弱知识点（建议重点讲解）
        </h3>
        {stats.weak_knowledge_points.length ? (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {stats.weak_knowledge_points.map((k, i) => (
              <li key={i} style={{ marginBottom: 8 }}>{k}</li>
            ))}
          </ul>
        ) : (
          <p style={{ color: "var(--text-muted)", margin: 0 }}>暂无统计</p>
        )}
      </div>
      <div className="card" style={{ marginBottom: 28 }}>
        <h3 style={{ marginTop: 0, marginBottom: 16, fontSize: 17, fontWeight: 600 }}>
          高频提问
        </h3>
        {stats.top_asked.length ? (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {stats.top_asked.map((item, i) => (
              <li key={i} style={{ marginBottom: 8 }}>
                {item.question}
                <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
                  （{item.count} 次）
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ color: "var(--text-muted)", margin: 0 }}>暂无提问记录</p>
        )}
      </div>
      <div>
        <h3 style={{ marginBottom: 8, fontSize: 17, fontWeight: 600 }}>
          导出数据
        </h3>
        <p style={{ color: "var(--text-muted)", marginBottom: 16, fontSize: 14 }}>
          下载 CSV 用于备课与教学调整
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => handleExport("overview")}
          >
            概览
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => handleExport("preview")}
          >
            预习记录
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => handleExport("answers")}
          >
            作答记录
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => handleExport("qa")}
          >
            提问记录
          </button>
        </div>
      </div>
    </div>
  );
}
