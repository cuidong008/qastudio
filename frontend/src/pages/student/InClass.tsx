import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { useAuth } from "../../api/auth";
import Preview from "./Preview";
import Review from "./Review";
import Exercises from "./Exercises";
import Feedback from "./Feedback";

const CHAT_STORAGE_KEY = "qastudio.student.chat.v1";
const MAX_AVATAR_FILE_BYTES = 1.5 * 1024 * 1024;
const SUPPORTED_AVATAR_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
  "image/tiff",
  "image/heic",
  "image/heif",
]);

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("图片压缩失败"));
        return;
      }
      resolve(blob);
    }, type, quality);
  });
}

async function loadImageElement(file: File): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => {
        resolve();
      };
      image.onerror = () => {
        reject(new Error("图片解码失败，请更换图片格式"));
      };
      image.src = objectUrl;
    });
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function compressAvatarToDataUrl(file: File): Promise<{ dataUrl: string; bytes: number }> {
  const image = await loadImageElement(file);
  let width = image.naturalWidth || image.width;
  let height = image.naturalHeight || image.height;
  const maxDimension = 1600;
  if (width > maxDimension || height > maxDimension) {
    const ratio = Math.min(maxDimension / width, maxDimension / height);
    width = Math.max(1, Math.round(width * ratio));
    height = Math.max(1, Math.round(height * ratio));
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("浏览器不支持图片压缩");
  }

  let bestBlob: Blob | null = null;
  const qualities = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42, 0.34];
  const mimeTypes = ["image/webp", "image/jpeg", "image/png"];

  for (let round = 0; round < 6; round += 1) {
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    for (const mime of mimeTypes) {
      for (const q of qualities) {
        const blob = await canvasToBlob(canvas, mime, q);
        if (!bestBlob || blob.size < bestBlob.size) {
          bestBlob = blob;
        }
        if (blob.size <= MAX_AVATAR_FILE_BYTES) {
          return { dataUrl: await blobToDataUrl(blob), bytes: blob.size };
        }
      }
      const blob = await canvasToBlob(canvas, mime);
      if (!bestBlob || blob.size < bestBlob.size) {
        bestBlob = blob;
      }
      if (blob.size <= MAX_AVATAR_FILE_BYTES) {
        return { dataUrl: await blobToDataUrl(blob), bytes: blob.size };
      }
    }

    width = Math.max(1, Math.round(width * 0.85));
    height = Math.max(1, Math.round(height * 0.85));
  }

  if (bestBlob && bestBlob.size <= MAX_AVATAR_FILE_BYTES) {
    return { dataUrl: await blobToDataUrl(bestBlob), bytes: bestBlob.size };
  }
  throw new Error("图片压缩后仍超过 1.5MB，请换一张更小的图片");
}

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
  const { user, logout, updateProfile, changePassword } = useAuth();
  const navigate = useNavigate();
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
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [avatarProcessing, setAvatarProcessing] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [settingsSuccess, setSettingsSuccess] = useState("");
  const [mode, setMode] = useState<WorkspaceMode>("qa");
  const [sessionSeq, setSessionSeq] = useState(initialState.sessionSeq);
  const [sessions, setSessions] = useState<ChatSession[]>(initialState.sessions);
  const [activeSessionId, setActiveSessionId] = useState(initialState.activeSessionId);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const userMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!userMenuRef.current) return;
      if (!userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

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

  const openSettings = () => {
    setDisplayName(user?.display_name || user?.username || "");
    setAvatarUrl(user?.avatar_url || null);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setSettingsError("");
    setSettingsSuccess("");
    setUserMenuOpen(false);
    setSettingsOpen(true);
  };

  const onPickAvatar = () => avatarInputRef.current?.click();

  const onAvatarChange = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setSettingsError("请选择图片文件作为头像");
      return;
    }
    if (!SUPPORTED_AVATAR_TYPES.has(file.type.toLowerCase())) {
      setSettingsError("图片格式暂不支持，请使用 JPG/PNG/WebP/GIF/BMP/AVIF/TIFF/HEIC");
      return;
    }
    setAvatarProcessing(true);
    setSettingsError("");
    setSettingsSuccess("");
    compressAvatarToDataUrl(file)
      .then(({ dataUrl, bytes }) => {
        setAvatarUrl(dataUrl);
        const sizeMb = (bytes / (1024 * 1024)).toFixed(2);
        setSettingsSuccess(`头像已处理并压缩为 ${sizeMb}MB`);
      })
      .catch((e) => {
        const msg = (e as Error)?.message || "头像处理失败";
        if (file.size > MAX_AVATAR_FILE_BYTES && msg === "头像处理失败") {
          const fileSizeMb = (file.size / (1024 * 1024)).toFixed(2);
          setSettingsError(`头像文件过大（当前 ${fileSizeMb}MB），请上传不超过 1.5MB 的图片`);
          return;
        }
        setSettingsError(msg);
      })
      .finally(() => {
        setAvatarProcessing(false);
      });
  };

  const handleSaveProfile = async () => {
    setSettingsError("");
    setSettingsSuccess("");
    try {
      setProfileSaving(true);
      await updateProfile({
        display_name: displayName.trim() || null,
        avatar_url: avatarUrl ?? null,
      });
      setSettingsSuccess("资料已更新");
    } catch (e) {
      setSettingsError((e as Error)?.message || "保存失败");
    } finally {
      setProfileSaving(false);
    }
  };

  const handleSavePassword = async () => {
    setSettingsError("");
    setSettingsSuccess("");
    if (!currentPassword || !newPassword || !confirmPassword) {
      setSettingsError("请完整填写密码项");
      return;
    }
    if (newPassword !== confirmPassword) {
      setSettingsError("两次输入的新密码不一致");
      return;
    }
    try {
      setPasswordSaving(true);
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSettingsSuccess("密码已修改");
    } catch (e) {
      setSettingsError((e as Error)?.message || "密码修改失败");
    } finally {
      setPasswordSaving(false);
    }
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
        <div className="student-chat-user-wrap" ref={userMenuRef}>
          <button
            type="button"
            className="student-chat-user-trigger"
            onClick={() => setUserMenuOpen((v) => !v)}
          >
            <span className="student-chat-user-avatar">
              {avatarUrl || user?.avatar_url ? (
                <img src={avatarUrl || user?.avatar_url || ""} alt="头像" />
              ) : (
                (user?.display_name || user?.username || "U").slice(0, 1).toUpperCase()
              )}
            </span>
            <span className="student-chat-user-name">{user?.display_name || user?.username || "未登录用户"}</span>
          </button>
          {userMenuOpen && (
            <div className="student-chat-user-menu">
              <button type="button" onClick={openSettings}>设置</button>
              <button
                type="button"
                onClick={() => {
                  logout();
                  navigate("/login");
                }}
              >
                退出
              </button>
            </div>
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
      {settingsOpen && (
        <div className="student-chat-settings-mask" onClick={() => setSettingsOpen(false)}>
          <div className="student-chat-settings-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>设置</h3>
            <div className="student-chat-settings-avatar-row">
              <span className="student-chat-user-avatar lg">
                {avatarUrl ? (
                  <img src={avatarUrl} alt="头像" />
                ) : (
                  (displayName || user?.username || "U").slice(0, 1).toUpperCase()
                )}
              </span>
              <div>
                <button type="button" className="btn-secondary" onClick={onPickAvatar} disabled={avatarProcessing}>
                  {avatarProcessing ? "头像处理中…" : "修改头像"}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ marginLeft: 8 }}
                  onClick={() => setAvatarUrl(null)}
                >
                  清除头像
                </button>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={(e) => onAvatarChange(e.target.files?.[0] ?? null)}
                />
                <p className="student-chat-settings-help">支持 JPG/PNG/WebP/GIF/BMP/AVIF/TIFF/HEIC，大小不超过 1.5MB</p>
              </div>
            </div>

            <label className="student-chat-settings-field">
              <span>显示姓名</span>
              <input
                type="text"
                maxLength={64}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="请输入显示姓名"
              />
            </label>
            <button type="button" className="btn-primary" onClick={handleSaveProfile} disabled={profileSaving || avatarProcessing}>
              {profileSaving ? "保存中…" : "保存资料"}
            </button>

            <div className="student-chat-settings-divider" />
            <label className="student-chat-settings-field">
              <span>当前密码</span>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="请输入当前密码"
              />
            </label>
            <label className="student-chat-settings-field">
              <span>新密码</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="请输入新密码（至少 6 位）"
              />
            </label>
            <label className="student-chat-settings-field">
              <span>确认新密码</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="请再次输入新密码"
              />
            </label>
            <button type="button" className="btn-primary" onClick={handleSavePassword} disabled={passwordSaving}>
              {passwordSaving ? "提交中…" : "修改密码"}
            </button>

            {settingsError && <p className="text-error" style={{ margin: "8px 0 0" }}>{settingsError}</p>}
            {settingsSuccess && <p className="text-success" style={{ margin: "8px 0 0" }}>{settingsSuccess}</p>}

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button type="button" className="btn-ghost" onClick={() => setSettingsOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
