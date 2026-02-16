import { Link } from "react-router-dom";

export default function AdminHome() {
  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>后管台</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 28, fontSize: 15 }}>
        用户与系统配置管理
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
        <Link to="/admin/users" className="card" style={{ textDecoration: "none", color: "inherit" }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>用户管理</div>
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>创建/编辑用户、角色、班级分配</div>
        </Link>
        <Link to="/admin/rag" className="card" style={{ textDecoration: "none", color: "inherit" }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>RAG 配置</div>
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>RAG 状态与索引说明</div>
        </Link>
      </div>
    </div>
  );
}
