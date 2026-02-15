import { useState, useEffect } from "react";
import { api } from "../../api/client";

export default function Preview() {
  const [chapters, setChapters] = useState<{ id: number; title: string }[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [task, setTask] = useState<{
    chapter_id: number;
    chapter_title: string;
    summary: string;
    key_points: string[];
    self_check_questions: string[];
    duration_minutes: number;
  } | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    api.chapters.list().then((list) => {
      setChapters(list);
      if (list.length && !selected) setSelected(list[0].id);
    });
  }, []);

  useEffect(() => {
    if (selected == null) return;
    api.preview.task(selected).then(setTask);
    setSubmitted(false);
  }, [selected]);

  const handleSubmit = () => {
    if (selected == null) return;
    api.preview.submit(selected).then(() => setSubmitted(true));
  };

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>
        课前预习
      </h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 20, fontSize: 15 }}>
        选择章节获取预习任务（约 10–15 分钟）
      </p>
      <select
        value={selected ?? ""}
        onChange={(e) => setSelected(Number(e.target.value))}
        style={{ padding: "10px 14px", marginBottom: 24, minWidth: 280 }}
      >
        {chapters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>
      {task && (
        <div className="card">
          <h2 style={{ marginTop: 0, marginBottom: 16, fontSize: 18, fontWeight: 600 }}>
            {task.chapter_title}
          </h2>
          <p style={{ marginBottom: 12 }}>
            <strong>概览：</strong>
            {task.summary}
          </p>
          <p style={{ marginBottom: 16, color: "var(--text-secondary)" }}>
            <strong>预计时间：</strong>
            {task.duration_minutes} 分钟
          </p>
          <h4 style={{ marginBottom: 8, fontSize: 15, fontWeight: 600 }}>
            核心要点
          </h4>
          <ul style={{ marginBottom: 16, paddingLeft: 20 }}>
            {task.key_points.map((p, i) => (
              <li key={i} style={{ marginBottom: 4 }}>{p}</li>
            ))}
          </ul>
          <h4 style={{ marginBottom: 8, fontSize: 15, fontWeight: 600 }}>
            自测思考题
          </h4>
          <ul style={{ marginBottom: 20, paddingLeft: 20 }}>
            {task.self_check_questions.map((q, i) => (
              <li key={i} style={{ marginBottom: 4 }}>{q}</li>
            ))}
          </ul>
          {!submitted ? (
            <button
              type="button"
              className="btn-primary"
              onClick={handleSubmit}
            >
              完成预习并提交
            </button>
          ) : (
            <p style={{ color: "var(--success)" }}>
              已记录预习完成，薄弱点将反馈给教师。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
