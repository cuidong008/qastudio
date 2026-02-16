import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";

export default function Review({ inWorkspace = false, onGoQa, courseId }: { inWorkspace?: boolean; onGoQa?: () => void; courseId?: number | null }) {
  const [chapters, setChapters] = useState<{ id: number; title: string }[]>([]);
  const [detail, setDetail] = useState<{ id: number; title: string; knowledge_points: { id: number; title: string; ppt_slide_ref: string | null }[] } | null>(null);

  useEffect(() => {
    api.chapters.list({ course_id: courseId ?? undefined }).then(setChapters);
  }, [courseId]);

  const loadDetail = (id: number) => {
    api.chapters.get(id).then(setDetail);
  };

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>
        课后复习
      </h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 16, fontSize: 15 }}>
        按章节回顾知识框架，结合电商场景巩固
      </p>
      <p style={{ marginBottom: 20 }}>
        {inWorkspace ? (
          <button type="button" className="btn-ghost" onClick={onGoQa} style={{ padding: "0 6px", minHeight: "auto" }}>
            7×24 答疑入口
          </button>
        ) : (
          <Link to="/student/inclass">7×24 答疑入口</Link>
        )}
        （与课中辅助共用）
      </p>
      <div style={{ marginBottom: 20 }}>
        <label style={{ marginRight: 10, color: "var(--text-secondary)", fontSize: 14 }}>
          选择章节查看知识框架
        </label>
        <select
          value={detail?.id ?? ""}
          onChange={(e) => loadDetail(Number(e.target.value))}
          style={{ padding: "10px 14px", minWidth: 280 }}
        >
          <option value="">请选择</option>
          {chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </div>
      {detail && (
        <div className="card">
          <h2 style={{ marginTop: 0, marginBottom: 16, fontSize: 18, fontWeight: 600 }}>
            {detail.title}
          </h2>
          <h4 style={{ marginBottom: 8, fontSize: 15, fontWeight: 600 }}>
            本章知识点
          </h4>
          <ul style={{ marginBottom: 16, paddingLeft: 20 }}>
            {detail.knowledge_points.map((p) => (
              <li key={p.id} style={{ marginBottom: 6 }}>
                {p.title}
                {p.ppt_slide_ref && (
                  <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
                    （{p.ppt_slide_ref}）
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p style={{ color: "var(--text-muted)", margin: 0 }}>
            个性化复习建议与薄弱点专项请结合习题训练与错题本使用。
          </p>
        </div>
      )}
    </div>
  );
}
