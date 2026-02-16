import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";

export default function Feedback({ inWorkspace = false, onGoQa }: { inWorkspace?: boolean; onGoQa?: () => void }) {
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = content.trim();
    if (!text) {
      setMessage("请填写反馈内容");
      setStatus("error");
      return;
    }
    setStatus("sending");
    setMessage("");
    try {
      const res = await api.feedback.submit(text, "form");
      if (res.ok) {
        setContent("");
        setStatus("success");
        setMessage("感谢您的反馈，我们会认真查看。");
      } else {
        setStatus("error");
        setMessage(res.message || "提交失败，请重试");
      }
    } catch {
      setStatus("error");
      setMessage("网络错误，请稍后重试");
    }
  };

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>
        学习反馈
      </h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 24, fontSize: 15 }}>
        您的反馈将用于持续改进课程与产品；我们同时支持问卷与对话两种方式收集意见。
      </p>

      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 17 }}>填写反馈</h3>
        <form onSubmit={handleSubmit}>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="请描述您的建议、遇到的问题或对课程/智能体的看法…"
            rows={5}
            style={{
              width: "100%",
              padding: 12,
              borderRadius: 8,
              border: "1px solid var(--border)",
              fontSize: 14,
              resize: "vertical",
              boxSizing: "border-box",
            }}
            disabled={status === "sending"}
          />
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button
              type="submit"
              className="btn-primary"
              disabled={status === "sending"}
            >
              {status === "sending" ? "提交中…" : "提交反馈"}
            </button>
            {status === "success" && (
              <span style={{ color: "var(--success)" }}>{message}</span>
            )}
            {status === "error" && (
              <span style={{ color: "var(--error)" }}>{message}</span>
            )}
          </div>
        </form>
      </div>

      <div className="card" style={{ background: "var(--bg-muted)" }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>通过对话提交反馈</h3>
        <p style={{ color: "var(--text-muted)", margin: 0, fontSize: 14, lineHeight: 1.5 }}>
          您也可以在「
          {inWorkspace ? (
            <button type="button" className="btn-ghost" onClick={onGoQa} style={{ padding: "0 6px", minHeight: "auto" }}>
              课中辅助
            </button>
          ) : (
            <Link to="/student/inclass">课中辅助</Link>
          )}
          」或课后答疑中直接向智能体说出您的意见或建议，系统会同时记录为反馈内容，便于教师与运营汇总改进。
        </p>
      </div>
    </div>
  );
}
