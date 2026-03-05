import { useEffect } from "react";
import { Link, NavLink, useNavigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../api/auth";

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isQaHome = location.pathname === "/admin" || location.pathname === "/admin/";

  useEffect(() => {
    if (!user) {
      navigate("/login", { replace: true });
      return;
    }
    if (user.role !== "admin") {
      navigate((user.role === "teacher" || user.role === "teaching_leader") ? "/teacher" : "/student", { replace: true });
    }
  }, [user, navigate]);

  if (!user || user.role !== "admin") return null;

  return (
    <div
      style={{
        minHeight: "100vh",
        ...(isQaHome ? { height: "100vh", overflow: "hidden" } : {}),
        display: "flex",
        flexDirection: "column",
      }}
    >
      {!isQaHome && (
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
            <NavLink to="/admin" className="nav-link" end><span>问答首页</span></NavLink>
            <NavLink to="/admin/users" className="nav-link"><span>用户管理</span></NavLink>
            <NavLink to="/admin/rag" className="nav-link"><span>RAG 配置</span></NavLink>
          </nav>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>
              {user.display_name || user.username}（管理员）
            </span>
            <Link to="/teacher" className="btn-ghost" style={{ padding: "8px 14px", minHeight: 36, borderRadius: "var(--radius-md)" }}>教师端</Link>
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
      )}
      <main
        style={{
          flex: 1,
          ...(isQaHome ? { padding: 0, maxWidth: "none", margin: 0, minHeight: 0 } : { padding: 24, maxWidth: 1200, margin: "0 auto", width: "100%" }),
        }}
      >
        <Outlet />
      </main>
    </div>
  );
}
