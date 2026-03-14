import { useState } from "react";
import { api } from "../../api/client";

type FeedbackItem = {
  id: number;
  content: string;
  reply_text: string | null;
  status: string;
  created_at: string;
};

function formatDateTime(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function Feedback({ courseId }: { inWorkspace?: boolean; onGoQa?: () => void; courseId?: number | null }) {
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState<FeedbackItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");

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
      const res = await api.feedback.submit(text, "form", courseId);
      if (res.ok) {
        setContent("");
        setStatus("success");
        setMessage("感谢您的反馈，我们会认真查看。");
        if (showHistory) {
          const list = await api.feedback.listMy();
          setHistoryList(list);
        }
      } else {
        setStatus("error");
        setMessage(res.message || "提交失败，请重试");
      }
    } catch {
      setStatus("error");
      setMessage("网络错误，请稍后重试");
    }
  };

  const handleToggleHistory = async () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next && historyList.length === 0 && !historyLoading) {
      setHistoryError("");
      setHistoryLoading(true);
      try {
        const list = await api.feedback.listMy();
        setHistoryList(list);
      } catch {
        setHistoryError("加载反馈记录失败，请稍后重试");
        setHistoryList([]);
      } finally {
        setHistoryLoading(false);
      }
    }
  };

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>
        学习反馈
      </h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 24, fontSize: 15 }}>
        您的反馈将用于持续改进课程与产品；您的疑问老师将会给予悉心解答。
      </p>

      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 17 }}>填写反馈与疑问</h3>
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

      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 17 }}>反馈处理</h3>
        <p style={{ color: "var(--text-muted)", margin: "0 0 12px", fontSize: 14 }}>
          可查看您已提交的反馈与疑问，以及教师/管理员的处理结果与状态。
        </p>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleToggleHistory}
          style={{ marginBottom: showHistory ? 16 : 0 }}
        >
          {showHistory ? "收起反馈处理" : "查看反馈处理"}
        </button>
        {showHistory && (
          <>
            {historyLoading && <p style={{ color: "var(--text-muted)", margin: "8px 0" }}>加载中…</p>}
            {historyError && <p style={{ color: "var(--error)", margin: "8px 0" }}>{historyError}</p>}
            {!historyLoading && !historyError && (
              <div style={{ overflowX: "auto" }}>
                {historyList.length === 0 ? (
                  <p style={{ color: "var(--text-muted)", margin: 0 }}>暂无反馈记录</p>
                ) : (
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontSize: 14,
                    }}
                  >
                    <thead>
                      <tr style={{ borderBottom: "2px solid var(--border)", textAlign: "left" }}>
                        <th style={{ padding: "10px 12px", fontWeight: 600 }}>反馈内容</th>
                        <th style={{ padding: "10px 12px", fontWeight: 600 }}>处理结果</th>
                        <th style={{ padding: "10px 12px", fontWeight: 600, whiteSpace: "nowrap" }}>状态</th>
                        <th style={{ padding: "10px 12px", fontWeight: 600, whiteSpace: "nowrap" }}>提交时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyList.map((row) => (
                        <tr key={row.id} style={{ borderBottom: "1px solid var(--border)" }}>
                          <td style={{ padding: "10px 12px", verticalAlign: "top", maxWidth: 280 }}>{row.content}</td>
                          <td style={{ padding: "10px 12px", verticalAlign: "top", maxWidth: 280 }}>
                            {row.reply_text || "—"}
                          </td>
                          <td style={{ padding: "10px 12px", verticalAlign: "top" }}>{row.status}</td>
                          <td style={{ padding: "10px 12px", verticalAlign: "top", whiteSpace: "nowrap" }}>
                            {formatDateTime(row.created_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
