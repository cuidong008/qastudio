import { ReactNode, useEffect } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../api/auth";

export default function TeacherLayout({
  children,
  requireAuth,
  fluid,
  fullBleed,
}: {
  children: ReactNode;
  requireAuth?: boolean;
  fluid?: boolean;
  /** 问答首页等全屏页面设为 true，main 无内边距 */
  fullBleed?: boolean;
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const redirectTo =
    requireAuth && !user
      ? "/login"
      : requireAuth && user && user.role !== "teacher" && user.role !== "teaching_leader" && user.role !== "admin"
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
          <NavLink to="/teacher/qa" className="nav-link"><span>问答首页</span></NavLink>
          <NavLink to="/teacher/learning-data" className="nav-link"><span>学情概览</span></NavLink>
          <NavLink to="/teacher/courses" className="nav-link"><span>我的课程</span></NavLink>
          <NavLink to="/teacher/classes" className="nav-link" onMouseEnter={() => { import("../pages/teacher/TeacherClasses"); }}><span>我的班级</span></NavLink>
          <NavLink to="/teacher/pipeline" className="nav-link"><span>课件流水线</span></NavLink>
          <NavLink to="/teacher/question-bank" className="nav-link" end={false}><span>题库管理</span></NavLink>
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>
            {user?.display_name || user?.username}（{user?.role === "teaching_leader" ? "教研组长" : "教师"}）
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
          padding: fullBleed ? 0 : 24,
          maxWidth: fluid || fullBleed ? "none" : 1000,
          margin: "0 auto",
          width: "100%",
        }}
      >
        {children}
      </main>
    </div>
  );
}
