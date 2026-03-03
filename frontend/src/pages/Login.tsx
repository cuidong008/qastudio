import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../api/auth";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const u = await login(username, password);
      const target = u.role === "admin" ? "/admin" : (u.role === "teacher" || u.role === "teaching_leader") ? "/teacher/qa" : "/student/inclass";
      navigate(target, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "var(--bg-base)",
      }}
    >
      <div
        style={{
          maxWidth: 400,
          width: "100%",
          padding: 32,
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-xl)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <h1
          style={{
            margin: "0 0 8px",
            fontSize: 22,
            fontWeight: 600,
            textAlign: "center",
            color: "var(--text-primary)",
          }}
        >
          计算机网络基础 · 课程智能体
        </h1>
        <p
          style={{
            color: "var(--text-muted)",
            textAlign: "center",
            marginBottom: 28,
            fontSize: 14,
          }}
        >
          请登录后使用（演示：teacher/teacher 或 student/student）
        </p>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 20 }}>
            <label
              style={{
                display: "block",
                marginBottom: 8,
                fontSize: 14,
                color: "var(--text-secondary)",
              }}
            >
              用户名
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              style={{ width: "100%" }}
              required
            />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label
              style={{
                display: "block",
                marginBottom: 8,
                fontSize: 14,
                color: "var(--text-secondary)",
              }}
            >
              密码
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>
          {error && (
            <p
              style={{
                color: "var(--error)",
                marginBottom: 16,
                fontSize: 14,
              }}
            >
              {error}
            </p>
          )}
          <button
            type="submit"
            className="btn-primary"
            style={{ width: "100%", minHeight: 48 }}
          >
            登录
          </button>
        </form>
      </div>
    </div>
  );
}
