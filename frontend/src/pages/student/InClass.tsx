import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import { useAuth } from "../../api/auth";
import TeacherStudentLearningCard, { type StudentLearningPayload, type StatsRow } from "../../components/TeacherStudentLearningCard";
import Preview from "./Preview";
import Review from "./Review";
import Exercises from "./Exercises";
import Feedback from "./Feedback";
import StudentLearningData from "./StudentLearningData";

/** 各角色按用户隔离的 key 前缀，避免教师/学生/管理员之间或不同用户之间混用会话 */
const CHAT_STORAGE_KEY_STUDENT_PREFIX = "qastudio.student.chat.v1.";
const CHAT_STORAGE_KEY_TEACHER_PREFIX = "qastudio.teacher.chat.v1.";
const CHAT_STORAGE_KEY_ADMIN_PREFIX = "qastudio.admin.chat.v1.";
/** 旧版学生端使用的全局 key（无 userId），迁移到 per-user 后仅用于一次性读取 */
const CHAT_STORAGE_KEY_STUDENT_LEGACY = "qastudio.student.chat.v1";

/** 每用户最多保留的问答会话条数（按 updatedAt 保留最近 N 条） */
const MAX_CHAT_SESSIONS_PER_USER = 100;

/** 教师与教研组长共用教师端 key（会话按 userId 隔离） */
function getChatStorageKey(variant: "student" | "teacher" | "teaching_leader" | "admin", userId?: number | null): string | null {
  if (userId == null) return null;
  if (variant === "teacher" || variant === "teaching_leader") return CHAT_STORAGE_KEY_TEACHER_PREFIX + userId;
  if (variant === "admin") return CHAT_STORAGE_KEY_ADMIN_PREFIX + userId;
  return CHAT_STORAGE_KEY_STUDENT_PREFIX + userId;
}
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

/** 关联知识点展示最大字符数，超出用 ... 表示 */
const KNOWLEDGE_POINT_MAX_DISPLAY_LEN = 20;

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  document_ref?: string | null;
  reference_doc_id?: number | null;
  reference_page?: number | null;
  reference_doc_title?: string | null;
  knowledge_point?: string | null;
  question_asked_id?: number | null;
  /** 教师端：查看学生学情时的结构化数据 */
  payload?: StudentLearningPayload;
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
  { key: "learning-data", label: "我的学情" },
] as const;
type WorkspaceMode = (typeof studentMenus)[number]["key"];

const teacherQuickLinks = [
  { label: "学情概览", path: "/teacher/learning-data" },
  { label: "我的课程", path: "/teacher/courses" },
  { label: "我的班级", path: "/teacher/classes" },
  { label: "课件流水线", path: "/teacher/pipeline" },
  { label: "题库管理", path: "/teacher/question-bank" },
];

const adminQuickLinks = [
  { label: "用户管理", path: "/admin/users" },
  { label: "RAG配置", path: "/admin/rag" },
];

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

/** 教师端：判断是否为「查看学生学情」意图并提取关键词（姓名或学号） */
function parseLearningIntent(message: string): string | null {
  const t = message.trim();
  if (!t.includes("学情")) return null;
  const m1 = t.match(/把\s*([^的]+)\s*的学情/);
  if (m1) return m1[1].trim();
  const m2 = t.match(/(?:查看|列出|显示)\s*([^的\s]+)\s*的?学情/);
  if (m2) return m2[1].trim();
  const m3 = t.match(/学情[表]?\s*[：:]\s*(\S+)/);
  if (m3) return m3[1].trim();
  const m4 = t.match(/^\/学情\s*(.*)$/);
  if (m4) return m4[1].trim();
  const after = t.slice(t.indexOf("学情") + 2).trim();
  if (after) return after.split(/\s/)[0] ?? "";
  const before = t.slice(0, t.indexOf("学情")).replace(/^.*?(?:把|给|查看|列出|显示)\s*/i, "").trim();
  return before || null;
}

function getDefaultLearningTimeRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function trimSessionsToMax(sessions: ChatSession[], max: number): ChatSession[] {
  if (sessions.length <= max) return sessions;
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, max);
}

/**
 * 若当前 key 无数据且为学生 per-user key，尝试从旧版全局 key 迁移一次，并写入新 key。
 * 返回最终应使用的 key（可能已写入迁移数据）。
 */
function migrateLegacyStudentKeyIfNeeded(storageKey: string): void {
  if (typeof window === "undefined") return;
  if (!storageKey.startsWith(CHAT_STORAGE_KEY_STUDENT_PREFIX)) return;
  const rawNew = localStorage.getItem(storageKey);
  if (rawNew) return;
  const rawLegacy = localStorage.getItem(CHAT_STORAGE_KEY_STUDENT_LEGACY);
  if (!rawLegacy) return;
  try {
    localStorage.setItem(storageKey, rawLegacy);
  } catch {
    // ignore
  }
}

function loadChatState(storageKey: string): { sessions: ChatSession[]; sessionSeq: number; activeSessionId: number } {
  const fallback = { sessions: [makeSession(1)], sessionSeq: 2, activeSessionId: 1 };
  if (typeof window === "undefined") return fallback;
  migrateLegacyStudentKeyIfNeeded(storageKey);
  try {
    const raw = localStorage.getItem(storageKey);
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
    const trimmed = trimSessionsToMax(sessions, MAX_CHAT_SESSIONS_PER_USER);
    const maxId = Math.max(...trimmed.map((s) => s.id));
    const active = trimmed.some((s) => s.id === parsed.activeSessionId) ? parsed.activeSessionId! : trimmed[0].id;
    return {
      sessions: trimmed,
      sessionSeq: typeof parsed.sessionSeq === "number" ? Math.max(parsed.sessionSeq, maxId + 1) : maxId + 1,
      activeSessionId: active,
    };
  } catch {
    return fallback;
  }
}

const fallbackChatState = { sessions: [makeSession(1)], sessionSeq: 2, activeSessionId: 1 };

export type InClassVariant = "student" | "teacher" | "teaching_leader" | "admin";

export default function InClass({ variant = "student" }: { variant?: InClassVariant }) {
  const { user, logout, updateProfile, changePassword } = useAuth();
  const navigate = useNavigate();
  const storageKey = getChatStorageKey(variant, user?.id);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [courses, setCourses] = useState<{ id: number; name: string }[]>([]);
  const [openingReferenceId, setOpeningReferenceId] = useState<number | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<number | null>(null);
  const [deleteMessageId, setDeleteMessageId] = useState<number | null>(null);
  const [renameSessionId, setRenameSessionId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");
  const [collapsedCourseGroups, setCollapsedCourseGroups] = useState<Record<string, boolean>>({});
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [avatarProcessing, setAvatarProcessing] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [settingsSuccess, setSettingsSuccess] = useState("");
  const [mode, setMode] = useState<WorkspaceMode>("qa");
  const [sessionSeq, setSessionSeq] = useState(fallbackChatState.sessionSeq);
  const [sessions, setSessions] = useState<ChatSession[]>(() => fallbackChatState.sessions);
  const [activeSessionId, setActiveSessionId] = useState(fallbackChatState.activeSessionId);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  /** 仅在一次从 localStorage 加载后再持久化，避免首次挂载用 fallback 覆盖已有历史（教师/学生/管理员统一） */
  const storageLoadedRef = useRef(false);

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
    if (variant === "teacher" || variant === "teaching_leader") {
      api.teacher.courses.list().then((rows) => setCourses(rows.map((c) => ({ id: c.id, name: c.name })))).catch(() => setCourses([]));
    } else if (variant === "admin") {
      setCourses([]);
    } else {
      api.courses.list().then((rows) => setCourses(rows.map((c) => ({ id: c.id, name: c.name })))).catch(() => setCourses([]));
    }
  }, [variant]);

  useEffect(() => {
    if (!storageKey) return;
    storageLoadedRef.current = false;
    const loaded = loadChatState(storageKey);
    setSessions(loaded.sessions);
    setSessionSeq(loaded.sessionSeq);
    setActiveSessionId(loaded.activeSessionId);
    // 下一轮再允许持久化，避免本轮 persist effect 仍读到旧 state 从而用空会话覆盖 localStorage
    const t = setTimeout(() => {
      storageLoadedRef.current = true;
    }, 0);
    return () => clearTimeout(t);
  }, [storageKey]);

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
      courseName:
        courseId == null
          ? "未选择课程"
          : courseId === 0
            ? "全部课程"
            : courseNameMap.get(courseId) ?? `课程 ${courseId}`,
      sessions: list.sort((a, b) => b.updatedAt - a.updatedAt),
    }));
    return groups.sort((a, b) => {
      if (a.courseId == null) return 1;
      if (b.courseId == null) return -1;
      return a.courseName.localeCompare(b.courseName, "zh-CN");
    });
  }, [sessions, courseNameMap, sessionSearch]);

  /** 弹出删除确认时，待删除的那条问答对应的消息 id 集合（用于高亮展示） */
  const pendingDeleteMessageIds = useMemo(() => {
    if (deleteMessageId == null || !activeSession) return new Set<number>();
    const messages = activeSession.messages;
    const idx = messages.findIndex((m) => m.id === deleteMessageId);
    if (idx < 0) return new Set<number>();
    const ids = new Set<number>();
    if (messages[idx].role === "user") {
      ids.add(messages[idx].id);
      if (idx + 1 < messages.length && messages[idx + 1].role === "assistant") ids.add(messages[idx + 1].id);
    } else {
      ids.add(messages[idx].id);
      if (idx - 1 >= 0 && messages[idx - 1].role === "user") ids.add(messages[idx - 1].id);
    }
    return ids;
  }, [deleteMessageId, activeSession]);

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
    if (typeof window === "undefined" || !storageKey) return;
    if (!storageLoadedRef.current) return;
    const toSave = trimSessionsToMax(sessions, MAX_CHAT_SESSIONS_PER_USER);
    localStorage.setItem(
      storageKey,
      JSON.stringify({ sessions: toSave, sessionSeq, activeSessionId })
    );
  }, [sessions, sessionSeq, activeSessionId, storageKey]);

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
    setSessions((prev) => {
      const list = [next, ...prev];
      return trimSessionsToMax(list, MAX_CHAT_SESSIONS_PER_USER);
    });
    setActiveSessionId(id);
    setMode("qa");
    setQuestion("");
  };

  const handleAsk = async () => {
    const q = question.trim();
    if (!q || !activeSession) return;
    const courseId = activeSession.courseId;
    const hasCourse =
      variant === "admin" ||
      (variant === "teacher" || variant === "teaching_leader") ||
      (courseId != null && courseId > 0);
    if (!hasCourse) {
      if (variant === "student") {
        alert("请先选择课程，再进行提问。");
      }
      return;
    }
    const apiCourseId = ((variant === "teacher" || variant === "teaching_leader") && courseId === 0) || variant === "admin" ? null : courseId;
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

    const learningKeyword = (variant === "teacher" || variant === "teaching_leader") ? parseLearningIntent(q) : null;
    if ((variant === "teacher" || variant === "teaching_leader") && learningKeyword !== null) {
      try {
        if (!learningKeyword.trim()) {
          const assistantMsg: ChatMessage = {
            id: Date.now() + 1,
            role: "assistant",
            content: "请说明要查看学情的学生姓名或学号，例如：把张三的学情表列出来",
            payload: {
              type: "student_learning",
              keyword: "",
              candidates: [],
              selectedStudentId: null,
              selectedStudentName: null,
              timeRange: null,
              period: "7",
              customStart: "",
              customEnd: "",
              courseRows: [],
              allChaptersByCourse: {},
            },
          };
          updateActiveSession((session) => ({ ...session, messages: [...session.messages, assistantMsg] }));
          return;
        }
        const candidates = await api.teacher.students.list({ q: learningKeyword.trim() });
        const filtered = candidates;
        const defaultRange = getDefaultLearningTimeRange();
        const emptyPayload: StudentLearningPayload = {
          type: "student_learning",
          keyword: learningKeyword || "",
          candidates: filtered.map((s) => ({ id: s.id, student_no: s.student_no, display_name: s.display_name })),
          selectedStudentId: null,
          selectedStudentName: null,
          timeRange: null,
          period: "7",
          customStart: "",
          customEnd: "",
          courseRows: [],
          allChaptersByCourse: {},
        };
        if (filtered.length === 0) {
          const content = learningKeyword.trim()
            ? `未找到匹配「${learningKeyword}」的学生（按姓名或学号）。`
            : "请说明要查看学情的学生姓名或学号，例如：把张三的学情表列出来";
          const assistantMsg: ChatMessage = {
            id: Date.now() + 1,
            role: "assistant",
            content,
            payload: { ...emptyPayload, candidates: filtered.map((s) => ({ id: s.id, student_no: s.student_no, display_name: s.display_name })) },
          };
          updateActiveSession((session) => ({ ...session, messages: [...session.messages, assistantMsg] }));
          return;
        }
        if (filtered.length === 1) {
          const student = filtered[0];
          const studentName = (student.display_name || student.student_no || `学生${student.id}`).trim();
          const list = await api.teacher.statsByCourseStudent({
            studentId: student.id,
            startDate: defaultRange.start,
            endDate: defaultRange.end,
          });
          const courseIds = [...new Set(list.map((r) => r.course_id))];
          const allChaptersByCourse: Record<number, { id: number; title: string }[]> = {};
          await Promise.all(
            courseIds.map((cid) =>
              api.teacher.courses.chapters(cid).then((chList) => {
                allChaptersByCourse[cid] = chList.map((ch) => ({ id: ch.id, title: ch.title }));
              })
            )
          );
          const assistantMsg: ChatMessage = {
            id: Date.now() + 1,
            role: "assistant",
            content: `已列出 **${studentName}** 的学情统计（默认近7天），可修改统计周期后点击「再次查询」。`,
            payload: {
              ...emptyPayload,
              candidates: filtered.map((s) => ({ id: s.id, student_no: s.student_no, display_name: s.display_name })),
              selectedStudentId: student.id,
              selectedStudentName: studentName,
              timeRange: defaultRange,
              courseRows: list as StatsRow[],
              allChaptersByCourse,
            },
          };
          updateActiveSession((session) => ({ ...session, messages: [...session.messages, assistantMsg] }));
          return;
        }
        const assistantMsg: ChatMessage = {
          id: Date.now() + 1,
          role: "assistant",
          content: "找到多位匹配学生，请选择要查看学情的一位：",
          payload: { ...emptyPayload, candidates: filtered.map((s) => ({ id: s.id, student_no: s.student_no, display_name: s.display_name })) },
        };
        updateActiveSession((session) => ({ ...session, messages: [...session.messages, assistantMsg] }));
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      const res = await api.qa.ask(q, apiCourseId);
      const assistantMsg: ChatMessage = {
        id: Date.now() + 1,
        role: "assistant",
        content: res.answer,
        document_ref: res.document_ref,
        reference_doc_id: res.reference_doc_id ?? null,
        reference_page: res.reference_page ?? null,
        reference_doc_title: res.reference_doc_title ?? null,
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

  const updateLearningPayload = (
    messageId: number,
    updater: (prev: StudentLearningPayload) => StudentLearningPayload
  ) => {
    updateActiveSession((session) => ({
      ...session,
      messages: session.messages.map((m) =>
        m.id === messageId && m.payload?.type === "student_learning"
          ? { ...m, payload: updater(m.payload) }
          : m
      ),
    }), false);
  };

  const handleSelectStudentLearning = async (messageId: number, studentId: number, studentName: string) => {
    const defaultRange = getDefaultLearningTimeRange();
    try {
      const list = await api.teacher.statsByCourseStudent({
        studentId,
        startDate: defaultRange.start,
        endDate: defaultRange.end,
      });
      const courseIds = [...new Set(list.map((r) => r.course_id))];
      const allChaptersByCourse: Record<number, { id: number; title: string }[]> = {};
      await Promise.all(
        courseIds.map((cid) =>
          api.teacher.courses.chapters(cid).then((chList) => {
            allChaptersByCourse[cid] = chList.map((ch) => ({ id: ch.id, title: ch.title }));
          })
        )
      );
      updateLearningPayload(messageId, (p) => ({
        ...p,
        selectedStudentId: studentId,
        selectedStudentName: studentName,
        timeRange: defaultRange,
        courseRows: list as StatsRow[],
        allChaptersByCourse,
      }));
    } catch {
      updateLearningPayload(messageId, (p) => ({ ...p, selectedStudentId: null, selectedStudentName: null }));
    }
  };

  const handleLearningTimeRangeChange = (messageId: number, period: string, customStart: string, customEnd: string) => {
    updateLearningPayload(messageId, (p) => ({ ...p, period, customStart, customEnd }));
  };

  const handleRefetchLearningTimeRange = (
    messageId: number,
    _studentId: number,
    start: string,
    end: string,
    period: string,
    customStart: string,
    customEnd: string,
    courseRows: StatsRow[],
    allChaptersByCourse: Record<number, { id: number; title: string }[]>
  ) => {
    updateLearningPayload(messageId, (p) => ({
      ...p,
      timeRange: { start, end },
      period,
      customStart,
      customEnd,
      courseRows,
      allChaptersByCourse,
    }));
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

  /** 请求删除该条问答（仅前端对话中移除，不删后台记录）；确认后执行 */
  const handleRequestDeleteMessage = (messageId: number) => setDeleteMessageId(messageId);

  const handleConfirmDeleteMessage = () => {
    if (deleteMessageId == null || !activeSession) {
      setDeleteMessageId(null);
      return;
    }
    const messages = activeSession.messages;
    const idx = messages.findIndex((m) => m.id === deleteMessageId);
    if (idx < 0) {
      setDeleteMessageId(null);
      return;
    }
    const toRemove = new Set<number>();
    if (messages[idx].role === "user") {
      toRemove.add(idx);
      if (idx + 1 < messages.length && messages[idx + 1].role === "assistant") toRemove.add(idx + 1);
    } else {
      toRemove.add(idx);
      if (idx - 1 >= 0 && messages[idx - 1].role === "user") toRemove.add(idx - 1);
    }
    updateActiveSession((session) => ({
      ...session,
      messages: session.messages.filter((_, i) => !toRemove.has(i)),
    }));
    setDeleteMessageId(null);
  };

  const handleCancelDeleteMessage = () => setDeleteMessageId(null);

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
    setAvatarUrl(user?.avatar_url || null);
    setEditUsername(user?.username ?? "");
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
    const payload: { avatar_url?: string | null; username?: string } = {};
    if (avatarUrl !== (user?.avatar_url ?? null)) {
      payload.avatar_url = avatarUrl ?? null;
    }
    const canEditUsername =
      user && user.role !== "admin" && (user.username_changed_at == null || user.username_changed_at === "");
    const newUsername = editUsername.trim();
    if (canEditUsername && newUsername && newUsername !== user?.username) {
      payload.username = newUsername;
    }
    if (Object.keys(payload).length === 0) {
      setSettingsSuccess("未修改");
      return;
    }
    try {
      setProfileSaving(true);
      await updateProfile(payload);
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
        {variant !== "admin" && (
          <div className="student-chat-topbar">
            <div className="student-chat-course-picker">
              <span>课程</span>
              <select
                value={activeSession.courseId ?? ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  const nextId = raw === "" ? null : Number(raw);
                  updateActiveSession((session) => ({ ...session, courseId: nextId }));
                }}
              >
                <option value="">请选择课程</option>
                {(variant === "teacher" || variant === "teaching_leader") && <option value="0">全部课程</option>}
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="student-chat-message-list">
          {(variant === "teacher" || variant === "teaching_leader" || variant === "admin" || mode === "qa") ? (
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
                    className={`student-chat-message ${msg.role === "user" ? "from-user" : "from-assistant"}${pendingDeleteMessageIds.has(msg.id) ? " student-chat-message--pending-delete" : ""}`}
                  >
                    <p>{msg.content}</p>
                    {msg.role === "assistant" && msg.payload?.type === "student_learning" && (
                      <TeacherStudentLearningCard
                        messageId={msg.id}
                        payload={msg.payload}
                        onSelectStudent={handleSelectStudentLearning}
                        onTimeRangeChange={handleLearningTimeRangeChange}
                        onRefetchWithTimeRange={handleRefetchLearningTimeRange}
                      />
                    )}
                    <div className="student-chat-message-meta">
                      {msg.role === "assistant" && msg.document_ref && (() => {
                        const noAnswerRef = (msg.document_ref || "").includes("当前问题在知识库中没有参考答案");
                        if (noAnswerRef) {
                          return <span>{msg.document_ref}</span>;
                        }
                        const refDocTitle = msg.reference_doc_title ?? (msg.knowledge_point ?? null);
                        const refDocLabel = refDocTitle ? `${refDocTitle}，${msg.document_ref}` : msg.document_ref;
                        return msg.reference_doc_id ? (
                          <button
                            type="button"
                            className="student-chat-ref-btn"
                            onClick={() => handleOpenReferenceFile(msg)}
                          >
                            {openingReferenceId === msg.id ? "参考文档打开中…" : `参考文档：${refDocLabel}`}
                          </button>
                        ) : (
                          <span>参考文档：{refDocLabel}</span>
                        );
                      })()}
                      {msg.role === "assistant" && msg.knowledge_point && (
                        <span title={msg.knowledge_point}>
                          关联知识点：
                          {msg.knowledge_point.length > KNOWLEDGE_POINT_MAX_DISPLAY_LEN
                            ? `${msg.knowledge_point.slice(0, KNOWLEDGE_POINT_MAX_DISPLAY_LEN)}...`
                            : msg.knowledge_point}
                        </span>
                      )}
                      <div style={{ display: "inline-flex", gap: 4 }}>
                        <button type="button" className="btn-ghost" onClick={() => handleCopyMessage(msg)}>
                          {copiedMessageId === msg.id ? "已复制" : "复制"}
                        </button>
                        {msg.role === "user" && (
                          <button type="button" className="btn-ghost" onClick={() => handleEditQuestion(msg.id)}>
                            编辑
                          </button>
                        )}
                        <button type="button" className="btn-ghost" onClick={() => handleRequestDeleteMessage(msg.id)}>
                          删除
                        </button>
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
              {mode === "feedback" && <Feedback inWorkspace onGoQa={() => setMode("qa")} courseId={activeSession.courseId} />}
              {mode === "learning-data" && <StudentLearningData inWorkspace onGoQa={() => setMode("qa")} courseId={activeSession.courseId} />}
            </div>
          )}
        </div>

        <div className="student-chat-input-wrap">
          {(variant === "teacher" || variant === "teaching_leader" || variant === "admin" || mode === "qa") ? (
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
          <div className={`student-chat-menu-row${variant === "admin" ? " student-chat-menu-row--admin" : ""}`}>
            {variant === "admin" ? (
              adminQuickLinks.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  className="student-chat-menu-btn"
                >
                  {item.label}
                </Link>
              ))
            ) : (variant === "teacher" || variant === "teaching_leader") ? (
              teacherQuickLinks.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  className="student-chat-menu-btn"
                >
                  {item.label}
                </Link>
              ))
            ) : (
              studentMenus.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`student-chat-menu-btn ${mode === item.key ? "is-active" : ""}`}
                  onClick={() => setMode(item.key)}
                >
                  {item.label}
                </button>
              ))
            )}
          </div>
        </div>
      </section>
      {deleteMessageId != null && (
        <div className="student-chat-settings-mask" onClick={handleCancelDeleteMessage}>
          <div className="student-chat-settings-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
            <h3 style={{ marginBottom: 16 }}>是否删除该条问答？</h3>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="btn-ghost" onClick={handleCancelDeleteMessage}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={handleConfirmDeleteMessage}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
      {settingsOpen && (
        <div className="student-chat-settings-mask" onClick={() => setSettingsOpen(false)}>
          <div className="student-chat-settings-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>设置</h3>
            <div className="student-chat-settings-avatar-row">
              <span className="student-chat-user-avatar lg">
                {avatarUrl ? (
                  <img src={avatarUrl} alt="头像" />
                ) : (
                  (user?.display_name || user?.username || "U").slice(0, 1).toUpperCase()
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

            <div className="student-chat-settings-field student-chat-settings-field-row">
              <span className="student-chat-settings-field-label">学号/工号</span>
              <span className="student-chat-settings-field-value">{user?.student_no ?? "—"}</span>
            </div>

            <div className="student-chat-settings-field student-chat-settings-field-row">
              <span className="student-chat-settings-field-label">姓名</span>
              <span className="student-chat-settings-field-value">{user?.display_name ?? "—"}</span>
            </div>

            <div className="student-chat-settings-field">
              <div className="student-chat-settings-field-row">
                <span className="student-chat-settings-field-label">登录用户名</span>
                {user?.role === "admin" ? (
                  <span className="student-chat-settings-field-value">{user?.username}</span>
                ) : user?.username_changed_at != null && user.username_changed_at !== "" ? (
                  <span className="student-chat-settings-field-value">{user?.username}</span>
                ) : (
                  <input
                    type="text"
                    className="student-chat-settings-field-row-input"
                    maxLength={64}
                    value={editUsername}
                    onChange={(e) => setEditUsername(e.target.value)}
                    placeholder="请输入登录用户名"
                  />
                )}
              </div>
              {user?.role === "admin" ? (
                <p className="student-chat-settings-help">管理员不可修改登录用户名</p>
              ) : user?.username_changed_at != null && user.username_changed_at !== "" ? (
                <p className="student-chat-settings-help">登录用户名仅可修改一次，您已修改过，不可再次修改</p>
              ) : (
                <p className="student-chat-settings-help">登录用户名仅可修改一次，请谨慎填写。修改后点击下方「保存资料」生效。</p>
              )}
            </div>

            <button
              type="button"
              className="btn-primary"
              onClick={handleSaveProfile}
              disabled={profileSaving || avatarProcessing}
            >
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
