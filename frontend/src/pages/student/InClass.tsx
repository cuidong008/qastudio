import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import Preview from "./Preview";
import Review from "./Review";
import Exercises from "./Exercises";
import Feedback from "./Feedback";

const CHAT_STORAGE_KEY = "qastudio.student.chat.v1";

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
  customTitle: boolean;
  createdAt: number;
  updatedAt: number;
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

function makeSession(id: number, courseId: number | null = null): ChatSession {
  const now = Date.now();
  return {
    id,
    title: "新对话",
    courseId,
    customTitle: false,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function hasUserQuestion(session: ChatSession): boolean {
  return session.messages.some((m) => m.role === "user");
}

function loadChatState(): { sessions: ChatSession[]; sessionSeq: number; activeSessionId: number } {
  const fallback = { sessions: [makeSession(1)], sessionSeq: 2, activeSessionId: 1 };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as {
      sessions?: ChatSession[];
      sessionSeq?: number;
      activeSessionId?: number;
    };
    if (!Array.isArray(parsed.sessions) || parsed.sessions.length === 0) return fallback;
    const sessions = parsed.sessions
      .filter((s) => typeof s?.id === "number")
      .map((s) => ({
        ...s,
        courseId: s.courseId ?? null,
        customTitle: Boolean(s.customTitle),
        createdAt: typeof s.createdAt === "number" ? s.createdAt : Date.now(),
        updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : Date.now(),
        messages: Array.isArray(s.messages) ? s.messages : [],
      }));
    if (sessions.length === 0) return fallback;
    const maxId = Math.max(...sessions.map((s) => s.id));
    const active = sessions.some((s) => s.id === parsed.activeSessionId) ? parsed.activeSessionId! : sessions[0].id;
    return {
      sessions,
      sessionSeq: typeof parsed.sessionSeq === "number" ? Math.max(parsed.sessionSeq, maxId + 1) : maxId + 1,
      activeSessionId: active,
    };
  } catch {
    return fallback;
  }
}

export default function InClass() {
  const initialState = useMemo(() => loadChatState(), []);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [courses, setCourses] = useState<{ id: number; name: string }[]>([]);
  const [openingReferenceId, setOpeningReferenceId] = useState<number | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<number | null>(null);
  const [renameSessionId, setRenameSessionId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");
  const [collapsedCourseGroups, setCollapsedCourseGroups] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<WorkspaceMode>("qa");
  const [sessionSeq, setSessionSeq] = useState(initialState.sessionSeq);
  const [sessions, setSessions] = useState<ChatSession[]>(initialState.sessions);
  const [activeSessionId, setActiveSessionId] = useState(initialState.activeSessionId);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    api.courses.list().then((rows) => setCourses(rows.map((c) => ({ id: c.id, name: c.name })))).catch(() => setCourses([]));
  }, []);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? sessions[0],
    [sessions, activeSessionId]
  );

  const courseNameMap = useMemo(() => {
    const m = new Map<number, string>();
    courses.forEach((c) => m.set(c.id, c.name));
    return m;
  }, [courses]);

  const groupedSessions = useMemo(() => {
    const keyword = sessionSearch.trim().toLowerCase();
    const grouped = new Map<number | null, ChatSession[]>();
    sessions.forEach((s) => {
      if (keyword) {
        const titleMatched = s.title.toLowerCase().includes(keyword);
        const messageMatched = s.messages.some((m) => m.content.toLowerCase().includes(keyword));
        if (!titleMatched && !messageMatched) return;
      }
      const key = s.courseId ?? null;
      const list = grouped.get(key) ?? [];
      list.push(s);
      grouped.set(key, list);
    });
    const groups = Array.from(grouped.entries()).map(([courseId, list]) => ({
      courseId,
      courseName: courseId == null ? "未选择课程" : courseNameMap.get(courseId) ?? `课程 ${courseId}`,
      sessions: list.sort((a, b) => b.updatedAt - a.updatedAt),
    }));
    return groups.sort((a, b) => {
      if (a.courseId == null) return 1;
      if (b.courseId == null) return -1;
      return a.courseName.localeCompare(b.courseName, "zh-CN");
    });
  }, [sessions, courseNameMap, sessionSearch]);

  const updateActiveSession = (updater: (session: ChatSession) => ChatSession, touch = true) => {
    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== activeSessionId) return session;
        const next = updater(session);
        return { ...next, updatedAt: touch ? Date.now() : next.updatedAt };
      })
    );
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    localStorage.setItem(
      CHAT_STORAGE_KEY,
      JSON.stringify({ sessions, sessionSeq, activeSessionId })
    );
  }, [sessions, sessionSeq, activeSessionId]);

  const createNewSession = () => {
    const reusable = sessions.find((s) => !hasUserQuestion(s));
    if (reusable) {
      setActiveSessionId(reusable.id);
      setMode("qa");
      setQuestion("");
      return;
    }
    const id = sessionSeq;
    const next = makeSession(id, activeSession?.courseId ?? null);
    setSessionSeq((prev) => prev + 1);
    setSessions((prev) => [next, ...prev]);
    setActiveSessionId(id);
    setMode("qa");
    setQuestion("");
  };

  const handleAsk = async () => {
    const q = question.trim();
    if (!q || !activeSession) return;
    if (!activeSession.courseId) {
      const tipMsg: ChatMessage = {
        id: Date.now(),
        role: "assistant",
        content: "请先选择课程，再进行提问",
      };
      updateActiveSession((session) => ({
        ...session,
        messages: [...session.messages, tipMsg],
      }));
      return;
    }
    const userMsg: ChatMessage = {
      id: Date.now(),
      role: "user",
      content: q,
    };
    updateActiveSession((session) => ({
      ...session,
      title: !session.customTitle && session.messages.length === 0 ? q.slice(0, 16) : session.title,
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

  const handleCopyMessage = async (message: ChatMessage) => {
    const text = (message.content || "").trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((curr) => (curr === message.id ? null : curr)), 1200);
    } catch {
      alert("复制失败，请检查浏览器剪贴板权限");
    }
  };

  const handleEditQuestion = (messageId: number) => {
    if (!activeSession) return;
    const idx = activeSession.messages.findIndex((m) => m.id === messageId && m.role === "user");
    if (idx < 0) return;
    const target = activeSession.messages[idx];
    setMode("qa");
    setQuestion(target.content);
    updateActiveSession((session) => ({
      ...session,
      messages: session.messages.slice(0, idx),
    }));
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const startRename = (session: ChatSession) => {
    setRenameSessionId(session.id);
    setRenameValue(session.title);
  };

  const submitRename = (sessionId: number) => {
    const nextTitle = renameValue.trim();
    if (!nextTitle) {
      cancelRename();
      return;
    }
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? { ...s, title: nextTitle.slice(0, 48), customTitle: true, updatedAt: Date.now() }
          : s
      )
    );
    setRenameSessionId(null);
    setRenameValue("");
  };

  const cancelRename = () => {
    setRenameSessionId(null);
    setRenameValue("");
  };

  const handleDeleteSession = (sessionId: number) => {
    if (!window.confirm("确认删除该对话历史吗？")) return;
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== sessionId);
      if (next.length > 0) {
        if (activeSessionId === sessionId) {
          setActiveSessionId(next[0].id);
        }
        return next;
      }
      const created = makeSession(sessionSeq);
      setSessionSeq((seq) => seq + 1);
      setActiveSessionId(created.id);
      return [created];
    });
  };

  const getQaCount = (session: ChatSession): number =>
    session.messages.filter((m) => m.role === "user").length;

  const toggleCourseGroup = (courseId: number | null) => {
    const key = String(courseId);
    setCollapsedCourseGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="student-chat-shell">
      <aside className="student-chat-sidebar">
        <button type="button" className="btn-primary student-chat-new-btn" onClick={createNewSession}>
          + 新建对话
        </button>
        <input
          type="text"
          placeholder="搜索会话"
          value={sessionSearch}
          onChange={(e) => setSessionSearch(e.target.value)}
        />
        <div className="student-chat-session-list">
          {groupedSessions.map((group) => (
            <div key={String(group.courseId)} className="student-chat-session-group">
              <button
                type="button"
                className="student-chat-session-group-title"
                onClick={() => toggleCourseGroup(group.courseId)}
              >
                <span>{group.courseName}</span>
                <span>{collapsedCourseGroups[String(group.courseId)] ? "展开" : "收起"}</span>
              </button>
              {!collapsedCourseGroups[String(group.courseId)] && (
                <>
                  {group.sessions.map((session) => (
                    <div
                      key={session.id}
                      className={`student-chat-session-item ${session.id === activeSession.id ? "is-active" : ""}`}
                    >
                      <button
                        type="button"
                        className="student-chat-session-main"
                        onClick={() => setActiveSessionId(session.id)}
                      >
                        {renameSessionId === session.id ? (
                          <input
                            autoFocus
                            value={renameValue}
                            maxLength={48}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") submitRename(session.id);
                              if (e.key === "Escape") cancelRename();
                            }}
                            onBlur={() => submitRename(session.id)}
                          />
                        ) : (
                          <>
                            <span className="student-chat-session-title">{session.title}</span>
                            <span className="student-chat-session-count">{getQaCount(session)} 条问答</span>
                          </>
                        )}
                      </button>
                      <div className="student-chat-session-actions">
                        {renameSessionId !== session.id && (
                          <button type="button" className="btn-ghost" onClick={() => startRename(session)}>
                            重命名
                          </button>
                        )}
                        <button type="button" className="btn-ghost" onClick={() => handleDeleteSession(session.id)}>
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          ))}
          {groupedSessions.length === 0 && (
            <div className="student-chat-session-empty">没有匹配的会话</div>
          )}
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
                    <div className="student-chat-message-meta">
                      {msg.role === "assistant" && msg.document_ref && (
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
                      {msg.role === "assistant" && msg.knowledge_point && <span>关联知识点：{msg.knowledge_point}</span>}
                      <div style={{ display: "inline-flex", gap: 8 }}>
                        <button type="button" className="btn-ghost" onClick={() => handleCopyMessage(msg)}>
                          {copiedMessageId === msg.id ? "已复制" : "复制"}
                        </button>
                        {msg.role === "user" && (
                          <button type="button" className="btn-ghost" onClick={() => handleEditQuestion(msg.id)}>
                            编辑
                          </button>
                        )}
                      </div>
                    </div>
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
                ref={inputRef}
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
