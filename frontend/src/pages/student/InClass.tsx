import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  ppt_ref?: string | null;
  knowledge_point?: string | null;
  question_asked_id?: number | null;
};

type ChatSession = {
  id: number;
  title: string;
  chapterId: number | null;
  messages: ChatMessage[];
};

const studentMenus = [
  { to: "/student/preview", label: "课前预习" },
  { to: "/student/inclass", label: "课中辅助" },
  { to: "/student/review", label: "课后复习" },
  { to: "/student/exercises", label: "习题训练" },
  { to: "/student/feedback", label: "反馈" },
];

function makeSession(id: number): ChatSession {
  return {
    id,
    title: "新对话",
    chapterId: null,
    messages: [],
  };
}

export default function InClass() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [chapters, setChapters] = useState<{ id: number; title: string }[]>([]);
  const [feedbackSendingId, setFeedbackSendingId] = useState<number | null>(null);
  const [submittedQaIds, setSubmittedQaIds] = useState<Set<number>>(new Set());
  const [sessionSeq, setSessionSeq] = useState(2);
  const [sessions, setSessions] = useState<ChatSession[]>([makeSession(1)]);
  const [activeSessionId, setActiveSessionId] = useState(1);

  useEffect(() => {
    api.chapters.list().then(setChapters).catch(() => setChapters([]));
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
      const res = await api.qa.ask(q, activeSession.chapterId ?? undefined);
      const assistantMsg: ChatMessage = {
        id: Date.now() + 1,
        role: "assistant",
        content: res.answer,
        ppt_ref: res.ppt_ref,
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
          <div className="student-chat-topbar-title">课中辅助</div>
          <div className="student-chat-course-picker">
            <span>课程</span>
            <select
              value={activeSession.chapterId ?? ""}
              onChange={(e) => {
                const nextId = e.target.value ? Number(e.target.value) : null;
                updateActiveSession((session) => ({ ...session, chapterId: nextId }));
              }}
            >
              <option value="">全部课程</option>
              {chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="student-chat-message-list">
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
                    {msg.ppt_ref && <span>参考 PPT：{msg.ppt_ref}</span>}
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
        </div>

        <div className="student-chat-input-wrap">
          <div className="student-chat-input-row">
            <input
              type="text"
              placeholder="请输入你的问题"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAsk()}
            />
            <button type="button" className="btn-primary" onClick={handleAsk} disabled={loading || !question.trim()}>
              发送
            </button>
          </div>
          <div className="student-chat-menu-row">
            {studentMenus.map((item) => (
              <Link key={item.to} to={item.to} className="student-chat-menu-link">
                {item.label}
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
