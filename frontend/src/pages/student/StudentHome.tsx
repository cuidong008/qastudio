import { Link } from "react-router-dom";

const cards = [
  { to: "/student/preview", title: "课前预习", desc: "章节预习任务、知识点导读、基础自测与薄弱点反馈" },
  { to: "/student/inclass", title: "课中辅助", desc: "课堂实时答疑、PPT 知识点定位、重点提炼与操作指导" },
  { to: "/student/review", title: "课后复习", desc: "知识框架总结、个性化复习建议、7×24 答疑与易错点复盘" },
  { to: "/student/exercises", title: "习题训练", desc: "分层习题推送、详细解析与课件关联、错题本与薄弱点专项" },
];

export default function StudentHome() {
  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>
        计算机网络基础 · 学习入口
      </h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 28, fontSize: 15 }}>
        请选择学习场景进入
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 20,
        }}
      >
        {cards.map(({ to, title, desc }) => (
          <Link
            key={to}
            to={to}
            className="card"
            style={{
              display: "block",
              color: "inherit",
              textDecoration: "none",
            }}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 600 }}>
              {title}
            </h3>
            <p
              style={{
                color: "var(--text-muted)",
                fontSize: 14,
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {desc}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
