import { useState, useEffect } from "react";
import { api } from "../../api/client";

export default function TeacherDashboard() {
  const [stats, setStats] = useState<{
    preview_completion_rate: number;
    total_questions_asked: number;
    top_asked: { question: string; count: number }[];
    answer_accuracy_rate: number;
    weak_knowledge_points: string[];
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.teacher.stats().then((data) => {
      setStats(data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleExport = (report: string) => {
    const url = (import.meta.env.VITE_API_BASE || "http://localhost:8000/api") + "/teacher/export/csv?report=" + report;
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
            课堂/课后提问数
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "var(--text-primary)" }}>
            {stats.total_questions_asked}
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
      <div className="card" style={{ marginBottom: 28 }}>
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
