import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import Preview from "./Preview";
import Review from "./Review";
import Exercises from "./Exercises";
import Feedback from "./Feedback";

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  document_ref?: string | null;
  reference_doc_id?: number | null;
  reference_page?: number | null;
  knowledge_point?: string | null;
  question_asked_id?: number | null;
};

type ChatSession = {
  id: number;
  title: string;
  courseId: number | null;
  messages: ChatMessage[];
};

const studentMenus = [
  { key: "qa", label: "问答模式" },
  { key: "preview", label: "课前预习" },
  { key: "review", label: "课后复习" },
  { key: "exercises", label: "习题训练" },
  { key: "feedback", label: "反馈" },
] as const;
type WorkspaceMode = (typeof studentMenus)[number]["key"];

function makeSession(id: number): ChatSession {
  return {
    id,
    title: "新对话",
    courseId: null,
    messages: [],
  };
}

export default function InClass() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [courses, setCourses] = useState<{ id: number; name: string }[]>([]);
  const [feedbackSendingId, setFeedbackSendingId] = useState<number | null>(null);
  const [submittedQaIds, setSubmittedQaIds] = useState<Set<number>>(new Set());
  const [openingReferenceId, setOpeningReferenceId] = useState<number | null>(null);
  const [mode, setMode] = useState<WorkspaceMode>("qa");
  const [sessionSeq, setSessionSeq] = useState(2);
  const [sessions, setSessions] = useState<ChatSession[]>([makeSession(1)]);
  const [activeSessionId, setActiveSessionId] = useState(1);

  useEffect(() => {
    api.courses.list().then((rows) => setCourses(rows.map((c) => ({ id: c.id, name: c.name })))).catch(() => setCourses([]));
  }, []);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? sessions[0],
    [sessions, activeSessionId]
  );

  const updateActiveSession = (updater: (session: ChatSession) => ChatSession) => {
    setSessions((prev) =>
      prev.map((session) => (session.id === activeSessionId ? updater(session) : session))
    );
  };

  const createNewSession = () => {
    const id = sessionSeq;
    const next = makeSession(id);
    setSessionSeq((prev) => prev + 1);
    setSessions((prev) => [next, ...prev]);
    setActiveSessionId(id);
    setQuestion("");
  };

  const handleAsk = async () => {
    const q = question.trim();
    if (!q || !activeSession) return;
    if (!activeSession.courseId) {
      alert("请先选择课程后再提问");
      return;
    }
    const userMsg: ChatMessage = {
      id: Date.now(),
      role: "user",
      content: q,
    };
    updateActiveSession((session) => ({
      ...session,
      title: session.messages.length === 0 ? q.slice(0, 16) : session.title,
      messages: [...session.messages, userMsg],
    }));
    setQuestion("");
    setLoading(true);
    try {
      const res = await api.qa.ask(q, activeSession.courseId);
      const assistantMsg: ChatMessage = {
        id: Date.now() + 1,
        role: "assistant",
        content: res.answer,
        document_ref: res.document_ref,
        reference_doc_id: res.reference_doc_id ?? null,
        reference_page: res.reference_page ?? null,
        knowledge_point: res.knowledge_point,
        question_asked_id: res.question_asked_id ?? null,
      };
      updateActiveSession((session) => ({
        ...session,
        messages: [...session.messages, assistantMsg],
      }));
    } finally {
      setLoading(false);
    }
  };

  const handleOpenReferenceFile = async (message: ChatMessage) => {
    const docId = message.reference_doc_id ?? null;
    if (!docId) return;
    const popup = window.open("", "_blank");
    if (popup) {
      popup.document.title = "参考文档加载中";
      popup.document.body.innerHTML = "<p style=\"font-family: sans-serif; padding: 16px;\">参考文档加载中…</p>";
      try {
        popup.opener = null;
      } catch {
        // 某些浏览器不允许写 opener，忽略即可
      }
    }
    setOpeningReferenceId(message.id);
    try {
      const blob = await api.qa.referenceFile(docId);
      const url = URL.createObjectURL(blob);
      const targetUrl = message.reference_page && message.reference_page > 0
        ? `${url}#page=${message.reference_page}`
        : url;
      if (popup) {
        popup.location.href = targetUrl;
      } else {
        window.open(targetUrl, "_blank", "noopener,noreferrer");
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      if (popup && !popup.closed) {
        popup.document.title = "参考文档加载失败";
        popup.document.body.innerHTML = "<p style=\"font-family: sans-serif; padding: 16px;\">参考文档加载失败，请重试。</p>";
      }
      alert((e as Error)?.message || "参考文档加载失败，请重试");
    } finally {
      setOpeningReferenceId(null);
    }
  };

  const handleSubmitAsFeedback = async (questionAskedId: number) => {
    setFeedbackSendingId(questionAskedId);
    try {
      await api.feedback.submitFromQa(questionAskedId);
      setSubmittedQaIds((prev) => new Set([...prev, questionAskedId]));
    } finally {
      setFeedbackSendingId(null);
    }
  };

  return (
    <div className="student-chat-shell">
      <aside className="student-chat-sidebar">
        <button type="button" className="btn-primary student-chat-new-btn" onClick={createNewSession}>
          + 新建对话
        </button>
        <div className="student-chat-session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`student-chat-session-item ${session.id === activeSession.id ? "is-active" : ""}`}
              onClick={() => setActiveSessionId(session.id)}
            >
              <span className="student-chat-session-title">{session.title}</span>
              <span className="student-chat-session-count">{session.messages.length} 条消息</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="student-chat-main">
        <div className="student-chat-topbar">
          <div className="student-chat-course-picker">
            <span>课程</span>
            <select
              value={activeSession.courseId ?? ""}
              onChange={(e) => {
                const nextId = e.target.value ? Number(e.target.value) : null;
                updateActiveSession((session) => ({ ...session, courseId: nextId }));
              }}
            >
              <option value="">请选择课程</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="student-chat-message-list">
          {mode === "qa" ? (
            <>
              {activeSession.messages.length === 0 ? (
                <div className="student-chat-empty">
                  <h2>有什么我能帮你的吗？</h2>
                  <p>你可以提问课堂疑点、PPT 知识点定位、知识点解释等问题。</p>
                </div>
              ) : (
                activeSession.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`student-chat-message ${msg.role === "user" ? "from-user" : "from-assistant"}`}
                  >
                    <p>{msg.content}</p>
                    {msg.role === "assistant" && (
                      <div className="student-chat-message-meta">
                        {msg.document_ref && (
                          msg.reference_doc_id ? (
                            <button
                              type="button"
                              className="student-chat-ref-btn"
                              onClick={() => handleOpenReferenceFile(msg)}
                            >
                              {openingReferenceId === msg.id ? "参考文档打开中…" : `参考文档：${msg.document_ref}`}
                            </button>
                          ) : (
                            <span>参考文档：{msg.document_ref}</span>
                          )
                        )}
                        {msg.knowledge_point && <span>关联知识点：{msg.knowledge_point}</span>}
                        {msg.question_asked_id && (
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={feedbackSendingId === msg.question_asked_id || submittedQaIds.has(msg.question_asked_id)}
                            onClick={() => handleSubmitAsFeedback(msg.question_asked_id!)}
                          >
                            {submittedQaIds.has(msg.question_asked_id)
                              ? "已提交反馈"
                              : feedbackSendingId === msg.question_asked_id
                                ? "提交中…"
                                : "提交为学习反馈"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
              {loading && <div className="student-chat-loading">回答中…</div>}
            </>
          ) : (
            <div className="student-chat-tool-content">
              {mode === "preview" && <Preview courseId={activeSession.courseId} />}
              {mode === "review" && <Review inWorkspace onGoQa={() => setMode("qa")} courseId={activeSession.courseId} />}
              {mode === "exercises" && <Exercises courseId={activeSession.courseId} />}
              {mode === "feedback" && <Feedback inWorkspace onGoQa={() => setMode("qa")} />}
            </div>
          )}
        </div>

        <div className="student-chat-input-wrap">
          {mode === "qa" ? (
            <div className="student-chat-input-row">
              <input
                type="text"
                placeholder="请输入你的问题"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAsk()}
              />
              <button type="button" className="btn-primary" onClick={handleAsk} disabled={loading || !question.trim() || !activeSession.courseId}>
                发送
              </button>
            </div>
          ) : (
            <div className="student-chat-mode-hint">
              当前在「{studentMenus.find((m) => m.key === mode)?.label}」模式
              <button type="button" className="btn-primary" onClick={() => setMode("qa")} style={{ marginLeft: 12 }}>
                返回问答
              </button>
            </div>
          )}
          <div className="student-chat-menu-row">
            {studentMenus.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`student-chat-menu-btn ${mode === item.key ? "is-active" : ""}`}
                onClick={() => setMode(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
