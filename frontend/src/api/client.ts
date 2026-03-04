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
  default_tts: string;
  provider_types: { id: string; name: string; need_base_url: boolean }[];
  llm_models_by_type: Record<string, string[]>;
  embedding_models_by_type: Record<string, string[]>;
  pdf_parser_models_by_type: Record<string, string[]>;
  rerank_models_by_type: Record<string, string[]>;
  tts_models_by_type: Record<string, string[]>;
};

/** PUT /admin/rag/providers 请求体 */
export type RagProvidersUpdateBody = {
  providers: { id?: string; type: string; name: string; base_url?: string; api_key?: string }[];
  default_llm: string;
  default_embedding: string;
  default_rerank: string;
  default_pdf_parser: string;
  default_tts: string;
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

/** 教师端文档（含 course_id、chapter_ids） */
export type DocWithChapters = {
  id: number;
  chapter_id: number | null;
  course_id?: number | null;
  source_type: string;
  title: string;
  page_ref: string | null;
  file_name: string | null;
  file_size: number | null;
  parse_status: string | null;
  parse_error: string | null;
  chunk_count: number | null;
  student_visible: boolean;
  downloadable: boolean;
  chapter_ids?: number[];
  created_at: string | null;
};

type JsonRequestOptions = Omit<RequestInit, "body"> & { body?: unknown };

export async function request<T>(
  path: string,
  options: JsonRequestOptions = {}
): Promise<T> {
  const { body, ...rest } = options;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(rest.headers as Record<string, string>),
  };
  const token = getToken();
  if (token) (headers as Record<string, string>)["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers,
    body: payload,
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
    me: () =>
      request<{
        id: number;
        username: string;
        role: string;
        display_name: string | null;
        student_no: string | null;
        avatar_url: string | null;
        username_changed_at: string | null;
      } | null>("/auth/me"),
    updateProfile: (body: {
      display_name?: string | null;
      avatar_url?: string | null;
      username?: string | null;
    }) =>
      request<{
        id: number;
        username: string;
        role: string;
        display_name: string | null;
        student_no: string | null;
        avatar_url: string | null;
        username_changed_at: string | null;
      }>("/auth/profile", { method: "PUT", body }),
    changePassword: (body: { current_password: string; new_password: string }) =>
      request<{ ok: boolean }>("/auth/password", { method: "POST", body }),
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
    task: (chapterId: number) =>
      request<{
        chapter_id: number;
        chapter_title: string;
        summary: string;
        learning_goals: string[];
        materials: { pdf_ready: boolean; pdf_count: number; video_ready: boolean; video_url: string | null };
        pdf_materials: { id: number; title: string; file_name: string | null }[];
        video_materials: { id: number; title: string; file_name: string | null }[];
        preview_questions: { id: number; question_type: string | null; question_text: string; options: string | null }[];
        duration_minutes: number;
      }>(`/preview/task/${chapterId}`),
    materialFile: (materialId: number) => requestBlob(`/preview/materials/${materialId}/file`),
    submit: (chapterId: number, weakPoints?: string[]) =>
      request<{ ok: boolean }>("/preview/submit", { method: "POST", body: { chapter_id: chapterId, weak_points: weakPoints } }),
  },
  review: {
    task: (chapterId: number) =>
      request<{
        chapter_id: number;
        chapter_title: string;
        key_points: string[];
        recall_card_rule: string;
        basic_questions: { id: number; question_type: string | null; difficulty: string; question_text: string; options: string | null }[];
        variant_questions: { id: number; question_type: string | null; difficulty: string; question_text: string; options: string | null }[];
        comprehensive_question: { id: number; question_type: string | null; difficulty: string; question_text: string; options: string | null } | null;
      }>(`/review/task/${chapterId}`),
    submitRecall: (chapterId: number, recallPoints: string[]) =>
      request<{
        ok: boolean;
        message: string;
        reference_points: string[];
        results: { is_correct: boolean | null; reason: string | null }[];
      }>("/review/recall", {
        method: "POST",
        body: { chapter_id: chapterId, recall_points: recallPoints },
      }),
  },
  qa: {
    ask: (question: string, courseId: number | null) =>
      request<{ answer: string; document_ref: string | null; reference_doc_id?: number | null; reference_page?: number | null; reference_doc_title?: string | null; knowledge_point: string | null; in_scope: boolean; question_asked_id?: number | null }>("/qa/ask", { method: "POST", body: { question, course_id: courseId } }),
    reference: (docId: number) =>
      request<{ id: number; title: string; source_type: string; page_ref: string | null; file_name: string | null }>(`/qa/reference/${docId}`),
    referenceFile: (docId: number) =>
      requestBlob(`/qa/reference/${docId}/file`),
  },
  questions: {
    list: (params?: { chapter_id?: number; difficulty?: string; question_types?: string; limit?: number }) => {
      const q = new URLSearchParams();
      if (params?.chapter_id) q.set("chapter_id", String(params.chapter_id));
      if (params?.difficulty) q.set("difficulty", params.difficulty);
      if (params?.question_types) q.set("question_types", params.question_types);
      if (params?.limit != null) q.set("limit", String(params.limit));
      return request<{ id: number; chapter_id: number; difficulty: string; question_type: string | null; question_text: string; options: string | null; explanation: string | null; ppt_ref: string | null }[]>(
        `/questions?${q}`
      );
    },
    submit: (questionId: number, userAnswer: string, scene: "preview" | "review" | "exercise" = "exercise") =>
      request<{
        answer_record_id: number;
        is_correct: boolean;
        correct_answer: string;
        question_type: string;
        explanation: string | null;
        ppt_ref: string | null;
        grading_source?: string | null;
        grading_confidence?: number | null;
        grading_reason?: string | null;
      }>(
        "/questions/submit",
        { method: "POST", body: { question_id: questionId, user_answer: userAnswer, scene } }
      ),
    wrong: () => request<{ id: number; question_text: string; options: string | null; explanation: string | null }[]>("/questions/wrong"),
    markWrongReason: (recordId: number, wrongReason: "concept" | "reading" | "calculation") =>
      request<{ ok: boolean }>(`/questions/answer-records/${recordId}/wrong-reason`, {
        method: "POST",
        body: { wrong_reason: wrongReason },
      }),
    similar: (questionId: number, limit = 2) =>
      request<{ id: number; chapter_id: number; difficulty: string; question_type: string | null; question_text: string; options: string | null; explanation: string | null }[]>(
        `/questions/${questionId}/similar?limit=${limit}`
      ),
  },
  teacher: {
    stats: (params?: { classId?: number; courseId?: number; chapterId?: number; startDate?: string; endDate?: string }) => {
      const qs = new URLSearchParams();
      if (params?.classId != null) qs.set("class_id", String(params.classId));
      if (params?.courseId != null) qs.set("course_id", String(params.courseId));
      if (params?.chapterId != null) qs.set("chapter_id", String(params.chapterId));
      if (params?.startDate) qs.set("start_date", params.startDate);
      if (params?.endDate) qs.set("end_date", params.endDate);
      const q = qs.toString() ? `?${qs.toString()}` : "";
      return request<{
        preview_completion_rate: number;
        preview_student_count?: number;
        completed_question_count?: number;
        feedback_question_count?: number;
        top_asked: { question: string; count: number; course_id?: number | null }[];
        answer_accuracy_rate: number;
        ai_ask_count?: number;
        ai_irrelevant_count?: number;
        weak_knowledge_points: string[];
        weak_knowledge_point_course_ids?: (number | null)[];
        weak_knowledge_point_wrong_counts?: number[];
      }>(`/teacher/stats/overview${q}`);
    },
    /** 学情课程统计详细表：按课程+学生维度，班级名称来自教师管理且关联该课程的班级 */
    statsByCourseStudent: (params?: { courseId?: number; classId?: number; studentId?: number; startDate?: string; endDate?: string }) => {
      const qs = new URLSearchParams();
      if (params?.courseId != null) qs.set("course_id", String(params.courseId));
      if (params?.classId != null) qs.set("class_id", String(params.classId));
      if (params?.studentId != null) qs.set("student_id", String(params.studentId));
      if (params?.startDate) qs.set("start_date", params.startDate);
      if (params?.endDate) qs.set("end_date", params.endDate);
      const q = qs.toString() ? `?${qs.toString()}` : "";
      return request<{
        course_id: number;
        course_name: string;
        student_id: number;
        student_no: string;
        student_name: string;
        class_name: string;
        preview_rate: string;
        preview_completed_chapter_ids: number[];
        completed_question_count: number;
        completed_question_count_by_chapter?: { chapter_id: number; count: number }[];
        correct_question_count_by_chapter?: { chapter_id: number; count: number }[];
        accuracy_rate: string;
        feedback_question_count: number;
        ai_ask_count: number;
        ai_irrelevant_count: number;
        weak_knowledge_points: string;
        weak_knowledge_points_by_chapter?: { chapter_id: number; weak_knowledge_points: string }[];
      }[]>(`/teacher/stats/by-course-student${q}`);
    },
    feedbackList: (params?: { courseId?: number; classId?: number }) => {
      const qs = new URLSearchParams();
      if (params?.courseId != null) qs.set("course_id", String(params.courseId));
      if (params?.classId != null) qs.set("class_id", String(params.classId));
      const q = qs.toString() ? `?${qs.toString()}` : "";
      return request<{
        id: number;
        course_name: string;
        feedback_text: string;
        student_no: string;
        student_name: string;
        class_name: string;
        created_at: string;
        reply_text: string;
        status: string;
        processed_at: string | null;
      }[]>(`/teacher/feedback/list${q}`);
    },
    getFeedback: (id: number) =>
      request<{
        id: number;
        course_name: string;
        feedback_text: string;
        student_no: string;
        student_name: string;
        class_name: string;
        created_at: string;
        reply_text: string | null;
        status: string | null;
        processed_at: string | null;
      }>(`/teacher/feedback/${id}`),
    updateFeedback: (id: number, body: { reply_text?: string | null; status?: string | null }) =>
      request<{
        id: number;
        course_name: string;
        feedback_text: string;
        student_no: string;
        student_name: string;
        class_name: string;
        created_at: string;
        reply_text: string | null;
        status: string | null;
        processed_at: string | null;
      }>(`/teacher/feedback/${id}`, { method: "PUT", body }),
    getPaperGenerateDefaults: () =>
      request<{ type: string; count: number; difficulty: string; score: number }[]>("/teacher/config/paper-generate-defaults"),
    getExerciseGenerateDefaults: () =>
      request<{ type: string; max: number; difficulty: string }[]>("/teacher/config/exercise-generate-defaults"),
    configChapters: () =>
      request<{
        chapter_id: number;
        title: string;
        preview_enabled: boolean;
        preview_video_url: string | null;
        difficulty_filter: string[];
        question_limit: number | null;
      }[]>("/teacher/config/chapters"),
    updateChapterConfig: (body: {
      chapter_id: number;
      preview_enabled: boolean;
      preview_video_url?: string | null;
      difficulty_filter: string[] | null;
      question_limit: number | null;
    }) =>
      request<{ ok: boolean }>("/teacher/config/chapter", {
        method: "PUT",
        body,
      }),
    courses: {
      list: () =>
        request<{ id: number; name: string; code: string | null; description: string | null; remark: string | null; is_active: boolean; owner_teacher_id: number | null; created_at: string | null }[]>("/teacher/courses"),
      create: (body: { name: string; code?: string; description?: string; remark?: string; is_active?: boolean }) =>
        request<{ id: number; name: string; code: string | null; description: string | null; remark: string | null; is_active: boolean; owner_teacher_id: number | null; created_at: string | null }>("/teacher/courses", { method: "POST", body }),
      update: (id: number, body: { name?: string; code?: string; description?: string; remark?: string; is_active?: boolean }) =>
        request<{ id: number; name: string; code: string | null; description: string | null; remark: string | null; is_active: boolean; owner_teacher_id: number | null; created_at: string | null }>(`/teacher/courses/${id}`, { method: "PUT", body }),
      delete: (id: number) => request<{ ok: boolean }>(`/teacher/courses/${id}`, { method: "DELETE" }),
      reindex: (courseId: number) =>
        request<{ ok: boolean; task_id: number; status: string }>(`/teacher/courses/${courseId}/reindex`, { method: "POST" }),
      getReindexTask: (taskId: number) =>
        request<{
          id: number;
          course_id: number;
          status: string;
          request_payload: Record<string, unknown>;
          result_payload: { chunks_indexed: number } | null;
          error_message: string | null;
          created_at: string | null;
          updated_at: string | null;
        }>(`/teacher/courses/reindex/tasks/${taskId}`),
      listActiveReindexTasks: () =>
        request<{
          task_id: number;
          course_id: number;
          status: string;
          updated_at: string | null;
        }[]>("/teacher/courses/reindex/active"),
      clearKnowledge: (courseId: number) =>
        request<{ ok: boolean; stats: { knowledge_documents: number; knowledge_points: number; ppt_files: number; ppt_slides: number; deleted_files: number }; chunks_indexed: number }>(
          `/teacher/courses/${courseId}/clear-knowledge`,
          { method: "POST" }
        ),
      chapters: (courseId: number) =>
        request<{ id: number; course_id: number | null; title: string; order_index: number; syllabus_ref: string | null; question_count: number }[]>(`/teacher/courses/${courseId}/chapters`),
      createChapter: (courseId: number, body: { title: string; order_index?: number; syllabus_ref?: string }) =>
        request<{ id: number; course_id: number | null; title: string; order_index: number; syllabus_ref: string | null }>(`/teacher/courses/${courseId}/chapters`, { method: "POST", body }),
      updateChapter: (chapterId: number, body: { title?: string; order_index?: number; syllabus_ref?: string }) =>
        request<{ id: number; course_id: number | null; title: string; order_index: number; syllabus_ref: string | null }>(`/teacher/chapters/${chapterId}`, { method: "PUT", body }),
      chapterKnowledgePoints: (chapterId: number) =>
        request<{ id: number; chapter_id: number; title: string; content: string | null; ppt_slide_ref: string | null; order_index: number }[]>(
          `/teacher/chapters/${chapterId}/knowledge-points`
        ),
      generateChapterKnowledgePoints: (chapterId: number, count: number) =>
        request<{ title: string; content: string | null; ppt_slide_ref: string | null; order_index?: number | null }[]>(
          `/teacher/chapters/${chapterId}/knowledge-points/generate`,
          { method: "POST", body: { count } }
        ),
      saveChapterKnowledgePoints: (
        chapterId: number,
        body: { knowledge_points: { title: string; content?: string | null; ppt_slide_ref?: string | null; order_index?: number | null }[] }
      ) =>
        request<{ id: number; chapter_id: number; title: string; content: string | null; ppt_slide_ref: string | null; order_index: number }[]>(
          `/teacher/chapters/${chapterId}/knowledge-points`,
          { method: "PUT", body }
        ),
      deleteChapter: (chapterId: number) => request<{ ok: boolean }>(`/teacher/chapters/${chapterId}`, { method: "DELETE" }),
      generateChapterQuestions: (
        chapterId: number,
        body: {
          single_choice_max: number;
          multiple_choice_max: number;
          judge_max: number;
          qa_max: number;
          blank_max: number;
          question_bank_type: "training" | "exam";
          single_choice_difficulty_score: number;
          multiple_choice_difficulty_score: number;
          judge_difficulty_score: number;
          qa_difficulty_score: number;
          blank_difficulty_score: number;
          knowledge_point_ids?: number[];
        }
      ) =>
        request<{ ok: boolean; task_id: number; status: string }>(
          `/teacher/chapters/${chapterId}/questions/generate`,
          { method: "POST", body }
        ),
      generatePaper: (
        body: {
          course_id: number;
          chapter_ids: number[];
          paper_title: string;
          paper_bank_type: "training" | "formal";
          question_source: "local" | "internet";
          overall_difficulty?: number | null;
          configs: { type: string; count: number; difficulty?: number | null; score: number }[];
          save_to_bank: boolean;
        }
      ) =>
        request<{
          ok: boolean;
          paper_id: number | null;
          status: string;
          is_partial: boolean;
          message: string;
          insufficient_types: { question_type: string; requested: number; available: number; missing: number }[];
          preview_questions: {
            question_type: string;
            question_text: string;
            options: string[];
            correct_answer: string;
            explanation: string | null;
            difficulty_score: number;
            score: number;
            source: "local" | "internet";
          }[];
          total_score: number;
          overall_difficulty: number;
        }>("/teacher/papers/generate", { method: "POST", body }),
      listPapers: (params?: {
        courseId?: number;
        chapterIds?: number[];
        titleKw?: string;
        difficultyMin?: number;
        difficultyMax?: number;
        reviewStatus?: "pending" | "reviewed" | "";
        paperBankType?: "training" | "formal" | "";
        status?: "generated" | "partial" | "failed" | "";
      }) => {
        const qs = new URLSearchParams();
        if (params?.courseId != null && params.courseId > 0) qs.set("course_id", String(params.courseId));
        if ((params?.chapterIds || []).length) {
          for (const id of params?.chapterIds || []) {
            if (id > 0) qs.append("chapter_ids", String(id));
          }
        }
        if ((params?.titleKw || "").trim()) qs.set("title_kw", (params?.titleKw || "").trim());
        if (params?.difficultyMin != null) qs.set("difficulty_min", String(params.difficultyMin));
        if (params?.difficultyMax != null) qs.set("difficulty_max", String(params.difficultyMax));
        if (params?.reviewStatus) qs.set("review_status", params.reviewStatus);
        if (params?.paperBankType) qs.set("paper_bank_type", params.paperBankType);
        if (params?.status) qs.set("status", params.status);
        const q = qs.toString() ? `?${qs.toString()}` : "";
        return request<{
          id: number;
          course_id: number;
          course_name: string;
          title: string;
          paper_bank_type: "training" | "formal";
          question_source: "local" | "internet";
          status: "pending" | "reviewed";
          review_status: "pending" | "reviewed";
          is_partial: boolean;
          total_score: number;
          overall_difficulty: number;
          chapter_ids: number[];
          created_at: string | null;
          updated_at: string | null;
        }[]>(`/teacher/papers${q}`);
      },
      listPapersPaged: (params?: {
        courseId?: number;
        chapterIds?: number[];
        titleKw?: string;
        difficultyMin?: number;
        difficultyMax?: number;
        reviewStatus?: "pending" | "reviewed" | "";
        paperBankType?: "training" | "formal" | "";
        status?: "pending" | "reviewed" | "";
        page?: number;
        pageSize?: number;
      }) => {
        const qs = new URLSearchParams();
        if (params?.courseId != null && params.courseId > 0) qs.set("course_id", String(params.courseId));
        if ((params?.chapterIds || []).length) {
          for (const id of params?.chapterIds || []) {
            if (id > 0) qs.append("chapter_ids", String(id));
          }
        }
        if ((params?.titleKw || "").trim()) qs.set("title_kw", (params?.titleKw || "").trim());
        if (params?.difficultyMin != null) qs.set("difficulty_min", String(params.difficultyMin));
        if (params?.difficultyMax != null) qs.set("difficulty_max", String(params.difficultyMax));
        if (params?.reviewStatus) qs.set("review_status", params.reviewStatus);
        if (params?.paperBankType) qs.set("paper_bank_type", params.paperBankType);
        if (params?.status) qs.set("status", params.status);
        if (params?.page) qs.set("page", String(params.page));
        if (params?.pageSize) qs.set("page_size", String(params.pageSize));
        const q = qs.toString() ? `?${qs.toString()}` : "";
        return request<{
          items: {
            id: number;
            course_id: number;
            course_name: string;
            title: string;
            paper_type: "electronic" | "file";
            paper_bank_type: "training" | "formal";
            question_source: "local" | "internet";
            status: "pending" | "reviewed";
            review_status: "pending" | "reviewed";
            is_partial: boolean;
            total_score: number;
            overall_difficulty: number;
            chapter_ids: number[];
            created_at: string | null;
            updated_at: string | null;
          }[];
          total: number;
          page: number;
          page_size: number;
        }>(`/teacher/papers/paged${q}`);
      },
      batchDeletePapers: (paperIds: number[]) =>
        request<{ ok: boolean; deleted: number }>("/teacher/papers/batch-delete", { method: "POST", body: { paper_ids: paperIds } }),
      exportPapersCsv: (params?: {
        courseId?: number;
        chapterIds?: number[];
        titleKw?: string;
        difficultyMin?: number;
        difficultyMax?: number;
        reviewStatus?: "pending" | "reviewed" | "";
        paperBankType?: "training" | "formal" | "";
        status?: "pending" | "reviewed" | "";
      }) => {
        const qs = new URLSearchParams();
        if (params?.courseId != null && params.courseId > 0) qs.set("course_id", String(params.courseId));
        if ((params?.chapterIds || []).length) {
          for (const id of params?.chapterIds || []) {
            if (id > 0) qs.append("chapter_ids", String(id));
          }
        }
        if ((params?.titleKw || "").trim()) qs.set("title_kw", (params?.titleKw || "").trim());
        if (params?.difficultyMin != null) qs.set("difficulty_min", String(params.difficultyMin));
        if (params?.difficultyMax != null) qs.set("difficulty_max", String(params.difficultyMax));
        if (params?.reviewStatus) qs.set("review_status", params.reviewStatus);
        if (params?.paperBankType) qs.set("paper_bank_type", params.paperBankType);
        if (params?.status) qs.set("status", params.status);
        const q = qs.toString() ? `?${qs.toString()}` : "";
        return requestBlob(`/teacher/papers/export/csv${q}`);
      },
      paperDetail: (paperId: number) =>
        request<{
          id: number;
          course_id: number;
          course_name: string;
          title: string;
          paper_type: "electronic" | "file";
          paper_bank_type: "training" | "formal";
          question_source: "local" | "internet";
          status: "pending" | "reviewed";
          review_status: "pending" | "reviewed";
          is_partial: boolean;
          total_score: number;
          overall_difficulty: number;
          chapter_ids: number[];
          request_payload: Record<string, unknown>;
          content_payload: {
            preview_questions?: {
              question_type: string;
              question_text: string;
              options: string[];
              correct_answer: string;
              explanation: string | null;
              difficulty_score: number;
              score: number;
              source: "local" | "internet";
            }[];
            insufficient_types?: { question_type: string; requested: number; available: number; missing: number }[];
          } | null;
          error_message: string | null;
          created_at: string | null;
          updated_at: string | null;
        }>(`/teacher/papers/${paperId}`),
      listPaperFiles: (paperId: number) =>
        request<{ id: number; paper_id: number; file_name: string; created_at: string | null }[]>(
          `/teacher/papers/${paperId}/files`
        ),
      uploadPaperFile: (paperId: number, file: File) => {
        const form = new FormData();
        form.append("file", file);
        return request<{ id: number; paper_id: number; file_name: string; created_at: string | null }>(
          `/teacher/papers/${paperId}/files`,
          { method: "POST", body: form }
        );
      },
      downloadPaperFile: (paperId: number, fileId: number) =>
        requestBlob(`/teacher/papers/${paperId}/files/${fileId}/download`),
      deletePaperFile: (paperId: number, fileId: number) =>
        request<{ ok: boolean }>(`/teacher/papers/${paperId}/files/${fileId}`, { method: "DELETE" }),
      importPaper: (params: {
        courseId: number;
        title: string;
        paperBankType: "training" | "formal";
        chapterIds?: number[];
        files: File[];
      }) => {
        const form = new FormData();
        form.append("course_id", String(params.courseId));
        form.append("title", params.title);
        form.append("paper_bank_type", params.paperBankType);
        form.append("chapter_ids", JSON.stringify(params.chapterIds ?? []));
        for (const f of params.files) form.append("files", f);
        return requestForm<{ paper_id: number; file_count: number }>("/teacher/papers/import", form, { method: "POST" });
      },
      updatePaper: (
        paperId: number,
        body: {
          title?: string;
          status?: "pending" | "reviewed";
          paper_bank_type?: "training" | "formal";
          question_source?: "local" | "internet";
          total_score?: number;
          overall_difficulty?: number;
          request_payload?: Record<string, unknown>;
          content_payload?: Record<string, unknown>;
          error_message?: string | null;
        }
      ) =>
        request<{
          id: number;
          course_id: number;
          course_name: string;
          title: string;
          paper_type: "electronic" | "file";
          paper_bank_type: "training" | "formal";
          question_source: "local" | "internet";
          status: "pending" | "reviewed";
          review_status: "pending" | "reviewed";
          is_partial: boolean;
          total_score: number;
          overall_difficulty: number;
          chapter_ids: number[];
          request_payload: Record<string, unknown>;
          content_payload: {
            preview_questions?: {
              question_type: string;
              question_text: string;
              options: string[];
              correct_answer: string;
              explanation: string | null;
              difficulty_score: number;
              score: number;
              source: "local" | "internet";
            }[];
            insufficient_types?: { question_type: string; requested: number; available: number; missing: number }[];
          } | null;
          error_message: string | null;
          created_at: string | null;
          updated_at: string | null;
        }>(`/teacher/papers/${paperId}`, { method: "PUT", body }),
      getQuestionTask: (taskId: number) =>
        request<{
          id: number;
          course_id: number;
          chapter_id: number;
          status: string;
          request_payload: Record<string, unknown>;
          result_payload: { created: number; by_type: { single_choice: number; multiple_choice: number; judge: number; qa: number; blank: number }; skipped: number } | null;
          error_message: string | null;
          created_at: string | null;
          updated_at: string | null;
        }>(`/teacher/questions/tasks/${taskId}`),
      listActiveQuestionTasks: () =>
        request<{
          task_id: number;
          course_id: number;
          chapter_id: number;
          status: string;
          updated_at: string | null;
        }[]>("/teacher/questions/active-tasks"),
      chapterQuestions: (chapterId: number, params?: { knowledgePointId?: number }) => {
        const qs = new URLSearchParams();
        if (params?.knowledgePointId != null) qs.set("knowledge_point_id", String(params.knowledgePointId));
        const q = qs.toString() ? `?${qs.toString()}` : "";
        return request<{
          id: number;
          course_id: number | null;
          course_name: string | null;
          chapter_id: number;
          chapter_title: string;
          question_type: string;
          question_bank_type: string;
          difficulty: string;
          difficulty_score: number;
          question_text: string;
          options: string | null;
          correct_answer: string;
          explanation: string | null;
          remark: string | null;
          is_approved: boolean;
          generated_time: string | null;
          edited_time: string | null;
          knowledge_point_ids: string | null;
          knowledge_points: string[];
          created_at: string | null;
        }[]>(`/teacher/chapters/${chapterId}/questions${q}`);
      },
      importQuestionsPreview: (form: FormData) =>
        requestForm<{
          course_id: number;
          chapter_ids: number[];
          question_bank_type: string;
          parsed_count: number;
          items: {
            chapter_id: number | null;
            chapter_title: string | null;
            question_type: string;
            question_text: string;
            options: string[];
            correct_answer: string;
            explanation: string | null;
            difficulty_score: number | null;
          }[];
        }>("/teacher/questions/import/preview", form, { method: "POST" }),
      importQuestionsConfirm: (body: {
        course_id: number;
        question_bank_type: string;
        items: {
          chapter_id: number;
          question_type: string;
          question_text: string;
          options: string[];
          correct_answer: string;
          explanation: string | null;
          difficulty_score: number | null;
        }[];
      }) =>
        request<{ imported_count: number; message: string }>("/teacher/questions/import/confirm", {
          method: "POST",
          body,
        }),
      updateQuestion: (
        questionId: number,
        body: {
          difficulty?: string;
          question_bank_type?: "training" | "exam";
          difficulty_score?: number;
          question_text?: string;
          options?: string[] | null;
          correct_answer?: string;
          explanation?: string | null;
          remark?: string | null;
          is_approved?: boolean;
          knowledge_point_ids?: number[];
        }
      ) =>
        request<{
          id: number;
          course_id: number | null;
          course_name: string | null;
          chapter_id: number;
          chapter_title: string;
          question_type: string;
          question_bank_type: string;
          difficulty: string;
          difficulty_score: number;
          question_text: string;
          options: string | null;
          correct_answer: string;
          explanation: string | null;
          remark: string | null;
          is_approved: boolean;
          generated_time: string | null;
          edited_time: string | null;
          knowledge_point_ids: string | null;
          knowledge_points: string[];
          created_at: string | null;
        }>(`/teacher/questions/${questionId}`, { method: "PUT", body }),
      deleteQuestion: (questionId: number) => request<{ ok: boolean }>(`/teacher/questions/${questionId}`, { method: "DELETE" }),
      /** 文档列表项（含关联章节 id 列表） */
      chapterDocuments: (chapterId: number) =>
        request<DocWithChapters[]>(`/teacher/chapters/${chapterId}/documents`),
      courseDocuments: (courseId: number) =>
        request<DocWithChapters[]>(`/teacher/courses/${courseId}/documents`),
      uploadChapterDocument: (chapterId: number, file: File) => {
        const form = new FormData();
        form.append("file", file);
        return requestForm<DocWithChapters>(`/teacher/chapters/${chapterId}/documents/upload`, form, { method: "POST" });
      },
      uploadChapterVideo: (chapterId: number, file: File) => {
        const form = new FormData();
        form.append("file", file);
        return requestForm<DocWithChapters>(`/teacher/chapters/${chapterId}/videos/upload`, form, { method: "POST" });
      },
      uploadCourseDocument: (courseId: number, file: File, chapterIds: number[]) => {
        const form = new FormData();
        form.append("file", file);
        form.append("chapter_ids_json", JSON.stringify(chapterIds));
        return requestForm<DocWithChapters>(`/teacher/courses/${courseId}/documents/upload`, form, { method: "POST" });
      },
      uploadCourseVideo: (courseId: number, file: File, chapterIds: number[]) => {
        const form = new FormData();
        form.append("file", file);
        form.append("chapter_ids_json", JSON.stringify(chapterIds));
        return requestForm<DocWithChapters>(`/teacher/courses/${courseId}/videos/upload`, form, { method: "POST" });
      },
      documentDetail: (docId: number) =>
        request<DocWithChapters & { content_preview: string; chunks: { index: number; text: string }[] }>(
          `/teacher/documents/${docId}`
        ),
      patchDocument: (docId: number, body: { student_visible?: boolean; downloadable?: boolean; chapter_ids?: number[] }) =>
        request<DocWithChapters>(`/teacher/documents/${docId}`, { method: "PATCH", body }),
      deleteDocument: (docId: number) => request<{ ok: boolean }>(`/teacher/documents/${docId}`, { method: "DELETE" }),
      reprocessDocument: (docId: number) =>
        request<{ ok: boolean; task_id: number; status: string }>(
          `/teacher/documents/${docId}/reprocess`,
          { method: "POST" }
        ),
      getDocumentProcessTask: (taskId: number) =>
        request<{
          id: number;
          course_id: number;
          chapter_id: number;
          doc_id: number;
          status: string;
          request_payload: Record<string, unknown>;
          result_payload: { doc_id: number; parse_status: string; chunk_count: number | null } | null;
          error_message: string | null;
          created_at: string | null;
          updated_at: string | null;
        }>(`/teacher/documents/tasks/${taskId}`),
      cancelDocumentProcessTask: (taskId: number) =>
        request<{
          id: number;
          course_id: number;
          chapter_id: number;
          doc_id: number;
          status: string;
          error_message: string | null;
          created_at: string | null;
          updated_at: string | null;
        }>(`/teacher/documents/tasks/${taskId}/cancel`, { method: "POST" }),
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
      students: (classId: number, params?: { q?: string; student_no?: string; name?: string; admin_class_or_dept?: string }) => {
        const q = new URLSearchParams();
        if (params?.q) q.set("q", params.q);
        if (params?.student_no) q.set("student_no", params.student_no);
        if (params?.name) q.set("name", params.name);
        if (params?.admin_class_or_dept) q.set("admin_class_or_dept", params.admin_class_or_dept);
        return request<{ id: number; username: string; student_no: string | null; display_name: string | null; admin_class_or_dept: string | null }[]>(
          `/teacher/classes/${classId}/students${q.toString() ? `?${q}` : ""}`
        );
      },
      assignStudents: (classId: number, body: { student_ids?: number[]; student_no?: string; name?: string }) =>
        request<{ ok: boolean; assigned: number }>(`/teacher/classes/${classId}/students/assign`, { method: "POST", body }),
      removeStudent: (classId: number, studentId: number) =>
        request<{ ok: boolean }>(`/teacher/classes/${classId}/students/${studentId}`, { method: "DELETE" }),
      /** 下载批量导入学生模版（CSV，表头：学号，姓名） */
      downloadStudentImportTemplate: () => requestBlob("/teacher/classes/students/import-template"),
      /** 批量导入学生：上传填好的模版文件，按学号匹配用户表 */
      importStudents: (classId: number, file: File) => {
        const form = new FormData();
        form.append("file", file);
        return requestForm<{ ok: boolean; imported: number; skipped: number; not_found: string[]; message: string }>(
          `/teacher/classes/${classId}/students/import`,
          form,
          { method: "POST" }
        );
      },
    },
    students: {
      list: (params?: { q?: string; student_no?: string; name?: string; admin_class_or_dept?: string }) => {
        const q = new URLSearchParams();
        if (params?.q) q.set("q", params.q);
        if (params?.student_no) q.set("student_no", params.student_no);
        if (params?.name) q.set("name", params.name);
        if (params?.admin_class_or_dept) q.set("admin_class_or_dept", params.admin_class_or_dept);
        return request<{ id: number; username: string; student_no: string | null; display_name: string | null; admin_class_or_dept: string | null }[]>(`/teacher/students?${q}`);
      },
      listAdminClasses: () => request<string[]>("/teacher/students/admin-classes"),
    },
    export: (report: string) => `${API_BASE}/teacher/export/csv?report=${report}`,
    pipeline: {
      listPdfDocs: () => {
        return request<
          {
            id: number;
            chapter_id: number | null;
            chapter_title: string | null;
            course_id: number | null;
            course_name: string | null;
            title: string;
            file_name: string | null;
            parse_status: string | null;
            created_at: string | null;
            workflow_id: string;
          }[]
        >(`/teacher/pipeline/pdf-docs`);
      },
      uploadPdfDoc: (file: File) => {
        const form = new FormData();
        form.append("file", file);
        return requestForm<{
          id: number;
          chapter_id: number | null;
          chapter_title: string | null;
          course_id: number | null;
          course_name: string | null;
          title: string;
          file_name: string | null;
          file_size?: number | null;
          parse_status: string | null;
          created_at: string | null;
          workflow_id: string;
        }>(`/teacher/pipeline/pdf-docs/upload`, form, { method: "POST" });
      },
      ttsModels: () =>
        request<{
          default_model: string;
          options: {
            value: string;
            label: string;
            provider_id: string;
            provider_name: string;
            provider_type: string;
            model: string;
          }[];
          voices_by_provider_type: Record<string, { value: string; label: string; gender?: string }[]>;
          voices_by_model: Record<string, { value: string; label: string; gender?: string }[]>;
        }>(`/teacher/pipeline/tts-models`),
      ttsPreview: (body: { voice: string; speed: number }) =>
        requestBlob(`/teacher/pipeline/tts-preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      getOrCreatePdfWorkflow: (docId: number) =>
        request<{
          workflow_id: string;
          title: string;
          chapter_id: number | null;
          created_at: string;
          updated_at: string;
          stages: Record<string, { status: string; updated_at: string; outputs: string[] }>;
        }>(`/teacher/pipeline/pdf-docs/${docId}/workflow`, { method: "POST" }),
      createWorkflow: (body: { title: string; chapter_id?: number | null }) =>
        request<{
          workflow_id: string;
          title: string;
          chapter_id: number | null;
          created_at: string;
          updated_at: string;
          stages: Record<string, { status: string; updated_at: string; outputs: string[] }>;
        }>("/teacher/pipeline/workflows", { method: "POST", body }),
      getWorkflow: (workflowId: string) =>
        request<{
          workflow_id: string;
          title: string;
          chapter_id: number | null;
          created_at: string;
          updated_at: string;
          stages: Record<string, { status: string; updated_at: string; outputs: string[] }>;
        }>(`/teacher/pipeline/workflows/${workflowId}`),
      stage1Extract: (workflowId: string, body: { file?: File } = {}) => {
        const form = new FormData();
        if (body.file) form.append("file", body.file);
        return requestForm<{ ok: boolean; workflow_id: string; page_count: number; chapter_count: number; outputs: string[] }>(
          `/teacher/pipeline/workflows/${workflowId}/stage1/extract`,
          form,
          { method: "POST" }
        );
      },
      stage2Generate: (
        workflowId: string,
        body: {
          source_file?: string;
          max_slides?: number;
          prefer_llm?: boolean;
          title?: string;
          output_json_file?: string;
        }
      ) =>
        request<{
          ok: boolean;
          workflow_id: string;
          slide_count: number;
          fallback_used: boolean;
          fallback_reason: string | null;
          outputs: string[];
        }>(`/teacher/pipeline/workflows/${workflowId}/stage2/generate`, { method: "POST", body }),
      stage3GeneratePpt: (
        workflowId: string,
        body: { source_file?: string; output_file?: string; template_file?: string | null }
      ) =>
        request<{ ok: boolean; workflow_id: string; slide_count: number; output: string }>(
          `/teacher/pipeline/workflows/${workflowId}/stage3/generate-ppt`,
          { method: "POST", body }
        ),
      stage3UploadEditedPpt: (workflowId: string, file: File) => {
        const form = new FormData();
        form.append("file", file);
        return requestForm<{ ok: boolean; workflow_id: string; output: string }>(
          `/teacher/pipeline/workflows/${workflowId}/stage3/upload-edited-ppt`,
          form,
          { method: "POST" }
        );
      },
      stage4GenerateScript: (
        workflowId: string,
        body: {
          source_ppt?: string;
          fallback_ppt?: string;
          prefer_llm?: boolean;
          output_segments_file?: string;
          output_script_file?: string;
        }
      ) =>
        request<{
          ok: boolean;
          workflow_id: string;
          segment_count: number;
          fallback_used: boolean;
          fallback_reason: string | null;
          outputs: string[];
        }>(`/teacher/pipeline/workflows/${workflowId}/stage4/generate-script`, { method: "POST", body }),
      stage5Tts: (
        workflowId: string,
        body: { script_file?: string; output_file?: string; model?: string; voice?: string; speed?: number }
      ) =>
        request<{ ok: boolean; workflow_id: string; output: string; bytes: number }>(
          `/teacher/pipeline/workflows/${workflowId}/stage5/tts`,
          { method: "POST", body }
        ),
      stage6RenderVideo: (
        workflowId: string,
        body: {
          ppt_file?: string;
          fallback_ppt?: string;
          audio_file?: string;
          output_file?: string;
          timing_file?: string | null;
          script_segments_file?: string | null;
          default_slide_seconds?: number;
        }
      ) =>
        request<{ ok: boolean; workflow_id: string; output: string; slide_count: number; durations: number[] }>(
          `/teacher/pipeline/workflows/${workflowId}/stage6/render-video`,
          { method: "POST", body }
        ),
      downloadFile: (workflowId: string, path: string) =>
        requestBlob(`/teacher/pipeline/workflows/${workflowId}/files/download?path=${encodeURIComponent(path)}`),
      uploadFileOverride: (workflowId: string, path: string, file: File) => {
        const form = new FormData();
        form.append("path", path);
        form.append("file", file);
        return requestForm<{ ok: boolean; workflow_id: string; path: string; bytes: number }>(
          `/teacher/pipeline/workflows/${workflowId}/files/upload`,
          form,
          { method: "POST" }
        );
      },
      readTextFile: (workflowId: string, path: string) =>
        request<{ path: string; content: string }>(
          `/teacher/pipeline/workflows/${workflowId}/files/text?path=${encodeURIComponent(path)}`
        ),
      saveTextFile: (workflowId: string, body: { path: string; content: string }) =>
        request<{ path: string; content: string }>(`/teacher/pipeline/workflows/${workflowId}/files/text`, {
          method: "PUT",
          body,
        }),
    },
  },
  feedback: {
    submit: (content: string, source: "form" | "dialogue" = "form", courseId?: number | null) =>
      request<{ ok: boolean; id?: number; message?: string }>("/feedback", {
        method: "POST",
        body: { content, source, course_id: courseId ?? undefined },
      }),
    /** 将某次答疑对话记为学习反馈（仅限本人提问记录） */
    submitFromQa: (questionAskedId: number) =>
      request<{ ok: boolean; id?: number }>("/feedback/from-qa", {
        method: "POST",
        body: { question_asked_id: questionAskedId },
      }),
    /** 当前用户提交的反馈列表（含处理结果、状态、提交时间），按提交时间逆序 */
    listMy: () =>
      request<{ id: number; content: string; reply_text: string | null; status: string; created_at: string }[]>(
        "/feedback"
      ),
  },
  /** 学生端：我的学情（与教师端学情课程统计详细表同结构，仅当前用户） */
  student: {
    learningStats: (params?: { courseId?: number; startDate?: string; endDate?: string }) => {
      const qs = new URLSearchParams();
      if (params?.courseId != null) qs.set("course_id", String(params.courseId));
      if (params?.startDate) qs.set("start_date", params.startDate);
      if (params?.endDate) qs.set("end_date", params.endDate);
      const q = qs.toString() ? `?${qs.toString()}` : "";
      return request<{
        course_id: number;
        course_name: string;
        student_id: number;
        student_no: string;
        student_name: string;
        class_name: string;
        preview_rate: string;
        preview_completed_chapter_ids: number[];
        completed_question_count: number;
        completed_question_count_by_chapter?: { chapter_id: number; count: number }[];
        correct_question_count_by_chapter?: { chapter_id: number; count: number }[];
        accuracy_rate: string;
        feedback_question_count: number;
        ai_ask_count: number;
        ai_irrelevant_count: number;
        weak_knowledge_points: string;
        weak_knowledge_points_by_chapter?: { chapter_id: number; weak_knowledge_points: string }[];
      }[]>(`/student/learning-stats${q}`);
    },
  },
  admin: {
    users: {
      list: (params?: { role?: string; q?: string }) => {
        const q = new URLSearchParams();
        if (params?.role) q.set("role", params.role);
        if (params?.q) q.set("q", params.q);
        return request<{ id: number; username: string; role: string; display_name: string | null; student_no: string | null; admin_class_or_dept: string | null; created_at: string | null }[]>(`/admin/users?${q}`);
      },
      create: (body: { username: string; password?: string; role: string; display_name?: string; student_no?: string; admin_class_or_dept?: string }) =>
        request<{ id: number; username: string; role: string; display_name: string | null; student_no: string | null; admin_class_or_dept: string | null }>("/admin/users", { method: "POST", body }),
      get: (id: number) => request<{ id: number; username: string; role: string; display_name: string | null; student_no: string | null; admin_class_or_dept: string | null }>(`/admin/users/${id}`),
      update: (id: number, body: { password?: string; role?: string; display_name?: string; student_no?: string; admin_class_or_dept?: string }) =>
        request<{ id: number; username: string; role: string; display_name: string | null; student_no: string | null; admin_class_or_dept: string | null }>(`/admin/users/${id}`, { method: "PUT", body }),
      delete: (id: number) => request<{ ok: boolean }>(`/admin/users/${id}`, { method: "DELETE" }),
      /** 下载批量导入用户模版（CSV） */
      downloadImportTemplate: () => requestBlob("/admin/users/import-template"),
      /** 批量导入用户：上传填好的模版 CSV */
      importUsers: (file: File) => {
        const form = new FormData();
        form.append("file", file);
        return requestForm<{ ok: boolean; imported: number; errors: string[]; message: string }>(
          "/admin/users/import",
          form,
          { method: "POST" }
        );
      },
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
        request<{ ok: boolean; task_id: number; status: string }>(`/admin/courses/${courseId}/reindex`, { method: "POST" }),
      getReindexTask: (taskId: number) =>
        request<{
          id: number;
          course_id: number;
          status: string;
          request_payload: Record<string, unknown>;
          result_payload: { chunks_indexed: number } | null;
          error_message: string | null;
          created_at: string | null;
          updated_at: string | null;
        }>(`/admin/courses/reindex/tasks/${taskId}`),
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
