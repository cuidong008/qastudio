import { useState, useEffect } from "react";
import { api } from "../../api/client";

export default function InClass() {
  const [question, setQuestion] = useState("");
  const [chapterId, setChapterId] = useState<number | null>(null);
  const [answer, setAnswer] = useState<{
    answer: string;
    ppt_ref: string | null;
    knowledge_point: string | null;
    question_asked_id?: number | null;
  } | null>(null);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [chapters, setChapters] = useState<{ id: number; title: string }[]>([]);

  useEffect(() => {
    api.chapters.list().then(setChapters);
  }, []);

  const handleSubmitAsFeedback = async () => {
    if (!answer?.question_asked_id) return;
    setFeedbackSending(true);
    try {
      await api.feedback.submitFromQa(answer.question_asked_id);
      setFeedbackSubmitted(true);
    } catch {
      // 可加 toast
    } finally {
      setFeedbackSending(false);
    }
  };

  const handleAsk = async () => {
    if (!question.trim()) return;
    setLoading(true);
    setAnswer(null);
    try {
      const res = await api.qa.ask(question.trim(), chapterId ?? undefined);
      setAnswer({
        answer: res.answer,
        ppt_ref: res.ppt_ref,
        knowledge_point: res.knowledge_point,
        question_asked_id: res.question_asked_id ?? undefined,
      });
      setFeedbackSubmitted(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>
        课中辅助
      </h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 20, fontSize: 15 }}>
        课堂实时答疑、PPT 知识点定位
      </p>
      <div style={{ marginBottom: 16 }}>
        <label style={{ marginRight: 10, color: "var(--text-secondary)", fontSize: 14 }}>
          关联章节（可选）
        </label>
        <select
          value={chapterId ?? ""}
          onChange={(e) => setChapterId(e.target.value ? Number(e.target.value) : null)}
          style={{ padding: "10px 14px", minWidth: 200 }}
        >
          <option value="">不限定</option>
          {chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="输入你的问题…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAsk()}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button
          type="button"
          className="btn-primary"
          onClick={handleAsk}
          disabled={loading}
        >
          {loading ? "回答中…" : "提问"}
        </button>
      </div>
      {answer && (
        <div className="card">
          <p style={{ marginBottom: 8 }}>
            <strong>回答：</strong>
            {answer.answer}
          </p>
          {answer.ppt_ref && (
            <p style={{ color: "var(--accent)", marginBottom: 4 }}>
              参考 PPT：{answer.ppt_ref}
            </p>
          )}
          {answer.knowledge_point && (
            <p style={{ color: "var(--text-secondary)", marginBottom: 12 }}>
              关联知识点：{answer.knowledge_point}
            </p>
          )}
          {answer.question_asked_id != null && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
              {feedbackSubmitted ? (
                <span style={{ color: "var(--text-muted)", fontSize: 14 }}>
                  已将该条对话提交为学习反馈
                </span>
              ) : (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleSubmitAsFeedback}
                  disabled={feedbackSending}
                  style={{ fontSize: 14 }}
                >
                  {feedbackSending ? "提交中…" : "将本条对话提交为学习反馈"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
