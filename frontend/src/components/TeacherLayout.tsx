import { ReactNode, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../api/auth";

export default function TeacherLayout({
  children,
  requireAuth,
  fluid,
}: {
  children: ReactNode;
  requireAuth?: boolean;
  fluid?: boolean;
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const redirectTo =
    requireAuth && !user
      ? "/login"
      : requireAuth && user && user.role !== "teacher" && user.role !== "admin"
        ? "/student"
        : null;

  useEffect(() => {
    if (redirectTo) navigate(redirectTo, { replace: true });
  }, [redirectTo, navigate]);

  if (redirectTo) return null;

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
        <nav style={{ display: "flex", gap: 8 }}>
          <Link to="/teacher" className="nav-link">
            学情概览
          </Link>
          <Link to="/teacher/courses" className="nav-link">
            我的课程
          </Link>
          <Link to="/teacher/classes" className="nav-link">
            我的班级
          </Link>
          <Link to="/teacher/pipeline" className="nav-link">
            课件流水线
          </Link>
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>
            {user?.display_name || user?.username}（教师）
          </span>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              logout();
              navigate("/login");
            }}
            style={{ padding: "8px 14px", minHeight: 36 }}
          >
            退出
          </button>
        </div>
      </header>
      <main
        style={{
          flex: 1,
          padding: 24,
          maxWidth: fluid ? "none" : 1000,
          margin: "0 auto",
          width: "100%",
        }}
      >
        {children}
      </main>
    </div>
  );
}
