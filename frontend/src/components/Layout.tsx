import { ReactNode, useEffect } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../api/auth";

const nav = [
  { to: "/student", label: "首页" },
  { to: "/student/preview", label: "课前预习" },
  { to: "/student/inclass", label: "课中辅助" },
  { to: "/student/review", label: "课后复习" },
  { to: "/student/exercises", label: "习题训练" },
  { to: "/student/feedback", label: "反馈" },
];

export default function Layout({
  children,
  role,
  requireAuth,
}: {
  children: ReactNode;
  role: string;
  requireAuth?: boolean;
}) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const redirectTo =
    requireAuth && !user
      ? "/login"
      : requireAuth && user && user.role !== role
        ? (user.role === "teacher" || user.role === "teaching_leader")
          ? "/teacher"
          : "/student/inclass"
        : null;

  useEffect(() => {
    if (redirectTo) navigate(redirectTo, { replace: true });
  }, [redirectTo, navigate]);

  if (redirectTo) return null;

  const isStudent = role === "student";
  const isStudentChatShell =
    isStudent &&
    (location.pathname === "/student" || location.pathname === "/student/inclass");

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {!isStudentChatShell && (
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
          {!isStudent && (
            <nav style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {nav.map(({ to, label }) => (
                <NavLink key={to} to={to} className="nav-link">
                  <span>{label}</span>
                </NavLink>
              ))}
            </nav>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>
              {user?.display_name || user?.username}
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
      )}
      <main
        style={{
          flex: 1,
          padding: isStudentChatShell ? 0 : 24,
          maxWidth: isStudentChatShell ? "none" : 900,
          margin: isStudentChatShell ? 0 : "0 auto",
          width: "100%",
        }}
      >
        {children}
      </main>
    </div>
  );
}
