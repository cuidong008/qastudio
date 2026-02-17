const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000/api";

/** 模型提供商（API Key 返回 ***） */
export type RagProvider = {
  id: string;
  type: string;
  name: string;
  base_url: string;
  api_key: string;
};

/** GET /admin/rag/providers 响应 */
export type RagProvidersResponse = {
  providers: RagProvider[];
  default_llm: string;
  default_embedding: string;
  default_rerank: string;
  default_pdf_parser: string;
  provider_types: { id: string; name: string; need_base_url: boolean }[];
  llm_models_by_type: Record<string, string[]>;
  embedding_models_by_type: Record<string, string[]>;
  pdf_parser_models_by_type: Record<string, string[]>;
  rerank_models_by_type: Record<string, string[]>;
};

/** PUT /admin/rag/providers 请求体 */
export type RagProvidersUpdateBody = {
  providers: { id?: string; type: string; name: string; base_url?: string; api_key?: string }[];
  default_llm: string;
  default_embedding: string;
  default_rerank: string;
  default_pdf_parser: string;
};

/** 后管台 RAG 配置（API Key 等敏感项可能为 ***） */
export type RagConfig = {
  enabled: boolean;
  llm_type: string;
  llm_vllm_base_url: string;
  llm_vllm_model: string;
  llm_vllm_api_key: string;
  llm_qianwen_api_key: string;
  llm_qianwen_model: string;
  llm_zhipu_api_key: string;
  llm_zhipu_model: string;
  llm_zhipu_base_url: string;
  embedding_type: string;
  embedding_dim: number;
  embedding_builtin_model: string;
  embedding_external_api_key: string;
  embedding_external_base_url: string;
  embedding_external_model: string;
  embedding_qianwen_api_key: string;
  embedding_zhipu_api_key: string;
  vector_store_path: string;
  vector_collection_name: string;
  top_k: number;
  chunk_size: number;
  chunk_overlap: number;
  hybrid_enabled: boolean;
  vector_recall_k: number;
  sparse_recall_k: number;
  fused_top_n: number;
  rrf_k: number;
  query_rewrite_enabled: boolean;
  query_rewrite_count: number;
  hyde_enabled: boolean;
  hyde_max_tokens: number;
  hyde_temperature: number;
  rerank_enabled: boolean;
  rerank_top_n: number;
  no_answer_threshold: number;
  llm_max_tokens: number;
  llm_temperature: number;
};

function getToken(): string | null {
  return localStorage.getItem("token");
}

export async function request<T>(
  path: string,
  options: RequestInit & { body?: unknown } = {}
): Promise<T> {
  const { body, ...rest } = options;
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(rest.headers as Record<string, string>),
  };
  const token = getToken();
  if (token) (headers as Record<string, string>)["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers,
    body: body !== undefined ? JSON.stringify(body) : rest.body,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || String(err));
  }
  return res.json();
}

export async function requestForm<T>(
  path: string,
  form: FormData,
  options: RequestInit = {}
): Promise<T> {
  const headers: HeadersInit = {
    ...(options.headers as Record<string, string>),
  };
  const token = getToken();
  if (token) (headers as Record<string, string>)["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || String(err));
  }
  return res.json();
}

export async function requestBlob(
  path: string,
  options: RequestInit = {}
): Promise<Blob> {
  const headers: HeadersInit = {
    ...(options.headers as Record<string, string>),
  };
  const token = getToken();
  if (token) (headers as Record<string, string>)["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || String(err));
  }
  return res.blob();
}

export const api = {
  auth: {
    login: (username: string, password: string) =>
      request<{ access_token: string; role: string }>("/auth/login", { method: "POST", body: { username, password } }),
    me: () => request<{ id: number; username: string; role: string; display_name: string | null; student_no: string | null } | null>("/auth/me"),
  },
  chapters: {
    list: (params?: { course_id?: number }) => {
      const q = new URLSearchParams();
      if (params?.course_id != null) q.set("course_id", String(params.course_id));
      return request<{ id: number; title: string; order_index: number }[]>(`/chapters${q.toString() ? `?${q}` : ""}`);
    },
    get: (id: number) => request<{ id: number; title: string; knowledge_points: { id: number; title: string; ppt_slide_ref: string | null }[] }>(`/chapters/${id}`),
  },
  courses: {
    list: () => request<{ id: number; name: string; code: string | null; is_active: boolean }[]>("/chapters/courses"),
  },
  preview: {
    task: (chapterId: number) => request<{ chapter_id: number; chapter_title: string; summary: string; key_points: string[]; self_check_questions: string[]; duration_minutes: number }>(`/preview/task/${chapterId}`),
    submit: (chapterId: number, weakPoints?: string[]) =>
      request<{ ok: boolean }>("/preview/submit", { method: "POST", body: { chapter_id: chapterId, weak_points: weakPoints } }),
  },
  qa: {
    ask: (question: string, courseId: number) =>
      request<{ answer: string; document_ref: string | null; reference_doc_id?: number | null; reference_page?: number | null; knowledge_point: string | null; in_scope: boolean; question_asked_id?: number | null }>("/qa/ask", { method: "POST", body: { question, course_id: courseId } }),
    reference: (docId: number) =>
      request<{ id: number; title: string; source_type: string; page_ref: string | null; file_name: string | null }>(`/qa/reference/${docId}`),
    referenceFile: (docId: number) =>
      requestBlob(`/qa/reference/${docId}/file`),
  },
  questions: {
    list: (params?: { chapter_id?: number; difficulty?: string }) => {
      const q = new URLSearchParams();
      if (params?.chapter_id) q.set("chapter_id", String(params.chapter_id));
      if (params?.difficulty) q.set("difficulty", params.difficulty);
      return request<{ id: number; chapter_id: number; difficulty: string; question_text: string; options: string | null; explanation: string | null; ppt_ref: string | null }[]>(`/questions?${q}`);
    },
    submit: (questionId: number, userAnswer: string) =>
      request<{ is_correct: boolean; correct_answer: string; explanation: string | null; ppt_ref: string | null }>("/questions/submit", { method: "POST", body: { question_id: questionId, user_answer: userAnswer } }),
    wrong: () => request<{ id: number; question_text: string; options: string | null; explanation: string | null }[]>("/questions/wrong"),
  },
  teacher: {
    stats: (classId?: number) => {
      const q = classId != null ? `?class_id=${classId}` : "";
      return request<{
        preview_completion_rate: number;
        total_questions_asked: number;
        top_asked: { question: string; count: number }[];
        answer_accuracy_rate: number;
        weak_knowledge_points: string[];
      }>(`/teacher/stats/overview${q}`);
    },
    configChapters: () =>
      request<{
        chapter_id: number;
        title: string;
        preview_enabled: boolean;
        difficulty_filter: string[];
        question_limit: number | null;
      }[]>("/teacher/config/chapters"),
    updateChapterConfig: (body: {
      chapter_id: number;
      preview_enabled: boolean;
      difficulty_filter: string[] | null;
      question_limit: number | null;
    }) =>
      request<{ ok: boolean }>("/teacher/config/chapter", {
        method: "PUT",
        body,
      }),
    courses: {
      list: () =>
        request<{ id: number; name: string; code: string | null; description: string | null; is_active: boolean; owner_teacher_id: number | null; created_at: string | null }[]>("/teacher/courses"),
      create: (body: { name: string; code?: string; description?: string; is_active?: boolean }) =>
        request<{ id: number; name: string; code: string | null; description: string | null; is_active: boolean; owner_teacher_id: number | null; created_at: string | null }>("/teacher/courses", { method: "POST", body }),
      update: (id: number, body: { name?: string; code?: string; description?: string; is_active?: boolean }) =>
        request<{ id: number; name: string; code: string | null; description: string | null; is_active: boolean; owner_teacher_id: number | null; created_at: string | null }>(`/teacher/courses/${id}`, { method: "PUT", body }),
      delete: (id: number) => request<{ ok: boolean }>(`/teacher/courses/${id}`, { method: "DELETE" }),
      reindex: (courseId: number) =>
        request<{ ok: boolean; chunks_indexed: number }>(`/teacher/courses/${courseId}/reindex`, { method: "POST" }),
      clearKnowledge: (courseId: number) =>
        request<{ ok: boolean; stats: { knowledge_documents: number; knowledge_points: number; ppt_files: number; ppt_slides: number; deleted_files: number }; chunks_indexed: number }>(
          `/teacher/courses/${courseId}/clear-knowledge`,
          { method: "POST" }
        ),
      chapters: (courseId: number) =>
        request<{ id: number; course_id: number | null; title: string; order_index: number; syllabus_ref: string | null }[]>(`/teacher/courses/${courseId}/chapters`),
      createChapter: (courseId: number, body: { title: string; order_index?: number; syllabus_ref?: string }) =>
        request<{ id: number; course_id: number | null; title: string; order_index: number; syllabus_ref: string | null }>(`/teacher/courses/${courseId}/chapters`, { method: "POST", body }),
      updateChapter: (chapterId: number, body: { title?: string; order_index?: number; syllabus_ref?: string }) =>
        request<{ id: number; course_id: number | null; title: string; order_index: number; syllabus_ref: string | null }>(`/teacher/chapters/${chapterId}`, { method: "PUT", body }),
      deleteChapter: (chapterId: number) => request<{ ok: boolean }>(`/teacher/chapters/${chapterId}`, { method: "DELETE" }),
      chapterDocuments: (chapterId: number) =>
        request<{ id: number; chapter_id: number | null; source_type: string; title: string; page_ref: string | null; file_name: string | null; file_size: number | null; parse_status: string | null; parse_error: string | null; chunk_count: number | null; created_at: string | null }[]>(
          `/teacher/chapters/${chapterId}/documents`
        ),
      uploadChapterDocument: (chapterId: number, file: File) => {
        const form = new FormData();
        form.append("file", file);
        return requestForm<{ id: number; chapter_id: number | null; source_type: string; title: string; page_ref: string | null; file_name: string | null; file_size: number | null; parse_status: string | null; parse_error: string | null; chunk_count: number | null; created_at: string | null }>(
          `/teacher/chapters/${chapterId}/documents/upload`,
          form,
          { method: "POST" }
        );
      },
      documentDetail: (docId: number) =>
        request<{ id: number; chapter_id: number | null; source_type: string; title: string; page_ref: string | null; file_name: string | null; file_size: number | null; parse_status: string | null; parse_error: string | null; chunk_count: number | null; created_at: string | null; content_preview: string; chunks: { index: number; text: string }[] }>(
          `/teacher/documents/${docId}`
        ),
      documentFileUrl: (docId: number) => `${API_BASE}/teacher/documents/${docId}/file`,
    },
    classes: {
      list: () =>
        request<{ id: number; name: string; term: string | null; course_id: number | null; course_name: string | null; owner_teacher_id: number | null; student_count: number; created_at: string | null }[]>("/teacher/classes"),
      create: (body: { name: string; term?: string; course_id: number }) =>
        request<{ id: number; name: string; term: string | null; course_id: number | null; course_name: string | null; owner_teacher_id: number | null; student_count: number; created_at: string | null }>("/teacher/classes", { method: "POST", body }),
      update: (id: number, body: { name?: string; term?: string; course_id?: number }) =>
        request<{ id: number; name: string; term: string | null; course_id: number | null; course_name: string | null; owner_teacher_id: number | null; student_count: number; created_at: string | null }>(`/teacher/classes/${id}`, { method: "PUT", body }),
      delete: (id: number) => request<{ ok: boolean }>(`/teacher/classes/${id}`, { method: "DELETE" }),
      students: (classId: number, params?: { q?: string; student_no?: string; name?: string }) => {
        const q = new URLSearchParams();
        if (params?.q) q.set("q", params.q);
        if (params?.student_no) q.set("student_no", params.student_no);
        if (params?.name) q.set("name", params.name);
        return request<{ id: number; username: string; student_no: string | null; display_name: string | null }[]>(
          `/teacher/classes/${classId}/students${q.toString() ? `?${q}` : ""}`
        );
      },
      assignStudents: (classId: number, body: { student_ids?: number[]; student_no?: string; name?: string }) =>
        request<{ ok: boolean; assigned: number }>(`/teacher/classes/${classId}/students/assign`, { method: "POST", body }),
      removeStudent: (classId: number, studentId: number) =>
        request<{ ok: boolean }>(`/teacher/classes/${classId}/students/${studentId}`, { method: "DELETE" }),
    },
    students: {
      list: (params?: { q?: string; student_no?: string; name?: string }) => {
        const q = new URLSearchParams();
        if (params?.q) q.set("q", params.q);
        if (params?.student_no) q.set("student_no", params.student_no);
        if (params?.name) q.set("name", params.name);
        return request<{ id: number; username: string; student_no: string | null; display_name: string | null }[]>(`/teacher/students?${q}`);
      },
    },
    export: (report: string) => `${API_BASE}/teacher/export/csv?report=${report}`,
  },
  feedback: {
    submit: (content: string, source: "form" | "dialogue" = "form") =>
      request<{ ok: boolean; id?: number; message?: string }>("/feedback", {
        method: "POST",
        body: { content, source },
      }),
    /** 将某次答疑对话记为学习反馈（仅限本人提问记录） */
    submitFromQa: (questionAskedId: number) =>
      request<{ ok: boolean; id?: number }>("/feedback/from-qa", {
        method: "POST",
        body: { question_asked_id: questionAskedId },
      }),
  },
  admin: {
    users: {
      list: (params?: { role?: string; q?: string }) => {
        const q = new URLSearchParams();
        if (params?.role) q.set("role", params.role);
        if (params?.q) q.set("q", params.q);
        return request<{ id: number; username: string; role: string; display_name: string | null; student_no: string | null; created_at: string | null }[]>(`/admin/users?${q}`);
      },
      create: (body: { username: string; password?: string; role: string; display_name?: string; student_no?: string }) =>
        request<{ id: number; username: string; role: string; display_name: string | null; student_no: string | null }>("/admin/users", { method: "POST", body }),
      get: (id: number) => request<{ id: number; username: string; role: string; display_name: string | null; student_no: string | null }>(`/admin/users/${id}`),
      update: (id: number, body: { password?: string; role?: string; display_name?: string; student_no?: string }) =>
        request<{ id: number; username: string; role: string; display_name: string | null; student_no: string | null }>(`/admin/users/${id}`, { method: "PUT", body }),
      delete: (id: number) => request<{ ok: boolean }>(`/admin/users/${id}`, { method: "DELETE" }),
    },
    classes: {
      list: () => request<{ id: number; name: string; term: string | null; created_at: string | null }[]>("/admin/classes"),
      create: (body: { name: string; term?: string }) => request<{ id: number; name: string; term: string | null }>("/admin/classes", { method: "POST", body }),
      get: (id: number) => request<{ id: number; name: string; term: string | null }>(`/admin/classes/${id}`),
      update: (id: number, body: { name?: string; term?: string }) => request<{ id: number; name: string; term: string | null }>(`/admin/classes/${id}`, { method: "PUT", body }),
      delete: (id: number) => request<{ ok: boolean }>(`/admin/classes/${id}`, { method: "DELETE" }),
    },
    courses: {
      list: () => request<{ id: number; name: string; code: string | null; description: string | null; is_active: boolean; created_at: string | null }[]>("/admin/courses"),
      create: (body: { name: string; code?: string; description?: string; is_active?: boolean }) =>
        request<{ id: number; name: string; code: string | null; description: string | null; is_active: boolean }>("/admin/courses", { method: "POST", body }),
      get: (id: number) => request<{ id: number; name: string; code: string | null; description: string | null; is_active: boolean }>(`/admin/courses/${id}`),
      update: (id: number, body: { name?: string; code?: string; description?: string; is_active?: boolean }) =>
        request<{ id: number; name: string; code: string | null; description: string | null; is_active: boolean }>(`/admin/courses/${id}`, { method: "PUT", body }),
      delete: (id: number) => request<{ ok: boolean }>(`/admin/courses/${id}`, { method: "DELETE" }),
      chapters: (courseId: number) =>
        request<{ id: number; course_id: number | null; title: string; order_index: number; syllabus_ref: string | null }[]>(`/admin/courses/${courseId}/chapters`),
      createChapter: (courseId: number, body: { title: string; order_index?: number; syllabus_ref?: string }) =>
        request<{ id: number; course_id: number | null; title: string; order_index: number; syllabus_ref: string | null }>(`/admin/courses/${courseId}/chapters`, { method: "POST", body }),
      updateChapter: (chapterId: number, body: { title?: string; order_index?: number; syllabus_ref?: string }) =>
        request<{ id: number; course_id: number | null; title: string; order_index: number; syllabus_ref: string | null }>(`/admin/chapters/${chapterId}`, { method: "PUT", body }),
      deleteChapter: (chapterId: number) => request<{ ok: boolean }>(`/admin/chapters/${chapterId}`, { method: "DELETE" }),
      reindex: (courseId: number) =>
        request<{ ok: boolean; chunks_indexed: number }>(`/admin/courses/${courseId}/reindex`, { method: "POST" }),
      clearKnowledge: (courseId: number) =>
        request<{ ok: boolean; stats: { knowledge_documents: number; knowledge_points: number; ppt_files: number; ppt_slides: number; deleted_files: number }; chunks_indexed: number }>(
          `/admin/courses/${courseId}/clear-knowledge`,
          { method: "POST" }
        ),
    },
    rag: {
      status: () =>
        request<{ enabled: boolean; llm_type: string; embedding_type: string; top_k: number; chunk_size: number; chunk_overlap: number; config_note?: string }>("/admin/rag/status"),
      config: () =>
        request<RagConfig>("/admin/rag/config"),
      updateConfig: (body: Partial<RagConfig>) =>
        request<RagConfig>("/admin/rag/config", { method: "PUT", body }),
      /** 模型提供商（RAGFlow 风格）：先配提供商，再选默认 LLM/Embedding */
      providers: () =>
        request<RagProvidersResponse>("/admin/rag/providers"),
      updateProviders: (body: RagProvidersUpdateBody) =>
        request<RagProvidersResponse>("/admin/rag/providers", { method: "PUT", body }),
    },
    teachings: {
      list: (params?: { course_id?: number; class_id?: number; teacher_id?: number }) => {
        const q = new URLSearchParams();
        if (params?.course_id != null) q.set("course_id", String(params.course_id));
        if (params?.class_id != null) q.set("class_id", String(params.class_id));
        if (params?.teacher_id != null) q.set("teacher_id", String(params.teacher_id));
        return request<{ id: number; course_id: number; class_id: number; teacher_id: number; term: string | null; is_active: boolean; course_name: string | null; class_name: string | null; teacher_name: string | null }[]>(`/admin/teachings?${q}`);
      },
      create: (body: { course_id: number; class_id: number; teacher_id: number; term?: string; is_active?: boolean }) =>
        request<{ id: number; course_id: number; class_id: number; teacher_id: number; term: string | null; is_active: boolean; course_name: string | null; class_name: string | null; teacher_name: string | null }>("/admin/teachings", { method: "POST", body }),
      createBatch: (body: { course_id: number; teacher_id: number; class_ids: number[]; term?: string; is_active?: boolean }) =>
        request<{ created: { id: number; course_id: number; class_id: number; teacher_id: number; term: string | null; is_active: boolean; course_name: string | null; class_name: string | null; teacher_name: string | null }[]; skipped: { class_id: number; class_name?: string; reason: string }[] }>("/admin/teachings/batch", { method: "POST", body }),
      update: (id: number, body: { teacher_id?: number; term?: string; is_active?: boolean }) =>
        request<{ id: number; course_id: number; class_id: number; teacher_id: number; term: string | null; is_active: boolean; course_name: string | null; class_name: string | null; teacher_name: string | null }>(`/admin/teachings/${id}`, { method: "PUT", body }),
      delete: (id: number) => request<{ ok: boolean }>(`/admin/teachings/${id}`, { method: "DELETE" }),
    },
  },
};

export function setToken(token: string) {
  localStorage.setItem("token", token);
}
export function clearToken() {
  localStorage.removeItem("token");
}
