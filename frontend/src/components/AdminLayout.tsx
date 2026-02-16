import { useEffect } from "react";
import { Link, useNavigate, Outlet } from "react-router-dom";
import { useAuth } from "../api/auth";

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!user) {
      navigate("/login", { replace: true });
      return;
    }
    if (user.role !== "admin") {
      navigate(user.role === "teacher" ? "/teacher" : "/student", { replace: true });
    }
  }, [user, navigate]);

  if (!user || user.role !== "admin") return null;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border)",
          padding: "14px 24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <nav style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link to="/admin" className="nav-link">概览</Link>
          <Link to="/admin/users" className="nav-link">用户管理</Link>
          <Link to="/admin/rag" className="nav-link">RAG 配置</Link>
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>
            {user.display_name || user.username}（管理员）
          </span>
          <Link to="/teacher" className="btn-ghost" style={{ padding: "8px 14px", minHeight: 36 }}>教师端</Link>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => { logout(); navigate("/login"); }}
            style={{ padding: "8px 14px", minHeight: 36 }}
          >
            退出
          </button>
        </div>
      </header>
      <main style={{ flex: 1, padding: 24, maxWidth: 1200, margin: "0 auto", width: "100%" }}>
        <Outlet />
      </main>
    </div>
  );
}
