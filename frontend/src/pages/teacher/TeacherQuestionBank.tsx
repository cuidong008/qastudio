import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { toast } from "../../utils/toast";

export type QuestionBankPageKey =
  | "exercise-generate"
  | "exercise-import"
  | "exercise-manage"
  | "paper-generate"
  | "paper-import"
  | "paper-manage";

type MenuItem = {
  key: QuestionBankPageKey;
  label: string;
  path: string;
};

type CourseItem = {
  id: number;
  name: string;
};

type ChapterItem = {
  id: number;
  title: string;
};

type QuestionTypeKey = "single_choice" | "multiple_choice" | "judge" | "blank" | "qa";
type QuestionBankType = "training" | "exam";

type QuestionTypeConfig = {
  key: QuestionTypeKey;
  label: string;
  max: number;
  difficulty: number;
};

const menuGroups: { title: string; items: MenuItem[] }[] = [
  {
    title: "习题库管理",
    items: [
      { key: "exercise-generate", label: "生成习题", path: "/teacher/question-bank/exercises/generate" },
      { key: "exercise-import", label: "导入习题", path: "/teacher/question-bank/exercises/import" },
      { key: "exercise-manage", label: "习题库查看/编辑", path: "/teacher/question-bank/exercises/manage" },
    ],
  },
  {
    title: "试卷库管理",
    items: [
      { key: "paper-generate", label: "生成试卷", path: "/teacher/question-bank/papers/generate" },
      { key: "paper-import", label: "导入试卷", path: "/teacher/question-bank/papers/import" },
      { key: "paper-manage", label: "试卷库查看/编辑", path: "/teacher/question-bank/papers/manage" },
    ],
  },
];

const EXERCISE_GENERATE_DEFAULTS_STORAGE_KEY = "qastudio.exerciseGenerateDefaults";

const defaultTypeConfigs: QuestionTypeConfig[] = [
  { key: "single_choice", label: "单选题", max: 10, difficulty: 0.8 },
  { key: "multiple_choice", label: "多选题", max: 10, difficulty: 0.8 },
  { key: "judge", label: "判断题", max: 10, difficulty: 0.8 },
  { key: "blank", label: "填空题", max: 10, difficulty: 0.8 },
  { key: "qa", label: "问答题", max: 5, difficulty: 0.8 },
];

type ExerciseDefaultPerType = { max: number; difficulty: number };
function loadSavedExerciseDefaults(): Partial<Record<QuestionTypeKey, ExerciseDefaultPerType>> | null {
  try {
    const raw = localStorage.getItem(EXERCISE_GENERATE_DEFAULTS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, { max?: number; difficulty?: number }>;
    const keys: QuestionTypeKey[] = ["single_choice", "multiple_choice", "judge", "blank", "qa"];
    const out: Partial<Record<QuestionTypeKey, ExerciseDefaultPerType>> = {};
    for (const k of keys) {
      const v = parsed[k];
      if (v && typeof v.max === "number" && Number.isFinite(v.max) && typeof v.difficulty === "number" && Number.isFinite(v.difficulty)) {
        out[k] = {
          max: Math.max(0, Math.min(30, v.max)),
          difficulty: Math.max(0, Math.min(1, v.difficulty)),
        };
      }
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

function loadSavedExerciseDefaultsCompat(): Partial<Record<QuestionTypeKey, ExerciseDefaultPerType>> | null {
  const fromNew = loadSavedExerciseDefaults();
  if (fromNew) return fromNew;
  try {
    const raw = localStorage.getItem("qastudio.exerciseGenerateDefaultMax");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, number>;
    const keys: QuestionTypeKey[] = ["single_choice", "multiple_choice", "judge", "blank", "qa"];
    const out: Partial<Record<QuestionTypeKey, ExerciseDefaultPerType>> = {};
    for (const k of keys) {
      if (typeof parsed[k] === "number" && Number.isFinite(parsed[k])) {
        out[k] = { max: Math.max(0, Math.min(30, parsed[k])), difficulty: 0.8 };
      }
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

const itemByKey = menuGroups.flatMap((g) => g.items).reduce<Record<QuestionBankPageKey, MenuItem>>(
  (acc, item) => {
    acc[item.key] = item;
    return acc;
  },
  {} as Record<QuestionBankPageKey, MenuItem>
);

function GenerateExercisesPanel() {
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [loadingKnowledgePoints, setLoadingKnowledgePoints] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [progressState, setProgressState] = useState<"idle" | "running" | "success" | "failed">("idle");

  const [courses, setCourses] = useState<CourseItem[]>([]);
  const [chapters, setChapters] = useState<ChapterItem[]>([]);
  const [knowledgePoints, setKnowledgePoints] = useState<Array<{ id: number; title: string; chapterId: number }>>([]);
  const [courseId, setCourseId] = useState<number | "">("");
  const [chapterId, setChapterId] = useState<number | "all" | "">("");
  const [knowledgePointIds, setKnowledgePointIds] = useState<number[]>([]);
  const [bankType, setBankType] = useState<QuestionBankType>("training");
  const [exerciseDefaultRowsFromApi, setExerciseDefaultRowsFromApi] = useState<
    { type: string; max: number; difficulty: string }[] | null
  >(null);
  const [savedExerciseDefaults, setSavedExerciseDefaults] = useState<Partial<Record<QuestionTypeKey, ExerciseDefaultPerType>> | null>(
    () => loadSavedExerciseDefaultsCompat()
  );
  const defaultExerciseTypeConfigs = useMemo(() => {
    if (!exerciseDefaultRowsFromApi?.length) return defaultTypeConfigs;
    const byType = Object.fromEntries(exerciseDefaultRowsFromApi.map((r) => [r.type, r]));
    return (["single_choice", "multiple_choice", "judge", "blank", "qa"] as const).map((key) => {
      const row = defaultTypeConfigs.find((c) => c.key === key)!;
      const fromApi = byType[key];
      if (!fromApi) return row;
      const difficultyNum = parseFloat(String(fromApi.difficulty));
      const apiMax = Number.isFinite(fromApi.max) ? Math.max(0, Math.min(30, fromApi.max)) : row.max;
      const apiDifficulty =
        Number.isFinite(difficultyNum) && difficultyNum >= 0 && difficultyNum <= 1 ? difficultyNum : row.difficulty;
      const saved = savedExerciseDefaults?.[key];
      return {
        key: row.key,
        label: row.label,
        max: saved != null ? saved.max : apiMax,
        difficulty: saved != null ? saved.difficulty : apiDifficulty,
      };
    });
  }, [exerciseDefaultRowsFromApi, savedExerciseDefaults]);
  const [typeConfigs, setTypeConfigs] = useState<QuestionTypeConfig[]>(defaultTypeConfigs);
  const [generateSettingsModalOpen, setGenerateSettingsModalOpen] = useState(false);
  const [generateSettingsDraft, setGenerateSettingsDraft] = useState<Record<QuestionTypeKey, { max: number; difficulty: number }>>({
    single_choice: { max: 10, difficulty: 0.8 },
    multiple_choice: { max: 10, difficulty: 0.8 },
    judge: { max: 10, difficulty: 0.8 },
    blank: { max: 10, difficulty: 0.8 },
    qa: { max: 5, difficulty: 0.8 },
  });
  const [previewRows, setPreviewRows] = useState<
    {
      id: number;
      courseName: string;
      chapterId: number;
      chapterName: string;
      questionType: string;
      questionTypeKey: QuestionTypeKey;
      questionText: string;
      options: string[];
      correctAnswer: string;
      explanation: string;
      difficultyScore: number | null;
    }[]
  >([]);
  const [previewCurrentPage, setPreviewCurrentPage] = useState(1);
  const [previewPageSize, setPreviewPageSize] = useState(10);
  const [confirmingImport, setConfirmingImport] = useState(false);
  const [previewModalMode, setPreviewModalMode] = useState<"view" | "edit">("view");
  const [editingPreviewRowId, setEditingPreviewRowId] = useState<number | null>(null);
  const [previewQuestionTypeDraft, setPreviewQuestionTypeDraft] = useState<QuestionTypeKey>("single_choice");
  const [previewChapterIdDraft, setPreviewChapterIdDraft] = useState<number | "">("");
  const [previewQuestionTextDraft, setPreviewQuestionTextDraft] = useState("");
  const [previewOptionsDraft, setPreviewOptionsDraft] = useState("");
  const [previewAnswerDraft, setPreviewAnswerDraft] = useState("");
  const [previewExplanationDraft, setPreviewExplanationDraft] = useState("");
  const [previewDifficultyScoreDraft, setPreviewDifficultyScoreDraft] = useState("");
  const [chapterGenerateStats, setChapterGenerateStats] = useState<
    {
      chapterId: number;
      chapterName: string;
      requestedTotal: number;
      modelOutputCount: number;
      generatedCount: number;
      skipped: number;
      requestedByType: Record<QuestionTypeKey, number>;
      generatedByType: Record<QuestionTypeKey, number>;
    }[]
  >([]);
  const previewTotalPages = Math.max(1, Math.ceil(previewRows.length / previewPageSize));
  const pagedPreviewRows = useMemo(() => {
    const start = (previewCurrentPage - 1) * previewPageSize;
    return previewRows.slice(start, start + previewPageSize);
  }, [previewRows, previewCurrentPage, previewPageSize]);
  const questionTypeLabel: Record<QuestionTypeKey, string> = {
    single_choice: "单选题",
    multiple_choice: "多选题",
    judge: "判断题",
    blank: "填空题",
    qa: "问答题",
  };

  useEffect(() => {
    api.teacher
      .getExerciseGenerateDefaults()
      .then((rows) => setExerciseDefaultRowsFromApi(rows))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!exerciseDefaultRowsFromApi?.length) return;
    setTypeConfigs(defaultExerciseTypeConfigs);
  }, [exerciseDefaultRowsFromApi, defaultExerciseTypeConfigs]);

  const totalMaxCount = useMemo(() => typeConfigs.reduce((sum, row) => sum + (Number.isFinite(row.max) ? row.max : 0), 0), [typeConfigs]);
  const truncateByHanCount = (text: string, maxHan: number) => {
    let hanCount = 0;
    let truncated = false;
    const out: string[] = [];
    for (const ch of Array.from(text)) {
      const isHan = /[\u4e00-\u9fff]/.test(ch);
      if (isHan && hanCount >= maxHan) {
        truncated = true;
        break;
      }
      out.push(ch);
      if (isHan) hanCount += 1;
    }
    return truncated ? `${out.join("")}...` : text;
  };
  const knowledgeSelectedSummary = useMemo(() => {
    const selectedTitles = knowledgePoints
      .filter((kp) => knowledgePointIds.includes(kp.id))
      .map((kp) => kp.title.trim())
      .filter((x) => !!x)
      .join("；");
    return selectedTitles ? `。${truncateByHanCount(selectedTitles, 64)}` : "";
  }, [knowledgePoints, knowledgePointIds]);

  useEffect(() => {
    setLoadingCourses(true);
    api.teacher.courses
      .list()
      .then((rows) => {
        const mapped = rows.map((c) => ({ id: c.id, name: c.name }));
        setCourses(mapped);
        if (!mapped.length) {
          setCourseId("");
          return;
        }
        setCourseId((prev) => (prev === "" ? mapped[0].id : prev));
      })
      .catch((e: any) => {
        toast(e?.message || "课程加载失败", "error");
        setCourses([]);
      })
      .finally(() => setLoadingCourses(false));
  }, []);

  useEffect(() => {
    if (!courseId) {
      setChapters([]);
      setChapterId("");
      return;
    }
    setLoadingChapters(true);
    api.teacher.courses
      .chapters(courseId)
      .then((rows) => {
        const mapped = rows.map((ch) => ({ id: ch.id, title: ch.title }));
        setChapters(mapped);
        setChapterId(mapped.length ? "all" : "");
      })
      .catch((e: any) => {
        toast(e?.message || "章节加载失败", "error");
        setChapters([]);
        setChapterId("");
      })
      .finally(() => setLoadingChapters(false));
  }, [courseId]);

  useEffect(() => {
    if (!courseId || !chapterId) {
      setKnowledgePoints([]);
      setKnowledgePointIds([]);
      return;
    }
    const targetChapterIds = chapterId === "all" ? chapters.map((ch) => ch.id) : [chapterId];
    if (!targetChapterIds.length) {
      setKnowledgePoints([]);
      setKnowledgePointIds([]);
      return;
    }
    setLoadingKnowledgePoints(true);
    Promise.all(
      targetChapterIds.map((id) =>
        api.teacher.courses
          .chapterKnowledgePoints(id)
          .then((rows) => rows.map((kp) => ({ id: kp.id, title: kp.title, chapterId: id })))
          .catch(() => [])
      )
    )
      .then((parts) => {
        const merged = parts.flat();
        setKnowledgePoints(merged);
        setKnowledgePointIds(merged.map((x) => x.id));
      })
      .catch(() => {
        setKnowledgePoints([]);
        setKnowledgePointIds([]);
      })
      .finally(() => setLoadingKnowledgePoints(false));
  }, [courseId, chapterId, chapters]);

  const allKnowledgePointsSelected = knowledgePoints.length > 0 && knowledgePointIds.length === knowledgePoints.length;
  const toggleAllKnowledgePoints = (checked: boolean) => {
    setKnowledgePointIds(checked ? knowledgePoints.map((x) => x.id) : []);
  };
  const toggleKnowledgePoint = (id: number) => {
    setKnowledgePointIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const updateTypeMax = (key: QuestionTypeKey, value: string) => {
    const parsed = Math.max(0, Math.min(30, Number(value || 0)));
    setTypeConfigs((prev) => prev.map((row) => (row.key === key ? { ...row, max: Number.isFinite(parsed) ? parsed : 0 } : row)));
  };

  const updateTypeDifficulty = (key: QuestionTypeKey, value: string) => {
    const parsed = Number(value);
    const nextValue = Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0.8;
    setTypeConfigs((prev) => prev.map((row) => (row.key === key ? { ...row, difficulty: nextValue } : row)));
  };

  const resetForm = () => {
    setBankType("training");
    setTypeConfigs(defaultExerciseTypeConfigs);
    setChapterId(chapters.length ? "all" : "");
    setKnowledgePointIds(knowledgePoints.map((x) => x.id));
    setEditingPreviewRowId(null);
    setPreviewRows([]);
    setPreviewCurrentPage(1);
    setPreviewPageSize(10);
    setChapterGenerateStats([]);
    setProgressPercent(0);
    setProgressText("");
    setProgressState("idle");
  };

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(previewRows.length / previewPageSize));
    setPreviewCurrentPage((p) => Math.min(p, maxPage));
  }, [previewRows.length, previewPageSize]);

  const openGenerateSettingsModal = () => {
    const draft: Record<QuestionTypeKey, { max: number; difficulty: number }> = {
      single_choice: {
        max: defaultExerciseTypeConfigs.find((r) => r.key === "single_choice")?.max ?? 10,
        difficulty: defaultExerciseTypeConfigs.find((r) => r.key === "single_choice")?.difficulty ?? 0.8,
      },
      multiple_choice: {
        max: defaultExerciseTypeConfigs.find((r) => r.key === "multiple_choice")?.max ?? 10,
        difficulty: defaultExerciseTypeConfigs.find((r) => r.key === "multiple_choice")?.difficulty ?? 0.8,
      },
      judge: {
        max: defaultExerciseTypeConfigs.find((r) => r.key === "judge")?.max ?? 10,
        difficulty: defaultExerciseTypeConfigs.find((r) => r.key === "judge")?.difficulty ?? 0.8,
      },
      blank: {
        max: defaultExerciseTypeConfigs.find((r) => r.key === "blank")?.max ?? 10,
        difficulty: defaultExerciseTypeConfigs.find((r) => r.key === "blank")?.difficulty ?? 0.8,
      },
      qa: {
        max: defaultExerciseTypeConfigs.find((r) => r.key === "qa")?.max ?? 5,
        difficulty: defaultExerciseTypeConfigs.find((r) => r.key === "qa")?.difficulty ?? 0.8,
      },
    };
    setGenerateSettingsDraft(draft);
    setGenerateSettingsModalOpen(true);
  };

  const saveGenerateSettings = () => {
    const toSave: Record<QuestionTypeKey, ExerciseDefaultPerType> = { ...generateSettingsDraft };
    localStorage.setItem(EXERCISE_GENERATE_DEFAULTS_STORAGE_KEY, JSON.stringify(toSave));
    setSavedExerciseDefaults(toSave);
    setTypeConfigs((prev) =>
      prev.map((row) => ({
        ...row,
        max: generateSettingsDraft[row.key]?.max ?? row.max,
        difficulty: generateSettingsDraft[row.key]?.difficulty ?? row.difficulty,
      }))
    );
    setGenerateSettingsModalOpen(false);
    toast("生成设置已保存", "success");
  };

  const clearGenerateSettingsOverrides = () => {
    localStorage.removeItem(EXERCISE_GENERATE_DEFAULTS_STORAGE_KEY);
    localStorage.removeItem("qastudio.exerciseGenerateDefaultMax");
    setSavedExerciseDefaults(null);
    if (exerciseDefaultRowsFromApi?.length) {
      const byType = Object.fromEntries(exerciseDefaultRowsFromApi.map((r) => [r.type, r]));
      const d = (k: QuestionTypeKey) => {
        const r = byType[k];
        const difficultyNum = parseFloat(String(r?.difficulty));
        return {
          max: Math.max(0, Math.min(30, r?.max ?? 10)),
          difficulty:
            Number.isFinite(difficultyNum) && difficultyNum >= 0 && difficultyNum <= 1 ? difficultyNum : 0.8,
        };
      };
      setGenerateSettingsDraft({
        single_choice: d("single_choice"),
        multiple_choice: d("multiple_choice"),
        judge: d("judge"),
        blank: d("blank"),
        qa: d("qa"),
      });
    }
    toast("已恢复为配置文件中的初始值", "success");
  };

  const submitGenerate = async () => {
    if (!courseId) {
      toast("请先选择课程", "error");
      return;
    }
    if (!chapterId) {
      toast("请先选择章节", "error");
      return;
    }
    if (totalMaxCount <= 0) {
      toast("请至少配置一种题型数量大于 0", "error");
      return;
    }
    if (knowledgePoints.length > 0 && knowledgePointIds.length === 0) {
      toast("请至少选择一个知识点，或勾选全部知识点", "error");
      return;
    }

    const maxByType = {
      single_choice_max: typeConfigs.find((x) => x.key === "single_choice")?.max || 0,
      multiple_choice_max: typeConfigs.find((x) => x.key === "multiple_choice")?.max || 0,
      judge_max: typeConfigs.find((x) => x.key === "judge")?.max || 0,
      qa_max: typeConfigs.find((x) => x.key === "qa")?.max || 0,
      blank_max: typeConfigs.find((x) => x.key === "blank")?.max || 0,
    };
    const commonPayload = {
      question_bank_type: bankType,
      single_choice_difficulty_score: typeConfigs.find((x) => x.key === "single_choice")?.difficulty || 0.8,
      multiple_choice_difficulty_score: typeConfigs.find((x) => x.key === "multiple_choice")?.difficulty || 0.8,
      judge_difficulty_score: typeConfigs.find((x) => x.key === "judge")?.difficulty || 0.8,
      qa_difficulty_score: typeConfigs.find((x) => x.key === "qa")?.difficulty || 0.8,
      blank_difficulty_score: typeConfigs.find((x) => x.key === "blank")?.difficulty || 0.8,
    };

    const targetChapterIds = chapterId === "all" ? chapters.map((ch) => ch.id) : [chapterId];
    if (!targetChapterIds.length) {
      toast("当前课程没有可用章节", "error");
      return;
    }

    setSubmitting(true);
    setProgressState("running");
    setProgressPercent(1);
    setProgressText("正在生成预览...");
    setChapterGenerateStats([]);
    try {
      const generatedRows: {
        id: number;
        courseName: string;
        chapterId: number;
        chapterName: string;
        questionType: string;
        questionTypeKey: QuestionTypeKey;
        questionText: string;
        options: string[];
        correctAnswer: string;
        explanation: string;
        difficultyScore: number | null;
      }[] = [];
      const statsRows: {
        chapterId: number;
        chapterName: string;
        requestedTotal: number;
        modelOutputCount: number;
        generatedCount: number;
        skipped: number;
        requestedByType: Record<QuestionTypeKey, number>;
        generatedByType: Record<QuestionTypeKey, number>;
      }[] = [];
      const chapterCount = targetChapterIds.length;
      const distribute = (total: number, count: number) => {
        const base = Math.floor(total / count);
        const rem = total % count;
        return Array.from({ length: count }, (_, i) => base + (i < rem ? 1 : 0));
      };
      const singleChoicePlan = distribute(maxByType.single_choice_max, chapterCount);
      const multiChoicePlan = distribute(maxByType.multiple_choice_max, chapterCount);
      const judgePlan = distribute(maxByType.judge_max, chapterCount);
      const qaPlan = distribute(maxByType.qa_max, chapterCount);
      const blankPlan = distribute(maxByType.blank_max, chapterCount);
      const courseName = courses.find((x) => x.id === courseId)?.name || "未知课程";
      let idSeed = Date.now();
      let submittedChapters = 0;

      for (let i = 0; i < chapterCount; i += 1) {
        setProgressText(`正在生成预览：第 ${i + 1} / ${chapterCount} 个章节`);
        const chapterKnowledgePointIds = knowledgePointIds.filter(
          (kpId) => knowledgePoints.find((kp) => kp.id === kpId)?.chapterId === targetChapterIds[i]
        );
        const chapterTaskPayload = {
          ...commonPayload,
          single_choice_max: singleChoicePlan[i],
          multiple_choice_max: multiChoicePlan[i],
          judge_max: judgePlan[i],
          qa_max: qaPlan[i],
          blank_max: blankPlan[i],
          knowledge_point_ids: allKnowledgePointsSelected ? [] : chapterKnowledgePointIds,
        };
        const perChapterTotal =
          chapterTaskPayload.single_choice_max +
          chapterTaskPayload.multiple_choice_max +
          chapterTaskPayload.judge_max +
          chapterTaskPayload.qa_max +
          chapterTaskPayload.blank_max;
        if (perChapterTotal <= 0) continue;
        const resp = await api.teacher.courses.generateChapterQuestionsPreview(targetChapterIds[i], chapterTaskPayload);
        const chapterName = chapters.find((x) => x.id === targetChapterIds[i])?.title || `章节${targetChapterIds[i]}`;
        const generatedByType: Record<QuestionTypeKey, number> = {
          single_choice: Number(resp.by_type?.single_choice || 0),
          multiple_choice: Number(resp.by_type?.multiple_choice || 0),
          judge: Number(resp.by_type?.judge || 0),
          blank: Number(resp.by_type?.blank || 0),
          qa: Number(resp.by_type?.qa || 0),
        };
        const requestedByType: Record<QuestionTypeKey, number> = {
          single_choice: chapterTaskPayload.single_choice_max,
          multiple_choice: chapterTaskPayload.multiple_choice_max,
          judge: chapterTaskPayload.judge_max,
          blank: chapterTaskPayload.blank_max,
          qa: chapterTaskPayload.qa_max,
        };
        statsRows.push({
          chapterId: targetChapterIds[i],
          chapterName,
          requestedTotal: perChapterTotal,
          modelOutputCount: Number(resp.output_count || 0),
          generatedCount: Number(resp.generated_count || 0),
          skipped: Number(resp.skipped || 0),
          requestedByType,
          generatedByType,
        });
        for (const item of resp.items || []) {
          const typeKey = (
            ["single_choice", "multiple_choice", "judge", "blank", "qa"].includes(item.question_type)
              ? item.question_type
              : "qa"
          ) as QuestionTypeKey;
          generatedRows.push({
            id: idSeed++,
            courseName,
            chapterId: targetChapterIds[i],
            chapterName: item.chapter_title || chapterName,
            questionType: questionTypeLabel[typeKey] || typeKey,
            questionTypeKey: typeKey,
            questionText: item.question_text || "",
            options: Array.isArray(item.options) ? item.options.map((x) => String(x || "")) : [],
            correctAnswer: item.correct_answer || "",
            explanation: item.explanation || "",
            difficultyScore:
              item.difficulty_score != null && Number.isFinite(Number(item.difficulty_score))
                ? Number(Number(item.difficulty_score).toFixed(2))
                : null,
          });
        }
        submittedChapters += 1;
        setProgressPercent(Math.max(1, Math.min(99, Math.round((submittedChapters / chapterCount) * 100))));
      }
      setChapterGenerateStats(statsRows);
      if (!submittedChapters) {
        throw new Error("题型数量配置过小，无法分配到所选章节，请调整后重试");
      }
      if (!generatedRows.length) {
        throw new Error("未生成可预览题目，请调整参数后重试");
      }
      setPreviewRows(generatedRows);
      setPreviewCurrentPage(1);
      setProgressState("success");
      setProgressPercent(100);
      setProgressText(`预览生成完成：共 ${generatedRows.length} 道题，请确认后导入题库`);
      toast(`已生成预览 ${generatedRows.length} 道题`, "success");
    } catch (e: any) {
      setProgressState("failed");
      setProgressText(e?.message || "提交生成失败");
      toast(e?.message || "提交生成失败", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const confirmImportGenerated = async () => {
    if (!courseId) return toast("请先选择课程", "error");
    if (!previewRows.length) return toast("预览表格为空，请先生成预览", "error");
    const items = previewRows.map((row) => ({
      chapter_id: row.chapterId,
      question_type: row.questionTypeKey,
      question_text: row.questionText,
      options: row.options || [],
      correct_answer: row.correctAnswer,
      explanation: row.explanation || null,
      difficulty_score: row.difficultyScore,
    }));
    setConfirmingImport(true);
    try {
      const res = await api.teacher.courses.importQuestionsConfirm({
        course_id: courseId,
        question_bank_type: bankType,
        items,
      });
      toast(res.message || `已导入 ${res.imported_count} 道题目`, "success");
      // 仅刷新生成结果区，保留基础筛选区已选项
      setPreviewRows([]);
      setPreviewCurrentPage(1);
      setChapterGenerateStats([]);
      setProgressPercent(0);
      setProgressText("");
      setProgressState("idle");
    } catch (e: any) {
      toast(e?.message || "导入失败", "error");
    } finally {
      setConfirmingImport(false);
    }
  };

  const openPreviewModal = (rowId: number, mode: "view" | "edit") => {
    const row = previewRows.find((x) => x.id === rowId);
    if (!row) return;
    setPreviewModalMode(mode);
    setEditingPreviewRowId(rowId);
    setPreviewQuestionTypeDraft(row.questionTypeKey);
    setPreviewChapterIdDraft(row.chapterId);
    setPreviewQuestionTextDraft(row.questionText || "");
    setPreviewOptionsDraft((row.options || []).join("\n"));
    setPreviewAnswerDraft(row.correctAnswer || "");
    setPreviewExplanationDraft(row.explanation || "");
    setPreviewDifficultyScoreDraft(row.difficultyScore != null ? String(row.difficultyScore) : "");
  };

  const savePreviewRow = () => {
    if (!editingPreviewRowId) return;
    const qText = previewQuestionTextDraft.trim();
    const ans = previewAnswerDraft.trim();
    if (!qText) return toast("题目内容不能为空", "error");
    if (!ans) return toast("答案不能为空", "error");
    const optionsList = previewOptionsDraft
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => !!x);
    const needOptions = previewQuestionTypeDraft === "single_choice" || previewQuestionTypeDraft === "multiple_choice";
    if (needOptions && optionsList.length < 2) return toast("选择题至少需要2个选项", "error");
    const diffStr = previewDifficultyScoreDraft.trim();
    const difficultyScore: number | null =
      diffStr === ""
        ? null
        : (() => {
            const d = Number(diffStr);
            if (!Number.isFinite(d) || d < 0 || d > 1) return null;
            return Number(d.toFixed(2));
          })();
    if (diffStr !== "" && difficultyScore === null) return toast("难度系数需在 0~1 或留空", "error");
    const draftChapterId = previewChapterIdDraft === "" ? null : Number(previewChapterIdDraft);
    const nextChapter = draftChapterId ? chapters.find((x) => x.id === draftChapterId) : null;
    setPreviewRows((prev) =>
      prev.map((x) =>
        x.id === editingPreviewRowId
          ? {
              ...x,
              chapterId: nextChapter?.id ?? x.chapterId,
              chapterName: nextChapter?.title || x.chapterName,
              questionTypeKey: previewQuestionTypeDraft,
              questionType: questionTypeLabel[previewQuestionTypeDraft],
              questionText: qText,
              options: needOptions ? optionsList : [],
              correctAnswer: ans,
              explanation: previewExplanationDraft.trim(),
              difficultyScore: difficultyScore ?? null,
            }
          : x
      )
    );
    toast("预览数据已更新", "success");
    setEditingPreviewRowId(null);
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>生成习题</h2>
        <button type="button" className="btn-secondary" onClick={openGenerateSettingsModal}>
          生成设置
        </button>
      </div>
      {generateSettingsModalOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.4)",
          }}
          onClick={(e) => e.target === e.currentTarget && setGenerateSettingsModalOpen(false)}
        >
          <div
            style={{
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 20,
              minWidth: 360,
              maxWidth: "90vw",
              color: "var(--text-primary)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>生成设置</div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 8, color: "var(--text-secondary)", fontSize: 14 }}>各题型默认：最大数量、难度系数</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 320 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>题型</th>
                      <th style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>最大数量</th>
                      <th style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>难度系数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(["single_choice", "multiple_choice", "judge", "blank", "qa"] as const).map((key) => {
                      const label = defaultTypeConfigs.find((c) => c.key === key)!.label;
                      return (
                        <tr key={key}>
                          <td style={{ border: "1px solid var(--border)", padding: 8 }}>{label}</td>
                          <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                            <input
                              type="number"
                              min={0}
                              max={30}
                              step={1}
                              value={generateSettingsDraft[key].max}
                              onChange={(e) => {
                                const v = Math.max(0, Math.min(30, Number(e.target.value) || 0));
                                setGenerateSettingsDraft((prev) => ({ ...prev, [key]: { ...prev[key], max: v } }));
                              }}
                              style={{ width: 88, padding: "4px 8px" }}
                            />
                          </td>
                          <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                            <input
                              type="number"
                              min={0}
                              max={1}
                              step={0.01}
                              value={generateSettingsDraft[key].difficulty}
                              onChange={(e) => {
                                const v = Math.max(0, Math.min(1, Number(e.target.value) || 0));
                                setGenerateSettingsDraft((prev) => ({ ...prev, [key]: { ...prev[key], difficulty: v } }));
                              }}
                              style={{ width: 88, padding: "4px 8px" }}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn-secondary" onClick={clearGenerateSettingsOverrides}>
                恢复初始值
              </button>
              <button type="button" className="btn-secondary" onClick={() => setGenerateSettingsModalOpen(false)}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={saveGenerateSettings}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 10,
          minHeight: 380,
          padding: 14,
          background: "var(--bg-elevated)",
          color: "var(--text-primary)",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 10 }}>【基础筛选】</div>
        <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", rowGap: 10, columnGap: 12, alignItems: "center" }}>
          <div style={{ color: "var(--text-secondary)" }}>课程</div>
          <select
            value={courseId === "" ? "" : String(courseId)}
            onChange={(e) => setCourseId(e.target.value ? Number(e.target.value) : "")}
            disabled={loadingCourses}
          >
            {!courses.length && <option value="">暂无课程</option>}
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name}
              </option>
            ))}
          </select>

          <div style={{ color: "var(--text-secondary)" }}>章节</div>
          <select
            value={chapterId === "" ? "" : String(chapterId)}
            onChange={(e) => {
              const v = e.target.value;
              setChapterId(v === "all" ? "all" : v ? Number(v) : "");
            }}
            disabled={loadingChapters || !courseId}
          >
            {!chapters.length && <option value="">暂无章节</option>}
            {!!chapters.length && <option value="all">全部章节</option>}
            {chapters.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>
                {chapter.title}
              </option>
            ))}
          </select>

          <div style={{ color: "var(--text-secondary)" }}>知识点</div>
          <div>
            <details>
              <summary
                style={{
                  listStyle: "none",
                  cursor: "pointer",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  background: "var(--bg-base)",
                  color: "var(--text-primary)",
                  userSelect: "none",
                }}
              >
                {loadingKnowledgePoints
                  ? "知识点加载中..."
                  : `已选 ${knowledgePointIds.length} / ${knowledgePoints.length || 0} 个知识点${knowledgeSelectedSummary}`}
              </summary>
              <div
                style={{
                  marginTop: 8,
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: 10,
                  display: "grid",
                  gap: 8,
                  maxHeight: 220,
                  overflowY: "auto",
                  background: "var(--bg-base)",
                }}
              >
                {!loadingKnowledgePoints && !!knowledgePoints.length && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600 }}>
                    <input type="checkbox" checked={allKnowledgePointsSelected} onChange={(e) => toggleAllKnowledgePoints(e.target.checked)} />
                    全部知识点
                  </label>
                )}
                {loadingKnowledgePoints && <span style={{ color: "var(--text-muted)" }}>加载中...</span>}
                {!loadingKnowledgePoints &&
                  knowledgePoints.map((kp) => (
                    <label key={kp.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                      <input type="checkbox" checked={knowledgePointIds.includes(kp.id)} onChange={() => toggleKnowledgePoint(kp.id)} />
                      {kp.title}
                    </label>
                  ))}
                {!loadingKnowledgePoints && !knowledgePoints.length && <span style={{ color: "var(--text-muted)" }}>暂无知识点</span>}
              </div>
            </details>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>【加入的题库类型】</div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 16 }}>
            <input type="radio" name="question-bank-type" checked={bankType === "training"} onChange={() => setBankType("training")} />
            训练库
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="radio" name="question-bank-type" checked={bankType === "exam"} onChange={() => setBankType("exam")} />
            考试库
          </label>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <div style={{ fontWeight: 700 }}>【题目类型配置】</div>
            <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              大模型单次生成最大数量有限制，设置的数量请不要过大
            </div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>题型</th>
                  <th style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>最大数量</th>
                  <th style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>难度系数</th>
                </tr>
              </thead>
              <tbody>
                {typeConfigs.map((row) => (
                  <tr key={row.key}>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.label}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <input
                        type="number"
                        min={0}
                        max={30}
                        step={1}
                        value={row.max}
                        onChange={(e) => updateTypeMax(row.key, e.target.value)}
                        style={{ width: 120 }}
                      />
                    </td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.01}
                        value={row.difficulty}
                        onChange={(e) => updateTypeDifficulty(row.key, e.target.value)}
                        style={{ width: 120 }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14, display: "flex", gap: 10 }}>
          <button type="button" className="btn-secondary" onClick={resetForm} disabled={submitting}>
            重置
          </button>
          <button type="button" className="btn-primary" onClick={submitGenerate} disabled={submitting}>
            {submitting ? "生成中..." : "提交生成"}
          </button>
        </div>
        {progressState !== "idle" && (
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 12 }}>
            <div style={{ marginBottom: 8, color: progressState === "failed" ? "#ef4444" : "var(--text-secondary)" }}>{progressText}</div>
            <div style={{ height: 10, borderRadius: 999, background: "var(--bg-base)", border: "1px solid var(--border)", overflow: "hidden" }}>
              <div
                style={{
                  width: `${Math.max(0, Math.min(100, progressPercent))}%`,
                  height: "100%",
                  background: progressState === "failed" ? "#ef4444" : "var(--accent)",
                  transition: "width 0.2s ease",
                }}
              />
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-muted)" }}>{progressPercent}%</div>
          </div>
        )}

        {!!chapterGenerateStats.length && (
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>【按章节生成统计】</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 920 }}>
                <thead>
                  <tr>
                    {["章节", "请求总数", "模型产出", "预览生成", "跳过(校验/去重)", "单选", "多选", "判断", "填空", "问答"].map((h) => (
                      <th key={h} style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {chapterGenerateStats.map((s) => (
                    <tr key={s.chapterId}>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{s.chapterName}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{s.requestedTotal}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{s.modelOutputCount}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{s.generatedCount}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{s.skipped}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{s.requestedByType.single_choice} → {s.generatedByType.single_choice}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{s.requestedByType.multiple_choice} → {s.generatedByType.multiple_choice}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{s.requestedByType.judge} → {s.generatedByType.judge}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{s.requestedByType.blank} → {s.generatedByType.blank}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{s.requestedByType.qa} → {s.generatedByType.qa}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>【生成后习题预览】</div>
          <div style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 8 }}>未点击“确认导入题库”前，不会写入习题库。</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 920 }}>
              <thead>
                <tr>
                  {["序号", "课程", "章节", "题型", "题干", "选项", "答案", "解析", "难度系数", "操作"].map((h) => (
                    <th key={h} style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedPreviewRows.map((row, idx) => (
                  <tr key={row.id}>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{(previewCurrentPage - 1) * previewPageSize + idx + 1}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.courseName}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.chapterName}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.questionType}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.questionText}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.options.length ? row.options.join("；") : "-"}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.correctAnswer || "-"}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.explanation || "-"}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.difficultyScore != null ? row.difficultyScore.toFixed(2) : ""}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ minHeight: 30, padding: "4px 8px" }}
                          onClick={() => openPreviewModal(row.id, "view")}
                        >
                          查看
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ minHeight: 30, padding: "4px 8px" }}
                          onClick={() => openPreviewModal(row.id, "edit")}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ minHeight: 30, padding: "4px 8px" }}
                          onClick={() => setPreviewRows((prev) => prev.filter((x) => x.id !== row.id))}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!previewRows.length && (
                  <tr>
                    <td colSpan={10} style={{ border: "1px solid var(--border)", padding: 12, color: "var(--text-muted)" }}>
                      暂无预览数据，请先点击“提交生成”。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>每页显示</span>
            <select
              value={String(previewPageSize)}
              onChange={(e) => {
                const n = Math.max(1, Math.min(100, Number(e.target.value || 10)));
                setPreviewPageSize(n);
                setPreviewCurrentPage(1);
              }}
            >
              {[10, 20, 30, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button type="button" className="btn-secondary" onClick={() => setPreviewCurrentPage((p) => Math.max(1, p - 1))} disabled={previewCurrentPage <= 1}>
              上一页
            </button>
            <button type="button" className="btn-secondary" onClick={() => setPreviewCurrentPage((p) => Math.min(previewTotalPages, p + 1))} disabled={previewCurrentPage >= previewTotalPages}>
              下一页
            </button>
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              第 {previewCurrentPage} / {previewTotalPages} 页，共 {previewRows.length} 条
            </span>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14, display: "flex", gap: 10 }}>
          <button type="button" className="btn-primary" onClick={confirmImportGenerated} disabled={confirmingImport || !previewRows.length}>
            {confirmingImport ? "导入中..." : "确认导入题库"}
          </button>
        </div>
      </div>
      {editingPreviewRowId !== null && (() => {
        const row = previewRows.find((x) => x.id === editingPreviewRowId);
        if (!row) return null;
        return (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0, 0, 0, 0.55)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 2000,
              padding: 16,
            }}
            onClick={() => setEditingPreviewRowId(null)}
          >
            <div className="card" style={{ width: "min(760px, 100%)", maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ marginTop: 0, marginBottom: 10 }}>{previewModalMode === "edit" ? "编辑习题" : "查看习题"}</h3>
              <div style={{ display: "grid", gridTemplateColumns: "100px minmax(0,1fr)", rowGap: 10, columnGap: 10 }}>
                <div style={{ color: "var(--text-secondary)" }}>课程</div>
                <div>{row.courseName}</div>
                <div style={{ color: "var(--text-secondary)" }}>章节</div>
                {previewModalMode === "edit" ? (
                  <select value={previewChapterIdDraft === "" ? "" : String(previewChapterIdDraft)} onChange={(e) => setPreviewChapterIdDraft(e.target.value ? Number(e.target.value) : "")}>
                    {!chapters.length && <option value="">暂无章节</option>}
                    {chapters.map((ch) => (
                      <option key={ch.id} value={ch.id}>
                        {ch.title}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div>{row.chapterName}</div>
                )}
                <div style={{ color: "var(--text-secondary)" }}>题型</div>
                {previewModalMode === "edit" ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    {(["single_choice", "multiple_choice", "judge", "blank", "qa"] as const).map((k) => (
                      <label key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <input type="radio" name="generate-preview-question-type" checked={previewQuestionTypeDraft === k} onChange={() => setPreviewQuestionTypeDraft(k)} />
                        {questionTypeLabel[k]}
                      </label>
                    ))}
                  </div>
                ) : (
                  <div>{row.questionType}</div>
                )}
                <div style={{ color: "var(--text-secondary)" }}>题目内容</div>
                {previewModalMode === "edit" ? (
                  <textarea value={previewQuestionTextDraft} onChange={(e) => setPreviewQuestionTextDraft(e.target.value)} rows={4} style={{ width: "100%" }} />
                ) : (
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{row.questionText}</div>
                )}
                <div style={{ color: "var(--text-secondary)" }}>选项</div>
                {previewModalMode === "edit" ? (
                  <textarea value={previewOptionsDraft} onChange={(e) => setPreviewOptionsDraft(e.target.value)} rows={4} placeholder="每行一个选项" style={{ width: "100%" }} />
                ) : (
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{row.options.length ? row.options.join("\n") : "-"}</div>
                )}
                <div style={{ color: "var(--text-secondary)" }}>答案</div>
                {previewModalMode === "edit" ? (
                  <textarea value={previewAnswerDraft} onChange={(e) => setPreviewAnswerDraft(e.target.value)} rows={3} style={{ width: "100%" }} />
                ) : (
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{row.correctAnswer || "-"}</div>
                )}
                <div style={{ color: "var(--text-secondary)" }}>难度系数</div>
                {previewModalMode === "edit" ? (
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={previewDifficultyScoreDraft}
                    onChange={(e) => setPreviewDifficultyScoreDraft(e.target.value)}
                    placeholder="0~1，留空表示未识别"
                    style={{ width: 160 }}
                  />
                ) : (
                  <div>{row.difficultyScore != null ? row.difficultyScore.toFixed(2) : ""}</div>
                )}
                <div style={{ color: "var(--text-secondary)" }}>解析</div>
                {previewModalMode === "edit" ? (
                  <textarea value={previewExplanationDraft} onChange={(e) => setPreviewExplanationDraft(e.target.value)} rows={4} style={{ width: "100%" }} />
                ) : (
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{row.explanation || "-"}</div>
                )}
              </div>
              <div style={{ marginTop: 14, display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button type="button" className="btn-secondary" onClick={() => setEditingPreviewRowId(null)}>
                  关闭
                </button>
                {previewModalMode === "edit" && (
                  <button type="button" className="btn-primary" onClick={savePreviewRow}>
                    保存修改
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}

function ImportExercisesPanel() {
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [courses, setCourses] = useState<CourseItem[]>([]);
  const [chapters, setChapters] = useState<ChapterItem[]>([]);
  const [courseId, setCourseId] = useState<number | "">("");
  const [chapterIds, setChapterIds] = useState<number[]>([]);
  const [bankType, setBankType] = useState<QuestionBankType>("training");
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [previewRows, setPreviewRows] = useState<
    {
      id: number;
      courseName: string;
      chapterId: number | "";
      chapterName: string;
      questionType: string;
      questionTypeKey: "single_choice" | "multiple_choice" | "judge" | "blank" | "qa";
      questionText: string;
      optionsText: string;
      correctAnswer: string;
      explanation: string;
      status: "pending" | "approved";
      difficultyScore: number | null;
    }[]
  >([]);
  const [previewModalMode, setPreviewModalMode] = useState<"view" | "edit">("view");
  const [editingPreviewRowId, setEditingPreviewRowId] = useState<number | null>(null);
  const [previewQuestionTypeDraft, setPreviewQuestionTypeDraft] = useState<"single_choice" | "multiple_choice" | "judge" | "blank" | "qa">("single_choice");
  const [previewChapterIdDraft, setPreviewChapterIdDraft] = useState<number | "">("");
  const [previewQuestionTextDraft, setPreviewQuestionTextDraft] = useState("");
  const [previewOptionsDraft, setPreviewOptionsDraft] = useState("");
  const [previewAnswerDraft, setPreviewAnswerDraft] = useState("");
  const [previewExplanationDraft, setPreviewExplanationDraft] = useState("");
  const [previewStatusDraft, setPreviewStatusDraft] = useState<"pending" | "approved">("pending");
  const [previewDifficultyScoreDraft, setPreviewDifficultyScoreDraft] = useState("0.8");
  const [previewCurrentPage, setPreviewCurrentPage] = useState(1);
  const [previewPageSize, setPreviewPageSize] = useState(10);
  const previewTotalPages = Math.max(1, Math.ceil(previewRows.length / previewPageSize));
  const pagedPreviewRows = useMemo(() => {
    const start = (previewCurrentPage - 1) * previewPageSize;
    return previewRows.slice(start, start + previewPageSize);
  }, [previewRows, previewCurrentPage, previewPageSize]);
  const questionTypeLabel: Record<"single_choice" | "multiple_choice" | "judge" | "blank" | "qa", string> = {
    single_choice: "单选题",
    multiple_choice: "多选题",
    judge: "判断题",
    blank: "填空题",
    qa: "问答题",
  };

  useEffect(() => {
    setLoadingCourses(true);
    api.teacher.courses
      .list()
      .then((rows) => {
        const mapped = rows.map((c) => ({ id: c.id, name: c.name }));
        setCourses(mapped);
        if (mapped.length) setCourseId(mapped[0].id);
      })
      .catch((e: any) => {
        toast(e?.message || "课程加载失败", "error");
        setCourses([]);
      })
      .finally(() => setLoadingCourses(false));
  }, []);

  useEffect(() => {
    if (!courseId) {
      setChapters([]);
      setChapterIds([]);
      return;
    }
    setLoadingChapters(true);
    api.teacher.courses
      .chapters(courseId)
      .then((rows) => {
        const mapped = rows.map((ch) => ({ id: ch.id, title: ch.title }));
        setChapters(mapped);
        setChapterIds(mapped.map((x) => x.id));
      })
      .catch((e: any) => {
        toast(e?.message || "章节加载失败", "error");
        setChapters([]);
        setChapterIds([]);
      })
      .finally(() => setLoadingChapters(false));
  }, [courseId]);

  const toggleChapter = (id: number) => {
    setChapterIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const allChaptersSelected = chapters.length > 0 && chapterIds.length === chapters.length;
  const toggleAllChapters = (checked: boolean) => {
    setChapterIds(checked ? chapters.map((x) => x.id) : []);
  };
  const chapterSelectedSummary = useMemo(() => {
    const selectedTitles = chapters
      .filter((ch) => chapterIds.includes(ch.id))
      .map((ch) => ch.title.trim())
      .filter((x) => !!x)
      .join("；");
    if (!selectedTitles) return "";
    let hanCount = 0;
    let truncated = false;
    const out: string[] = [];
    for (const ch of Array.from(selectedTitles)) {
      const isHan = /[\u4e00-\u9fff]/.test(ch);
      if (isHan && hanCount >= 64) {
        truncated = true;
        break;
      }
      out.push(ch);
      if (isHan) hanCount += 1;
    }
    const text = truncated ? `${out.join("")}...` : selectedTitles;
    return `。${text}`;
  }, [chapters, chapterIds]);

  const resetForm = () => {
    setBankType("training");
    setPickedFiles([]);
    setPreviewRows([]);
    setPreviewCurrentPage(1);
    setChapterIds(chapters.map((x) => x.id));
  };
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(previewRows.length / previewPageSize));
    setPreviewCurrentPage((p) => Math.min(p, maxPage));
  }, [previewRows.length, previewPageSize]);

  const chooseFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const next = Array.from(files).filter((f) => /\.(doc|docx|pdf)$/i.test(f.name));
    if (!next.length) {
      toast("仅支持 .doc/.docx/.pdf 文件", "error");
      return;
    }
    setPickedFiles((prev) => [...prev, ...next]);
  };

  const uploadFiles = async () => {
    if (!courseId) return toast("请先选择课程", "error");
    if (!chapterIds.length) return toast("请至少选择一个章节", "error");
    if (!pickedFiles.length) return toast("请先选择文件", "error");
    setUploading(true);
    try {
      const form = new FormData();
      form.append("course_id", String(courseId));
      form.append("chapter_ids", JSON.stringify(chapterIds));
      form.append("question_bank_type", bankType);
      pickedFiles.forEach((f) => form.append("files", f));
      const resp = await api.teacher.courses.importQuestionsPreview(form);
      const courseName = courses.find((c) => c.id === courseId)?.name || "未知课程";
      const chapterName = chapterIds.length === chapters.length ? "全部章节" : `${chapterIds.length}个章节`;
      const base = Date.now();
      const questionTypeLabel: Record<string, string> = {
        single_choice: "单选题",
        multiple_choice: "多选题",
        judge: "判断题",
        blank: "填空题",
        qa: "问答题",
      };
      const rows = (resp.items || []).map((item: any, idx: number) => {
        const rawDiff = item?.difficulty_score;
        const difficultyScore: number | null =
          rawDiff != null && Number.isFinite(Number(rawDiff)) && Number(rawDiff) >= 0 && Number(rawDiff) <= 1
            ? Number(Number(rawDiff).toFixed(2))
            : null;
        return {
          id: base + idx,
          courseName,
          chapterId: (Number.isFinite(Number(item.chapter_id)) && Number(item.chapter_id) > 0 ? Number(item.chapter_id) : "") as number | "",
          chapterName: (item.chapter_title || "").trim() || chapterName,
          questionType: questionTypeLabel[item.question_type] || item.question_type || "待识别",
          questionTypeKey: (["single_choice", "multiple_choice", "judge", "blank", "qa"].includes(item.question_type) ? item.question_type : "qa") as
            | "single_choice"
            | "multiple_choice"
            | "judge"
            | "blank"
            | "qa",
          questionText: item.question_text || "",
          optionsText: (item.options || []).length ? (item.options || []).join("；") : "-",
          correctAnswer: item.correct_answer || "",
          explanation: item.explanation || "",
          status: "pending" as const,
          difficultyScore,
        };
      });
      if (!rows.length) throw new Error("未识别到可导入题目");
      setPreviewRows((prev) => [...rows, ...prev]);
      toast(`已识别并加入预览：${rows.length} 条`, "success");
    } catch (e: any) {
      toast(e?.message || "上传识别失败", "error");
    } finally {
      setUploading(false);
    }
  };

  const openPreviewModal = (rowId: number, mode: "view" | "edit") => {
    const row = previewRows.find((x) => x.id === rowId);
    if (!row) return;
    setPreviewModalMode(mode);
    setEditingPreviewRowId(rowId);
    setPreviewChapterIdDraft(row.chapterId);
    setPreviewQuestionTypeDraft(row.questionTypeKey);
    setPreviewQuestionTextDraft(row.questionText || "");
    setPreviewOptionsDraft(row.optionsText && row.optionsText !== "-" ? row.optionsText.split("；").join("\n") : "");
    setPreviewAnswerDraft(row.correctAnswer || "");
    setPreviewExplanationDraft(row.explanation || "");
    setPreviewStatusDraft(row.status);
    setPreviewDifficultyScoreDraft(row.difficultyScore != null ? String(row.difficultyScore) : "");
  };

  const savePreviewRow = () => {
    if (!editingPreviewRowId) return;
    const qText = previewQuestionTextDraft.trim();
    const ans = previewAnswerDraft.trim();
    if (!qText) return toast("题目内容不能为空", "error");
    if (!ans) return toast("答案不能为空", "error");
    const optionsList = previewOptionsDraft
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => !!x);
    const needOptions = previewQuestionTypeDraft === "single_choice" || previewQuestionTypeDraft === "multiple_choice";
    if (needOptions && optionsList.length < 2) return toast("选择题至少需要2个选项", "error");
    const diffStr = previewDifficultyScoreDraft.trim();
    const difficultyScore: number | null =
      diffStr === ""
        ? null
        : (() => {
            const d = Number(diffStr);
            if (!Number.isFinite(d) || d < 0 || d > 1) return null;
            return Number(d.toFixed(2));
          })();
    if (diffStr !== "" && difficultyScore === null) return toast("难度系数需在 0~1 或留空", "error");
    const optionsText = needOptions ? optionsList.join("；") : "-";
    const questionType = questionTypeLabel[previewQuestionTypeDraft];
    const draftChapterId = previewChapterIdDraft === "" ? "" : Number(previewChapterIdDraft);
    const nextChapter = chapters.find((x) => x.id === draftChapterId);
    setPreviewRows((prev) =>
      prev.map((x) =>
        x.id === editingPreviewRowId
          ? {
              ...x,
              chapterId: draftChapterId,
              chapterName: nextChapter?.title || x.chapterName,
              questionType,
              questionTypeKey: previewQuestionTypeDraft,
              questionText: qText,
              optionsText,
              correctAnswer: ans,
              explanation: previewExplanationDraft.trim(),
              status: previewStatusDraft,
              difficultyScore: difficultyScore ?? null,
            }
          : x
      )
    );
    toast("预览数据已更新", "success");
    setEditingPreviewRowId(null);
  };

  const [confirming, setConfirming] = useState(false);
  const confirmImport = async () => {
    if (!courseId) return toast("请先选择课程", "error");
    if (!chapterIds.length) return toast("请至少选择一个章节", "error");
    if (!previewRows.length) return toast("预览表格为空，请先上传并解析题目", "error");
    const fallbackChapterId = chapterIds[0];
    const items = previewRows.map((row) => {
      const chapterId =
        row.chapterId !== "" && Number.isFinite(Number(row.chapterId)) ? Number(row.chapterId) : fallbackChapterId;
      const options =
        row.optionsText && row.optionsText !== "-"
          ? row.optionsText.split("；").map((s) => s.trim()).filter(Boolean)
          : [];
      return {
        chapter_id: chapterId,
        question_type: row.questionTypeKey,
        question_text: row.questionText,
        options,
        correct_answer: row.correctAnswer,
        explanation: row.explanation || null,
        difficulty_score: row.difficultyScore,
      };
    });
    setConfirming(true);
    try {
      const res = await api.teacher.courses.importQuestionsConfirm({
        course_id: courseId,
        question_bank_type: bankType,
        items,
      });
      toast(res.message || `已导入 ${res.imported_count} 道题目`, "success");
      setPreviewRows([]);
    } catch (e: any) {
      toast(e?.message || "导入失败", "error");
    } finally {
      setConfirming(false);
    }
  };

  return (
    <>
      <h2 style={{ marginTop: 0, marginBottom: 4, fontSize: 20, fontWeight: 700 }}>导入习题</h2>
      <p style={{ margin: "0 0 12px", fontSize: 14, color: "var(--text-secondary)" }}>
        可以自动识别试卷等文件中记录的习题和答案并导入
      </p>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 10,
          minHeight: 380,
          padding: 14,
          background: "var(--bg-elevated)",
          color: "var(--text-primary)",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 10 }}>【基础筛选】</div>
        <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", rowGap: 10, columnGap: 12, alignItems: "start" }}>
          <div style={{ color: "var(--text-secondary)", paddingTop: 8 }}>课程</div>
          <select
            value={courseId === "" ? "" : String(courseId)}
            onChange={(e) => setCourseId(e.target.value ? Number(e.target.value) : "")}
            disabled={loadingCourses}
          >
            {!courses.length && <option value="">暂无课程</option>}
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name}
              </option>
            ))}
          </select>

          <div style={{ color: "var(--text-secondary)", paddingTop: 8 }}>章节</div>
          <div>
            <details>
              <summary
                style={{
                  listStyle: "none",
                  cursor: "pointer",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  background: "var(--bg-base)",
                  color: "var(--text-primary)",
                  userSelect: "none",
                }}
              >
                {loadingChapters ? "章节加载中..." : `已选 ${chapterIds.length} / ${chapters.length || 0} 个章节${chapterSelectedSummary}`}
              </summary>
              <div
                style={{
                  marginTop: 8,
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: 10,
                  display: "grid",
                  gap: 8,
                  maxHeight: 220,
                  overflowY: "auto",
                  background: "var(--bg-base)",
                }}
              >
                {!loadingChapters && !!chapters.length && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600 }}>
                    <input type="checkbox" checked={allChaptersSelected} onChange={(e) => toggleAllChapters(e.target.checked)} />
                    全部章节
                  </label>
                )}
                {loadingChapters && <span style={{ color: "var(--text-muted)" }}>加载中...</span>}
                {!loadingChapters &&
                  chapters.map((ch) => (
                    <label key={ch.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                      <input type="checkbox" checked={chapterIds.includes(ch.id)} onChange={() => toggleChapter(ch.id)} />
                      {ch.title}
                    </label>
                  ))}
                {!loadingChapters && !chapters.length && <span style={{ color: "var(--text-muted)" }}>暂无章节</span>}
              </div>
            </details>
          </div>

          <div style={{ color: "var(--text-secondary)", alignSelf: "center" }}>导入习题库类型</div>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", minHeight: 38 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 16 }}>
              <input type="radio" name="import-exercise-bank-type" checked={bankType === "training"} onChange={() => setBankType("training")} />
              训练库
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="radio" name="import-exercise-bank-type" checked={bankType === "exam"} onChange={() => setBankType("exam")} />
              考试库
            </label>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>【导入规则说明】</div>
          <div style={{ color: "var(--text-secondary)", fontSize: 14 }}>支持上传文件格式：Word（.doc/.docx）、PDF（.pdf）。</div>
          <div style={{ color: "var(--text-secondary)", fontSize: 14 }}>未点击确认导入前，状态为“待审核”，可编辑/删除。</div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>【文件上传区域】</div>
          <label
            htmlFor="exercise-import-files"
            style={{
              display: "block",
              border: "1px dashed var(--border)",
              borderRadius: 10,
              padding: 16,
              background: "var(--bg-hover)",
              cursor: "pointer",
            }}
          >
            点击选择文件 / 拖拽文件至此处（支持多文件）
            <div style={{ marginTop: 8, color: "var(--text-secondary)", fontSize: 13 }}>
              已选文件：{pickedFiles.length ? pickedFiles.map((f) => f.name).join("、") : "无"}
            </div>
          </label>
          <input
            id="exercise-import-files"
            type="file"
            multiple
            accept=".doc,.docx,.pdf"
            style={{ display: "none" }}
            onChange={(e) => chooseFiles(e.target.files)}
          />
          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="btn-secondary" onClick={() => document.getElementById("exercise-import-files")?.click()}>
              选择文件
            </button>
            <button type="button" className="btn-primary" onClick={uploadFiles} disabled={uploading}>
              {uploading ? "上传中..." : "上传文件"}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setPickedFiles([])}>
              清空文件
            </button>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>【导入后习题预览】</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 920 }}>
              <thead>
                <tr>
                  {["序号", "课程", "章节", "题型", "题干", "选项", "答案", "解析", "难度系数", "状态", "操作"].map((h) => (
                    <th key={h} style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedPreviewRows.map((row, idx) => (
                  <tr key={row.id}>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{(previewCurrentPage - 1) * previewPageSize + idx + 1}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.courseName}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.chapterName}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.questionType}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.questionText}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.optionsText}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.correctAnswer || "-"}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.explanation || "-"}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.difficultyScore != null ? row.difficultyScore.toFixed(2) : ""}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.status === "approved" ? "已确认" : "待确认"}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button type="button" className="btn-ghost" style={{ minHeight: 30, padding: "4px 8px" }} onClick={() => openPreviewModal(row.id, "view")}>
                          查看
                        </button>
                        <button type="button" className="btn-ghost" style={{ minHeight: 30, padding: "4px 8px" }} onClick={() => openPreviewModal(row.id, "edit")}>
                          编辑
                        </button>
                        <button type="button" className="btn-ghost" style={{ minHeight: 30, padding: "4px 8px" }} onClick={() => setPreviewRows((prev) => prev.filter((x) => x.id !== row.id))}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>每页显示</span>
            <select
              value={String(previewPageSize)}
              onChange={(e) => {
                const n = Math.max(1, Math.min(100, Number(e.target.value || 10)));
                setPreviewPageSize(n);
                setPreviewCurrentPage(1);
              }}
            >
              {[10, 20, 30, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button type="button" className="btn-secondary" onClick={() => setPreviewCurrentPage((p) => Math.max(1, p - 1))} disabled={previewCurrentPage <= 1}>
              上一页
            </button>
            <button type="button" className="btn-secondary" onClick={() => setPreviewCurrentPage((p) => Math.min(previewTotalPages, p + 1))} disabled={previewCurrentPage >= previewTotalPages}>
              下一页
            </button>
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              第 {previewCurrentPage} / {previewTotalPages} 页，共 {previewRows.length} 条
            </span>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14, display: "flex", gap: 10 }}>
          <button type="button" className="btn-secondary" onClick={resetForm}>
            重置
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={confirmImport}
            disabled={confirming || !previewRows.length}
          >
            {confirming ? "导入中..." : "确认导入"}
          </button>
        </div>
      </div>
      {editingPreviewRowId !== null && (() => {
        const row = previewRows.find((x) => x.id === editingPreviewRowId);
        if (!row) return null;
        return (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0, 0, 0, 0.55)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 2000,
              padding: 16,
            }}
            onClick={() => setEditingPreviewRowId(null)}
          >
            <div className="card" style={{ width: "min(760px, 100%)", maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ marginTop: 0, marginBottom: 10 }}>{previewModalMode === "edit" ? "编辑习题" : "查看习题"}</h3>
              <div style={{ display: "grid", gridTemplateColumns: "100px minmax(0,1fr)", rowGap: 10, columnGap: 10 }}>
                <div style={{ color: "var(--text-secondary)" }}>课程</div>
                <div>{row.courseName}</div>
                <div style={{ color: "var(--text-secondary)" }}>章节</div>
                {previewModalMode === "edit" ? (
                  <select value={previewChapterIdDraft === "" ? "" : String(previewChapterIdDraft)} onChange={(e) => setPreviewChapterIdDraft(e.target.value ? Number(e.target.value) : "")}>
                    {!chapterIds.length && <option value="">暂无章节</option>}
                    {chapters
                      .filter((ch) => chapterIds.includes(ch.id))
                      .map((ch) => (
                        <option key={ch.id} value={ch.id}>
                          {ch.title}
                        </option>
                      ))}
                  </select>
                ) : (
                  <div>{row.chapterName}</div>
                )}
                <div style={{ color: "var(--text-secondary)" }}>题型</div>
                {previewModalMode === "edit" ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    {(["single_choice", "multiple_choice", "judge", "blank", "qa"] as const).map((k) => (
                      <label key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <input type="radio" name="preview-question-type" checked={previewQuestionTypeDraft === k} onChange={() => setPreviewQuestionTypeDraft(k)} />
                        {questionTypeLabel[k]}
                      </label>
                    ))}
                  </div>
                ) : (
                  <div>{row.questionType}</div>
                )}
                <div style={{ color: "var(--text-secondary)" }}>题目内容</div>
                {previewModalMode === "edit" ? (
                  <textarea value={previewQuestionTextDraft} onChange={(e) => setPreviewQuestionTextDraft(e.target.value)} rows={4} style={{ width: "100%" }} />
                ) : (
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{row.questionText}</div>
                )}
                <div style={{ color: "var(--text-secondary)" }}>选项</div>
                {previewModalMode === "edit" ? (
                  <textarea value={previewOptionsDraft} onChange={(e) => setPreviewOptionsDraft(e.target.value)} rows={4} placeholder="每行一个选项" style={{ width: "100%" }} />
                ) : (
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{row.optionsText || "-"}</div>
                )}
                <div style={{ color: "var(--text-secondary)" }}>答案</div>
                {previewModalMode === "edit" ? (
                  <textarea value={previewAnswerDraft} onChange={(e) => setPreviewAnswerDraft(e.target.value)} rows={3} style={{ width: "100%" }} />
                ) : (
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{row.correctAnswer || "-"}</div>
                )}
                <div style={{ color: "var(--text-secondary)" }}>难度系数</div>
                {previewModalMode === "edit" ? (
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={previewDifficultyScoreDraft}
                    onChange={(e) => setPreviewDifficultyScoreDraft(e.target.value)}
                    placeholder="0~1，留空表示未识别"
                    style={{ width: 160 }}
                  />
                ) : (
                  <div>{row.difficultyScore != null ? row.difficultyScore.toFixed(2) : ""}</div>
                )}
                <div style={{ color: "var(--text-secondary)" }}>解析</div>
                {previewModalMode === "edit" ? (
                  <textarea value={previewExplanationDraft} onChange={(e) => setPreviewExplanationDraft(e.target.value)} rows={4} style={{ width: "100%" }} />
                ) : (
                  <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{row.explanation || "-"}</div>
                )}
                <div style={{ color: "var(--text-secondary)" }}>状态</div>
                {previewModalMode === "edit" ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <input type="radio" name="preview-status" checked={previewStatusDraft === "pending"} onChange={() => setPreviewStatusDraft("pending")} />
                      待确认
                    </label>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <input type="radio" name="preview-status" checked={previewStatusDraft === "approved"} onChange={() => setPreviewStatusDraft("approved")} />
                      已确认
                    </label>
                  </div>
                ) : (
                  <div>{row.status === "approved" ? "已确认" : "待确认"}</div>
                )}
              </div>
              <div style={{ marginTop: 14, display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button type="button" className="btn-secondary" onClick={() => setEditingPreviewRowId(null)}>
                  关闭
                </button>
                {previewModalMode === "edit" && (
                  <button type="button" className="btn-primary" onClick={savePreviewRow}>
                    保存修改
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}

function ExerciseManagePanel() {
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [loadingKnowledgePoints, setLoadingKnowledgePoints] = useState(false);
  const [querying, setQuerying] = useState(false);

  const [courses, setCourses] = useState<CourseItem[]>([]);
  const [chapters, setChapters] = useState<ChapterItem[]>([]);
  const [knowledgePoints, setKnowledgePoints] = useState<Array<{ id: number; title: string; chapterId: number }>>([]);
  const [rows, setRows] = useState<
    {
      id: number;
      courseName: string;
      chapterId: number;
      chapterName: string;
      questionType: string;
      difficultyScore: number;
      knowledgePoints: string[];
      remark: string;
      bankType: "training" | "exam";
      status: "pending" | "approved";
      questionText: string;
      options: string[];
      correctAnswer: string;
      explanation: string;
      knowledgePointIds: number[];
      generatedTime: string | null;
      editedTime: string | null;
    }[]
  >([]);

  const [courseId, setCourseId] = useState<number | "">("");
  const [chapterIds, setChapterIds] = useState<number[]>([]);
  const [knowledgePointIds, setKnowledgePointIds] = useState<number[]>([]);
  const [bankTypeFilter, setBankTypeFilter] = useState<"" | "training" | "exam">("");
  const [questionTypeFilter, setQuestionTypeFilter] = useState<"" | QuestionTypeKey>("");
  const [statusFilter, setStatusFilter] = useState<"" | "pending" | "approved">("");
  const [difficultyMin, setDifficultyMin] = useState(0);
  const [difficultyMax, setDifficultyMax] = useState(1);
  const [editingRow, setEditingRow] = useState<{
    id: number;
    questionText: string;
    courseName: string;
    chapterId: number;
    chapterName: string;
    questionType: string;
    status: "pending" | "approved";
    remark: string;
    bankType: "training" | "exam";
    knowledgePoints: string[];
    knowledgePointIds: number[];
    options: string[];
    correctAnswer: string;
    explanation: string;
    difficultyScore: number;
    generatedTime: string | null;
    editedTime: string | null;
  } | null>(null);
  const [questionModalMode, setQuestionModalMode] = useState<"view" | "edit">("view");
  const [remarkDraft, setRemarkDraft] = useState("");
  const [questionTextDraft, setQuestionTextDraft] = useState("");
  const [optionsDraft, setOptionsDraft] = useState("");
  const [correctAnswerDraft, setCorrectAnswerDraft] = useState("");
  const [explanationDraft, setExplanationDraft] = useState("");
  const [difficultyScoreDraft, setDifficultyScoreDraft] = useState("0.8");
  const [bankTypeDraft, setBankTypeDraft] = useState<"training" | "exam">("training");
  const [statusDraft, setStatusDraft] = useState<"pending" | "approved">("pending");
  const [modalKnowledgeOptions, setModalKnowledgeOptions] = useState<Array<{ id: number; title: string }>>([]);
  const [modalKnowledgePointIdsDraft, setModalKnowledgePointIdsDraft] = useState<number[]>([]);
  const [loadingModalKnowledge, setLoadingModalKnowledge] = useState(false);
  const [savingRemark, setSavingRemark] = useState(false);
  const [deletingBatch, setDeletingBatch] = useState(false);
  const [exportingList, setExportingList] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [pageSize, setPageSize] = useState(10);
  const [generatedTimeSortOrder, setGeneratedTimeSortOrder] = useState<"none" | "asc" | "desc">("none");
  const [autoQueried, setAutoQueried] = useState(false);

  const typeLabel: Record<QuestionTypeKey, string> = {
    single_choice: "单选题",
    multiple_choice: "多选题",
    judge: "判断题",
    blank: "填空题",
    qa: "问答题",
  };

  const sortedRows = useMemo(() => {
    if (generatedTimeSortOrder === "none") return rows;
    const toTs = (value: string | null) => {
      if (!value) return Number.NaN;
      const normalized = /^\d{4}-\d{2}-\d{2}\s/.test(value) ? value.replace(" ", "T") : value;
      const ts = Date.parse(normalized);
      return Number.isFinite(ts) ? ts : Number.NaN;
    };
    return [...rows].sort((a, b) => {
      const aTs = toTs(a.generatedTime);
      const bTs = toTs(b.generatedTime);
      const aValid = Number.isFinite(aTs);
      const bValid = Number.isFinite(bTs);
      if (!aValid && !bValid) return 0;
      if (!aValid) return 1;
      if (!bValid) return -1;
      return generatedTimeSortOrder === "asc" ? aTs - bTs : bTs - aTs;
    });
  }, [rows, generatedTimeSortOrder]);
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const pagedRows = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedRows.slice(start, start + pageSize);
  }, [sortedRows, currentPage, pageSize]);
  const truncateByHanCount = (text: string, maxHan: number) => {
    let hanCount = 0;
    let truncated = false;
    const out: string[] = [];
    for (const ch of Array.from(text)) {
      const isHan = /[\u4e00-\u9fff]/.test(ch);
      if (isHan && hanCount >= maxHan) {
        truncated = true;
        break;
      }
      out.push(ch);
      if (isHan) hanCount += 1;
    }
    return truncated ? `${out.join("")}...` : text;
  };
  const chapterSelectedSummary = useMemo(() => {
    const selectedTitles = chapters
      .filter((ch) => chapterIds.includes(ch.id))
      .map((ch) => ch.title.trim())
      .filter((x) => !!x)
      .join("；");
    return selectedTitles ? `。${truncateByHanCount(selectedTitles, 64)}` : "";
  }, [chapters, chapterIds]);
  const knowledgeSelectedSummary = useMemo(() => {
    const selectedTitles = knowledgePoints
      .filter((kp) => knowledgePointIds.includes(kp.id))
      .map((kp) => kp.title.trim())
      .filter((x) => !!x)
      .join("；");
    return selectedTitles ? `。${truncateByHanCount(selectedTitles, 64)}` : "";
  }, [knowledgePoints, knowledgePointIds]);
  const modalSelectedKnowledgeSummary = useMemo(() => {
    if (!modalKnowledgeOptions.length || !modalKnowledgePointIdsDraft.length) return "";
    const selectedTitles = modalKnowledgeOptions
      .filter((kp) => modalKnowledgePointIdsDraft.includes(kp.id))
      .map((kp) => kp.title.trim())
      .filter((x) => !!x);
    return truncateByHanCount(selectedTitles.join("；"), 64);
  }, [modalKnowledgeOptions, modalKnowledgePointIdsDraft]);

  useEffect(() => {
    setLoadingCourses(true);
    api.teacher.courses
      .list()
      .then((list) => {
        const mapped = list.map((c) => ({ id: c.id, name: c.name }));
        setCourses(mapped);
        if (mapped.length) setCourseId(mapped[0].id);
      })
      .catch((e: any) => {
        toast(e?.message || "课程加载失败", "error");
        setCourses([]);
      })
      .finally(() => setLoadingCourses(false));
  }, []);

  useEffect(() => {
    if (!courseId) {
      setChapters([]);
      setChapterIds([]);
      setKnowledgePoints([]);
      setKnowledgePointIds([]);
      setRows([]);
      return;
    }
    setLoadingChapters(true);
    api.teacher.courses
      .chapters(courseId)
      .then((list) => {
        const mapped = list.map((ch) => ({ id: ch.id, title: ch.title }));
        setChapters(mapped);
        setChapterIds(mapped.map((x) => x.id));
      })
      .catch((e: any) => {
        toast(e?.message || "章节加载失败", "error");
        setChapters([]);
        setChapterIds([]);
        setKnowledgePoints([]);
        setKnowledgePointIds([]);
      })
      .finally(() => setLoadingChapters(false));
  }, [courseId]);

  useEffect(() => {
    if (!courseId || !chapterIds.length) {
      setKnowledgePoints([]);
      setKnowledgePointIds([]);
      return;
    }
    setLoadingKnowledgePoints(true);
    Promise.all(
      chapterIds.map((id) =>
        api.teacher.courses
          .chapterKnowledgePoints(id)
          .then((rows) => rows.map((kp) => ({ id: kp.id, title: kp.title, chapterId: id })))
          .catch(() => [])
      )
    )
      .then((parts) => {
        const merged = parts.flat();
        setKnowledgePoints(merged);
        setKnowledgePointIds(merged.map((x) => x.id));
      })
      .catch(() => {
        setKnowledgePoints([]);
        setKnowledgePointIds([]);
      })
      .finally(() => setLoadingKnowledgePoints(false));
  }, [courseId, chapterIds]);

  const allChaptersSelected = chapters.length > 0 && chapterIds.length === chapters.length;
  const toggleAllChapters = (checked: boolean) => {
    setChapterIds(checked ? chapters.map((x) => x.id) : []);
  };
  const toggleChapter = (id: number) => {
    setChapterIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const allKnowledgePointsSelected = knowledgePoints.length > 0 && knowledgePointIds.length === knowledgePoints.length;
  const toggleAllKnowledgePoints = (checked: boolean) => {
    setKnowledgePointIds(checked ? knowledgePoints.map((x) => x.id) : []);
  };
  const toggleKnowledgePoint = (id: number) => {
    setKnowledgePointIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const resetFilter = () => {
    setBankTypeFilter("");
    setQuestionTypeFilter("");
    setStatusFilter("");
    setDifficultyMin(0);
    setDifficultyMax(1);
    setChapterIds(chapters.map((x) => x.id));
    setKnowledgePointIds(knowledgePoints.map((x) => x.id));
    setGeneratedTimeSortOrder("none");
    setCurrentPage(1);
    setSelectedIds([]);
    setPageSize(10);
  };

  const runQuery = async () => {
    if (!courseId) return toast("请先选择课程", "error");
    if (!chapterIds.length) return toast("请至少选择一个章节", "error");
    if (difficultyMin > difficultyMax) return toast("难度区间不合法", "error");

    setQuerying(true);
    try {
      const chapterNameMap = new Map(chapters.map((x) => [x.id, x.title]));
      const courseName = courses.find((x) => x.id === courseId)?.name || "未知课程";
      const all = (
        await Promise.all(
          chapterIds.map((id) =>
            api.teacher.courses.chapterQuestions(id).catch(() => [])
          )
        )
      ).flat();

      const mapped = all.map((q) => ({
        id: q.id,
        courseName,
        chapterId: q.chapter_id,
        chapterName: q.chapter_title || chapterNameMap.get(q.chapter_id) || `章节${q.chapter_id}`,
        questionType: q.question_type,
        difficultyScore: Number(q.difficulty_score ?? 0.8),
        knowledgePoints: q.knowledge_points || [],
        remark: q.remark || "-",
        bankType: (q.question_bank_type === "exam" ? "exam" : "training") as "training" | "exam",
        status: (q.is_approved ? "approved" : "pending") as "pending" | "approved",
        questionText: q.question_text,
        options: (() => {
          try {
            const parsed = q.options ? JSON.parse(q.options) : [];
            return Array.isArray(parsed) ? parsed.map((x) => String(x || "")) : [];
          } catch {
            return [];
          }
        })(),
        correctAnswer: q.correct_answer || "",
        explanation: (q.explanation || "").trim() || "-",
        knowledgePointIds: (q.knowledge_point_ids || "")
          .split(",")
          .map((x) => Number(x.trim()))
          .filter((x) => Number.isFinite(x) && x > 0),
        generatedTime: q.generated_time || null,
        editedTime: q.edited_time || null,
      }));

      const filtered = mapped.filter((r) => {
        if (bankTypeFilter && r.bankType !== bankTypeFilter) return false;
        if (questionTypeFilter && r.questionType !== questionTypeFilter) return false;
        if (statusFilter && r.status !== statusFilter) return false;
        if (r.difficultyScore < difficultyMin || r.difficultyScore > difficultyMax) return false;
        if (!allKnowledgePointsSelected && knowledgePointIds.length > 0) {
          const hasAny = r.knowledgePointIds.some((id) => knowledgePointIds.includes(id));
          if (!hasAny) return false;
        }
        return true;
      });
      setRows(filtered);
      setCurrentPage(1);
      setSelectedIds([]);
    } catch (e: any) {
      toast(e?.message || "查询失败", "error");
      setRows([]);
      setCurrentPage(1);
      setSelectedIds([]);
    } finally {
      setQuerying(false);
    }
  };

  useEffect(() => {
    if (autoQueried) return;
    if (loadingCourses || loadingChapters) return;
    if (!courseId) return;
    if (!chapterIds.length) return;
    setAutoQueried(true);
    void runQuery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoQueried, loadingCourses, loadingChapters, courseId, chapterIds.length]);

  useEffect(() => {
    setCurrentPage((p) => Math.min(Math.max(1, p), totalPages));
    setSelectedIds((prev) => prev.filter((id) => rows.some((x) => x.id === id)));
  }, [rows, totalPages]);

  const allCurrentSelected = pagedRows.length > 0 && pagedRows.every((r) => selectedIds.includes(r.id));
  const toggleSelectAllCurrent = (checked: boolean) => {
    if (checked) {
      setSelectedIds(Array.from(new Set([...selectedIds, ...pagedRows.map((r) => r.id)])));
    } else {
      const current = new Set(pagedRows.map((r) => r.id));
      setSelectedIds(selectedIds.filter((id) => !current.has(id)));
    }
  };
  const toggleSelectOne = (id: number, checked: boolean) => {
    setSelectedIds((prev) => (checked ? Array.from(new Set([...prev, id])) : prev.filter((x) => x !== id)));
  };

  const batchDeleteQuestions = async () => {
    if (!selectedIds.length) {
      toast("请先选择要删除的习题", "error");
      return;
    }
    const ok = window.confirm(`确认删除已选择的 ${selectedIds.length} 道习题吗？删除后不可恢复。`);
    if (!ok) return;
    setDeletingBatch(true);
    try {
      await Promise.all(selectedIds.map((id) => api.teacher.courses.deleteQuestion(id)));
      setRows((prev) => prev.filter((x) => !selectedIds.includes(x.id)));
      toast(`已删除 ${selectedIds.length} 道习题`, "success");
      setSelectedIds([]);
    } catch (e: any) {
      toast(e?.message || "批量删除失败", "error");
    } finally {
      setDeletingBatch(false);
    }
  };

  const exportQuestionList = async () => {
    setExportingList(true);
    try {
      const esc = (s: string) => `"${String(s ?? "").replace(/"/g, '""')}"`;
      const header = ["ID", "题目内容", "章节", "题型", "难度系数", "关联知识点", "备注", "题库类型", "状态"];
      const lines = rows.map((r) =>
        [
          r.id,
          esc(r.questionText),
          esc(r.chapterName),
          esc(typeLabel[r.questionType as QuestionTypeKey] || r.questionType),
          r.difficultyScore.toFixed(2),
          esc(r.knowledgePoints.join("、")),
          esc(r.remark),
          r.bankType === "training" ? "训练库" : "考试库",
          r.status === "pending" ? "待审核" : "已审核",
        ].join(",")
      );
      const csv = "\ufeff" + header.join(",") + "\n" + lines.join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `习题列表_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("习题列表已导出", "success");
    } finally {
      setExportingList(false);
    }
  };

  const openQuestionModal = (
    row: {
      id: number;
      questionText: string;
      courseName: string;
      chapterId: number;
      chapterName: string;
      questionType: string;
      status: "pending" | "approved";
      remark: string;
      bankType: "training" | "exam";
      knowledgePoints: string[];
      knowledgePointIds: number[];
      options: string[];
      correctAnswer: string;
      explanation: string;
      difficultyScore: number;
      generatedTime: string | null;
      editedTime: string | null;
    },
    mode: "view" | "edit"
  ) => {
    setQuestionModalMode(mode);
    setEditingRow(row);
    setRemarkDraft(row.remark === "-" ? "" : row.remark);
    setQuestionTextDraft(row.questionText || "");
    setOptionsDraft((row.options || []).join("\n"));
    setCorrectAnswerDraft(row.correctAnswer || "");
    setExplanationDraft(row.explanation === "-" ? "" : row.explanation);
    setDifficultyScoreDraft(String(Number.isFinite(row.difficultyScore) ? row.difficultyScore : 0.8));
    setBankTypeDraft(row.bankType);
    setStatusDraft(row.status);
    setModalKnowledgePointIdsDraft(row.knowledgePointIds || []);
    setLoadingModalKnowledge(true);
    api.teacher.courses
      .chapterKnowledgePoints(row.chapterId)
      .then((list) => {
        const options = (list || []).map((kp) => ({ id: kp.id, title: kp.title }));
        setModalKnowledgeOptions(options);
        const validIds = new Set(options.map((x) => x.id));
        setModalKnowledgePointIdsDraft((row.knowledgePointIds || []).filter((id) => validIds.has(id)));
      })
      .catch(() => {
        setModalKnowledgeOptions([]);
        setModalKnowledgePointIdsDraft([]);
      })
      .finally(() => setLoadingModalKnowledge(false));
  };

  const saveQuestion = async () => {
    if (!editingRow) return;
    if (questionModalMode !== "edit") return;
    const text = questionTextDraft.trim();
    const answer = correctAnswerDraft.trim();
    const diff = Number(difficultyScoreDraft);
    if (!text) {
      toast("题目内容不能为空", "error");
      return;
    }
    if (!answer) {
      toast("参考答案不能为空", "error");
      return;
    }
    if (!Number.isFinite(diff) || diff < 0 || diff > 1) {
      toast("难度系数需在 0~1", "error");
      return;
    }
    const trimmed = remarkDraft.trim();
    if (trimmed.length > 128) {
      toast("备注最多 128 字", "error");
      return;
    }
    const optionsList = optionsDraft
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => !!x);
    setSavingRemark(true);
    try {
      const updated = await api.teacher.courses.updateQuestion(editingRow.id, {
        question_text: text,
        options: optionsList.length ? optionsList : null,
        correct_answer: answer,
        explanation: explanationDraft.trim() || null,
        difficulty_score: Number(diff.toFixed(2)),
        question_bank_type: bankTypeDraft,
        remark: trimmed || null,
        is_approved: statusDraft === "approved",
        knowledge_point_ids: modalKnowledgePointIdsDraft,
      });
      const nextRemark = (updated.remark || "").trim() || "-";
      const nextQuestionText = updated.question_text || text;
      const nextExplanation = (updated.explanation || "").trim() || "-";
      const nextOptions = (() => {
        try {
          const parsed = updated.options ? JSON.parse(updated.options) : [];
          return Array.isArray(parsed) ? parsed.map((x) => String(x || "")) : [];
        } catch {
          return optionsList;
        }
      })();
      const nextBankType = (updated.question_bank_type === "exam" ? "exam" : "training") as "training" | "exam";
      const nextStatus = (updated.is_approved ? "approved" : "pending") as "pending" | "approved";
      const nextDiff = Number(updated.difficulty_score ?? diff);
      const nextKnowledgePointIds = (updated.knowledge_point_ids || "")
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isFinite(x) && x > 0);
      const titleMap = new Map(modalKnowledgeOptions.map((x) => [x.id, x.title]));
      const nextKnowledgePoints =
        (updated.knowledge_points || []).length > 0
          ? (updated.knowledge_points || [])
          : nextKnowledgePointIds.map((id) => titleMap.get(id)).filter((x): x is string => !!x);
      setRows((prev) =>
        prev.map((x) =>
          x.id === editingRow.id
            ? {
                ...x,
                questionText: nextQuestionText,
                options: nextOptions,
                correctAnswer: updated.correct_answer || answer,
                explanation: nextExplanation,
                difficultyScore: nextDiff,
                bankType: nextBankType,
                status: nextStatus,
                knowledgePointIds: nextKnowledgePointIds,
                knowledgePoints: nextKnowledgePoints,
                remark: nextRemark,
                editedTime: updated.edited_time || x.editedTime,
              }
            : x
        )
      );
      setEditingRow((prev) =>
        prev
          ? {
              ...prev,
              questionText: nextQuestionText,
              options: nextOptions,
              correctAnswer: updated.correct_answer || answer,
              explanation: nextExplanation,
              difficultyScore: nextDiff,
              bankType: nextBankType,
              status: nextStatus,
              knowledgePointIds: nextKnowledgePointIds,
              knowledgePoints: nextKnowledgePoints,
              remark: nextRemark,
              editedTime: updated.edited_time || prev.editedTime,
            }
          : prev
      );
      setRemarkDraft(nextRemark === "-" ? "" : nextRemark);
      toast("习题已保存", "success");
    } catch (e: any) {
      toast(e?.message || "保存失败", "error");
    } finally {
      setSavingRemark(false);
    }
  };

  const deleteOneQuestion = async (id: number) => {
    const ok = window.confirm("确认删除此习题吗？删除后不可恢复。");
    if (!ok) return;
    try {
      await api.teacher.courses.deleteQuestion(id);
      setRows((prev) => prev.filter((x) => x.id !== id));
      setSelectedIds((prev) => prev.filter((x) => x !== id));
      if (editingRow?.id === id) setEditingRow(null);
      toast("删除成功", "success");
    } catch (e: any) {
      toast(e?.message || "删除失败", "error");
    }
  };

  return (
    <>
      <h2 style={{ marginTop: 0, marginBottom: 12, fontSize: 20, fontWeight: 700 }}>习题库查看/编辑</h2>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 10,
          minHeight: 380,
          padding: 14,
          background: "var(--bg-elevated)",
          color: "var(--text-primary)",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 10 }}>【高级筛选】</div>
        <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", rowGap: 10, columnGap: 12, alignItems: "start" }}>
          <div style={{ color: "var(--text-secondary)", paddingTop: 8 }}>课程</div>
          <select
            value={courseId === "" ? "" : String(courseId)}
            onChange={(e) => setCourseId(e.target.value ? Number(e.target.value) : "")}
            disabled={loadingCourses}
          >
            {!courses.length && <option value="">暂无课程</option>}
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name}
              </option>
            ))}
          </select>

          <div style={{ color: "var(--text-secondary)", paddingTop: 8 }}>章节</div>
          <div>
            <details>
              <summary
                style={{
                  listStyle: "none",
                  cursor: "pointer",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  background: "var(--bg-base)",
                  color: "var(--text-primary)",
                  userSelect: "none",
                }}
              >
                {loadingChapters ? "章节加载中..." : `已选 ${chapterIds.length} / ${chapters.length || 0} 个章节${chapterSelectedSummary}`}
              </summary>
              <div
                style={{
                  marginTop: 8,
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: 10,
                  display: "grid",
                  gap: 8,
                  maxHeight: 220,
                  overflowY: "auto",
                  background: "var(--bg-base)",
                }}
              >
                {!loadingChapters && !!chapters.length && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600 }}>
                    <input type="checkbox" checked={allChaptersSelected} onChange={(e) => toggleAllChapters(e.target.checked)} />
                    全部章节
                  </label>
                )}
                {loadingChapters && <span style={{ color: "var(--text-muted)" }}>加载中...</span>}
                {!loadingChapters &&
                  chapters.map((ch) => (
                    <label key={ch.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                      <input type="checkbox" checked={chapterIds.includes(ch.id)} onChange={() => toggleChapter(ch.id)} />
                      {ch.title}
                    </label>
                  ))}
              </div>
            </details>
          </div>

          <div style={{ color: "var(--text-secondary)", paddingTop: 8 }}>知识点</div>
          <div>
            <details>
              <summary
                style={{
                  listStyle: "none",
                  cursor: "pointer",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  background: "var(--bg-base)",
                  color: "var(--text-primary)",
                  userSelect: "none",
                }}
              >
                {loadingKnowledgePoints
                  ? "知识点加载中..."
                  : `已选 ${knowledgePointIds.length} / ${knowledgePoints.length || 0} 个知识点${knowledgeSelectedSummary}`}
              </summary>
              <div
                style={{
                  marginTop: 8,
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: 10,
                  display: "grid",
                  gap: 8,
                  maxHeight: 220,
                  overflowY: "auto",
                  background: "var(--bg-base)",
                }}
              >
                {!loadingKnowledgePoints && !!knowledgePoints.length && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600 }}>
                    <input type="checkbox" checked={allKnowledgePointsSelected} onChange={(e) => toggleAllKnowledgePoints(e.target.checked)} />
                    全部知识点
                  </label>
                )}
                {loadingKnowledgePoints && <span style={{ color: "var(--text-muted)" }}>加载中...</span>}
                {!loadingKnowledgePoints &&
                  knowledgePoints.map((kp) => (
                    <label key={kp.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                      <input type="checkbox" checked={knowledgePointIds.includes(kp.id)} onChange={() => toggleKnowledgePoint(kp.id)} />
                      {kp.title}
                    </label>
                  ))}
                {!loadingKnowledgePoints && !knowledgePoints.length && <span style={{ color: "var(--text-muted)" }}>暂无知识点</span>}
              </div>
            </details>
          </div>

          <div style={{ color: "var(--text-secondary)", alignSelf: "center" }}>题库类型</div>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", minHeight: 38 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 12 }}>
              <input type="radio" name="manage-bank-type" checked={bankTypeFilter === ""} onChange={() => setBankTypeFilter("")} />
              全部
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 12 }}>
              <input type="radio" name="manage-bank-type" checked={bankTypeFilter === "training"} onChange={() => setBankTypeFilter("training")} />
              训练库
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="radio" name="manage-bank-type" checked={bankTypeFilter === "exam"} onChange={() => setBankTypeFilter("exam")} />
              考试库
            </label>
          </div>

          <div style={{ color: "var(--text-secondary)", alignSelf: "center" }}>题目类型</div>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", minHeight: 38 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 12 }}>
              <input type="radio" name="manage-question-type" checked={questionTypeFilter === ""} onChange={() => setQuestionTypeFilter("")} />
              全部
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 12 }}>
              <input type="radio" name="manage-question-type" checked={questionTypeFilter === "single_choice"} onChange={() => setQuestionTypeFilter("single_choice")} />
              单选题
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 12 }}>
              <input type="radio" name="manage-question-type" checked={questionTypeFilter === "multiple_choice"} onChange={() => setQuestionTypeFilter("multiple_choice")} />
              多选题
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 12 }}>
              <input type="radio" name="manage-question-type" checked={questionTypeFilter === "judge"} onChange={() => setQuestionTypeFilter("judge")} />
              判断题
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 12 }}>
              <input type="radio" name="manage-question-type" checked={questionTypeFilter === "blank"} onChange={() => setQuestionTypeFilter("blank")} />
              填空题
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="radio" name="manage-question-type" checked={questionTypeFilter === "qa"} onChange={() => setQuestionTypeFilter("qa")} />
              问答题
            </label>
          </div>

          <div style={{ color: "var(--text-secondary)", paddingTop: 8 }}>难度系数</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="number" min={0} max={1} step={0.01} value={difficultyMin} onChange={(e) => setDifficultyMin(Math.max(0, Math.min(1, Number(e.target.value || 0))))} style={{ width: 120 }} />
            <span>~</span>
            <input type="number" min={0} max={1} step={0.01} value={difficultyMax} onChange={(e) => setDifficultyMax(Math.max(0, Math.min(1, Number(e.target.value || 0))))} style={{ width: 120 }} />
          </div>

          <div style={{ color: "var(--text-secondary)", paddingTop: 8 }}>状态</div>
          <div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 12 }}>
              <input type="radio" name="manage-status" checked={statusFilter === ""} onChange={() => setStatusFilter("")} />
              全部
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 12 }}>
              <input type="radio" name="manage-status" checked={statusFilter === "pending"} onChange={() => setStatusFilter("pending")} />
              待审核
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="radio" name="manage-status" checked={statusFilter === "approved"} onChange={() => setStatusFilter("approved")} />
              已审核
            </label>
          </div>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
          <button type="button" className="btn-primary" onClick={runQuery} disabled={querying}>
            {querying ? "查询中..." : "查询"}
          </button>
          <button type="button" className="btn-secondary" onClick={resetFilter}>
            重置筛选
          </button>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>【习题列表】</div>
          <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1080, tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: 36 }} />
                  <col style={{ width: 48 }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "6%" }} />
                  <col style={{ width: "10%" }} />
                  <col style={{ width: "auto" }} />
                  <col style={{ width: "auto" }} />
                  <col style={{ width: "auto" }} />
                  <col style={{ width: "auto" }} />
                  <col style={{ width: "auto" }} />
                  <col style={{ width: "clamp(3em, 8vw, 5em)" }} />
                  <col style={{ width: "auto" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>
                      <input type="checkbox" checked={allCurrentSelected} onChange={(e) => toggleSelectAllCurrent(e.target.checked)} />
                    </th>
                    {["序号", "题目内容", "选项", "答案", "解析", "章节", "关联知识点", "题型", "难度系数", "备注", "题库类型", "状态"].map((h) => (
                      <th key={h} style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>
                        {h}
                      </th>
                    ))}
                    <th
                      style={{
                        textAlign: "left",
                        border: "1px solid var(--border)",
                        padding: 8,
                        color: "var(--text-secondary)",
                        width: "clamp(3em, 8vw, 5em)",
                        maxWidth: "5em",
                        whiteSpace: "normal",
                        overflowWrap: "anywhere",
                      }}
                    >
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ minHeight: "auto", padding: 0, color: "inherit", fontWeight: 600 }}
                        onClick={() => setGeneratedTimeSortOrder((prev) => (prev === "none" ? "desc" : prev === "desc" ? "asc" : "none"))}
                      >
                        生成时间{generatedTimeSortOrder === "none" ? "" : generatedTimeSortOrder === "desc" ? " ↓" : " ↑"}
                      </button>
                    </th>
                    <th style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>操作</th>
                  </tr>
              </thead>
              <tbody>
                {pagedRows.map((row, idx) => (
                  <tr key={row.id}>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <input type="checkbox" checked={selectedIds.includes(row.id)} onChange={(e) => toggleSelectOne(row.id, e.target.checked)} />
                    </td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{(currentPage - 1) * pageSize + idx + 1}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8, wordBreak: "break-word", whiteSpace: "normal" }}>
                      {Array.from(row.questionText).length > 63 ? `${Array.from(row.questionText).slice(0, 63).join("")}...` : row.questionText}
                    </td>
                    <td style={{ border: "1px solid var(--border)", padding: 8, wordBreak: "break-word", whiteSpace: "normal" }}>
                      {row.options?.length ? row.options.join("；") : "-"}
                    </td>
                    <td style={{ border: "1px solid var(--border)", padding: 8, overflow: "hidden", wordBreak: "break-word" }}>{row.correctAnswer || "-"}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      {row.explanation ? (Array.from(row.explanation).length > 31 ? `${Array.from(row.explanation).slice(0, 31).join("")}...` : row.explanation) : "-"}
                    </td>
                    <td style={{ border: "1px solid var(--border)", padding: 8, wordBreak: "break-word", whiteSpace: "normal" }}>{row.chapterName}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.knowledgePoints.length ? row.knowledgePoints.join("、") : "-"}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{typeLabel[row.questionType as QuestionTypeKey] || row.questionType}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.difficultyScore.toFixed(2)}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.remark}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.bankType === "training" ? "训练库" : "考试库"}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.status === "pending" ? "待审核" : "已审核"}</td>
                    <td
                      style={{
                        border: "1px solid var(--border)",
                        padding: 8,
                        fontSize: 12,
                        lineHeight: 1.25,
                        width: "clamp(3em, 8vw, 5em)",
                        maxWidth: "5em",
                        whiteSpace: "normal",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {(() => {
                        if (!row.generatedTime) return "-";
                        const normalized = /^\d{4}-\d{2}-\d{2}\s/.test(row.generatedTime) ? row.generatedTime.replace(" ", "T") : row.generatedTime;
                        const ts = Date.parse(normalized);
                        if (!Number.isFinite(ts)) return row.generatedTime;
                        const dt = new Date(ts);
                        return (
                          <>
                            <div>{dt.toLocaleDateString()}</div>
                            <div style={{ color: "var(--text-secondary)" }}>{dt.toLocaleTimeString()}</div>
                          </>
                        );
                      })()}
                    </td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ minHeight: 30, padding: "4px 8px" }}
                          onClick={() =>
                            openQuestionModal(
                              {
                                id: row.id,
                                questionText: row.questionText,
                                courseName: row.courseName,
                                chapterId: row.chapterId,
                                chapterName: row.chapterName,
                                questionType: row.questionType,
                                status: row.status,
                                remark: row.remark,
                                options: row.options,
                                knowledgePoints: row.knowledgePoints,
                                knowledgePointIds: row.knowledgePointIds,
                                correctAnswer: row.correctAnswer,
                                explanation: row.explanation,
                                difficultyScore: row.difficultyScore,
                                generatedTime: row.generatedTime,
                                editedTime: row.editedTime,
                                bankType: row.bankType,
                              },
                              "view"
                            )
                          }
                        >
                          查看
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ minHeight: 30, padding: "4px 8px" }}
                          onClick={() =>
                            openQuestionModal(
                              {
                                id: row.id,
                                questionText: row.questionText,
                                courseName: row.courseName,
                                chapterId: row.chapterId,
                                chapterName: row.chapterName,
                                questionType: row.questionType,
                                status: row.status,
                                remark: row.remark,
                                options: row.options,
                                knowledgePoints: row.knowledgePoints,
                                knowledgePointIds: row.knowledgePointIds,
                                correctAnswer: row.correctAnswer,
                                explanation: row.explanation,
                                difficultyScore: row.difficultyScore,
                                generatedTime: row.generatedTime,
                                editedTime: row.editedTime,
                                bankType: row.bankType,
                              },
                              "edit"
                            )
                          }
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          style={{ minHeight: 30, padding: "4px 8px" }}
                          onClick={() => deleteOneQuestion(row.id)}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={15} style={{ border: "1px solid var(--border)", padding: 12, color: "var(--text-muted)" }}>
                      暂无数据，请先设置筛选条件后点击“查询”。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>每页显示</span>
            <select
              value={String(pageSize)}
              onChange={(e) => {
                const n = Math.max(1, Math.min(100, Number(e.target.value || 10)));
                setPageSize(n);
                setCurrentPage(1);
                void runQuery();
              }}
            >
              {[10, 20, 30, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button type="button" className="btn-secondary" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}>
              上一页
            </button>
            <button type="button" className="btn-secondary" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages}>
              下一页
            </button>
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              第 {currentPage} / {totalPages} 页，共 {rows.length} 条
            </span>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="btn-secondary" onClick={batchDeleteQuestions} disabled={deletingBatch || !selectedIds.length}>
              {deletingBatch ? "删除中..." : "批量删除"}
            </button>
            <button type="button" className="btn-secondary" onClick={exportQuestionList} disabled={exportingList || !rows.length}>
              {exportingList ? "导出中..." : "导出习题列表"}
            </button>
          </div>
        </div>
      </div>
      {editingRow && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2000,
            padding: 16,
          }}
          onClick={() => {
            if (!savingRemark) setEditingRow(null);
          }}
        >
          <div
            className="card"
            style={{ width: "min(760px, 100%)", maxHeight: "85vh", overflowY: "auto" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0, marginBottom: 10 }}>{questionModalMode === "edit" ? "编辑习题" : "查看习题"}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "100px minmax(0,1fr)", rowGap: 10, columnGap: 10 }}>
              <div style={{ color: "var(--text-secondary)" }}>课程</div>
              <div>{editingRow.courseName}</div>
              <div style={{ color: "var(--text-secondary)" }}>章节</div>
              <div>{editingRow.chapterName}</div>
              <div style={{ color: "var(--text-secondary)" }}>题目内容</div>
              {questionModalMode === "edit" ? (
                <textarea
                  value={questionTextDraft}
                  onChange={(e) => setQuestionTextDraft(e.target.value)}
                  rows={4}
                  style={{ width: "100%" }}
                />
              ) : (
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{editingRow.questionText}</div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>选项</div>
              {questionModalMode === "edit" ? (
                <textarea
                  value={optionsDraft}
                  onChange={(e) => setOptionsDraft(e.target.value)}
                  rows={4}
                  placeholder="每行一个选项"
                  style={{ width: "100%" }}
                />
              ) : (
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
                  {editingRow.options.length ? editingRow.options.join("\n") : "-"}
                </div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>参考答案</div>
              {questionModalMode === "edit" ? (
                <textarea
                  value={correctAnswerDraft}
                  onChange={(e) => setCorrectAnswerDraft(e.target.value)}
                  rows={3}
                  style={{ width: "100%" }}
                />
              ) : (
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{editingRow.correctAnswer || "-"}</div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>解析内容</div>
              {questionModalMode === "edit" ? (
                <textarea
                  value={explanationDraft}
                  onChange={(e) => setExplanationDraft(e.target.value)}
                  rows={4}
                  style={{ width: "100%" }}
                />
              ) : (
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{editingRow.explanation || "-"}</div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>关联知识点</div>
              {questionModalMode === "edit" ? (
                <div>
                  <details>
                    <summary
                      style={{
                        listStyle: "none",
                        cursor: "pointer",
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        padding: "8px 10px",
                        background: "var(--bg-base)",
                        color: "var(--text-primary)",
                        userSelect: "none",
                      }}
                    >
                      {loadingModalKnowledge
                        ? "知识点加载中..."
                        : `已选 ${modalKnowledgePointIdsDraft.length} / ${modalKnowledgeOptions.length || 0} 个知识点。${modalSelectedKnowledgeSummary}`}
                    </summary>
                    <div
                      style={{
                        marginTop: 8,
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        padding: 10,
                        display: "grid",
                        gap: 8,
                        maxHeight: 220,
                        overflowY: "auto",
                        background: "var(--bg-base)",
                      }}
                    >
                      {!loadingModalKnowledge && !!modalKnowledgeOptions.length && (
                        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600 }}>
                          <input
                            type="checkbox"
                            checked={modalKnowledgeOptions.length > 0 && modalKnowledgePointIdsDraft.length === modalKnowledgeOptions.length}
                            onChange={(e) =>
                              setModalKnowledgePointIdsDraft(e.target.checked ? modalKnowledgeOptions.map((x) => x.id) : [])
                            }
                          />
                          全部知识点
                        </label>
                      )}
                      {loadingModalKnowledge && <span style={{ color: "var(--text-muted)" }}>加载中...</span>}
                      {!loadingModalKnowledge &&
                        modalKnowledgeOptions.map((kp) => (
                          <label key={kp.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                            <input
                              type="checkbox"
                              checked={modalKnowledgePointIdsDraft.includes(kp.id)}
                              onChange={() =>
                                setModalKnowledgePointIdsDraft((prev) =>
                                  prev.includes(kp.id) ? prev.filter((x) => x !== kp.id) : [...prev, kp.id]
                                )
                              }
                            />
                            {kp.title}
                          </label>
                        ))}
                      {!loadingModalKnowledge && !modalKnowledgeOptions.length && <span style={{ color: "var(--text-muted)" }}>暂无知识点</span>}
                    </div>
                  </details>
                </div>
              ) : (
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
                  {editingRow.knowledgePoints.length ? editingRow.knowledgePoints.join("、") : "-"}
                </div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>题型</div>
              <div>{typeLabel[editingRow.questionType as QuestionTypeKey] || editingRow.questionType}</div>
              <div style={{ color: "var(--text-secondary)" }}>难度系数</div>
              {questionModalMode === "edit" ? (
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={difficultyScoreDraft}
                  onChange={(e) => setDifficultyScoreDraft(e.target.value)}
                  style={{ width: 140 }}
                />
              ) : (
                <div>{Number.isFinite(editingRow.difficultyScore) ? editingRow.difficultyScore.toFixed(2) : "-"}</div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>备注</div>
              {questionModalMode === "edit" ? (
                <div>
                  <textarea
                    value={remarkDraft}
                    onChange={(e) => setRemarkDraft(e.target.value.slice(0, 128))}
                    rows={4}
                    placeholder="请输入备注"
                    style={{ width: "100%" }}
                  />
                  <div style={{ marginTop: 6, color: "var(--text-muted)", fontSize: 12 }}>{remarkDraft.length}/128</div>
                </div>
              ) : (
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{editingRow.remark || "-"}</div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>题库类型</div>
              {questionModalMode === "edit" ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="radio"
                      name="question-modal-bank-type"
                      checked={bankTypeDraft === "training"}
                      onChange={() => setBankTypeDraft("training")}
                    />
                    训练库
                  </label>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="radio"
                      name="question-modal-bank-type"
                      checked={bankTypeDraft === "exam"}
                      onChange={() => setBankTypeDraft("exam")}
                    />
                    考试库
                  </label>
                </div>
              ) : (
                <div>{editingRow.bankType === "training" ? "训练库" : "考试库"}</div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>状态</div>
              {questionModalMode === "edit" ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <input type="radio" name="question-modal-status" checked={statusDraft === "pending"} onChange={() => setStatusDraft("pending")} />
                    待审核
                  </label>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <input type="radio" name="question-modal-status" checked={statusDraft === "approved"} onChange={() => setStatusDraft("approved")} />
                    已审核
                  </label>
                </div>
              ) : (
                <div>{editingRow.status === "approved" ? "已审核" : "待审核"}</div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>生成时间</div>
              <div>{editingRow.generatedTime ? new Date(editingRow.generatedTime).toLocaleString() : "-"}</div>
              <div style={{ color: "var(--text-secondary)" }}>更新时间</div>
              <div>{editingRow.editedTime ? new Date(editingRow.editedTime).toLocaleString() : "-"}</div>
            </div>

            <div style={{ marginTop: 14, display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" className="btn-secondary" onClick={() => setEditingRow(null)} disabled={savingRemark}>
                关闭
              </button>
              {questionModalMode === "edit" && (
                <button type="button" className="btn-primary" onClick={saveQuestion} disabled={savingRemark}>
                  {savingRemark ? "保存中..." : "保存修改"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const PAPER_GENERATE_DEFAULTS_STORAGE_KEY = "qastudio.paperGenerateDefaults";

type PaperDefaultPerType = { count: number; difficulty: number; score: number };
function loadSavedPaperDefaults(): Partial<Record<QuestionTypeKey, PaperDefaultPerType>> | null {
  try {
    const raw = localStorage.getItem(PAPER_GENERATE_DEFAULTS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, { count?: number; difficulty?: number; score?: number }>;
      const keys: QuestionTypeKey[] = ["single_choice", "multiple_choice", "judge", "blank", "qa"];
      const out: Partial<Record<QuestionTypeKey, PaperDefaultPerType>> = {};
      for (const k of keys) {
        const v = parsed[k];
        if (
          v &&
          typeof v.count === "number" && Number.isFinite(v.count) &&
          typeof v.difficulty === "number" && Number.isFinite(v.difficulty) &&
          typeof v.score === "number" && Number.isFinite(v.score)
        ) {
          out[k] = {
            count: Math.max(0, Math.min(100, v.count)),
            difficulty: Math.max(0, Math.min(1, v.difficulty)),
            score: Math.max(0, v.score),
          };
        }
      }
      if (Object.keys(out).length) return out;
    }
    const rawLegacy = localStorage.getItem("qastudio.paperGenerateDefaultCount");
    if (!rawLegacy) return null;
    const parsed = JSON.parse(rawLegacy) as Record<string, number>;
    const keys: QuestionTypeKey[] = ["single_choice", "multiple_choice", "judge", "blank", "qa"];
    const out: Partial<Record<QuestionTypeKey, PaperDefaultPerType>> = {};
    for (const k of keys) {
      if (typeof parsed[k] === "number" && Number.isFinite(parsed[k])) {
        out[k] = { count: Math.max(0, Math.min(100, parsed[k])), difficulty: 0.8, score: 2 };
      }
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

const FALLBACK_PAPER_DEFAULT_CONFIGS: Array<{ id: number; type: QuestionTypeKey; count: number; difficulty: string; score: number }> = [
  { id: 1, type: "single_choice", count: 10, difficulty: "0.8", score: 2 },
  { id: 2, type: "multiple_choice", count: 10, difficulty: "0.8", score: 4 },
  { id: 3, type: "judge", count: 10, difficulty: "0.8", score: 1 },
  { id: 4, type: "blank", count: 10, difficulty: "0.8", score: 2 },
  { id: 5, type: "qa", count: 5, difficulty: "0.8", score: 10 },
];
const OPTION_PREFIX_RE = /^\s*[A-Z][\.\)．、]\s*/;
const formatOptionsForDisplay = (options: string[]) =>
  (options || []).length
    ? options
        .map((opt, i) => {
          const text = String(opt || "").trim();
          if (!text) return `${String.fromCharCode(65 + i)}.`;
          return OPTION_PREFIX_RE.test(text) ? text : `${String.fromCharCode(65 + i)}. ${text}`;
        })
        .join("\n")
    : "-";

type PaperPreviewQuestionRow = {
  id: number;
  questionType: string;
  questionText: string;
  options: string[];
  correctAnswer: string;
  explanation: string | null;
  difficultyScore: number;
  score: number;
  source: "local" | "internet";
};

type PaperPreviewResult = {
  paperId: number | null;
  isPartial: boolean;
  status: string;
  message: string;
  insufficientTypes: { questionType: string; requested: number; available: number; missing: number }[];
  previewQuestions: PaperPreviewQuestionRow[];
  totalScore: number;
  overallDifficulty: number;
};

function GeneratePapersPanel() {
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);
  const [previewResult, setPreviewResult] = useState<PaperPreviewResult | null>(null);

  const [courses, setCourses] = useState<CourseItem[]>([]);
  const [chapters, setChapters] = useState<ChapterItem[]>([]);
  const [courseId, setCourseId] = useState<number | "">("");
  const [chapterIds, setChapterIds] = useState<number[]>([]);
  const [paperTitle, setPaperTitle] = useState("计算机网络期末试卷");
  const [paperBankType, setPaperBankType] = useState<"training" | "formal">("training");
  const [questionSource, setQuestionSource] = useState<"local" | "internet">("local");
  const [overallDifficulty, setOverallDifficulty] = useState<string>("0.8");
  const [defaultRowsFromApi, setDefaultRowsFromApi] = useState<{ type: string; count: number; difficulty: string; score: number }[] | null>(null);
  const [savedPaperDefaults, setSavedPaperDefaults] = useState<Partial<Record<QuestionTypeKey, PaperDefaultPerType>> | null>(
    () => loadSavedPaperDefaults()
  );
  const defaultConfigs = useMemo(() => {
    if (!defaultRowsFromApi || !defaultRowsFromApi.length) return FALLBACK_PAPER_DEFAULT_CONFIGS;
    return defaultRowsFromApi.map((row, i) => {
      const type = row.type as QuestionTypeKey;
      const saved = savedPaperDefaults?.[type];
      return {
        id: i + 1,
        type,
        count: Math.max(
          0,
          Math.min(100, saved != null ? saved.count : row.count)
        ),
        difficulty: saved != null ? String(saved.difficulty) : String(row.difficulty),
        score: saved != null ? saved.score : row.score,
      };
    });
  }, [defaultRowsFromApi, savedPaperDefaults]);
  const [configs, setConfigs] = useState<Array<{ id: number; type: QuestionTypeKey; count: number; difficulty: string; score: number }>>(
    () => FALLBACK_PAPER_DEFAULT_CONFIGS
  );
  const nextConfigIdRef = useRef(6);
  const [paperSettingsModalOpen, setPaperSettingsModalOpen] = useState(false);
  const [paperSettingsDraft, setPaperSettingsDraft] = useState<Record<QuestionTypeKey, { count: number; difficulty: number; score: number }>>({
    single_choice: { count: 10, difficulty: 0.8, score: 2 },
    multiple_choice: { count: 10, difficulty: 0.8, score: 4 },
    judge: { count: 10, difficulty: 0.8, score: 1 },
    blank: { count: 10, difficulty: 0.8, score: 2 },
    qa: { count: 5, difficulty: 0.8, score: 10 },
  });
  const previewQuestionIdRef = useRef(1);
  const [previewCurrentPage, setPreviewCurrentPage] = useState(1);
  const [previewPageSize, setPreviewPageSize] = useState(10);
  const [previewModalMode, setPreviewModalMode] = useState<"view" | "edit">("view");
  const [editingPreviewRowId, setEditingPreviewRowId] = useState<number | null>(null);
  const [previewDraft, setPreviewDraft] = useState<PaperPreviewQuestionRow | null>(null);
  const isValidDifficultyText = (value: string) => /^\d*(\.\d{0,2})?$/.test(value);
  const typeLabelMap: Record<QuestionTypeKey, string> = {
    single_choice: "单选题",
    multiple_choice: "多选题",
    judge: "判断题",
    blank: "填空题",
    qa: "问答题",
  };
  const previewRows = previewResult?.previewQuestions || [];
  const previewTotalPages = Math.max(1, Math.ceil(previewRows.length / previewPageSize));
  const pagedPreviewRows = useMemo(() => {
    const start = (previewCurrentPage - 1) * previewPageSize;
    return previewRows.slice(start, start + previewPageSize);
  }, [previewRows, previewCurrentPage, previewPageSize]);

  useEffect(() => {
    api.teacher
      .getPaperGenerateDefaults()
      .then((rows) => setDefaultRowsFromApi(rows))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!defaultRowsFromApi || !defaultRowsFromApi.length) return;
    setConfigs([...defaultConfigs]);
    nextConfigIdRef.current = defaultConfigs.length + 1;
  }, [defaultRowsFromApi, defaultConfigs]);

  useEffect(() => {
    setLoadingCourses(true);
    api.teacher.courses
      .list()
      .then((rows) => {
        const mapped = rows.map((c) => ({ id: c.id, name: c.name }));
        setCourses(mapped);
        if (!mapped.length) {
          setCourseId("");
          return;
        }
        setCourseId((prev) => (prev === "" ? mapped[0].id : prev));
      })
      .catch((e: any) => {
        toast(e?.message || "课程加载失败", "error");
        setCourses([]);
      })
      .finally(() => setLoadingCourses(false));
  }, []);

  useEffect(() => {
    if (!courseId) {
      setChapters([]);
      setChapterIds([]);
      return;
    }
    setLoadingChapters(true);
    api.teacher.courses
      .chapters(courseId)
      .then((rows) => {
        const mapped = rows.map((ch) => ({ id: ch.id, title: ch.title }));
        setChapters(mapped);
        setChapterIds(mapped.map((x) => x.id));
      })
      .catch((e: any) => {
        toast(e?.message || "章节加载失败", "error");
        setChapters([]);
        setChapterIds([]);
      })
      .finally(() => setLoadingChapters(false));
  }, [courseId]);

  const allChaptersSelected = chapters.length > 0 && chapterIds.length === chapters.length;
  const toggleAllChapters = (checked: boolean) => {
    setChapterIds(checked ? chapters.map((x) => x.id) : []);
  };
  const toggleChapter = (id: number) => {
    setChapterIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const normalizePreviewQuestionType = (value: string): QuestionTypeKey =>
    (["single_choice", "multiple_choice", "judge", "blank", "qa"].includes(value) ? value : "qa") as QuestionTypeKey;
  const computePreviewStats = (rows: PaperPreviewQuestionRow[]) => {
    const totalScore = Number(rows.reduce((sum, row) => sum + (Number.isFinite(row.score) ? row.score : 0), 0).toFixed(2));
    if (totalScore <= 0) {
      return { totalScore: 0, overallDifficulty: 0 };
    }
    const weighted = rows.reduce(
      (sum, row) => sum + (Number.isFinite(row.score) ? row.score : 0) * (Number.isFinite(row.difficultyScore) ? row.difficultyScore : 0.8),
      0
    );
    return { totalScore, overallDifficulty: Number((weighted / totalScore).toFixed(2)) };
  };
  const mapPreviewQuestionsFromApi = (
    rows: {
      question_type: string;
      question_text: string;
      options: string[];
      correct_answer: string;
      explanation: string | null;
      difficulty_score: number;
      score: number;
      source: "local" | "internet";
    }[]
  ): PaperPreviewQuestionRow[] =>
    rows.map((x) => ({
      id: previewQuestionIdRef.current++,
      questionType: x.question_type,
      questionText: x.question_text,
      options: Array.isArray(x.options) ? x.options.map((opt) => String(opt || "")) : [],
      correctAnswer: x.correct_answer || "",
      explanation: x.explanation,
      difficultyScore: Number.isFinite(Number(x.difficulty_score)) ? Number(x.difficulty_score) : 0.8,
      score: Number.isFinite(Number(x.score)) ? Number(x.score) : 0,
      source: x.source === "internet" ? "internet" : "local",
    }));

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(previewRows.length / previewPageSize));
    setPreviewCurrentPage((p) => Math.min(p, maxPage));
  }, [previewRows.length, previewPageSize]);

  const updateConfig = (id: number, patch: Partial<{ type: QuestionTypeKey; count: number; difficulty: string; score: number }>) => {
    setConfigs((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  };
  const addConfigRow = () => {
    setConfigs((prev) => [
      ...prev,
      { id: nextConfigIdRef.current++, type: "single_choice", count: 0, difficulty: "0.8", score: 0 },
    ]);
  };
  const removeConfigRow = (id: number) => {
    setConfigs((prev) => prev.filter((x) => x.id !== id));
  };

  const resetForm = () => {
    setPaperTitle("计算机网络期末试卷");
    setPaperBankType("training");
    setQuestionSource("local");
    setOverallDifficulty("0.8");
    nextConfigIdRef.current = defaultConfigs.length + 1;
    setConfigs([...defaultConfigs]);
    setChapterIds(chapters.map((x) => x.id));
    setPreviewResult(null);
    setEditingPreviewRowId(null);
    setPreviewDraft(null);
    setPreviewCurrentPage(1);
    setPreviewPageSize(10);
  };

  const openPaperSettingsModal = () => {
    const draft: Record<QuestionTypeKey, { count: number; difficulty: number; score: number }> = {
      single_choice: (() => {
        const r = defaultConfigs.find((x) => x.type === "single_choice");
        return { count: r?.count ?? 10, difficulty: Number(r?.difficulty) || 0.8, score: r?.score ?? 2 };
      })(),
      multiple_choice: (() => {
        const r = defaultConfigs.find((x) => x.type === "multiple_choice");
        return { count: r?.count ?? 10, difficulty: Number(r?.difficulty) || 0.8, score: r?.score ?? 4 };
      })(),
      judge: (() => {
        const r = defaultConfigs.find((x) => x.type === "judge");
        return { count: r?.count ?? 10, difficulty: Number(r?.difficulty) || 0.8, score: r?.score ?? 1 };
      })(),
      blank: (() => {
        const r = defaultConfigs.find((x) => x.type === "blank");
        return { count: r?.count ?? 10, difficulty: Number(r?.difficulty) || 0.8, score: r?.score ?? 2 };
      })(),
      qa: (() => {
        const r = defaultConfigs.find((x) => x.type === "qa");
        return { count: r?.count ?? 5, difficulty: Number(r?.difficulty) || 0.8, score: r?.score ?? 10 };
      })(),
    };
    setPaperSettingsDraft(draft);
    setPaperSettingsModalOpen(true);
  };

  const savePaperSettings = () => {
    const toSave: Record<QuestionTypeKey, PaperDefaultPerType> = { ...paperSettingsDraft };
    localStorage.setItem(PAPER_GENERATE_DEFAULTS_STORAGE_KEY, JSON.stringify(toSave));
    setSavedPaperDefaults(toSave);
    setConfigs((prev) =>
      prev.map((row) => {
        const d = paperSettingsDraft[row.type];
        return d
          ? { ...row, count: d.count, difficulty: String(d.difficulty), score: d.score }
          : row;
      })
    );
    setPaperSettingsModalOpen(false);
    toast("生成设置已保存", "success");
  };

  const clearPaperSettingsOverrides = () => {
    localStorage.removeItem(PAPER_GENERATE_DEFAULTS_STORAGE_KEY);
    localStorage.removeItem("qastudio.paperGenerateDefaultCount");
    setSavedPaperDefaults(null);
    if (defaultRowsFromApi?.length) {
      const byType = Object.fromEntries(defaultRowsFromApi.map((r) => [r.type, r]));
      const d = (k: QuestionTypeKey) => {
        const r = byType[k];
        const diff = parseFloat(String(r?.difficulty));
        return {
          count: Math.max(0, Math.min(100, r?.count ?? 10)),
          difficulty: Number.isFinite(diff) && diff >= 0 && diff <= 1 ? diff : 0.8,
          score: Number(r?.score) ?? 2,
        };
      };
      setPaperSettingsDraft({
        single_choice: d("single_choice"),
        multiple_choice: d("multiple_choice"),
        judge: d("judge"),
        blank: d("blank"),
        qa: d("qa"),
      });
    }
    toast("已恢复为配置文件中的初始值", "success");
  };

  const validate = () => {
    if (!courseId) return "请先选择课程";
    if (!chapterIds.length) return "请至少选择一个章节";
    if (!paperTitle.trim()) return "请填写试卷标题";
    if (!configs.length) return "请至少配置一行题型数量";
    const hasAnyCount = configs.some((x) => x.count > 0);
    if (!hasAnyCount) return "题型数量不能都为 0";
    if (overallDifficulty.trim()) {
      const n = Number(overallDifficulty);
      if (!Number.isFinite(n) || n < 0 || n > 1) return "整卷难度系数需在 0~1";
    }
    if (!overallDifficulty.trim()) {
      for (const row of configs) {
        const n = Number(row.difficulty);
        if (!Number.isFinite(n) || n < 0 || n > 1) return "题型难度系数需在 0~1";
      }
    }
    return "";
  };

  const callGeneratePaper = async (saveToBank: boolean, previewOverride?: PaperPreviewQuestionRow[]) => {
    const err = validate();
    if (err) {
      toast(err, "error");
      return null;
    }

    const payload: {
      course_id: number;
      chapter_ids: number[];
      paper_title: string;
      paper_bank_type: "training" | "formal";
      question_source: "local" | "internet";
      overall_difficulty: number | null;
      configs: { type: string; count: number; difficulty: number | null; score: number }[];
      save_to_bank: boolean;
      preview_questions_override?: {
        question_type: string;
        question_text: string;
        options: string[];
        correct_answer: string;
        explanation: string | null;
        difficulty_score: number;
        score: number;
        source: "local" | "internet";
      }[];
    } = {
      course_id: Number(courseId),
      chapter_ids: chapterIds,
      paper_title: paperTitle.trim(),
      paper_bank_type: paperBankType,
      question_source: questionSource,
      overall_difficulty: overallDifficulty.trim() ? Number(overallDifficulty) : null,
      configs: configs.map((row) => ({
        type: row.type,
        count: row.count,
        difficulty: row.difficulty.trim() ? Number(row.difficulty) : null,
        score: row.score,
      })),
      save_to_bank: saveToBank,
    };
    if (previewOverride) {
      payload.preview_questions_override = previewOverride.map((row) => ({
        question_type: normalizePreviewQuestionType(row.questionType),
        question_text: row.questionText,
        options: row.options,
        correct_answer: row.correctAnswer,
        explanation: row.explanation,
        difficulty_score: row.difficultyScore,
        score: row.score,
        source: row.source,
      }));
    }

    const resp = await api.teacher.courses.generatePaper(payload);
    const mapped: PaperPreviewResult = {
      paperId: resp.paper_id,
      isPartial: resp.is_partial,
      status: resp.status,
      message: resp.message,
      insufficientTypes: resp.insufficient_types.map((x) => ({
        questionType: x.question_type,
        requested: x.requested,
        available: x.available,
        missing: x.missing,
      })),
      previewQuestions: mapPreviewQuestionsFromApi(resp.preview_questions),
      totalScore: resp.total_score,
      overallDifficulty: resp.overall_difficulty,
    };
    setPreviewResult(mapped);
    setPreviewCurrentPage(1);
    if (mapped.isPartial) {
      const lackText = mapped.insufficientTypes
        .map((x) => `${typeLabelMap[x.questionType as QuestionTypeKey] || x.questionType}缺少${x.missing}题`)
        .join("；");
      toast(`${mapped.message}${lackText ? `（${lackText}）` : ""}`, "error");
    } else {
      toast(saveToBank ? `${mapped.message}（ID：${mapped.paperId ?? "-"}）` : "试卷预览已生成", "success");
    }
    return mapped;
  };

  const submitGenerate = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await callGeneratePaper(false);
    } catch (e: any) {
      toast(e?.message || "生成预览失败", "error");
      setPreviewResult({
        paperId: null,
        isPartial: true,
        status: "error",
        message: (e as Error)?.message || "生成预览失败",
        insufficientTypes: [],
        previewQuestions: [],
        totalScore: 0,
        overallDifficulty: 0,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const openPreviewModal = (rowId: number, mode: "view" | "edit") => {
    const row = previewRows.find((x) => x.id === rowId);
    if (!row) return;
    setPreviewModalMode(mode);
    setEditingPreviewRowId(rowId);
    setPreviewDraft({ ...row, options: [...row.options] });
  };

  const savePreviewRow = () => {
    if (!previewDraft || editingPreviewRowId == null) return;
    const questionText = previewDraft.questionText.trim();
    if (!questionText) return toast("题目内容不能为空", "error");
    const difficulty = Number(previewDraft.difficultyScore);
    if (!Number.isFinite(difficulty) || difficulty < 0 || difficulty > 1) return toast("难度系数需在 0~1", "error");
    const score = Number(previewDraft.score);
    if (!Number.isFinite(score) || score < 0) return toast("每题分数需大于等于 0", "error");
    const options = (previewDraft.options || []).map((x) => x.trim()).filter(Boolean);
    const answer = previewDraft.correctAnswer.trim();
    setPreviewResult((prev) => {
      if (!prev) return prev;
      const nextRows = prev.previewQuestions.map((row) =>
        row.id === editingPreviewRowId
          ? {
              ...row,
              questionType: normalizePreviewQuestionType(previewDraft.questionType),
              questionText,
              options,
              correctAnswer: answer,
              explanation: (previewDraft.explanation || "").trim() || null,
              difficultyScore: Number(difficulty.toFixed(2)),
              score: Number(score),
            }
          : row
      );
      const stats = computePreviewStats(nextRows);
      return { ...prev, previewQuestions: nextRows, ...stats };
    });
    toast("预览题目已更新", "success");
    setEditingPreviewRowId(null);
    setPreviewDraft(null);
  };

  const deletePreviewRow = (rowId: number) => {
    setPreviewResult((prev) => {
      if (!prev) return prev;
      const nextRows = prev.previewQuestions.filter((x) => x.id !== rowId);
      const stats = computePreviewStats(nextRows);
      return { ...prev, previewQuestions: nextRows, ...stats };
    });
    if (editingPreviewRowId === rowId) {
      setEditingPreviewRowId(null);
      setPreviewDraft(null);
    }
  };

  const submitToPaperBank = async () => {
    if (confirmingSubmit) return;
    if (!previewRows.length) {
      toast("预览为空，请先生成试卷预览", "error");
      return;
    }
    setConfirmingSubmit(true);
    try {
      await callGeneratePaper(true, previewRows);
    } catch (e: any) {
      toast(e?.message || "提交到试卷库失败", "error");
    } finally {
      setConfirmingSubmit(false);
    }
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>生成试卷</h2>
        <button type="button" className="btn-secondary" onClick={openPaperSettingsModal}>
          生成设置
        </button>
      </div>
      {paperSettingsModalOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.4)",
          }}
          onClick={(e) => e.target === e.currentTarget && setPaperSettingsModalOpen(false)}
        >
          <div
            style={{
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 20,
              minWidth: 360,
              maxWidth: "90vw",
              color: "var(--text-primary)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>生成设置</div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 8, color: "var(--text-secondary)", fontSize: 14 }}>各题型默认：数量、难度系数、每题分数</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 400 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>题型</th>
                      <th style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>数量</th>
                      <th style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>难度系数</th>
                      <th style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>每题分数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(["single_choice", "multiple_choice", "judge", "blank", "qa"] as const).map((key) => (
                      <tr key={key}>
                        <td style={{ border: "1px solid var(--border)", padding: 8 }}>{typeLabelMap[key]}</td>
                        <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            value={paperSettingsDraft[key].count}
                            onChange={(e) => {
                              const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                              setPaperSettingsDraft((prev) => ({ ...prev, [key]: { ...prev[key], count: v } }));
                            }}
                            style={{ width: 72, padding: "4px 8px" }}
                          />
                        </td>
                        <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                          <input
                            type="number"
                            min={0}
                            max={1}
                            step={0.01}
                            value={paperSettingsDraft[key].difficulty}
                            onChange={(e) => {
                              const v = Math.max(0, Math.min(1, Number(e.target.value) || 0));
                              setPaperSettingsDraft((prev) => ({ ...prev, [key]: { ...prev[key], difficulty: v } }));
                            }}
                            style={{ width: 72, padding: "4px 8px" }}
                          />
                        </td>
                        <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                          <input
                            type="number"
                            min={0}
                            step={0.1}
                            value={paperSettingsDraft[key].score}
                            onChange={(e) => {
                              const v = Math.max(0, Number(e.target.value) || 0);
                              setPaperSettingsDraft((prev) => ({ ...prev, [key]: { ...prev[key], score: v } }));
                            }}
                            style={{ width: 72, padding: "4px 8px" }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn-secondary" onClick={clearPaperSettingsOverrides}>
                恢复初始值
              </button>
              <button type="button" className="btn-secondary" onClick={() => setPaperSettingsModalOpen(false)}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={savePaperSettings}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 10,
          minHeight: 380,
          padding: 14,
          background: "var(--bg-elevated)",
          color: "var(--text-primary)",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 10 }}>【基础筛选】</div>
        <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", rowGap: 10, columnGap: 12, alignItems: "center" }}>
          <div style={{ color: "var(--text-secondary)" }}>课程</div>
          <select
            value={courseId === "" ? "" : String(courseId)}
            onChange={(e) => setCourseId(e.target.value ? Number(e.target.value) : "")}
            disabled={loadingCourses}
          >
            {!courses.length && <option value="">暂无课程</option>}
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name}
              </option>
            ))}
          </select>

          <div style={{ color: "var(--text-secondary)" }}>章节</div>
          <div>
            <details>
              <summary
                style={{
                  listStyle: "none",
                  cursor: "pointer",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  background: "var(--bg-base)",
                  color: "var(--text-primary)",
                  userSelect: "none",
                }}
              >
                {loadingChapters ? "章节加载中..." : `已选 ${chapterIds.length} / ${chapters.length || 0} 个章节`}
              </summary>
              <div
                style={{
                  marginTop: 8,
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: 10,
                  display: "grid",
                  gap: 8,
                  maxHeight: 220,
                  overflowY: "auto",
                  background: "var(--bg-base)",
                }}
              >
                {!loadingChapters && !!chapters.length && (
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600 }}>
                    <input type="checkbox" checked={allChaptersSelected} onChange={(e) => toggleAllChapters(e.target.checked)} />
                    全部章节
                  </label>
                )}
                {loadingChapters && <span style={{ color: "var(--text-muted)" }}>加载中...</span>}
                {!loadingChapters &&
                  chapters.map((ch) => (
                    <label key={ch.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                      <input type="checkbox" checked={chapterIds.includes(ch.id)} onChange={() => toggleChapter(ch.id)} />
                      {ch.title}
                    </label>
                  ))}
                {!loadingChapters && !chapters.length && <span style={{ color: "var(--text-muted)" }}>暂无章节</span>}
              </div>
            </details>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>【基础信息】</div>
          <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", rowGap: 10, columnGap: 12, alignItems: "center" }}>
            <div style={{ color: "var(--text-secondary)" }}>试卷标题</div>
            <input type="text" value={paperTitle} onChange={(e) => setPaperTitle(e.target.value)} maxLength={100} />

            <div style={{ color: "var(--text-secondary)", alignSelf: "center" }}>题库来源</div>
            <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", minHeight: 38 }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 16 }}>
                <input type="radio" name="paper-source-type" checked={questionSource === "local"} onChange={() => setQuestionSource("local")} />
                本地题库
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input type="radio" name="paper-source-type" checked={questionSource === "internet"} onChange={() => setQuestionSource("internet")} />
                互联网题库
              </label>
            </div>

            <div style={{ color: "var(--text-secondary)", alignSelf: "center" }}>导入试卷库类型</div>
            <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", minHeight: 38 }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 16 }}>
                <input type="radio" name="paper-bank-type" checked={paperBankType === "training"} onChange={() => setPaperBankType("training")} />
                训练库
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input type="radio" name="paper-bank-type" checked={paperBankType === "formal"} onChange={() => setPaperBankType("formal")} />
                正式题库
              </label>
            </div>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>【难度配置】</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "var(--text-secondary)" }}>整卷难度系数</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.1}
              placeholder="选填"
              value={overallDifficulty}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "" || isValidDifficultyText(v)) setOverallDifficulty(v);
              }}
              style={{ width: 140 }}
            />
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>填写后，下方题型难度可不填。</span>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>【题型数量&难度配置】</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
              <thead>
                <tr>
                  {["题型", "数量", "难度系数", "每题分数", "操作"].map((h) => (
                    <th key={h} style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {configs.map((row) => (
                  <tr key={row.id}>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <select value={row.type} onChange={(e) => updateConfig(row.id, { type: e.target.value as QuestionTypeKey })}>
                        <option value="single_choice">单选题</option>
                        <option value="multiple_choice">多选题</option>
                        <option value="judge">判断题</option>
                        <option value="blank">填空题</option>
                        <option value="qa">问答题</option>
                      </select>
                    </td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={row.count}
                        onChange={(e) => updateConfig(row.id, { count: Math.max(0, Number(e.target.value || 0)) })}
                        style={{ width: 120 }}
                      />
                    </td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.1}
                        value={row.difficulty}
                        disabled={!!overallDifficulty.trim()}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "" || isValidDifficultyText(v)) updateConfig(row.id, { difficulty: v });
                        }}
                        style={{ width: 120 }}
                      />
                    </td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={row.score}
                        onChange={(e) => updateConfig(row.id, { score: Math.max(0, Number(e.target.value || 0)) })}
                        style={{ width: 120 }}
                      />
                    </td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => removeConfigRow(row.id)}
                        disabled={configs.length <= 1}
                        style={{ padding: "4px 8px", fontSize: 13 }}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn-secondary" onClick={addConfigRow} style={{ padding: "6px 12px", fontSize: 14 }}>
              添加一行
            </button>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button type="button" className="btn-secondary" onClick={resetForm} disabled={submitting}>
            重置
          </button>
          <button type="button" className="btn-primary" onClick={submitGenerate} disabled={submitting}>
            {submitting ? "生成中..." : "提交生成"}
          </button>
        </div>

        {!!previewResult && (
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>
              【试卷预览】
              {previewResult.status === "error"
                ? "（生成失败）"
                : previewResult.isPartial
                  ? "（未完全生成）"
                  : ""}
              {previewResult.status !== "error" && (
                <> 总分：{previewResult.totalScore}，整卷难度：{previewResult.overallDifficulty.toFixed(2)}</>
              )}
            </div>
            <div style={{ color: "var(--text-secondary)", marginBottom: 8 }}>{previewResult.message}</div>
            <div style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 8 }}>未点击“提交到试卷库”前，不会写入试卷库。</div>
            {!!previewResult.insufficientTypes.length && (
              <div style={{ marginBottom: 8, color: "#ef4444", fontSize: 13 }}>
                缺题明细：
                {previewResult.insufficientTypes
                  .map((x) => `${typeLabelMap[x.questionType as QuestionTypeKey] || x.questionType}（需${x.requested}，可用${x.available}）`)
                  .join("；")}
              </div>
            )}
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 920 }}>
                <thead>
                  <tr>
                    {["序号", "题型", "题目内容", "选项", "答案", "解析", "难度系数", "每题分数", "来源", "操作"].map((h) => (
                      <th key={h} style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pagedPreviewRows.map((row, idx) => (
                    <tr key={row.id}>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{(previewCurrentPage - 1) * previewPageSize + idx + 1}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{typeLabelMap[row.questionType as QuestionTypeKey] || row.questionType}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.questionText}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8, whiteSpace: "pre-wrap" }}>
                        {Array.isArray(row.options) && row.options.length ? row.options.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt}`).join("\n") : "-"}
                      </td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.correctAnswer ?? "-"}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8, whiteSpace: "pre-wrap" }}>{row.explanation ?? "-"}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.difficultyScore.toFixed(2)}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.score}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.source === "local" ? "本地题库" : "互联网"}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="btn-ghost"
                            style={{ minHeight: 30, padding: "4px 8px" }}
                            onClick={() => openPreviewModal(row.id, "view")}
                          >
                            查看
                          </button>
                          <button
                            type="button"
                            className="btn-ghost"
                            style={{ minHeight: 30, padding: "4px 8px" }}
                            onClick={() => openPreviewModal(row.id, "edit")}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="btn-ghost"
                            style={{ minHeight: 30, padding: "4px 8px" }}
                            onClick={() => deletePreviewRow(row.id)}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!previewRows.length && (
                    <tr>
                      <td colSpan={10} style={{ border: "1px solid var(--border)", padding: 8, color: "var(--text-muted)" }}>
                        {previewResult.status === "error" ? "生成失败，无题目数据" : "暂无可预览题目"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>每页显示</span>
              <select
                value={String(previewPageSize)}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(100, Number(e.target.value || 10)));
                  setPreviewPageSize(n);
                  setPreviewCurrentPage(1);
                }}
              >
                {[10, 20, 30, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-secondary" onClick={() => setPreviewCurrentPage((p) => Math.max(1, p - 1))} disabled={previewCurrentPage <= 1}>
                上一页
              </button>
              <button type="button" className="btn-secondary" onClick={() => setPreviewCurrentPage((p) => Math.min(previewTotalPages, p + 1))} disabled={previewCurrentPage >= previewTotalPages}>
                下一页
              </button>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                第 {previewCurrentPage} / {previewTotalPages} 页，共 {previewRows.length} 条
              </span>
            </div>
            <div style={{ borderTop: "1px solid var(--border)", marginTop: 12, paddingTop: 12, display: "flex", gap: 10 }}>
              <button type="button" className="btn-primary" onClick={submitToPaperBank} disabled={confirmingSubmit || submitting || !previewRows.length}>
                {confirmingSubmit ? "提交中..." : "提交到试卷库"}
              </button>
            </div>
          </div>
        )}
      </div>
      {editingPreviewRowId !== null && previewDraft && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2000,
            padding: 16,
          }}
          onClick={() => {
            setEditingPreviewRowId(null);
            setPreviewDraft(null);
          }}
        >
          <div className="card" style={{ width: "min(760px, 100%)", maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0, marginBottom: 10 }}>{previewModalMode === "edit" ? "编辑题目" : "查看题目"}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "100px minmax(0,1fr)", rowGap: 10, columnGap: 10 }}>
              <div style={{ color: "var(--text-secondary)" }}>题型</div>
              {previewModalMode === "edit" ? (
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  {(["single_choice", "multiple_choice", "judge", "blank", "qa"] as const).map((k) => (
                    <label key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="radio"
                        name="paper-preview-question-type"
                        checked={normalizePreviewQuestionType(previewDraft.questionType) === k}
                        onChange={() => setPreviewDraft((d) => (d ? { ...d, questionType: k } : d))}
                      />
                      {typeLabelMap[k]}
                    </label>
                  ))}
                </div>
              ) : (
                <div>{typeLabelMap[normalizePreviewQuestionType(previewDraft.questionType)] || previewDraft.questionType}</div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>题目内容</div>
              {previewModalMode === "edit" ? (
                <textarea value={previewDraft.questionText} onChange={(e) => setPreviewDraft((d) => (d ? { ...d, questionText: e.target.value } : d))} rows={4} style={{ width: "100%" }} />
              ) : (
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{previewDraft.questionText}</div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>选项</div>
              {previewModalMode === "edit" ? (
                <textarea
                  value={previewDraft.options.join("\n")}
                  onChange={(e) =>
                    setPreviewDraft((d) => (d ? { ...d, options: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) } : d))
                  }
                  rows={4}
                  placeholder="每行一个选项"
                  style={{ width: "100%" }}
                />
              ) : (
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{previewDraft.options.length ? previewDraft.options.join("\n") : "-"}</div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>答案</div>
              {previewModalMode === "edit" ? (
                <textarea value={previewDraft.correctAnswer} onChange={(e) => setPreviewDraft((d) => (d ? { ...d, correctAnswer: e.target.value } : d))} rows={3} style={{ width: "100%" }} />
              ) : (
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{previewDraft.correctAnswer || "-"}</div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>难度系数</div>
              {previewModalMode === "edit" ? (
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={previewDraft.difficultyScore}
                  onChange={(e) => setPreviewDraft((d) => (d ? { ...d, difficultyScore: Number(e.target.value) || 0 } : d))}
                  style={{ width: 140 }}
                />
              ) : (
                <div>{previewDraft.difficultyScore.toFixed(2)}</div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>每题分数</div>
              {previewModalMode === "edit" ? (
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={previewDraft.score}
                  onChange={(e) => setPreviewDraft((d) => (d ? { ...d, score: Number(e.target.value) || 0 } : d))}
                  style={{ width: 140 }}
                />
              ) : (
                <div>{previewDraft.score}</div>
              )}
              <div style={{ color: "var(--text-secondary)" }}>来源</div>
              <div>{previewDraft.source === "local" ? "本地题库" : "互联网"}</div>
              <div style={{ color: "var(--text-secondary)" }}>解析</div>
              {previewModalMode === "edit" ? (
                <textarea value={previewDraft.explanation || ""} onChange={(e) => setPreviewDraft((d) => (d ? { ...d, explanation: e.target.value } : d))} rows={4} style={{ width: "100%" }} />
              ) : (
                <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{previewDraft.explanation || "-"}</div>
              )}
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setEditingPreviewRowId(null);
                  setPreviewDraft(null);
                }}
              >
                关闭
              </button>
              {previewModalMode === "edit" && (
                <button type="button" className="btn-primary" onClick={savePreviewRow}>
                  保存修改
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** 从文件名（无扩展名）提取分组 key：只去掉末尾的变体后缀（答案、参考、卷N、第N份 等），保留名称中的 "-"、"_" 及中间文字 */
function getPaperGroupKey(fileName: string): string {
  const base = fileName.replace(/\.(doc|docx|pdf)$/i, "").trim();
  const normalized = base
    .replace(/([-_\s]+(答案|参考|卷\s*\d*|第?\d+\s*份?).*)$/i, "")
    .replace(/(答案|参考答案|参考)$/i, "")
    .trim();
  return normalized || base;
}

type PaperGroupRow = { id: number; title: string; files: File[] };

function ImportPapersPanel() {
  const navigate = useNavigate();
  const [loadingCourses, setLoadingCourses] = useState(false);

  const [courses, setCourses] = useState<CourseItem[]>([]);
  const [chapters, setChapters] = useState<ChapterItem[]>([]);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [courseId, setCourseId] = useState<number | "">("");
  const [chapterIds, setChapterIds] = useState<number[]>([]);
  const [bankType, setBankType] = useState<QuestionBankType>("training");
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [paperGroups, setPaperGroups] = useState<PaperGroupRow[]>([]);
  const [confirming, setConfirming] = useState(false);

  const [editModalGroupId, setEditModalGroupId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editFiles, setEditFiles] = useState<File[]>([]);
  const editFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoadingCourses(true);
    api.teacher.courses
      .list()
      .then((rows) => {
        const mapped = rows.map((c) => ({ id: c.id, name: c.name }));
        setCourses(mapped);
        if (mapped.length) setCourseId(mapped[0].id);
      })
      .catch((e: any) => {
        toast(e?.message || "课程加载失败", "error");
        setCourses([]);
      })
      .finally(() => setLoadingCourses(false));
  }, []);

  useEffect(() => {
    if (!courseId) {
      setChapters([]);
      setChapterIds([]);
      return;
    }
    setLoadingChapters(true);
    api.teacher.courses
      .chapters(courseId)
      .then((rows) => {
        const mapped = rows.map((ch) => ({ id: ch.id, title: ch.title }));
        setChapters(mapped);
        setChapterIds(mapped.map((x) => x.id));
      })
      .catch((e: any) => {
        toast(e?.message || "章节加载失败", "error");
        setChapters([]);
        setChapterIds([]);
      })
      .finally(() => setLoadingChapters(false));
  }, [courseId]);

  const toggleChapter = (id: number) => {
    setChapterIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const allChaptersSelected = chapters.length > 0 && chapterIds.length === chapters.length;
  const toggleAllChapters = (checked: boolean) => {
    setChapterIds(checked ? chapters.map((x) => x.id) : []);
  };

  const resetForm = () => {
    setBankType("training");
    setPickedFiles([]);
    setPaperGroups([]);
    setEditModalGroupId(null);
    setChapterIds(chapters.map((x) => x.id));
  };

  const chooseFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const next = Array.from(files).filter((f) => /\.(doc|docx|pdf)$/i.test(f.name));
    if (!next.length) {
      toast("仅支持 .doc/.docx/.pdf 文件", "error");
      return;
    }
    setPickedFiles((prev) => [...prev, ...next]);
  };

  /** 按文件名分组，生成试卷行（不识别内容，只按名称归类） */
  const uploadFiles = () => {
    if (!pickedFiles.length) return toast("请先选择文件", "error");
    const keyToFiles = new Map<string, File[]>();
    for (const f of pickedFiles) {
      const key = getPaperGroupKey(f.name);
      if (!keyToFiles.has(key)) keyToFiles.set(key, []);
      keyToFiles.get(key)!.push(f);
    }
    const baseId = Date.now();
    const newRows: PaperGroupRow[] = Array.from(keyToFiles.entries()).map(([key, files], idx) => ({
      id: baseId + idx,
      title: key,
      files,
    }));
    setPaperGroups((prev) => [...newRows, ...prev]);
    setPickedFiles([]);
    toast(`已处理 ${pickedFiles.length} 个文件，归为 ${newRows.length} 份试卷`, "success");
  };

  const deleteGroup = (id: number) => {
    setPaperGroups((prev) => prev.filter((g) => g.id !== id));
    if (editModalGroupId === id) setEditModalGroupId(null);
  };

  const openEditModal = (row: PaperGroupRow) => {
    setEditModalGroupId(row.id);
    setEditTitle(row.title);
    setEditFiles([...row.files]);
  };

  const saveEditModal = () => {
    if (editModalGroupId == null) return;
    const title = editTitle.trim();
    if (!title) return toast("试卷名称不能为空", "error");
    if (!editFiles.length) return toast("至少保留一个文件", "error");
    setPaperGroups((prev) =>
      prev.map((g) =>
        g.id === editModalGroupId ? { ...g, title, files: editFiles } : g
      )
    );
    setEditModalGroupId(null);
    toast("已保存", "success");
  };

  const removeFileInEdit = (index: number) => {
    setEditFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const addFilesInEdit = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list?.length) return;
    const next = Array.from(list).filter((f) => /\.(doc|docx|pdf)$/i.test(f.name));
    setEditFiles((prev) => [...prev, ...next]);
    e.target.value = "";
    editFileInputRef.current?.value && (editFileInputRef.current.value = "");
  };

  const confirmImport = async () => {
    if (!courseId || typeof courseId !== "number") return toast("请先选择课程", "error");
    if (!paperGroups.length) return toast("请先上传文件并生成试卷列表", "error");
    const invalid = paperGroups.find((g) => !g.title.trim() || !g.files.length);
    if (invalid) return toast("每份试卷需有名称且至少一个文件", "error");
    setConfirming(true);
    try {
      let imported = 0;
      for (const group of paperGroups) {
        await api.teacher.courses.importPaper({
          courseId,
          title: group.title.trim(),
          paperBankType: bankType === "exam" ? "formal" : "training",
          chapterIds,
          files: group.files,
        });
        imported += 1;
      }
      toast(`成功导入 ${imported} 份文件试卷`, "success");
      resetForm();
      navigate("/teacher/question-bank/papers/manage");
    } catch (e: unknown) {
      toast((e as Error)?.message || "导入失败", "error");
    } finally {
      setConfirming(false);
    }
  };

  return (
    <>
      <h2 style={{ marginTop: 0, marginBottom: 6, fontSize: 20, fontWeight: 700 }}>导入试卷</h2>
      <p style={{ margin: "0 0 12px 0", fontSize: 14, color: "var(--text-secondary)" }}>导入的试卷将以原文件形式在试卷库中进行保存</p>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 10,
          minHeight: 380,
          padding: 14,
          background: "var(--bg-elevated)",
          color: "var(--text-primary)",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 10 }}>【基础设置】</div>
        <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", rowGap: 10, columnGap: 12, alignItems: "start" }}>
          <div style={{ color: "var(--text-secondary)", paddingTop: 8 }}>课程</div>
          <select
            value={courseId === "" ? "" : String(courseId)}
            onChange={(e) => setCourseId(e.target.value ? Number(e.target.value) : "")}
            disabled={loadingCourses}
          >
            {!courses.length && <option value="">暂无课程</option>}
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name}
              </option>
            ))}
          </select>

          <div style={{ color: "var(--text-secondary)", paddingTop: 8 }}>章节</div>
          <div>
            <details>
              <summary
                style={{
                  listStyle: "none",
                  cursor: courseId ? "pointer" : "not-allowed",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  background: "var(--bg-base)",
                  color: "var(--text-primary)",
                  userSelect: "none",
                  opacity: courseId ? 1 : 0.7,
                }}
              >
                {!courseId
                  ? "请先选择课程"
                  : loadingChapters
                    ? "章节加载中..."
                    : `已选 ${chapterIds.length} / ${chapters.length || 0} 个章节`}
              </summary>
              {!!courseId && (
                <div
                  style={{
                    marginTop: 8,
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: 10,
                    display: "grid",
                    gap: 8,
                    maxHeight: 220,
                    overflowY: "auto",
                    background: "var(--bg-base)",
                  }}
                >
                  {!loadingChapters && !!chapters.length && (
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600 }}>
                      <input type="checkbox" checked={allChaptersSelected} onChange={(e) => toggleAllChapters(e.target.checked)} />
                      全部章节
                    </label>
                  )}
                  {loadingChapters && <span style={{ color: "var(--text-muted)" }}>加载中...</span>}
                  {!loadingChapters &&
                    chapters.map((ch) => (
                      <label key={ch.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                        <input type="checkbox" checked={chapterIds.includes(ch.id)} onChange={() => toggleChapter(ch.id)} />
                        {ch.title}
                      </label>
                    ))}
                  {!loadingChapters && !chapters.length && <span style={{ color: "var(--text-muted)" }}>暂无章节</span>}
                </div>
              )}
            </details>
          </div>

          <div style={{ color: "var(--text-secondary)", alignSelf: "center" }}>导入试卷库类型</div>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", minHeight: 38 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 16 }}>
              <input type="radio" name="import-paper-bank-type" checked={bankType === "training"} onChange={() => setBankType("training")} />
              训练库
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="radio" name="import-paper-bank-type" checked={bankType === "exam"} onChange={() => setBankType("exam")} />
              正式题库
            </label>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>【文件上传】</div>
          <div style={{ color: "var(--text-secondary)", fontSize: 14, marginBottom: 8 }}>
            选择文件后点击「上传文件」，系统将按文件名自动归类为多份试卷（不识别题目内容）。每份试卷可包含多个文件。
          </div>
          <label
            htmlFor="paper-import-files"
            style={{
              display: "block",
              border: "1px dashed var(--border)",
              borderRadius: 10,
              padding: 16,
              background: "var(--bg-hover)",
              cursor: "pointer",
            }}
          >
            点击选择文件 / 拖拽文件至此处（支持多文件）
            <div style={{ marginTop: 8, color: "var(--text-secondary)", fontSize: 13 }}>
              已选文件：{pickedFiles.length ? pickedFiles.map((f) => f.name).join("、") : "无"}
            </div>
          </label>
          <input
            id="paper-import-files"
            type="file"
            multiple
            accept=".doc,.docx,.pdf"
            style={{ display: "none" }}
            onChange={(e) => chooseFiles(e.target.files)}
          />
          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="btn-secondary" onClick={() => document.getElementById("paper-import-files")?.click()}>
              选择文件
            </button>
            <button type="button" className="btn-primary" onClick={uploadFiles} disabled={!pickedFiles.length}>
              上传文件
            </button>
            <button type="button" className="btn-ghost" onClick={() => setPickedFiles([])}>
              清空已选
            </button>
          </div>
        </div>

        {!!paperGroups.length && (
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>【试卷列表】</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
                <thead>
                  <tr>
                    {["序号", "试卷名称", "文件列表", "操作"].map((h) => (
                      <th key={h} style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paperGroups.map((row, idx) => (
                    <tr key={row.id}>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{idx + 1}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.title}</td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                        <span style={{ fontSize: 13 }}>{row.files.map((f) => f.name).join("、")}</span>
                      </td>
                      <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button type="button" className="btn-ghost" style={{ minHeight: 30, padding: "4px 8px" }} onClick={() => deleteGroup(row.id)}>
                            删除
                          </button>
                          <button type="button" className="btn-ghost" style={{ minHeight: 30, padding: "4px 8px" }} onClick={() => openEditModal(row)}>
                            编辑
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {editModalGroupId != null && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.4)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1000,
            }}
            onClick={() => setEditModalGroupId(null)}
          >
            <div
              style={{
                background: "var(--bg-elevated)",
                borderRadius: 12,
                padding: 20,
                minWidth: 420,
                maxWidth: "90vw",
                maxHeight: "85vh",
                overflow: "auto",
                border: "1px solid var(--border)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ fontWeight: 700, marginBottom: 12 }}>编辑试卷</div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 4 }}>试卷名称</div>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  maxLength={128}
                  style={{ width: "100%", padding: "8px 10px" }}
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 4 }}>文件列表</div>
                <ul style={{ margin: 0, paddingLeft: 20, marginBottom: 8 }}>
                  {editFiles.map((f, i) => (
                    <li key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ flex: 1, fontSize: 13 }}>{f.name}</span>
                      <button type="button" className="btn-ghost" style={{ padding: "2px 8px" }} onClick={() => removeFileInEdit(i)}>
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
                <input
                  ref={editFileInputRef}
                  type="file"
                  multiple
                  accept=".doc,.docx,.pdf"
                  style={{ display: "none" }}
                  onChange={addFilesInEdit}
                />
                <button type="button" className="btn-secondary" onClick={() => editFileInputRef.current?.click()}>
                  添加文件
                </button>
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button type="button" className="btn-secondary" onClick={() => setEditModalGroupId(null)}>
                  取消
                </button>
                <button type="button" className="btn-primary" onClick={saveEditModal}>
                  保存
                </button>
              </div>
            </div>
          </div>
        )}

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14, display: "flex", gap: 10 }}>
          <button type="button" className="btn-secondary" onClick={resetForm}>
            重置
          </button>
          <button type="button" className="btn-primary" onClick={confirmImport} disabled={confirming || !paperGroups.length}>
            {confirming ? "导入中..." : "确认导入"}
          </button>
        </div>
      </div>
    </>
  );
}

type PaperQuestionRow = {
  questionType: string;
  questionText: string;
  options: string[];
  correctAnswer: string;
  explanation: string | null;
  difficultyScore: number;
  score: number;
  source: "local" | "internet";
};

const PAPER_CONTENT_TYPE_LABEL: Record<string, string> = {
  single_choice: "单选题",
  multiple_choice: "多选题",
  judge: "判断题",
  blank: "填空题",
  qa: "问答题",
};

type PaperFileRow = { id: number; paper_id: number; file_name: string; created_at: string | null };

export function TeacherPaperFilesPage() {
  const { paperId: paperIdParam } = useParams<{ paperId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const paperId = paperIdParam ? parseInt(paperIdParam, 10) : 0;
  const mode = (searchParams.get("mode") === "edit" ? "edit" : "view") as "view" | "edit";

  const [loading, setLoading] = useState(true);
  const [paperTitle, setPaperTitle] = useState("");
  const [overallDifficulty, setOverallDifficulty] = useState(0);
  const [totalScore, setTotalScore] = useState(0);
  const [editOverallDifficulty, setEditOverallDifficulty] = useState("");
  const [editTotalScore, setEditTotalScore] = useState("");
  const [files, setFiles] = useState<PaperFileRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [savingMeta, setSavingMeta] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadData = async () => {
    if (!paperId || !Number.isFinite(paperId)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [detail, list] = await Promise.all([
        api.teacher.courses.paperDetail(paperId),
        api.teacher.courses.listPaperFiles(paperId),
      ]);
      if (detail.paper_type !== "file") {
        toast("该试卷不是文件试卷", "error");
        navigate("/teacher/question-bank/papers/manage");
        return;
      }
      setPaperTitle(detail.title);
      setOverallDifficulty(detail.overall_difficulty ?? 0);
      setTotalScore(detail.total_score ?? 0);
      setEditOverallDifficulty(String(detail.overall_difficulty ?? 0));
      setEditTotalScore(String(detail.total_score ?? 0));
      setFiles(list);
    } catch (e: unknown) {
      toast((e as Error)?.message || "加载失败", "error");
      setPaperTitle("");
      setFiles([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [paperId]);

  const handleView = async (fileId: number, _fileName: string) => {
    try {
      const blob = await api.teacher.courses.downloadPaperFile(paperId, fileId);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e: unknown) {
      toast((e as Error)?.message || "打开失败", "error");
    }
  };

  const handleDownload = async (fileId: number, fileName: string) => {
    try {
      const blob = await api.teacher.courses.downloadPaperFile(paperId, fileId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName || "download";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      toast((e as Error)?.message || "下载失败", "error");
    }
  };

  const handleDelete = async (fileId: number) => {
    if (!window.confirm("确认删除该文件？")) return;
    setDeletingId(fileId);
    try {
      await api.teacher.courses.deletePaperFile(paperId, fileId);
      setFiles((prev) => prev.filter((f) => f.id !== fileId));
      toast("已删除", "success");
    } catch (e: unknown) {
      toast((e as Error)?.message || "删除失败", "error");
    } finally {
      setDeletingId(null);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files;
    if (!chosen?.length) return;
    setUploading(true);
    try {
      for (let i = 0; i < chosen.length; i++) {
        const file = chosen[i];
        if (!file.name?.trim()) continue;
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        if (![".pdf", ".doc", ".docx"].some((x) => x.slice(1) === ext)) continue;
        const added = await api.teacher.courses.uploadPaperFile(paperId, file);
        setFiles((prev) => [...prev, { id: added.id, paper_id: added.paper_id, file_name: added.file_name, created_at: added.created_at }]);
      }
      toast("上传成功", "success");
    } catch (err: unknown) {
      toast((err as Error)?.message || "上传失败", "error");
    } finally {
      setUploading(false);
      e.target.value = "";
      fileInputRef.current?.value && (fileInputRef.current.value = "");
    }
  };

  const saveDifficultyAndScore = async () => {
    const diffNum = Number(editOverallDifficulty);
    const scoreNum = Number(editTotalScore);
    if (!Number.isFinite(diffNum) || diffNum < 0 || diffNum > 1) {
      toast("整卷难度系数需在 0~1 之间", "error");
      return;
    }
    if (!Number.isFinite(scoreNum) || scoreNum < 0) {
      toast("总分值需为非负数", "error");
      return;
    }
    setSavingMeta(true);
    try {
      await api.teacher.courses.updatePaper(paperId, {
        overall_difficulty: diffNum,
        total_score: scoreNum,
      });
      setOverallDifficulty(diffNum);
      setTotalScore(scoreNum);
      toast("已保存", "success");
    } catch (e: unknown) {
      toast((e as Error)?.message || "保存失败", "error");
    } finally {
      setSavingMeta(false);
    }
  };

  const isValidDifficultyText = (value: string) => /^\d*(\.\d{0,2})?$/.test(value);
  const isValidScoreText = (value: string) => /^\d*(\.\d*)?$/.test(value);

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span />
          <button type="button" className="btn-secondary" onClick={() => navigate("/teacher/question-bank/papers/manage")}>
            返回
          </button>
        </div>
        <div style={{ color: "var(--text-muted)" }}>加载中...</div>
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>文件试卷：{paperTitle || "—"}</h2>
        <button type="button" className="btn-secondary" onClick={() => navigate("/teacher/question-bank/papers/manage")}>
          返回
        </button>
      </div>

      <div style={{ fontWeight: 700, marginBottom: 8 }}>【整卷难度与总分值】</div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          alignItems: "center",
          marginBottom: 16,
          padding: 12,
          border: "1px solid var(--border)",
          borderRadius: 10,
          background: "var(--bg-elevated)",
        }}
      >
        <span style={{ color: "var(--text-secondary)" }}>整卷难度</span>
        {mode === "view" ? (
          <span>{overallDifficulty.toFixed(2)}</span>
        ) : (
          <input
            type="text"
            value={editOverallDifficulty}
            onChange={(e) => isValidDifficultyText(e.target.value) && setEditOverallDifficulty(e.target.value)}
            placeholder="0~1"
            style={{ width: 80 }}
          />
        )}
        <span style={{ color: "var(--text-secondary)", marginLeft: "2em" }}>总分值</span>
        {mode === "view" ? (
          <span>{totalScore}</span>
        ) : (
          <input
            type="text"
            value={editTotalScore}
            onChange={(e) => isValidScoreText(e.target.value) && setEditTotalScore(e.target.value)}
            placeholder="总分"
            style={{ width: 80 }}
          />
        )}
        {mode === "edit" && (
          <button type="button" className="btn-primary" onClick={saveDifficultyAndScore} disabled={savingMeta}>
            {savingMeta ? "保存中..." : "保存"}
          </button>
        )}
      </div>

      <div style={{ fontWeight: 700, marginBottom: 8 }}>【导入的文件列表】</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
          <thead>
            <tr>
              {["序号", "文件名", "上传时间", "操作"].map((h) => (
                <th key={h} style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {files.map((f, idx) => (
              <tr key={f.id}>
                <td style={{ border: "1px solid var(--border)", padding: 8 }}>{idx + 1}</td>
                <td style={{ border: "1px solid var(--border)", padding: 8 }}>{f.file_name}</td>
                <td style={{ border: "1px solid var(--border)", padding: 8 }}>{f.created_at ? new Date(f.created_at).toLocaleString() : "-"}</td>
                <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button type="button" className="btn-ghost" style={{ minHeight: 30, padding: "4px 8px" }} onClick={() => handleView(f.id, f.file_name)}>
                      查看
                    </button>
                    <button type="button" className="btn-ghost" style={{ minHeight: 30, padding: "4px 8px" }} onClick={() => handleDownload(f.id, f.file_name)}>
                      下载
                    </button>
                    {mode === "edit" && (
                      <button type="button" className="btn-ghost" style={{ minHeight: 30, padding: "4px 8px" }} onClick={() => handleDelete(f.id)} disabled={deletingId === f.id}>
                        {deletingId === f.id ? "删除中..." : "删除"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!files.length && (
              <tr>
                <td colSpan={4} style={{ border: "1px solid var(--border)", padding: 8, color: "var(--text-muted)" }}>
                  暂无文件
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {mode === "edit" && (
        <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.doc,.docx"
            style={{ display: "none" }}
            onChange={handleUpload}
          />
          <button type="button" className="btn-primary" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? "上传中..." : "上传文件"}
          </button>
          <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>支持 .pdf、.doc、.docx，可多选</span>
        </div>
      )}
    </div>
  );
}

export function TeacherPaperContentPage() {
  const { paperId: paperIdParam } = useParams<{ paperId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const paperId = paperIdParam ? parseInt(paperIdParam, 10) : 0;
  const mode = (searchParams.get("mode") === "edit" ? "edit" : "view") as "view" | "edit";

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<{
    courseId: number;
    courseName: string;
    title: string;
    paperBankType: "training" | "formal";
    questionSource: "local" | "internet";
    status: string;
    overallDifficulty: number;
    chapterIds: number[];
    requestPayload: Record<string, unknown>;
    contentPayload: Record<string, unknown> | null;
  } | null>(null);
  const [chapterNames, setChapterNames] = useState<Map<number, string>>(new Map());
  const [chapters, setChapters] = useState<ChapterItem[]>([]);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editStatus, setEditStatus] = useState<"pending" | "reviewed">("pending");
  const [editPaperBankType, setEditPaperBankType] = useState<"training" | "formal">("training");
  const [editOverallDifficulty, setEditOverallDifficulty] = useState("");
  const [editChapterIds, setEditChapterIds] = useState<number[]>([]);
  const [questions, setQuestions] = useState<PaperQuestionRow[]>([]);
  const [editingQuestionIndex, setEditingQuestionIndex] = useState<number | null>(null);
  const [editQuestionDraft, setEditQuestionDraft] = useState<PaperQuestionRow | null>(null);

  useEffect(() => {
    if (!paperId || !Number.isFinite(paperId)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api.teacher.courses
      .paperDetail(paperId)
      .then((d) => {
        const rows = (d.content_payload?.preview_questions || []).map((q) => ({
          questionType: q.question_type,
          questionText: q.question_text,
          options: q.options || [],
          correctAnswer: q.correct_answer,
          explanation: q.explanation ?? null,
          difficultyScore: q.difficulty_score,
          score: q.score,
          source: q.source,
        }));
        setDetail({
          courseId: d.course_id,
          courseName: d.course_name,
          title: d.title,
          paperBankType: d.paper_bank_type,
          questionSource: d.question_source,
          status: d.status,
          overallDifficulty: d.overall_difficulty,
          chapterIds: d.chapter_ids || [],
          requestPayload: d.request_payload || {},
          contentPayload: d.content_payload || null,
        });
        setEditTitle(d.title);
        setEditStatus((d.status === "reviewed" ? "reviewed" : "pending") as "pending" | "reviewed");
        setEditPaperBankType(d.paper_bank_type);
        setEditOverallDifficulty(String(d.overall_difficulty));
        setEditChapterIds(d.chapter_ids || []);
        setQuestions(rows);
        if (d.course_id) {
          setLoadingChapters(true);
          return api.teacher.courses.chapters(d.course_id).then((chList) => {
            const mapped = chList.map((ch) => ({ id: ch.id, title: ch.title }));
            setChapters(mapped);
            const m = new Map<number, string>();
            mapped.forEach((ch) => m.set(ch.id, ch.title));
            setChapterNames(m);
          }).finally(() => setLoadingChapters(false));
        }
      })
      .catch((e: unknown) => {
        toast((e as Error)?.message || "试卷加载失败", "error");
        setDetail(null);
        setQuestions([]);
      })
      .finally(() => setLoading(false));
  }, [paperId]);

  const updateQuestion = (index: number, patch: Partial<PaperQuestionRow>) => {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  };

  const openQuestionEdit = (idx: number) => {
    const q = questions[idx];
    if (q) {
      setEditingQuestionIndex(idx);
      setEditQuestionDraft({ ...q });
    }
  };

  const closeQuestionEdit = () => {
    setEditingQuestionIndex(null);
    setEditQuestionDraft(null);
  };

  const saveQuestionEdit = () => {
    if (editingQuestionIndex === null || !editQuestionDraft) return;
    updateQuestion(editingQuestionIndex, editQuestionDraft);
    closeQuestionEdit();
  };

  const isValidDifficultyText = (value: string) => /^\d*(\.\d{0,2})?$/.test(value);

  const saveAll = async () => {
    if (!detail || !Number.isFinite(paperId)) return;
    const title = editTitle.trim();
    if (!title) {
      toast("试卷标题不能为空", "error");
      return;
    }
    const overallNum = Number(editOverallDifficulty);
    if (!Number.isFinite(overallNum) || overallNum < 0 || overallNum > 1) {
      toast("整卷难度系数需在 0~1 之间", "error");
      return;
    }
    setSaving(true);
    try {
      const contentPayload = {
        ...(detail.contentPayload || {}),
        preview_questions: questions.map((q) => ({
          question_type: q.questionType,
          question_text: q.questionText,
          options: q.options,
          correct_answer: q.correctAnswer,
          explanation: q.explanation,
          difficulty_score: q.difficultyScore,
          score: q.score,
          source: q.source,
        })),
      };
      const requestPayload = { ...(detail.requestPayload || {}), chapter_ids: editChapterIds };
      await api.teacher.courses.updatePaper(paperId, {
        title,
        status: editStatus,
        paper_bank_type: editPaperBankType,
        overall_difficulty: overallNum,
        request_payload: requestPayload,
        content_payload: contentPayload,
      });
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              title,
              status: editStatus,
              paperBankType: editPaperBankType,
              overallDifficulty: overallNum,
              chapterIds: editChapterIds,
              requestPayload,
              contentPayload,
            }
          : null
      );
      toast("保存成功", "success");
    } catch (e: unknown) {
      toast((e as Error)?.message || "保存失败", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span />
          <button type="button" className="btn-secondary" onClick={() => navigate("/teacher/question-bank/papers/manage")}>
            返回
          </button>
        </div>
        <div style={{ color: "var(--text-muted)" }}>加载中...</div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span />
          <button type="button" className="btn-secondary" onClick={() => navigate("/teacher/question-bank/papers/manage")}>
            返回
          </button>
        </div>
        <div style={{ color: "var(--text-muted)" }}>试卷不存在或加载失败</div>
      </div>
    );
  }

  const chapterLabel =
    mode === "edit"
      ? `已选 ${editChapterIds.length} / ${chapters.length || 0} 个章节`
      : detail.chapterIds.map((id) => chapterNames.get(id) ?? `章节${id}`).join("、") || "-";
  const statusLabel = (mode === "edit" ? editStatus : detail.status) === "pending" ? "待审核" : "已审核";
  const allChaptersSelected = chapters.length > 0 && (mode === "edit" ? editChapterIds.length === chapters.length : detail.chapterIds.length === chapters.length);
  const toggleAllChapters = (checked: boolean) => {
    setEditChapterIds(checked ? chapters.map((x) => x.id) : []);
  };
  const toggleChapter = (id: number) => {
    setEditChapterIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>试卷内容</h2>
        <button type="button" className="btn-secondary" onClick={() => navigate("/teacher/question-bank/papers/manage")}>
          返回
        </button>
      </div>
      <div
        className="card"
        style={{
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 14,
          background: "var(--bg-elevated)",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", rowGap: 10, columnGap: 12, alignItems: mode === "edit" ? "start" : "center" }}>
          <div style={{ color: "var(--text-secondary)" }}>课程</div>
          <div>{detail.courseName}</div>
          <div style={{ color: "var(--text-secondary)", paddingTop: mode === "edit" ? 8 : 0 }}>章节</div>
          {mode === "edit" ? (
            <div>
              <details>
                <summary
                  style={{
                    listStyle: "none",
                    cursor: "pointer",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: "10px 12px",
                    background: "var(--bg-base)",
                    color: "var(--text-primary)",
                    userSelect: "none",
                  }}
                >
                  {loadingChapters ? "章节加载中..." : chapterLabel}
                </summary>
                <div
                  style={{
                    marginTop: 8,
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: 10,
                    display: "grid",
                    gap: 8,
                    maxHeight: 220,
                    overflowY: "auto",
                    background: "var(--bg-base)",
                  }}
                >
                  {!!chapters.length && (
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600 }}>
                      <input type="checkbox" checked={allChaptersSelected} onChange={(e) => toggleAllChapters(e.target.checked)} />
                      全部章节
                    </label>
                  )}
                  {chapters.map((ch) => (
                    <label key={ch.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                      <input type="checkbox" checked={editChapterIds.includes(ch.id)} onChange={() => toggleChapter(ch.id)} />
                      {ch.title}
                    </label>
                  ))}
                  {!chapters.length && !loadingChapters && <span style={{ color: "var(--text-muted)" }}>暂无章节</span>}
                </div>
              </details>
            </div>
          ) : (
            <div>{detail.chapterIds.map((id) => chapterNames.get(id) ?? `章节${id}`).join("、") || "-"}</div>
          )}
          <div style={{ color: "var(--text-secondary)" }}>试卷库类型</div>
          {mode === "edit" ? (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input type="radio" name="paper-content-bank" checked={editPaperBankType === "training"} onChange={() => setEditPaperBankType("training")} />
                训练库
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input type="radio" name="paper-content-bank" checked={editPaperBankType === "formal"} onChange={() => setEditPaperBankType("formal")} />
                正式题库
              </label>
            </div>
          ) : (
            <div>{detail.paperBankType === "training" ? "训练库" : "正式题库"}</div>
          )}
          <div style={{ color: "var(--text-secondary)" }}>整卷难度系数</div>
          {mode === "edit" ? (
            <input
              type="text"
              value={editOverallDifficulty}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "" || isValidDifficultyText(v)) setEditOverallDifficulty(v);
              }}
              placeholder="0~1"
              style={{ width: 120 }}
            />
          ) : (
            <div>{detail.overallDifficulty.toFixed(2)}</div>
          )}
          <div style={{ color: "var(--text-secondary)" }}>试卷标题</div>
          {mode === "edit" ? (
            <input type="text" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={128} style={{ width: "100%", maxWidth: 400 }} />
          ) : (
            <div>{detail.title}</div>
          )}
          <div style={{ color: "var(--text-secondary)" }}>总分</div>
          <div>{questions.reduce((s, q) => s + q.score, 0)}</div>
          <div style={{ color: "var(--text-secondary)" }}>来源</div>
          <div>{detail.questionSource === "local" ? "本地题库" : "互联网"}</div>
          <div style={{ color: "var(--text-secondary)" }}>状态</div>
          {mode === "edit" ? (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input type="radio" name="paper-content-status" checked={editStatus === "pending"} onChange={() => setEditStatus("pending")} />
                待审核
              </label>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input type="radio" name="paper-content-status" checked={editStatus === "reviewed"} onChange={() => setEditStatus("reviewed")} />
                已审核
              </label>
            </div>
          ) : (
            <div>{statusLabel}</div>
          )}
        </div>
      </div>
      <div
        className="card"
        style={{
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 14,
          background: "var(--bg-elevated)",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 10 }}>试题列表</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
            <thead>
              <tr>
                {["序号", "题目内容", "选项", "答案", "解析", "分数", "题型", "难度系数", ...(mode === "edit" ? ["操作"] : [])].map((h) => (
                  <th key={h} style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {questions.map((row, idx) => (
                <tr key={idx}>
                  <td style={{ border: "1px solid var(--border)", padding: 8 }}>{idx + 1}</td>
                  <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                    <span style={{ whiteSpace: "pre-wrap" }}>{row.questionText}</span>
                  </td>
                  <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                    <span style={{ whiteSpace: "pre-wrap" }}>
                      {(row.options || []).length ? row.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("\n") : "-"}
                    </span>
                  </td>
                  <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.correctAnswer || "-"}</td>
                  <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                    <span style={{ whiteSpace: "pre-wrap" }}>{row.explanation ?? "-"}</span>
                  </td>
                  <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.score}</td>
                  <td style={{ border: "1px solid var(--border)", padding: 8 }}>{PAPER_CONTENT_TYPE_LABEL[row.questionType] || row.questionType}</td>
                  <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.difficultyScore.toFixed(2)}</td>
                  {mode === "edit" && (
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <button type="button" className="btn-ghost" style={{ padding: "4px 8px", fontSize: 13 }} onClick={() => openQuestionEdit(idx)}>
                        编辑
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {!questions.length && (
                <tr>
                  <td colSpan={mode === "edit" ? 9 : 8} style={{ border: "1px solid var(--border)", padding: 8, color: "var(--text-muted)" }}>
                    暂无题目
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {mode === "edit" && (
          <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
            <button type="button" className="btn-primary" onClick={saveAll} disabled={saving}>
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        )}
      </div>

      {editingQuestionIndex !== null && editQuestionDraft && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "grid",
            placeItems: "center",
            zIndex: 2000,
            padding: 12,
          }}
          onClick={closeQuestionEdit}
        >
          <div
            className="card"
            style={{ width: "min(560px, 100%)", maxHeight: "90vh", overflow: "auto", padding: 14 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0, marginBottom: 12 }}>编辑题目（第 {editingQuestionIndex + 1} 题）</h3>
            <div style={{ display: "grid", gridTemplateColumns: "80px minmax(0, 1fr)", rowGap: 8, columnGap: 12, alignItems: "start" }}>
              <div style={{ color: "var(--text-secondary)", paddingTop: 8 }}>题目内容</div>
              <textarea
                value={editQuestionDraft.questionText}
                onChange={(e) => setEditQuestionDraft((d) => (d ? { ...d, questionText: e.target.value } : null))}
                rows={4}
                style={{ width: "100%", minHeight: "4.5em", resize: "vertical" }}
              />
              <div style={{ color: "var(--text-secondary)", paddingTop: 8 }}>选项</div>
              <textarea
                value={(editQuestionDraft.options || []).join("\n")}
                onChange={(e) =>
                  setEditQuestionDraft((d) => (d ? { ...d, options: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) } : null))
                }
                rows={4}
                placeholder="每行一个选项"
                style={{ width: "100%", minHeight: "4.5em", resize: "vertical" }}
              />
              <div style={{ color: "var(--text-secondary)" }}>答案</div>
              <textarea
                value={editQuestionDraft.correctAnswer}
                onChange={(e) => setEditQuestionDraft((d) => (d ? { ...d, correctAnswer: e.target.value } : null))}
                rows={4}
                style={{ width: "100%", minHeight: "4.5em", resize: "vertical" }}
              />
              <div style={{ color: "var(--text-secondary)", paddingTop: 8 }}>解析</div>
              <textarea
                value={editQuestionDraft.explanation ?? ""}
                onChange={(e) => setEditQuestionDraft((d) => (d ? { ...d, explanation: e.target.value || null } : null))}
                rows={4}
                style={{ width: "100%", minHeight: "4.5em", resize: "vertical" }}
              />
              <div style={{ color: "var(--text-secondary)" }}>题型</div>
              <select
                value={editQuestionDraft.questionType}
                onChange={(e) => setEditQuestionDraft((d) => (d ? { ...d, questionType: e.target.value } : null))}
                style={{ minWidth: 120 }}
              >
                {Object.entries(PAPER_CONTENT_TYPE_LABEL).map(([val, label]) => (
                  <option key={val} value={val}>
                    {label}
                  </option>
                ))}
              </select>
              <div style={{ color: "var(--text-secondary)" }}>难度系数</div>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={editQuestionDraft.difficultyScore}
                onChange={(e) =>
                  setEditQuestionDraft((d) => (d ? { ...d, difficultyScore: Number(e.target.value) || 0 } : null))
                }
                style={{ width: 100 }}
              />
              <div style={{ color: "var(--text-secondary)" }}>分数</div>
              <input
                type="number"
                min={0}
                step={1}
                value={editQuestionDraft.score}
                onChange={(e) => setEditQuestionDraft((d) => (d ? { ...d, score: Number(e.target.value) || 0 } : null))}
                style={{ width: 100 }}
              />
            </div>
            <div style={{ marginTop: 14, display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button type="button" className="btn-secondary" onClick={closeQuestionEdit}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={saveQuestionEdit}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PaperManagePanel() {
  const navigate = useNavigate();
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [loadingChapters, setLoadingChapters] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [courses, setCourses] = useState<CourseItem[]>([]);
  const [chapters, setChapters] = useState<ChapterItem[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [rows, setRows] = useState<
    {
      id: number;
      courseId: number;
      courseName: string;
      title: string;
      paper_type: "electronic" | "file";
      paperBankType: "training" | "formal";
      questionSource: "local" | "internet";
      status: "pending" | "reviewed";
      isPartial: boolean;
      totalScore: number;
      overallDifficulty: number;
      chapterIds: number[];
      createdAt: string | null;
      updatedAt: string | null;
    }[]
  >([]);
  const [courseIdFilter, setCourseIdFilter] = useState<number | "">("");
  const [chapterIdsFilter, setChapterIdsFilter] = useState<number[]>([]);
  const [difficultyMin, setDifficultyMin] = useState<string>("0");
  const [difficultyMax, setDifficultyMax] = useState<string>("1");
  const [titleKeyword, setTitleKeyword] = useState<string>("");
  const [reviewStatusFilter, setReviewStatusFilter] = useState<"" | "pending" | "reviewed">("");
  const [bankTypeFilter, setBankTypeFilter] = useState<"" | "training" | "formal">("");
  const typeLabelMap: Record<string, string> = {
    single_choice: "单选题",
    multiple_choice: "多选题",
    judge: "判断题",
    blank: "填空题",
    qa: "问答题",
  };
  const isValidDifficultyText = (value: string) => /^\d*(\.\d{0,2})?$/.test(value);

  const statusLabel: Record<string, string> = {
    pending: "待审核",
    reviewed: "已审核",
  };

  useEffect(() => {
    setLoadingCourses(true);
    api.teacher.courses
      .list()
      .then((list) => {
        const mapped = list.map((x) => ({ id: x.id, name: x.name }));
        setCourses(mapped);
      })
      .catch((e: any) => {
        toast(e?.message || "课程加载失败", "error");
      })
      .finally(() => setLoadingCourses(false));
  }, []);

  useEffect(() => {
    if (!courseIdFilter) {
      setChapters([]);
      setChapterIdsFilter([]);
      return;
    }
    setLoadingChapters(true);
    api.teacher.courses
      .chapters(courseIdFilter)
      .then((rows) => {
        const mapped = rows.map((ch) => ({ id: ch.id, title: ch.title }));
        setChapters(mapped);
        setChapterIdsFilter(mapped.map((x) => x.id));
      })
      .catch((e: any) => {
        toast(e?.message || "章节加载失败", "error");
        setChapters([]);
        setChapterIdsFilter([]);
      })
      .finally(() => setLoadingChapters(false));
  }, [courseIdFilter]);

  const allChaptersSelected = chapters.length > 0 && chapterIdsFilter.length === chapters.length;
  const toggleAllChapters = (checked: boolean) => {
    setChapterIdsFilter(checked ? chapters.map((x) => x.id) : []);
  };
  const toggleChapter = (id: number) => {
    setChapterIdsFilter((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const loadRows = async (targetPage = page) => {
    setLoadingRows(true);
    try {
      const resp = await api.teacher.courses.listPapersPaged({
        courseId: courseIdFilter === "" ? undefined : courseIdFilter,
        chapterIds: courseIdFilter && !allChaptersSelected ? chapterIdsFilter : undefined,
        titleKw: titleKeyword.trim() || undefined,
        difficultyMin: difficultyMin.trim() ? Number(difficultyMin) : undefined,
        difficultyMax: difficultyMax.trim() ? Number(difficultyMax) : undefined,
        reviewStatus: reviewStatusFilter || undefined,
        paperBankType: bankTypeFilter || undefined,
        page: targetPage,
        pageSize,
      });
      setRows(
        resp.items.map((x) => ({
          id: x.id,
          courseId: x.course_id,
          courseName: x.course_name,
          title: x.title,
          paper_type: x.paper_type,
          paperBankType: x.paper_bank_type,
          questionSource: x.question_source,
          status: x.status,
          isPartial: x.is_partial,
          totalScore: x.total_score,
          overallDifficulty: x.overall_difficulty,
          chapterIds: x.chapter_ids || [],
          createdAt: x.created_at,
          updatedAt: x.updated_at,
        }))
      );
      setTotal(resp.total);
      setPage(resp.page);
      setSelectedIds([]);
    } catch (e: any) {
      toast(e?.message || "试卷列表加载失败", "error");
      setRows([]);
      setTotal(0);
      setSelectedIds([]);
    } finally {
      setLoadingRows(false);
    }
  };

  useEffect(() => {
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doQuery = async () => {
    if (difficultyMin.trim()) {
      const v = Number(difficultyMin);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        toast("整卷难度系数最小值需在 0~1", "error");
        return;
      }
    }
    if (difficultyMax.trim()) {
      const v = Number(difficultyMax);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        toast("整卷难度系数最大值需在 0~1", "error");
        return;
      }
    }
    if (difficultyMin.trim() && difficultyMax.trim() && Number(difficultyMin) > Number(difficultyMax)) {
      toast("整卷难度系数区间不合法：最小值不能大于最大值", "error");
      return;
    }
    await loadRows(1);
  };

  const resetFilters = async () => {
    setCourseIdFilter("");
    setChapters([]);
    setChapterIdsFilter([]);
    setDifficultyMin("0");
    setDifficultyMax("1");
    setTitleKeyword("");
    setReviewStatusFilter("");
    setBankTypeFilter("");
    setPage(1);
    setTotal(0);
    setSelectedIds([]);
    setLoadingRows(true);
    try {
      const resp = await api.teacher.courses.listPapersPaged({ page: 1, pageSize });
      setRows(
        resp.items.map((x) => ({
          id: x.id,
          courseId: x.course_id,
          courseName: x.course_name,
          title: x.title,
          paper_type: x.paper_type,
          paperBankType: x.paper_bank_type,
          questionSource: x.question_source,
          status: x.status,
          isPartial: x.is_partial,
          totalScore: x.total_score,
          overallDifficulty: x.overall_difficulty,
          chapterIds: x.chapter_ids || [],
          createdAt: x.created_at,
          updatedAt: x.updated_at,
        }))
      );
      setTotal(resp.total);
      setPage(resp.page);
    } catch (e: any) {
      toast(e?.message || "重置后加载失败", "error");
      setRows([]);
      setTotal(0);
    } finally {
      setLoadingRows(false);
    }
  };

  const allCurrentSelected = rows.length > 0 && rows.every((r) => selectedIds.includes(r.id));
  const toggleSelectAllCurrent = (checked: boolean) => {
    if (checked) {
      setSelectedIds(Array.from(new Set([...selectedIds, ...rows.map((r) => r.id)])));
    } else {
      const current = new Set(rows.map((r) => r.id));
      setSelectedIds(selectedIds.filter((id) => !current.has(id)));
    }
  };
  const toggleSelectOne = (id: number, checked: boolean) => {
    setSelectedIds((prev) => (checked ? Array.from(new Set([...prev, id])) : prev.filter((x) => x !== id)));
  };

  const batchDelete = async () => {
    if (!selectedIds.length) {
      toast("请先选择要删除的试卷", "error");
      return;
    }
    const ok = window.confirm(`确认删除已选择的 ${selectedIds.length} 条试卷吗？删除后不可恢复。`);
    if (!ok) return;
    setDeleting(true);
    try {
      const r = await api.teacher.courses.batchDeletePapers(selectedIds);
      toast(`已删除 ${r.deleted} 条试卷`, "success");
      const maxPage = Math.max(1, Math.ceil(Math.max(0, total - r.deleted) / pageSize));
      await loadRows(Math.min(page, maxPage));
    } catch (e: any) {
      toast(e?.message || "批量删除失败", "error");
    } finally {
      setDeleting(false);
    }
  };

  const exportList = async () => {
    setExporting(true);
    try {
      const blob = await api.teacher.courses.exportPapersCsv({
        courseId: courseIdFilter === "" ? undefined : courseIdFilter,
        chapterIds: courseIdFilter && !allChaptersSelected ? chapterIdsFilter : undefined,
        titleKw: titleKeyword.trim() || undefined,
        difficultyMin: difficultyMin.trim() ? Number(difficultyMin) : undefined,
        difficultyMax: difficultyMax.trim() ? Number(difficultyMax) : undefined,
        reviewStatus: reviewStatusFilter || undefined,
        paperBankType: bankTypeFilter || undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `试卷列表_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("试卷列表已导出", "success");
    } catch (e: any) {
      toast(e?.message || "导出失败", "error");
    } finally {
      setExporting(false);
    }
  };

  const _escapeHtml = (v: string) =>
    String(v || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const buildPaperHtml = (title: string, questions: any[], withAnswer: boolean) => {
    const rowsHtml = questions
      .map((q, idx) => {
        const opts = (q.options || []).map((o: string) => `<div style="margin-left:12px;">${_escapeHtml(o)}</div>`).join("");
        const answerPart = withAnswer
          ? `<div><b>答案：</b>${_escapeHtml(q.correct_answer || "")}</div>`
          : "";
        const typePart = withAnswer ? `【${_escapeHtml(typeLabelMap[q.question_type] || q.question_type || "")}】` : "";
        return `<div style="margin:10px 0;padding:8px;border-bottom:1px solid #ddd;">
          <div><b>${idx + 1}. ${typePart} ${_escapeHtml(q.question_text || "")}</b></div>
          ${opts}
          ${answerPart}
        </div>`;
      })
      .join("");
    return `<!doctype html><html><head><meta charset="utf-8"><title>${_escapeHtml(title)}</title></head>
      <body style="font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif; padding: 20px;">
        <h2>${_escapeHtml(title)}${withAnswer ? "（答案）" : ""}</h2>
        ${rowsHtml}
      </body></html>`;
  };

  const downloadPaperFile = async (paperId: number, withAnswer: boolean) => {
    try {
      const detail = await api.teacher.courses.paperDetail(paperId);
      const questions = (detail.content_payload?.preview_questions || []) as any[];
      if (!questions.length) {
        toast("该试卷暂无可导出题目", "error");
        return;
      }
      const format = window.prompt("请输入导出格式：pdf 或 word", "word");
      if (!format) return;
      const fmt = format.trim().toLowerCase();
      const html = buildPaperHtml(detail.title, questions, withAnswer);
      if (fmt === "word" || fmt === "doc" || fmt === "docx") {
        const blob = new Blob([`\ufeff${html}`], { type: "application/msword;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${detail.title}${withAnswer ? "_答案" : ""}.doc`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        return;
      }
      if (fmt === "pdf") {
        const win = window.open("", "_blank");
        if (!win) {
          toast("无法打开新窗口，请检查浏览器拦截设置", "error");
          return;
        }
        win.document.write(html);
        win.document.close();
        win.focus();
        win.print();
        return;
      }
      toast("仅支持 pdf 或 word", "error");
    } catch (e: any) {
      toast(e?.message || "导出失败", "error");
    }
  };

  const deleteOnePaper = async (paperId: number) => {
    const ok = window.confirm("确认删除此试卷吗？删除后不可恢复。");
    if (!ok) return;
    try {
      const r = await api.teacher.courses.batchDeletePapers([paperId]);
      if (r.deleted > 0) {
        toast("试卷已删除", "success");
        const maxPage = Math.max(1, Math.ceil(Math.max(0, total - 1) / pageSize));
        await loadRows(Math.min(page, maxPage));
      } else {
        toast("未删除任何试卷", "error");
      }
    } catch (e: any) {
      toast(e?.message || "删除失败", "error");
    }
  };

  return (
    <>
      <h2 style={{ marginTop: 0, marginBottom: 12, fontSize: 20, fontWeight: 700 }}>试卷库查看/编辑</h2>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 10,
          minHeight: 380,
          padding: 14,
          background: "var(--bg-elevated)",
          color: "var(--text-primary)",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 10 }}>【筛选条件】</div>
        <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr)", rowGap: 10, columnGap: 12, alignItems: "start" }}>
          <div style={{ color: "var(--text-secondary)" }}>课程</div>
          <select value={courseIdFilter === "" ? "" : String(courseIdFilter)} onChange={(e) => setCourseIdFilter(e.target.value ? Number(e.target.value) : "")} disabled={loadingCourses}>
            <option value="">全部课程</option>
            {courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.name}
              </option>
            ))}
          </select>
          <div style={{ color: "var(--text-secondary)", paddingTop: 8 }}>章节</div>
          <div>
            <details>
              <summary
                style={{
                  listStyle: "none",
                  cursor: courseIdFilter ? "pointer" : "not-allowed",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  background: "var(--bg-base)",
                  color: "var(--text-primary)",
                  userSelect: "none",
                  opacity: courseIdFilter ? 1 : 0.7,
                }}
              >
                {!courseIdFilter
                  ? "请先选择课程"
                  : loadingChapters
                    ? "章节加载中..."
                    : `已选 ${chapterIdsFilter.length} / ${chapters.length || 0} 个章节`}
              </summary>
              {!!courseIdFilter && (
                <div
                  style={{
                    marginTop: 8,
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: 10,
                    display: "grid",
                    gap: 8,
                    maxHeight: 220,
                    overflowY: "auto",
                    background: "var(--bg-base)",
                  }}
                >
                  {!loadingChapters && !!chapters.length && (
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600 }}>
                      <input type="checkbox" checked={allChaptersSelected} onChange={(e) => toggleAllChapters(e.target.checked)} />
                      全部章节
                    </label>
                  )}
                  {loadingChapters && <span style={{ color: "var(--text-muted)" }}>加载中...</span>}
                  {!loadingChapters &&
                    chapters.map((ch) => (
                      <label key={ch.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14 }}>
                        <input type="checkbox" checked={chapterIdsFilter.includes(ch.id)} onChange={() => toggleChapter(ch.id)} />
                        {ch.title}
                      </label>
                    ))}
                  {!loadingChapters && !chapters.length && <span style={{ color: "var(--text-muted)" }}>暂无章节</span>}
                </div>
              )}
            </details>
          </div>
          <div style={{ color: "var(--text-secondary)" }}>试卷库类型</div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", minHeight: 38 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="radio" name="paper-manage-bank" checked={bankTypeFilter === ""} onChange={() => setBankTypeFilter("")} />
              全部
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="radio" name="paper-manage-bank" checked={bankTypeFilter === "training"} onChange={() => setBankTypeFilter("training")} />
              训练库
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="radio" name="paper-manage-bank" checked={bankTypeFilter === "formal"} onChange={() => setBankTypeFilter("formal")} />
              正式题库
            </label>
          </div>
          <div style={{ color: "var(--text-secondary)", alignSelf: "center" }}>整卷难度系数</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minHeight: 38 }}>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              placeholder="最小值"
              value={difficultyMin}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "" || isValidDifficultyText(v)) setDifficultyMin(v);
              }}
              style={{ width: 110 }}
            />
            <span>-</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              placeholder="最大值"
              value={difficultyMax}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "" || isValidDifficultyText(v)) setDifficultyMax(v);
              }}
              style={{ width: 110 }}
            />
          </div>
          <div style={{ color: "var(--text-secondary)", alignSelf: "center" }}>试卷标题</div>
          <div style={{ minHeight: 38, display: "flex", alignItems: "center" }}>
            <input
              type="text"
              value={titleKeyword}
              onChange={(e) => setTitleKeyword(e.target.value)}
              maxLength={128}
              placeholder="关键词模糊查询"
              style={{ width: "min(420px, 100%)" }}
            />
          </div>
          <div style={{ color: "var(--text-secondary)" }}>状态</div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", minHeight: 38 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="radio" name="paper-manage-status" checked={reviewStatusFilter === ""} onChange={() => setReviewStatusFilter("")} />
              全部
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="radio" name="paper-manage-status" checked={reviewStatusFilter === "pending"} onChange={() => setReviewStatusFilter("pending")} />
              待审核
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="radio" name="paper-manage-status" checked={reviewStatusFilter === "reviewed"} onChange={() => setReviewStatusFilter("reviewed")} />
              已审核
            </label>
          </div>
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
          <button type="button" className="btn-primary" onClick={doQuery} disabled={loadingRows}>
            查询
          </button>
          <button type="button" className="btn-secondary" onClick={resetFilters} disabled={loadingRows}>
            重置筛选
          </button>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 16, paddingTop: 14 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>【试卷列表】</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>
                    <input type="checkbox" checked={allCurrentSelected} onChange={(e) => toggleSelectAllCurrent(e.target.checked)} />
                  </th>
                  {["序号", "试卷标题", "课程", "试卷类型", "试卷库类型", "来源", "状态", "整卷难度", "总分", "更新时间", "操作"].map((h) => (
                    <th key={h} style={{ textAlign: "left", border: "1px solid var(--border)", padding: 8, color: "var(--text-secondary)" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={row.id}>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <input type="checkbox" checked={selectedIds.includes(row.id)} onChange={(e) => toggleSelectOne(row.id, e.target.checked)} />
                    </td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{idx + 1}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.title}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.courseName}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.paper_type === "file" ? "文件试卷" : "电子试卷"}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.paperBankType === "training" ? "训练库" : "正式题库"}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.questionSource === "local" ? "本地题库" : "互联网"}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{statusLabel[row.status] || row.status}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.overallDifficulty.toFixed(2)}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.totalScore}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "-"}</td>
                    <td style={{ border: "1px solid var(--border)", padding: 8 }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button type="button" className="btn-ghost" style={{ minHeight: 30, padding: "4px 8px" }} onClick={() => row.paper_type === "file" ? navigate(`/teacher/question-bank/papers/files/${row.id}?mode=view`) : navigate(`/teacher/question-bank/papers/content/${row.id}?mode=view`)}>
                          查看
                        </button>
                        <button type="button" className="btn-ghost" style={{ minHeight: 30, padding: "4px 8px" }} onClick={() => row.paper_type === "file" ? navigate(`/teacher/question-bank/papers/files/${row.id}?mode=edit`) : navigate(`/teacher/question-bank/papers/content/${row.id}?mode=edit`)}>
                          编辑
                        </button>
                        {row.paper_type !== "file" && (
                          <>
                            <button type="button" className="btn-ghost" style={{ minHeight: 30, padding: "4px 8px" }} onClick={() => downloadPaperFile(row.id, false)}>
                              下载
                            </button>
                            <button type="button" className="btn-ghost" style={{ minHeight: 30, padding: "4px 8px" }} onClick={() => downloadPaperFile(row.id, true)}>
                              下载答案
                            </button>
                          </>
                        )}
                        <button type="button" className="btn-ghost" style={{ minHeight: 30, padding: "4px 8px" }} onClick={() => deleteOnePaper(row.id)}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!rows.length && !loadingRows && (
                  <tr>
                    <td colSpan={12} style={{ border: "1px solid var(--border)", padding: 8, color: "var(--text-muted)" }}>
                      暂无试卷
                    </td>
                  </tr>
                )}
                {loadingRows && (
                  <tr>
                    <td colSpan={12} style={{ border: "1px solid var(--border)", padding: 8, color: "var(--text-muted)" }}>
                      加载中...
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>每页显示</span>
            <select
              value={String(pageSize)}
              onChange={(e) => {
                const n = Math.max(1, Math.min(100, Number(e.target.value || 10)));
                setPageSize(n);
                void loadRows(1);
              }}
            >
              {[10, 20, 30, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button type="button" className="btn-secondary" onClick={() => loadRows(page - 1)} disabled={loadingRows || page <= 1}>
              上一页
            </button>
            <button type="button" className="btn-secondary" onClick={() => loadRows(page + 1)} disabled={loadingRows || page * pageSize >= total}>
              下一页
            </button>
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页，共 {total} 条
            </span>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="btn-secondary" onClick={batchDelete} disabled={deleting || !selectedIds.length}>
              {deleting ? "删除中..." : "批量删除"}
            </button>
            <button type="button" className="btn-secondary" onClick={exportList} disabled={exporting}>
              {exporting ? "导出中..." : "导出试卷列表"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

export default function TeacherQuestionBank({ pageKey }: { pageKey: QuestionBankPageKey }) {
  const activeItem = itemByKey[pageKey];

  return (
    <div>
      <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700 }}>题库管理</h1>
      <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
        <div className="question-bank-grid">
          <aside className="card" style={{ padding: 12 }}>
            {menuGroups.map((group) => (
              <div key={group.title} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 6, fontWeight: 600 }}>{group.title}</div>
                <div style={{ display: "grid", gap: 6, marginLeft: "1.5em" }}>
                  {group.items.map((item) => {
                    const active = item.key === pageKey;
                    return (
                      <Link
                        key={item.key}
                        to={item.path}
                        className="question-bank-sidebar-link"
                        style={{
                          display: "block",
                          borderRadius: 8,
                          padding: "8px 10px",
                          border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
                          background: active ? "var(--accent-muted)" : "transparent",
                          color: active ? "var(--text-primary)" : "var(--text-secondary)",
                          fontSize: 14,
                        }}
                      >
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </aside>

          <section className="card" style={{ padding: 16, minHeight: 460 }}>
            {pageKey === "exercise-generate" ? (
              <GenerateExercisesPanel />
            ) : pageKey === "paper-generate" ? (
              <GeneratePapersPanel />
            ) : pageKey === "exercise-import" ? (
              <ImportExercisesPanel />
            ) : pageKey === "exercise-manage" ? (
              <ExerciseManagePanel />
            ) : pageKey === "paper-import" ? (
              <ImportPapersPanel />
            ) : pageKey === "paper-manage" ? (
              <PaperManagePanel />
            ) : (
              <>
                <h2 style={{ marginTop: 0, marginBottom: 12, fontSize: 20, fontWeight: 700 }}>{activeItem.label}</h2>
                <div
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    minHeight: 380,
                    padding: 14,
                    background: "var(--bg-elevated)",
                    color: "var(--text-secondary)",
                  }}
                >
                  【功能操作区】
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
