import { useState, useEffect, useMemo } from "react";
import { api, API_BASE } from "../../api/client";

const STAT_PERIODS = [
  { value: "7", label: "近7天" },
  { value: "30", label: "近30天" },
  { value: "month", label: "本月" },
  { value: "custom", label: "自定义" },
] as const;

function formatDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function getDefaultTimeRange(period: string): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  if (period === "7") {
    start.setDate(start.getDate() - 6);
  } else if (period === "30") {
    start.setDate(start.getDate() - 29);
  } else if (period === "month") {
    start.setDate(1);
  } else {
    start.setDate(start.getDate() - 6);
  }
  return { start: formatDate(start), end: formatDate(end) };
}

/** ISO 时间串格式化为本地日期时间 */
function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "—";
  }
}

/** 核心学习概览：从 stats 衍生或占位 */
type OverviewStats = {
  preview_student_count: number;
  preview_completion_rate: number;
  completed_question_count: number;
  avg_accuracy_rate: number;
  feedback_question_count: number;
  ai_question_count: number;
  ai_irrelevant_count: number;
};

/** 课程/章节完成一行 */
type CourseChapterRow = {
  course_name: string;
  chapter_name: string;
  completed_count: number;
  accuracy_rate: number;
  top_wrong_point: string;
};

/** 高频错题知识点一行 */
type WeakPointRow = {
  rank: number;
  knowledge_point: string;
  course_name: string;
  wrong_count: number;
  wrong_rate: string;
};

/** AI 高频提问一行 */
type TopAskedRow = {
  rank: number;
  question: string;
  course_name: string;
  ask_count: number;
};

/** 学情详情一行（表6） */
type LearningDetailRow = {
  course_name: string;
  chapter_name: string;
  student_no: string;
  student_name: string;
  class_name: string;
  preview_rate: string;
  completed_count: number;
  accuracy_rate: string;
  feedback_count: number;
  ai_ask_count: number;
  ai_irrelevant_count: number;
  weak_points: string;
};

/** 高频薄弱知识点显示：最多 5 条，超过 20 字用 ... 截断，悬停显示全部 */
function formatWeakPoints(raw: string): { display: string; title: string } {
  if (!raw || raw === "—") return { display: "—", title: "" };
  const parts = raw.split(";").map((s) => s.trim()).filter(Boolean).slice(0, 5);
  const full = parts.join("; ");
  const maxLen = 20;
  const display = full.length > maxLen ? `${full.slice(0, maxLen)}...` : full;
  return { display, title: full };
}

/** 问题反馈一行（表7） */
type FeedbackRow = {
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
};

type ClassItem = { id: number; name: string; course_id: number | null };
type StudentItem = { id: number; username: string; student_no: string | null; display_name: string | null };

export default function TeacherLearningData() {
  const [courses, setCourses] = useState<{ id: number; name: string }[]>([]);
  const [chapters, setChapters] = useState<{ id: number; title: string }[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [students, setStudents] = useState<StudentItem[]>([]);
  const [classStudents, setClassStudents] = useState<StudentItem[]>([]);
  const [courseId, setCourseId] = useState<number | undefined>(undefined);
  const [chapterId, setChapterId] = useState<number | undefined>(undefined);
  const [classId, setClassId] = useState<number | undefined>(undefined);
  const [period, setPeriod] = useState<string>("7");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [stats, setStats] = useState<{
    preview_completion_rate: number;
    preview_student_count?: number;
    completed_question_count?: number;
    feedback_question_count?: number;
    ai_ask_count?: number;
    ai_irrelevant_count?: number;
    weak_knowledge_point_course_ids?: (number | null)[];
    weak_knowledge_point_wrong_counts?: number[];
    top_asked: { question: string; count: number; course_id?: number | null }[];
    answer_accuracy_rate: number;
    weak_knowledge_points: string[];
  } | null>(null);
  /** 章节选「全部」时，按章节拉取的完成数/正确率，用于表格与单独选某章时一致 */
  const [chapterStats, setChapterStats] = useState<Record<number, { completed_question_count: number; answer_accuracy_rate: number; weak_knowledge_points: string[] }>>({});
  /** 课程选「全部」时，按课程拉取的统计（反馈数、AI提问、AI无关、薄弱点），用于详情表每行显示该课程的数据 */
  const [courseStats, setCourseStats] = useState<Record<number, {
    feedback_question_count: number;
    top_asked: { question: string; count: number }[];
    ai_irrelevant_count: number;
    weak_knowledge_points: string[];
  }>>({});
  /** 课程选「全部」且章节选「全部」时：每门课的章节列表，用于表格逐行展示每课程每章节 */
  const [allChaptersByCourseId, setAllChaptersByCourseId] = useState<Record<number, { id: number; title: string }[]>>({});
  /** 课程选「全部」且章节选「全部」时：每 (课程, 章节) 的习题完成统计，key 为 `${courseId}-${chapterId}`，章节为 0 表示课程汇总 */
  const [allCourseChapterStats, setAllCourseChapterStats] = useState<Record<string, { completed_question_count: number; answer_accuracy_rate: number; weak_knowledge_points: string[] }>>({});
  const [loading, setLoading] = useState(true);

  const timeRange = useMemo(() => {
    if (period === "custom" && customStart && customEnd) {
      return { start: customStart, end: customEnd };
    }
    return getDefaultTimeRange(period);
  }, [period, customStart, customEnd]);

  useEffect(() => {
    api.teacher.courses.list().then((list) => setCourses(list.map((c) => ({ id: c.id, name: c.name })))).catch(() => setCourses([]));
    api.teacher.students.list().then(setStudents).catch(() => setStudents([]));
    api.teacher.classes.list().then((list) => setClasses(list.map((c) => ({ id: c.id, name: c.name, course_id: c.course_id ?? null })))).catch(() => setClasses([]));
  }, []);

  useEffect(() => {
    if (courseId == null) {
      setChapters([]);
      setChapterId(undefined);
      setClassId(undefined);
      return;
    }
    api.teacher.courses.chapters(courseId).then((list) => setChapters(list.map((ch) => ({ id: ch.id, title: ch.title })))).catch(() => setChapters([]));
    setChapterId(undefined);
    setClassId(undefined);
  }, [courseId]);

  useEffect(() => {
    if (classId == null) {
      setClassStudents([]);
      return;
    }
    api.teacher.classes.students(classId).then(setClassStudents).catch(() => setClassStudents([]));
  }, [classId]);

  // 学情统计区（无章节）：始终按「全部章节」拉取，供概览与学情统计详细表（按课程+学生聚合）使用；传时间范围使概览与详情表口径一致
  useEffect(() => {
    setLoading(true);
    const params = { courseId, chapterId: undefined, classId };
    if (timeRange?.start && timeRange?.end) {
      (params as { startDate?: string; endDate?: string }).startDate = timeRange.start;
      (params as { startDate?: string; endDate?: string }).endDate = timeRange.end;
    }
    api.teacher.stats(params).then((data) => { setStats(data); setLoading(false); }).catch(() => setLoading(false));
  }, [courseId, classId, timeRange?.start, timeRange?.end]);

  // 学情章节统计区：按所选章节拉取，供「学情章节统计详细表」使用
  const [statsChapter, setStatsChapter] = useState<typeof stats>(null);
  useEffect(() => {
    api.teacher.stats({ courseId, chapterId, classId }).then(setStatsChapter).catch(() => setStatsChapter(null));
  }, [courseId, chapterId, classId]);

  // 章节选「全部」时按章节拉取统计，使表格中每章的完成习题数与单独选该章时一致
  useEffect(() => {
    if (courseId == null || chapterId != null || chapters.length === 0) {
      setChapterStats({});
      return;
    }
    let cancelled = false;
    const next: Record<number, { completed_question_count: number; answer_accuracy_rate: number; weak_knowledge_points: string[] }> = {};
    Promise.all(
      chapters.map((ch) =>
        api.teacher.stats({ courseId, chapterId: ch.id, classId }).then((data) => {
          if (!cancelled) next[ch.id] = { completed_question_count: data.completed_question_count ?? 0, answer_accuracy_rate: data.answer_accuracy_rate, weak_knowledge_points: data.weak_knowledge_points ?? [] };
        })
      )
    ).then(() => { if (!cancelled) setChapterStats(next); }).catch(() => { if (!cancelled) setChapterStats({}); });
    return () => { cancelled = true; };
  }, [courseId, chapterId, classId, chapters]);

  // 课程选「全部」时按课程拉取统计，使学情详情表每行显示该课程下的反馈数、AI提问、AI无关、薄弱点（不按总行数均分）
  useEffect(() => {
    if (courseId != null || courses.length === 0) {
      setCourseStats({});
      return;
    }
    let cancelled = false;
    const next: Record<number, { feedback_question_count: number; top_asked: { question: string; count: number }[]; ai_irrelevant_count: number; weak_knowledge_points: string[] }> = {};
    Promise.all(
      courses.map((c) =>
        api.teacher.stats({ courseId: c.id, chapterId: undefined, classId }).then((data) => {
          if (!cancelled) next[c.id] = {
            feedback_question_count: data.feedback_question_count ?? 0,
            top_asked: data.top_asked ?? [],
            ai_irrelevant_count: data.ai_irrelevant_count ?? 0,
            weak_knowledge_points: data.weak_knowledge_points ?? [],
          };
        })
      )
    ).then(() => { if (!cancelled) setCourseStats(next); }).catch(() => { if (!cancelled) setCourseStats({}); });
    return () => { cancelled = true; };
  }, [courseId, classId, courses]);

  // 课程选「全部」时拉取每门课的章节列表，用于「课程/章节习题完成统计」表格逐行展示
  useEffect(() => {
    if (courseId != null || courses.length === 0) {
      setAllChaptersByCourseId({});
      return;
    }
    let cancelled = false;
    Promise.all(
      courses.map((c) =>
        api.teacher.courses.chapters(c.id).then((chList) => ({ courseId: c.id, chapters: chList.map((ch) => ({ id: ch.id, title: ch.title })) }))
      )
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<number, { id: number; title: string }[]> = {};
      pairs.forEach(({ courseId: cid, chapters: chs }) => { next[cid] = chs; });
      setAllChaptersByCourseId(next);
    }).catch(() => { if (!cancelled) setAllChaptersByCourseId({}); });
    return () => { cancelled = true; };
  }, [courseId, courses]);

  // 课程选「全部」且章节选「全部」时，拉取每 (课程, 章节) 的习题完成统计
  useEffect(() => {
    if (courseId != null || chapterId != null || courses.length === 0) {
      setAllCourseChapterStats({});
      return;
    }
    const chapterMap = allChaptersByCourseId;
    const courseIds = courses.map((c) => c.id);
    if (courseIds.some((id) => !(id in chapterMap))) return; // 尚未拉齐每门课的章节
    let cancelled = false;
    const pairs: { courseId: number; chapterId: number }[] = [];
    courseIds.forEach((cid) => {
      const chs = chapterMap[cid] ?? [];
      if (chs.length) chs.forEach((ch) => pairs.push({ courseId: cid, chapterId: ch.id }));
      else pairs.push({ courseId: cid, chapterId: 0 });
    });
    Promise.all(
      pairs.map(({ courseId: cid, chapterId: chid }) =>
        api.teacher.stats({ courseId: cid, chapterId: chid === 0 ? undefined : chid, classId }).then((data) => ({
          key: `${cid}-${chid}`,
          completed_question_count: data.completed_question_count ?? 0,
          answer_accuracy_rate: data.answer_accuracy_rate,
          weak_knowledge_points: data.weak_knowledge_points ?? [],
        }))
      )
    ).then((results) => {
      if (cancelled) return;
      const next: Record<string, { completed_question_count: number; answer_accuracy_rate: number; weak_knowledge_points: string[] }> = {};
      results.forEach((r) => { next[r.key] = { completed_question_count: r.completed_question_count, answer_accuracy_rate: r.answer_accuracy_rate, weak_knowledge_points: r.weak_knowledge_points }; });
      setAllCourseChapterStats(next);
    }).catch(() => { if (!cancelled) setAllCourseChapterStats({}); });
    return () => { cancelled = true; };
  }, [courseId, chapterId, classId, courses, allChaptersByCourseId]);

  useEffect(() => {
    const { start, end } = getDefaultTimeRange(period);
    if (period === "custom") return;
    setCustomStart(start);
    setCustomEnd(end);
  }, [period]);

  const handleReset = () => {
    setCourseId(undefined);
    setChapterId(undefined);
    setClassId(undefined);
    setPeriod("7");
    const { start, end } = getDefaultTimeRange("7");
    setCustomStart(start);
    setCustomEnd(end);
  };

  const filteredClasses = useMemo(() => {
    if (courseId == null) return classes;
    return classes.filter((c) => c.course_id === courseId);
  }, [classes, courseId]);

  const studentsForFilter = classId != null ? classStudents : students;

  // 核心学习概览（与当前 stats 联动，部分占位）
  const overviewStats: OverviewStats = useMemo(() => {
    if (!stats) {
      return {
        preview_student_count: 0,
        preview_completion_rate: 0,
        completed_question_count: 0,
        avg_accuracy_rate: 0,
        feedback_question_count: 0,
        ai_question_count: 0,
        ai_irrelevant_count: 0,
      };
    }
    const totalAskedFallback = stats.top_asked.reduce((s, t) => s + t.count, 0);
    return {
      preview_student_count: stats.preview_student_count ?? 0,
      preview_completion_rate: stats.preview_completion_rate,
      completed_question_count: stats.completed_question_count ?? 0,
      avg_accuracy_rate: stats.answer_accuracy_rate,
      feedback_question_count: stats.feedback_question_count ?? 0,
      ai_question_count: stats.ai_ask_count ?? totalAskedFallback,
      ai_irrelevant_count: stats.ai_irrelevant_count ?? 0,
    };
  }, [stats]);

  const courseChapterRows: CourseChapterRow[] = useMemo(() => {
    if (!stats || !courses.length) return [];
    const totalCompleted = stats.completed_question_count ?? 0;
    const list: CourseChapterRow[] = [];
    const chList = chapterId != null ? chapters.filter((c) => c.id === chapterId) : chapters;
    const courseName = courses.find((c) => c.id === courseId)?.name ?? "全部";
    const assignCount = (index: number, rowCount: number): number => {
      if (rowCount <= 0) return 0;
      if (rowCount === 1) return totalCompleted;
      const perRow = Math.floor(totalCompleted / rowCount);
      return index === 0 ? totalCompleted - perRow * (rowCount - 1) : perRow;
    };
    if (courseId != null) {
      // 选中了课程：只显示该课程（按章节或一条汇总）
      if (chList.length) {
        const usePerChapter = chapterId == null && chList.length > 1; // 章节选「全部」且多章时用按章统计
        chList.forEach((ch, i) => {
          const chStat = usePerChapter ? chapterStats[ch.id] : undefined;
          list.push({
            course_name: courseName,
            chapter_name: ch.title,
            completed_count: chStat != null ? chStat.completed_question_count : assignCount(i, chList.length),
            accuracy_rate: chStat != null ? chStat.answer_accuracy_rate : stats.answer_accuracy_rate + (i % 3) * 3,
            top_wrong_point: (chStat?.weak_knowledge_points?.[0] ?? stats.weak_knowledge_points[i % Math.max(1, stats.weak_knowledge_points.length)]) || "—",
          });
        });
      } else {
        list.push({
          course_name: courseName,
          chapter_name: "全部",
          completed_count: totalCompleted,
          accuracy_rate: stats.answer_accuracy_rate,
          top_wrong_point: stats.weak_knowledge_points[0] || "—",
        });
      }
    } else {
      // 未选课程（全部）：逐行列出每门课、每门课下每个章节的统计数据
      const chapterMap = allChaptersByCourseId;
      const hasChapterData = courses.every((c) => c.id in chapterMap);
      if (!hasChapterData) return list;
      courses.forEach((c) => {
        const chList = chapterMap[c.id] ?? [];
        if (chList.length) {
          chList.forEach((ch) => {
            const st = allCourseChapterStats[`${c.id}-${ch.id}`];
            list.push({
              course_name: c.name,
              chapter_name: ch.title,
              completed_count: st?.completed_question_count ?? 0,
              accuracy_rate: st?.answer_accuracy_rate ?? 0,
              top_wrong_point: st?.weak_knowledge_points?.[0] || "—",
            });
          });
        } else {
          const st = allCourseChapterStats[`${c.id}-0`];
          list.push({
            course_name: c.name,
            chapter_name: "全部",
            completed_count: st?.completed_question_count ?? 0,
            accuracy_rate: st?.answer_accuracy_rate ?? 0,
            top_wrong_point: st?.weak_knowledge_points?.[0] || "—",
          });
        }
      });
    }
    return list;
  }, [stats, courses, chapters, courseId, chapterId, chapterStats, allChaptersByCourseId, allCourseChapterStats]);

  /** 柱状图专用：只按课程统计，不受章节筛选影响。选全部课程时最多 10 门，选一门时只显示该课程一根柱子 */
  const courseChartBars: { course_name: string; completed_count: number; accuracy_rate: number }[] = useMemo(() => {
    if (!stats || !courses.length) return [];
    if (courseId != null) {
      const courseName = courses.find((c) => c.id === courseId)?.name ?? "—";
      return [{
        course_name: courseName,
        completed_count: stats.completed_question_count ?? 0,
        accuracy_rate: stats.answer_accuracy_rate ?? 0,
      }];
    }
    const chapterMap = allChaptersByCourseId;
    const list: { course_name: string; completed_count: number; accuracy_rate: number }[] = [];
    const coursesToShow = courses.slice(0, 10);
    for (const c of coursesToShow) {
      const chs = chapterMap[c.id] ?? [];
      let totalCompleted = 0;
      let weightedSum = 0;
      if (chs.length) {
        chs.forEach((ch) => {
          const st = allCourseChapterStats[`${c.id}-${ch.id}`];
          const comp = st?.completed_question_count ?? 0;
          totalCompleted += comp;
          weightedSum += (st?.answer_accuracy_rate ?? 0) * comp;
        });
      } else {
        const st = allCourseChapterStats[`${c.id}-0`];
        totalCompleted = st?.completed_question_count ?? 0;
        weightedSum = (st?.answer_accuracy_rate ?? 0) * totalCompleted;
      }
      const accuracy_rate = totalCompleted > 0 ? weightedSum / totalCompleted : 0;
      list.push({ course_name: c.name, completed_count: totalCompleted, accuracy_rate });
    }
    return list;
  }, [stats, courses, courseId, allChaptersByCourseId, allCourseChapterStats]);

  const weakPointRows: WeakPointRow[] = useMemo(() => {
    if (!stats) return [];
    const courseIds = stats.weak_knowledge_point_course_ids ?? [];
    const wrongCounts = stats.weak_knowledge_point_wrong_counts ?? [];
    const totalCompleted = stats.completed_question_count ?? 0;
    return stats.weak_knowledge_points.slice(0, 5).map((title, i) => {
      const cid = courseId ?? courseIds[i] ?? null;
      const course_name = cid != null ? (courses.find((c) => c.id === cid)?.name ?? "—") : "—";
      const wrong_count = wrongCounts[i] ?? 0;
      const wrong_rate = totalCompleted > 0 ? `${((wrong_count / totalCompleted) * 100).toFixed(1)}%` : "—";
      return {
        rank: i + 1,
        knowledge_point: title,
        course_name,
        wrong_count,
        wrong_rate,
      };
    });
  }, [stats, courseId, courses]);

  const topAskedRows: TopAskedRow[] = useMemo(() => {
    if (!stats) return [];
    return stats.top_asked.slice(0, 5).map((t, i) => {
      const cid = courseId ?? t.course_id ?? null;
      const course_name = cid != null ? (courses.find((c) => c.id === cid)?.name ?? "—") : "—";
      return {
        rank: i + 1,
        question: t.question,
        course_name,
        ask_count: t.count,
      };
    });
  }, [stats, courseId, courses]);

  /** 与习题管理页一致的分页每页条数选项 */
  const PAGE_SIZE_OPTIONS = [10, 20, 30, 50, 100] as const;

  /** 课程/章节习题完成统计表分页 */
  const [courseChapterPage, setCourseChapterPage] = useState(1);
  const [courseChapterPageSize, setCourseChapterPageSize] = useState(10);
  const courseChapterTotal = courseChapterRows.length;
  const courseChapterTotalPages = Math.max(1, Math.ceil(courseChapterTotal / courseChapterPageSize));
  const courseChapterPaged = useMemo(
    () => courseChapterRows.slice((courseChapterPage - 1) * courseChapterPageSize, courseChapterPage * courseChapterPageSize),
    [courseChapterRows, courseChapterPage, courseChapterPageSize]
  );

  // 详情区：学情综合统计（学情课程统计详细表使用后端按「课程+学生」维度接口，班级名与 teacher/classes 一致）
  const [detailPage, setDetailPage] = useState(1);
  const [detailPageSize, setDetailPageSize] = useState(10);
  /** 学情课程统计筛选区：所选学生，仅展示该学生的数据 */
  const [detailStudentId, setDetailStudentId] = useState<number | undefined>(undefined);
  const [detailTableLoading, setDetailTableLoading] = useState(false);
  /** 学情章节统计筛选区：所选学生，仅展示该学生的数据 */
  const [detailChapterStudentId, setDetailChapterStudentId] = useState<number | undefined>(undefined);
  useEffect(() => {
    setDetailPage(1);
    setDetailStudentId(undefined);
    setDetailChapterStudentId(undefined);
  }, [courseId, classId]);
  useEffect(() => {
    setCourseChapterPage(1);
  }, [courseId, chapterId]);

  /** 按课程+学生接口的原始列表（含 course_id/student_id），用于学情章节表班级与预习完成率按 (课程,学生) 解析 */
  type StatsByCourseStudentRow = {
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
    accuracy_rate: string;
    feedback_question_count: number;
    ai_ask_count: number;
    ai_irrelevant_count: number;
    weak_knowledge_points: string;
    weak_knowledge_points_by_chapter?: { chapter_id: number; weak_knowledge_points: string }[];
  };
  const [detailTableRawFromApi, setDetailTableRawFromApi] = useState<StatsByCourseStudentRow[]>([]);
  // 学情课程统计详细表：拉取按「课程+学生」维度的真实数据（不传 studentId 以拿到全部学生，供学情章节表用映射）；统计周期传给后端做时间筛选
  useEffect(() => {
    setDetailTableLoading(true);
    const params: { courseId?: number; classId?: number; startDate?: string; endDate?: string } = {
      courseId: courseId ?? undefined,
      classId: classId ?? undefined,
    };
    if (timeRange) {
      params.startDate = timeRange.start;
      params.endDate = timeRange.end;
    }
    api.teacher
      .statsByCourseStudent(params)
      .then((list) => setDetailTableRawFromApi(list))
      .catch(() => setDetailTableRawFromApi([]))
      .finally(() => setDetailTableLoading(false));
  }, [courseId, classId, timeRange?.start, timeRange?.end]);

  // 由原始列表按「学情课程统计」所选学生筛选后得到表格行；并生成 (courseId, studentId) -> class_name / preview_rate 供学情章节表使用
  const detailTableRowsFromApi: LearningDetailRow[] = useMemo(() => {
    let list = detailTableRawFromApi;
    if (detailStudentId != null) list = list.filter((r) => r.student_id === detailStudentId);
    return list.map((r) => ({
      course_name: r.course_name,
      chapter_name: "—",
      student_no: r.student_no,
      student_name: r.student_name,
      class_name: r.class_name,
      preview_rate: r.preview_rate,
      completed_count: r.completed_question_count,
      accuracy_rate: r.accuracy_rate,
      feedback_count: r.feedback_question_count,
      ai_ask_count: r.ai_ask_count,
      ai_irrelevant_count: r.ai_irrelevant_count,
      weak_points: r.completed_question_count > 0 ? r.weak_knowledge_points : "—",
    }));
  }, [detailTableRawFromApi, detailStudentId]);

  const classNamesByCourseStudent = useMemo(() => {
    const m: Record<string, string> = {};
    detailTableRawFromApi.forEach((r) => { m[`${r.course_id}-${r.student_id}`] = r.class_name; });
    return m;
  }, [detailTableRawFromApi]);
  const previewRateByCourseStudent = useMemo(() => {
    const m: Record<string, string> = {};
    detailTableRawFromApi.forEach((r) => { m[`${r.course_id}-${r.student_id}`] = r.preview_rate; });
    return m;
  }, [detailTableRawFromApi]);
  void previewRateByCourseStudent; // 预留供学情章节表按 (课程,学生) 显示预习率

  /** 学情章节表专用：按 (课程, 学生) 已完成的章节 id 集合，每行按「本章是否完成」显示 100% 或 0% */
  const previewCompletedChapterIds = useMemo(() => {
    const m: Record<string, Set<number>> = {};
    detailTableRawFromApi.forEach((r) => {
      m[`${r.course_id}-${r.student_id}`] = new Set(r.preview_completed_chapter_ids ?? []);
    });
    return m;
  }, [detailTableRawFromApi]);

  /** 学情章节表专用：按 (课程, 学生, 章节) 的真实完成习题数，与学情课程表一致，不再用聚合均分 */
  const completedCountByCourseStudentChapter = useMemo(() => {
    const m: Record<string, number> = {};
    detailTableRawFromApi.forEach((r) => {
      const keyBase = `${r.course_id}-${r.student_id}`;
      (r.completed_question_count_by_chapter ?? []).forEach(({ chapter_id, count }) => {
        m[`${keyBase}-${chapter_id}`] = count;
      });
    });
    return m;
  }, [detailTableRawFromApi]);

  /** 学情章节表「全部」行：按 (课程, 学生) 的课程总完成习题数 */
  const completedCountByCourseStudent = useMemo(() => {
    const m: Record<string, number> = {};
    detailTableRawFromApi.forEach((r) => {
      m[`${r.course_id}-${r.student_id}`] = r.completed_question_count;
    });
    return m;
  }, [detailTableRawFromApi]);

  /** 学情课程表：按 (课程, 学生) 的高频薄弱知识点，仅在有做题时才有值 */
  const weakPointsByCourseStudent = useMemo(() => {
    const m: Record<string, string> = {};
    detailTableRawFromApi.forEach((r) => {
      const key = `${r.course_id}-${r.student_id}`;
      m[key] = r.completed_question_count > 0 ? r.weak_knowledge_points : "—";
    });
    return m;
  }, [detailTableRawFromApi]);

  /** 学情章节表：按 (课程, 章节, 学生) 的高频薄弱知识点，仅在有做题时才有值；章节为「全部」时用课程维度的 weakPointsByCourseStudent */
  const weakPointsByCourseStudentChapter = useMemo(() => {
    const m: Record<string, string> = {};
    detailTableRawFromApi.forEach((r) => {
      (r.weak_knowledge_points_by_chapter ?? []).forEach(({ chapter_id, weak_knowledge_points }) => {
        m[`${r.course_id}-${r.student_id}-${chapter_id}`] = weak_knowledge_points || "—";
      });
    });
    return m;
  }, [detailTableRawFromApi]);

  const learningDetailRows: LearningDetailRow[] = useMemo(() => {
    const rows: LearningDetailRow[] = [];
    const courseList = courseId != null ? courses.filter((c) => c.id === courseId) : courses;
    let chapterList: { id: number; title: string }[] =
      chapterId != null ? chapters.filter((ch) => ch.id === chapterId) : [...chapters];
    if (chapterList.length === 0 && courseId != null) {
      chapterList = [{ id: 0, title: "全部" }];
    }
    const baseStudentList = classId != null ? classStudents : students;
    const studentList = detailStudentId != null ? baseStudentList.filter((s) => s.id === detailStudentId) : baseStudentList;
    const displayClass = classId != null ? (filteredClasses.find((c) => c.id === classId)?.name ?? "—") : "—";
    const maxStudents = 50;
    const totalCompleted = stats?.completed_question_count ?? 0;
    const avgAccuracy = stats?.answer_accuracy_rate ?? 0;
    const previewRate = stats?.preview_completion_rate ?? 0;
    const chaptersToIterate = chapterList.length ? chapterList : [{ id: 0, title: "—" }];
    const studentsInSlice = Math.min(studentList.length, maxStudents);
    const totalRows = courseList.length * chaptersToIterate.length * studentsInSlice;
    const perRowCompleted = totalRows > 0 ? Math.floor(totalCompleted / totalRows) : 0;
    const useChapterStats = courseId != null && chapterId == null && chaptersToIterate.length > 0 && chaptersToIterate.every((ch) => ch.id > 0);
    let rowIndex = 0;
    courseList.forEach((c) => {
      const isAllCourses = courseId == null;
      const courseData = isAllCourses ? courseStats[c.id] : null;
      const feedback_count = isAllCourses ? (courseData?.feedback_question_count ?? 0) : (stats?.feedback_question_count ?? 0);
      const aiAskTotal = isAllCourses ? (courseData?.top_asked?.reduce((s, t) => s + t.count, 0) ?? 0) : ((stats?.top_asked ?? []).reduce((s, t) => s + t.count, 0));
      const ai_irrelevant_count = isAllCourses ? (courseData?.ai_irrelevant_count ?? 0) : (stats?.ai_irrelevant_count ?? 0);
      const weakListForCourse = isAllCourses ? (courseData?.weak_knowledge_points ?? []) : (stats?.weak_knowledge_points ?? []);
      chaptersToIterate.forEach((ch) => {
        const chCompleted = useChapterStats && chapterStats[ch.id] != null ? chapterStats[ch.id].completed_question_count : null;
        const chAccuracy = useChapterStats && chapterStats[ch.id] != null ? chapterStats[ch.id].answer_accuracy_rate : null;
        const perChRow = chCompleted != null && studentsInSlice > 0 ? Math.floor(chCompleted / studentsInSlice) : perRowCompleted;
        studentList.slice(0, maxStudents).forEach((s, j) => {
          const isLastRow = rowIndex === totalRows - 1;
          const isLastInChapter = j === studentsInSlice - 1;
          let completed_count: number;
          if (chCompleted != null && studentsInSlice > 0) {
            completed_count = isLastInChapter ? chCompleted - perChRow * (studentsInSlice - 1) : perChRow;
          } else {
            completed_count = totalRows > 0 ? (isLastRow ? totalCompleted - perRowCompleted * (totalRows - 1) : perRowCompleted) : 0;
          }
          const rowTotal = chCompleted ?? totalCompleted;
          const rowAccuracy = chAccuracy ?? avgAccuracy;
          const weak_points = weakListForCourse.length ? (weakListForCourse[j % weakListForCourse.length] || "—") : "—";
          rows.push({
            course_name: c.name,
            chapter_name: ch.title,
            student_no: s.student_no || s.username || "—",
            student_name: s.display_name || s.username || "—",
            class_name: displayClass,
            preview_rate: `${previewRate.toFixed(1)}%`,
            completed_count,
            accuracy_rate: rowTotal > 0 ? `${rowAccuracy.toFixed(1)}%` : "—",
            feedback_count,
            ai_ask_count: aiAskTotal,
            ai_irrelevant_count,
            weak_points,
          });
          rowIndex += 1;
        });
      });
    });
    if (rows.length === 0 && courses.length) {
      const c = courses[0];
      const courseData = courseId == null ? courseStats[c.id] : null;
      const fb = courseData != null ? courseData.feedback_question_count : (stats?.feedback_question_count ?? 0);
      const aiAsk = courseData != null ? (courseData.top_asked?.reduce((s, t) => s + t.count, 0) ?? 0) : ((stats?.top_asked ?? []).reduce((s, t) => s + t.count, 0));
      const aiIrrel = courseData != null ? courseData.ai_irrelevant_count : (stats?.ai_irrelevant_count ?? 0);
      const wl = courseData?.weak_knowledge_points ?? stats?.weak_knowledge_points ?? [];
      rows.push({
        course_name: c.name,
        chapter_name: chapters[0]?.title ?? "—",
        student_no: "—",
        student_name: "—",
        class_name: "—",
        preview_rate: previewRate > 0 ? `${previewRate.toFixed(1)}%` : "—",
        completed_count: totalCompleted,
        accuracy_rate: totalCompleted > 0 ? `${avgAccuracy.toFixed(1)}%` : "—",
        feedback_count: fb,
        ai_ask_count: aiAsk,
        ai_irrelevant_count: aiIrrel,
        weak_points: wl[0] || "—",
      });
    }
    return rows;
  }, [courses, chapters, students, classStudents, filteredClasses, courseId, chapterId, classId, detailStudentId, stats, courseStats, chapterStats]);
  void learningDetailRows; // 预留，学情课程统计详细表已改用 detailTableRowsFromApi

  // 学情课程统计详细表使用 detailTableRowsFromApi（后端按课程+学生维度接口），不再使用前端聚合的 learningDetailRowsNoChapter

  // 学情章节统计详细表：使用 statsChapter，保留章节维度；班级与预习完成率与学情课程统计一致，按 (课程,学生) 从接口映射取
  const learningDetailRowsChapter: LearningDetailRow[] = useMemo(() => {
    const s = statsChapter ?? stats;
    const rows: LearningDetailRow[] = [];
    const baseStudentList = classId != null ? classStudents : students;
    const studentList = detailChapterStudentId != null ? baseStudentList.filter((stu) => stu.id === detailChapterStudentId) : baseStudentList;
    const maxStudents = 50;
    const avgAccuracy = s?.answer_accuracy_rate ?? 0;

    const classFor = (cid: number, uid: number) => classNamesByCourseStudent[`${cid}-${uid}`] ?? "—";
    /** 学情章节表：按「本章」是否完成预习，完成=100%，未完成=0%；章节为「全部」时显示 — */
    const previewForChapter = (cid: number, uid: number, chapterId: number) => {
      if (chapterId === 0) return "—";
      const set = previewCompletedChapterIds[`${cid}-${uid}`];
      return set?.has(chapterId) ? "100%" : "0%";
    };
    /** 学情章节表：完成习题数用接口按 (课程, 学生, 章节) 的真实数据，与学情课程表一致 */
    const completedForRow = (cid: number, uid: number, chId: number) =>
      chId === 0
        ? (completedCountByCourseStudent[`${cid}-${uid}`] ?? 0)
        : (completedCountByCourseStudentChapter[`${cid}-${uid}-${chId}`] ?? 0);

    if (courseId != null) {
      const courseList = courses.filter((c) => c.id === courseId);
      let chapterList: { id: number; title: string }[] =
        chapterId != null ? chapters.filter((ch) => ch.id === chapterId) : [...chapters];
      if (chapterList.length === 0) chapterList = [{ id: 0, title: "全部" }];
      const chaptersToIterate = chapterList;
      const useChapterStats = chapterId == null && chaptersToIterate.length > 0 && chaptersToIterate.every((ch) => ch.id > 0);
      courseList.forEach((c) => {
        const courseData = courseStats[c.id] ?? null;
        const feedback_count = courseData?.feedback_question_count ?? (s?.feedback_question_count ?? 0);
        const aiAskTotal = courseData?.top_asked?.reduce((sx, t) => sx + t.count, 0) ?? (s?.top_asked ?? []).reduce((sx, t) => sx + t.count, 0);
        const ai_irrelevant_count = courseData?.ai_irrelevant_count ?? (s?.ai_irrelevant_count ?? 0);
        chaptersToIterate.forEach((ch) => {
          const chAccuracy = useChapterStats && chapterStats[ch.id] != null ? chapterStats[ch.id].answer_accuracy_rate : avgAccuracy;
          studentList.slice(0, maxStudents).forEach((stu) => {
            const completed_count = completedForRow(c.id, stu.id, ch.id);
            const rowTotal = completed_count;
            const weak_points = completed_count > 0
              ? (ch.id === 0 ? (weakPointsByCourseStudent[`${c.id}-${stu.id}`] ?? "—") : (weakPointsByCourseStudentChapter[`${c.id}-${stu.id}-${ch.id}`] ?? "—"))
              : "—";
            rows.push({
              course_name: c.name,
              chapter_name: ch.title,
              student_no: stu.student_no || stu.username || "—",
              student_name: stu.display_name || stu.username || "—",
              class_name: classFor(c.id, stu.id),
              preview_rate: previewForChapter(c.id, stu.id, ch.id),
              completed_count,
              accuracy_rate: rowTotal > 0 ? `${chAccuracy.toFixed(1)}%` : "—",
              feedback_count,
              ai_ask_count: aiAskTotal,
              ai_irrelevant_count,
              weak_points,
            });
          });
        });
      });
    } else {
      const courseList = courses;
      courseList.forEach((c) => {
        const chapterListForCourse = allChaptersByCourseId[c.id] ?? [];
        const chaptersToIterate = chapterListForCourse.length > 0 ? chapterListForCourse : [{ id: 0, title: "全部" }];
        const courseData = courseStats[c.id];
        const feedback_count = courseData?.feedback_question_count ?? 0;
        const aiAskTotal = courseData?.top_asked?.reduce((sx, t) => sx + t.count, 0) ?? 0;
        const ai_irrelevant_count = courseData?.ai_irrelevant_count ?? 0;
        chaptersToIterate.forEach((ch) => {
          const st = allCourseChapterStats[`${c.id}-${ch.id}`];
          const chAccuracy = st?.answer_accuracy_rate ?? 0;
          studentList.slice(0, maxStudents).forEach((stu) => {
            const completed_count = completedForRow(c.id, stu.id, ch.id);
            const weak_points = completed_count > 0
              ? (ch.id === 0 ? (weakPointsByCourseStudent[`${c.id}-${stu.id}`] ?? "—") : (weakPointsByCourseStudentChapter[`${c.id}-${stu.id}-${ch.id}`] ?? "—"))
              : "—";
            rows.push({
              course_name: c.name,
              chapter_name: ch.title,
              student_no: stu.student_no || stu.username || "—",
              student_name: stu.display_name || stu.username || "—",
              class_name: classFor(c.id, stu.id),
              preview_rate: previewForChapter(c.id, stu.id, ch.id),
              completed_count,
              accuracy_rate: completed_count > 0 ? `${chAccuracy.toFixed(1)}%` : "—",
              feedback_count,
              ai_ask_count: aiAskTotal,
              ai_irrelevant_count,
              weak_points,
            });
          });
        });
      });
    }

    if (rows.length === 0 && courses.length) {
      const c = courses[0];
      const courseData = courseId == null ? courseStats[c.id] : null;
      const fb = courseData != null ? courseData.feedback_question_count : (s?.feedback_question_count ?? 0);
      const aiAsk = courseData != null ? (courseData.top_asked?.reduce((sx, t) => sx + t.count, 0) ?? 0) : ((s?.top_asked ?? []).reduce((sx, t) => sx + t.count, 0));
      const aiIrrel = courseData != null ? courseData.ai_irrelevant_count : (s?.ai_irrelevant_count ?? 0);
      const wl = courseData?.weak_knowledge_points ?? s?.weak_knowledge_points ?? [];
      const firstChapterTitle = courseId != null ? (chapters[0]?.title ?? "—") : (allChaptersByCourseId[c.id]?.[0]?.title ?? "—");
      rows.push({
        course_name: c.name,
        chapter_name: firstChapterTitle,
        student_no: "—",
        student_name: "—",
        class_name: "—",
        preview_rate: "—",
        completed_count: 0,
        accuracy_rate: "—",
        feedback_count: fb,
        ai_ask_count: aiAsk,
        ai_irrelevant_count: aiIrrel,
        weak_points: wl[0] || "—",
      });
    }
    return rows;
  }, [courses, chapters, students, classStudents, courseId, chapterId, classId, detailChapterStudentId, stats, statsChapter, courseStats, chapterStats, allChaptersByCourseId, allCourseChapterStats, classNamesByCourseStudent, previewCompletedChapterIds, completedCountByCourseStudentChapter, completedCountByCourseStudent, weakPointsByCourseStudent, weakPointsByCourseStudentChapter]);

  const detailTotal = detailTableRowsFromApi.length;
  const detailPaginated = useMemo(
    () => detailTableRowsFromApi.slice((detailPage - 1) * detailPageSize, detailPage * detailPageSize),
    [detailTableRowsFromApi, detailPage, detailPageSize]
  );

  const [detailPageChapter, setDetailPageChapter] = useState(1);
  const [detailPageSizeChapter, setDetailPageSizeChapter] = useState(10);
  useEffect(() => {
    setDetailPageChapter(1);
  }, [courseId, chapterId, classId]);
  const detailTotalChapter = learningDetailRowsChapter.length;
  const detailPaginatedChapter = useMemo(
    () => learningDetailRowsChapter.slice((detailPageChapter - 1) * detailPageSizeChapter, detailPageChapter * detailPageSizeChapter),
    [learningDetailRowsChapter, detailPageChapter, detailPageSizeChapter]
  );

  // 问题反馈列表（从后台拉取，按课程/班级筛选）
  const [feedbackList, setFeedbackList] = useState<FeedbackRow[]>([]);
  const [feedbackListLoading, setFeedbackListLoading] = useState(false);
  const [feedbackSort, setFeedbackSort] = useState<"course" | "student_no" | "class">("course");
  const [feedbackPage, setFeedbackPage] = useState(1);
  const [feedbackPageSize, setFeedbackPageSize] = useState(10);
  /** 反馈弹窗：查看 / 编辑 */
  const [feedbackModal, setFeedbackModal] = useState<null | "view" | "edit">(null);
  const [selectedFeedback, setSelectedFeedback] = useState<FeedbackRow | null>(null);
  const [editReplyText, setEditReplyText] = useState("");
  const [editStatus, setEditStatus] = useState("待处理");
  const [feedbackSaveLoading, setFeedbackSaveLoading] = useState(false);
  useEffect(() => {
    setFeedbackListLoading(true);
    api.teacher.feedbackList({ courseId: courseId ?? undefined, classId: classId ?? undefined })
      .then((list) => setFeedbackList(list))
      .catch(() => setFeedbackList([]))
      .finally(() => setFeedbackListLoading(false));
  }, [courseId, classId]);
  useEffect(() => {
    setFeedbackPage(1);
  }, [courseId, classId]);
  const feedbackRows: FeedbackRow[] = useMemo(() => {
    const key = feedbackSort === "course" ? "course_name" : feedbackSort === "student_no" ? "student_no" : "class_name";
    return [...feedbackList].sort((a, b) => (a[key as keyof FeedbackRow] as string).localeCompare(b[key as keyof FeedbackRow] as string));
  }, [feedbackList, feedbackSort]);
  const feedbackTotal = feedbackRows.length;
  const feedbackPaginated = useMemo(
    () => feedbackRows.slice((feedbackPage - 1) * feedbackPageSize, feedbackPage * feedbackPageSize),
    [feedbackRows, feedbackPage, feedbackPageSize]
  );

  const dataUpdateTime = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }, [stats]);

  const handleExportOverview = (format: "csv" | "pdf") => {
    if (format === "csv") {
      const params = new URLSearchParams({ report: "overview" });
      if (courseId != null) params.set("course_id", String(courseId));
      if (chapterId != null) params.set("chapter_id", String(chapterId));
      const url = `${API_BASE}/teacher/export/csv?${params.toString()}`;
      const token = localStorage.getItem("token");
      fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
        .then((r) => r.blob())
        .then((blob) => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "学情概览.csv";
          a.click();
          URL.revokeObjectURL(a.href);
        });
    } else {
      window.print();
    }
  };

  const handleExportDetailTable = () => {
    const headers = ["课程", "学号", "姓名", "班级", "预习完成率", "完成习题数", "平均正确率", "反馈问题数", "AI提问数", "AI无关问题数", "高频薄弱知识点"];
    const rows = detailTableRowsFromApi.map((r) => [r.course_name, r.student_no, r.student_name, r.class_name, r.preview_rate, r.completed_count, r.accuracy_rate, r.feedback_count, r.ai_ask_count, r.ai_irrelevant_count, r.weak_points]);
    const csv = [headers.join(","), ...rows.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "学情综合统计.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleExportChapterDetailTable = () => {
    const headers = ["课程", "章节", "学号", "姓名", "班级", "预习完成率", "完成习题数", "平均正确率", "高频薄弱知识点"];
    const rows = learningDetailRowsChapter.map((r) => [r.course_name, r.chapter_name, r.student_no, r.student_name, r.class_name, r.preview_rate, r.completed_count, r.accuracy_rate, r.weak_points]);
    const csv = [headers.join(","), ...rows.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "学情章节综合统计.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const openFeedbackView = (row: FeedbackRow) => {
    setSelectedFeedback(row);
    setFeedbackModal("view");
  };
  const openFeedbackEdit = (row: FeedbackRow) => {
    setSelectedFeedback(row);
    setEditReplyText(row.reply_text === "—" ? "" : row.reply_text);
    setEditStatus(row.status);
    setFeedbackModal("edit");
  };
  const closeFeedbackModal = () => {
    setFeedbackModal(null);
    setSelectedFeedback(null);
  };
  const saveFeedbackEdit = async () => {
    if (!selectedFeedback) return;
    setFeedbackSaveLoading(true);
    try {
      await api.teacher.updateFeedback(selectedFeedback.id, {
        reply_text: editReplyText || null,
        status: editStatus,
      });
      const list = await api.teacher.feedbackList({ courseId: courseId ?? undefined, classId: classId ?? undefined });
      setFeedbackList(list);
      closeFeedbackModal();
    } catch (e) {
      console.error(e);
    } finally {
      setFeedbackSaveLoading(false);
    }
  };

  const handleExportFeedbackTable = () => {
    const headers = ["课程", "反馈问题", "学号", "学生姓名", "班级", "反馈时间", "回复内容", "处理状态"];
    const rows = feedbackRows.map((r) => [r.course_name, r.feedback_text, r.student_no, r.student_name, r.class_name, formatDateTime(r.created_at), r.reply_text, r.status]);
    const csv = [headers.join(","), ...rows.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "问题反馈列表.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (loading && !stats) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 200, color: "var(--text-muted)" }}>
        加载学情数据…
      </div>
    );
  }

  return (
    <div className="learning-data-page" style={{ padding: "24px 0", maxWidth: 1400, margin: "0 auto" }}>
      {/* 标题与更新时间 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>学情统计分析中心</h1>
        <span style={{ color: "var(--text-muted)", fontSize: 14 }}>数据更新时间：{dataUpdateTime}</span>
      </div>

      {/* 多维度筛选区（上 + 下共用同一筛选逻辑，下文详情区有独立筛选描述，这里先做一套） */}
      <section className="card" style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>【多维度筛选区】支持组合筛选，统计结果实时联动</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--text-muted)" }}>课程</span>
            <select
              value={courseId ?? ""}
              onChange={(e) => setCourseId(e.target.value ? Number(e.target.value) : undefined)}
              style={{ minWidth: 140 }}
            >
              <option value="">全部</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--text-muted)" }}>章节</span>
            <select
              value={chapterId ?? ""}
              onChange={(e) => setChapterId(e.target.value ? Number(e.target.value) : undefined)}
              disabled={courseId == null}
              style={{ minWidth: 140 }}
            >
              <option value="">全部</option>
              {chapters.map((ch) => (
                <option key={ch.id} value={ch.id}>{ch.title}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--text-muted)" }}>统计周期</span>
            <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ minWidth: 100 }}>
              {STAT_PERIODS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </label>
          {period === "custom" && (
            <>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>开始</span>
                <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>结束</span>
                <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
              </label>
            </>
          )}
          <button type="button" className="btn-primary" onClick={() => {}}>筛选</button>
          <button type="button" className="btn-secondary" onClick={handleReset}>重置</button>
        </div>
        {period !== "custom" && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>默认：最近7天；自定义时为空则不限制时间</div>
        )}
      </section>

      {/* ========== 上半区域：前 5 个模块（概览） ========== */}
      <div className="card" style={{ marginBottom: 24, padding: "20px 24px" }}>
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>【核心学习概览】</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 16 }}>
          <div style={{ padding: "12px 16px", background: "var(--bg-muted)", borderRadius: "var(--radius-md)", textAlign: "center" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>预习学生数</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{overviewStats.preview_student_count}</div>
          </div>
          <div style={{ padding: "12px 16px", background: "var(--bg-muted)", borderRadius: "var(--radius-md)", textAlign: "center" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>预习完成率</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{overviewStats.preview_completion_rate}%</div>
          </div>
          <div style={{ padding: "12px 16px", background: "var(--bg-muted)", borderRadius: "var(--radius-md)", textAlign: "center" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>完成习题数</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{overviewStats.completed_question_count}</div>
          </div>
          <div style={{ padding: "12px 16px", background: "var(--bg-muted)", borderRadius: "var(--radius-md)", textAlign: "center" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>平均正确率</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{overviewStats.avg_accuracy_rate}%</div>
          </div>
          <div style={{ padding: "12px 16px", background: "var(--bg-muted)", borderRadius: "var(--radius-md)", textAlign: "center" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>反馈问题数</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{overviewStats.feedback_question_count}</div>
          </div>
          <div style={{ padding: "12px 16px", background: "var(--bg-muted)", borderRadius: "var(--radius-md)", textAlign: "center" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>AI提问数</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{overviewStats.ai_question_count}</div>
          </div>
          <div style={{ padding: "12px 16px", background: "var(--bg-muted)", borderRadius: "var(--radius-md)", textAlign: "center" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>AI无关问题数</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{overviewStats.ai_irrelevant_count}</div>
          </div>
        </div>
      </div>

      {/* 模块2：课程/章节习题完成统计 */}
      <div className="card" style={{ marginBottom: 24, padding: "20px 24px" }}>
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>课程/章节习题完成统计</div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>课程习题完成情况（柱状图：完成率/正确率）</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12, height: 120 }}>
            {courseChartBars.map((r, i) => (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 80 }}>
                  <div style={{ width: 12, height: (r.accuracy_rate / 100) * 70, background: "var(--accent)", borderRadius: "4px 4px 0 0" }} title="正确率" />
                  <div style={{ width: 12, height: Math.min(70, (r.completed_count / 100) * 70), background: "#f59e0b", borderRadius: "4px 4px 0 0" }} title="完成量" />
                </div>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }} title={r.course_name}>{r.course_name.length > 15 ? r.course_name.slice(0, 15) + "…" : r.course_name}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>图例：完成率（橙色）/ 正确率（蓝色）</div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "10px 8px" }}>课程名称</th>
                <th style={{ textAlign: "left", padding: "10px 8px" }}>章节名称</th>
                <th style={{ textAlign: "right", padding: "10px 8px" }}>完成习题数</th>
                <th style={{ textAlign: "right", padding: "10px 8px" }}>正确率</th>
                <th style={{ textAlign: "left", padding: "10px 8px" }}>高频错知识点</th>
              </tr>
            </thead>
            <tbody>
              {courseChapterPaged.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 8px" }}>{r.course_name}</td>
                  <td style={{ padding: "10px 8px" }}>{r.chapter_name}</td>
                  <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.completed_count}</td>
                  <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.accuracy_rate.toFixed(1)}%</td>
                  <td style={{ padding: "10px 8px" }}>{r.top_wrong_point}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>每页显示</span>
          <select
            value={String(courseChapterPageSize)}
            onChange={(e) => {
              const n = Math.max(1, Math.min(100, Number(e.target.value || 10)));
              setCourseChapterPageSize(n);
              setCourseChapterPage(1);
            }}
            style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6 }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <button type="button" className="btn-secondary" onClick={() => setCourseChapterPage((p) => Math.max(1, p - 1))} disabled={courseChapterPage <= 1}>
            上一页
          </button>
          <button type="button" className="btn-secondary" onClick={() => setCourseChapterPage((p) => Math.min(courseChapterTotalPages, p + 1))} disabled={courseChapterPage >= courseChapterTotalPages}>
            下一页
          </button>
          <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
            第 {courseChapterPage} / {courseChapterTotalPages} 页，共 {courseChapterTotal} 条
          </span>
        </div>
      </div>

      {/* 模块3：高频错题知识点 TOP5/10 */}
      <div className="card" style={{ marginBottom: 24, padding: "20px 24px" }}>
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>【习题作答深度分析】高频错题知识点，最多显示 5 条</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "center", padding: "10px 8px", width: 56 }}>排名</th>
                <th style={{ textAlign: "left", padding: "10px 8px" }}>知识点</th>
                <th style={{ textAlign: "left", padding: "10px 8px" }}>所属课程</th>
                <th style={{ textAlign: "right", padding: "10px 8px" }}>错题数</th>
                <th style={{ textAlign: "right", padding: "10px 8px" }}>错题率</th>
              </tr>
            </thead>
            <tbody>
              {weakPointRows.length ? weakPointRows.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 8px", textAlign: "center" }}>{r.rank}</td>
                  <td style={{ padding: "10px 8px" }}>{r.knowledge_point}</td>
                  <td style={{ padding: "10px 8px" }}>{r.course_name}</td>
                  <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.wrong_count}</td>
                  <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.wrong_rate}</td>
                </tr>
              )) : (
                <tr><td colSpan={5} style={{ padding: 16, textAlign: "center", color: "var(--text-muted)" }}>暂无数据</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 模块4：AI 高频提问 */}
      <div className="card" style={{ marginBottom: 24, padding: "20px 24px" }}>
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>【AI 高频提问】按提问次数排序，最多显示 5 条</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "center", padding: "10px 8px", width: 56 }}>排名</th>
                <th style={{ textAlign: "left", padding: "10px 8px" }}>问题</th>
                <th style={{ textAlign: "left", padding: "10px 8px" }}>所属课程</th>
                <th style={{ textAlign: "right", padding: "10px 8px" }}>提问次数</th>
              </tr>
            </thead>
            <tbody>
              {topAskedRows.length ? topAskedRows.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 8px", textAlign: "center" }}>{r.rank}</td>
                  <td style={{ padding: "10px 8px", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}>{r.question}</td>
                  <td style={{ padding: "10px 8px" }}>{r.course_name}</td>
                  <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.ask_count}</td>
                </tr>
              )) : (
                <tr><td colSpan={4} style={{ padding: 16, textAlign: "center", color: "var(--text-muted)" }}>暂无提问记录</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 概览区导出：Word/PDF（PDF 用打印） */}
      <div className="card" style={{ marginBottom: 32, padding: "16px 24px" }}>
        <span style={{ marginRight: 12, color: "var(--text-secondary)" }}>导出概览结果：</span>
        <button type="button" className="btn-secondary" style={{ marginRight: 8 }} onClick={() => handleExportOverview("csv")}>导出 CSV</button>
        <button type="button" className="btn-secondary" onClick={() => handleExportOverview("pdf")}>导出 PDF（打印）</button>
      </div>

      {/* ========== 下半区域：第 6、7 个表格 ========== */}
      <div style={{ borderTop: "2px solid var(--border)", paddingTop: 24, marginTop: 8 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>学情综合统计分析</h2>
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>【学情课程统计筛选区】课程/班级/学生可选「全部」或具体项；时间区间默认最近 7 天，为空则不限制</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--text-muted)" }}>课程</span>
              <select value={courseId ?? ""} onChange={(e) => setCourseId(e.target.value ? Number(e.target.value) : undefined)} style={{ minWidth: 140 }}>
                <option value="">全部</option>
                {courses.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--text-muted)" }}>班级</span>
              <select value={classId ?? ""} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : undefined)} style={{ minWidth: 140 }}>
                <option value="">全部</option>
                {filteredClasses.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--text-muted)" }}>学生</span>
              <select value={detailStudentId ?? ""} onChange={(e) => setDetailStudentId(e.target.value ? Number(e.target.value) : undefined)} style={{ minWidth: 160 }}>
                <option value="">全部</option>
                {studentsForFilter.map((s) => (
                  <option key={s.id} value={s.id}>{s.display_name || s.username}（{s.student_no || s.id}）</option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--text-muted)" }}>统计周期</span>
              <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ minWidth: 100 }}>
                {STAT_PERIODS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </label>
            {period === "custom" && (
              <>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>开始</span>
                  <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>结束</span>
                  <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
                </label>
              </>
            )}
            <button type="button" className="btn-primary" onClick={() => setDetailPage(1)}>筛选</button>
            <button type="button" className="btn-secondary" onClick={handleReset}>重置</button>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>【学情课程统计详细表】合计：{detailTotal} 条（按课程+学生，无章节）</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--border)" }}>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>课程</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>学号</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>姓名</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>班级</th>
                  <th style={{ textAlign: "right", padding: "10px 8px" }}>预习完成率</th>
                  <th style={{ textAlign: "right", padding: "10px 8px" }}>完成习题数</th>
                  <th style={{ textAlign: "right", padding: "10px 8px" }}>平均正确率</th>
                  <th style={{ textAlign: "right", padding: "10px 8px" }}>反馈问题数</th>
                  <th style={{ textAlign: "right", padding: "10px 8px" }}>AI提问数</th>
                  <th style={{ textAlign: "right", padding: "10px 8px" }}>AI无关问题数</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>高频薄弱知识点</th>
                </tr>
              </thead>
              <tbody>
                {detailTableLoading ? (
                  <tr><td colSpan={11} style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>加载中…</td></tr>
                ) : detailPaginated.length === 0 ? (
                  <tr><td colSpan={11} style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>暂无数据（仅展示已加入教师管理班级的学生）</td></tr>
                ) : (
                  detailPaginated.map((r, i) => {
                    const wp = formatWeakPoints(r.weak_points);
                    return (
                      <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                        <td style={{ padding: "10px 8px" }}>{r.course_name}</td>
                        <td style={{ padding: "10px 8px" }}>{r.student_no}</td>
                        <td style={{ padding: "10px 8px" }}>{r.student_name}</td>
                        <td style={{ padding: "10px 8px" }}>{r.class_name}</td>
                        <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.preview_rate}</td>
                        <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.completed_count}</td>
                        <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.accuracy_rate}</td>
                        <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.feedback_count}</td>
                        <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.ai_ask_count}</td>
                        <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.ai_irrelevant_count}</td>
                        <td style={{ padding: "10px 8px" }} title={wp.title}>{wp.display}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginTop: 16 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>每页显示</span>
              <select
                value={String(detailPageSize)}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(100, Number(e.target.value || 10)));
                  setDetailPageSize(n);
                  setDetailPage(1);
                }}
                style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6 }}
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <button type="button" className="btn-secondary" onClick={() => setDetailPage((p) => Math.max(1, p - 1))} disabled={detailPage <= 1}>上一页</button>
              <button type="button" className="btn-secondary" onClick={() => setDetailPage((p) => Math.min(Math.max(1, Math.ceil(detailTotal / detailPageSize)), p + 1))} disabled={detailPage >= Math.ceil(detailTotal / detailPageSize)}>下一页</button>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>第 {detailPage} / {Math.max(1, Math.ceil(detailTotal / detailPageSize))} 页，共 {detailTotal} 条</span>
            </div>
            <button type="button" className="btn-secondary" onClick={handleExportDetailTable}>导出表格（Excel/CSV）</button>
          </div>
        </div>

        {/* 学情章节统计筛选区 + 学情章节统计详细表（与原有筛选区/详情表结构一致，保留章节） */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>【学情章节统计筛选区】课程/章节/班级/学生可选「全部」或具体项；时间区间默认最近 7 天，为空则不限制</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--text-muted)" }}>课程</span>
              <select value={courseId ?? ""} onChange={(e) => setCourseId(e.target.value ? Number(e.target.value) : undefined)} style={{ minWidth: 140 }}>
                <option value="">全部</option>
                {courses.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--text-muted)" }}>章节</span>
              <select value={chapterId ?? ""} onChange={(e) => setChapterId(e.target.value ? Number(e.target.value) : undefined)} disabled={courseId == null} style={{ minWidth: 140 }}>
                <option value="">全部</option>
                {chapters.map((ch) => (<option key={ch.id} value={ch.id}>{ch.title}</option>))}
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--text-muted)" }}>班级</span>
              <select value={classId ?? ""} onChange={(e) => setClassId(e.target.value ? Number(e.target.value) : undefined)} style={{ minWidth: 140 }}>
                <option value="">全部</option>
                {filteredClasses.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--text-muted)" }}>学生</span>
              <select value={detailChapterStudentId ?? ""} onChange={(e) => setDetailChapterStudentId(e.target.value ? Number(e.target.value) : undefined)} style={{ minWidth: 160 }}>
                <option value="">全部</option>
                {studentsForFilter.map((s) => (
                  <option key={s.id} value={s.id}>{s.display_name || s.username}（{s.student_no || s.id}）</option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--text-muted)" }}>统计周期</span>
              <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ minWidth: 100 }}>
                {STAT_PERIODS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </label>
            {period === "custom" && (
              <>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>开始</span>
                  <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "var(--text-muted)", fontSize: 13 }}>结束</span>
                  <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
                </label>
              </>
            )}
            <button type="button" className="btn-primary" onClick={() => setDetailPageChapter(1)}>筛选</button>
            <button type="button" className="btn-secondary" onClick={handleReset}>重置</button>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>【学情章节统计详细表】合计：{detailTotalChapter} 条（含章节）</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--border)" }}>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>课程</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>章节</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>学号</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>姓名</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>班级</th>
                  <th style={{ textAlign: "right", padding: "10px 8px" }}>预习完成率</th>
                  <th style={{ textAlign: "right", padding: "10px 8px" }}>完成习题数</th>
                  <th style={{ textAlign: "right", padding: "10px 8px" }}>平均正确率</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>高频薄弱知识点</th>
                </tr>
              </thead>
              <tbody>
                {detailPaginatedChapter.map((r, i) => {
                  const wp = formatWeakPoints(r.weak_points);
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "10px 8px" }}>{r.course_name}</td>
                      <td style={{ padding: "10px 8px" }}>{r.chapter_name}</td>
                      <td style={{ padding: "10px 8px" }}>{r.student_no}</td>
                      <td style={{ padding: "10px 8px" }}>{r.student_name}</td>
                      <td style={{ padding: "10px 8px" }}>{r.class_name}</td>
                      <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.preview_rate}</td>
                      <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.completed_count}</td>
                      <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.accuracy_rate}</td>
                      <td style={{ padding: "10px 8px" }} title={wp.title}>{wp.display}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginTop: 16 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>每页显示</span>
              <select
                value={String(detailPageSizeChapter)}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(100, Number(e.target.value || 10)));
                  setDetailPageSizeChapter(n);
                  setDetailPageChapter(1);
                }}
                style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6 }}
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <button type="button" className="btn-secondary" onClick={() => setDetailPageChapter((p) => Math.max(1, p - 1))} disabled={detailPageChapter <= 1}>上一页</button>
              <button type="button" className="btn-secondary" onClick={() => setDetailPageChapter((p) => Math.min(Math.max(1, Math.ceil(detailTotalChapter / detailPageSizeChapter)), p + 1))} disabled={detailPageChapter >= Math.ceil(detailTotalChapter / detailPageSizeChapter)}>下一页</button>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>第 {detailPageChapter} / {Math.max(1, Math.ceil(detailTotalChapter / detailPageSizeChapter))} 页，共 {detailTotalChapter} 条</span>
            </div>
            <button type="button" className="btn-secondary" onClick={handleExportChapterDetailTable}>导出表格（Excel/CSV）</button>
          </div>
        </div>

        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>问题反馈列表</h2>
        <div className="card" style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>可按课程、学号或班级排序；支持导出</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <span style={{ color: "var(--text-muted)", fontSize: 13 }}>排序：</span>
            {(["course", "student_no", "class"] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={feedbackSort === key ? "btn-primary" : "btn-ghost"}
                style={{ padding: "6px 12px", fontSize: 13 }}
                onClick={() => setFeedbackSort(key)}
              >
                {key === "course" ? "课程" : key === "student_no" ? "学号" : "班级"}
              </button>
            ))}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--border)" }}>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>课程</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>反馈问题</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>学号</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>学生姓名</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>班级</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>反馈时间</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>回复内容</th>
                  <th style={{ textAlign: "left", padding: "10px 8px" }}>处理状态</th>
                  <th style={{ textAlign: "center", padding: "10px 8px", width: 120 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {feedbackListLoading ? (
                  <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>加载中…</td></tr>
                ) : feedbackPaginated.length === 0 ? (
                  <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>暂无反馈记录</td></tr>
                ) : (
                  feedbackPaginated.map((r, _i) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "10px 8px" }}>{r.course_name}</td>
                      <td style={{ padding: "10px 8px", maxWidth: 200 }}>{r.feedback_text}</td>
                      <td style={{ padding: "10px 8px" }}>{r.student_no}</td>
                      <td style={{ padding: "10px 8px" }}>{r.student_name}</td>
                      <td style={{ padding: "10px 8px" }}>{r.class_name}</td>
                      <td style={{ padding: "10px 8px", whiteSpace: "nowrap" }}>{formatDateTime(r.created_at)}</td>
                      <td style={{ padding: "10px 8px", maxWidth: 180 }}>{r.reply_text}</td>
                      <td style={{ padding: "10px 8px" }}>{r.status}</td>
                      <td style={{ padding: "10px 8px", textAlign: "center" }}>
                        <button type="button" className="btn-ghost" style={{ marginRight: 8, padding: "4px 10px", fontSize: 13 }} onClick={() => openFeedbackView(r)}>查看</button>
                        <button type="button" className="btn-primary" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => openFeedbackEdit(r)}>编辑</button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginTop: 16 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>每页显示</span>
              <select
                value={String(feedbackPageSize)}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(100, Number(e.target.value || 10)));
                  setFeedbackPageSize(n);
                  setFeedbackPage(1);
                }}
                style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6 }}
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <button type="button" className="btn-secondary" onClick={() => setFeedbackPage((p) => Math.max(1, p - 1))} disabled={feedbackPage <= 1}>上一页</button>
              <button type="button" className="btn-secondary" onClick={() => setFeedbackPage((p) => Math.min(Math.max(1, Math.ceil(feedbackTotal / feedbackPageSize)), p + 1))} disabled={feedbackPage >= Math.ceil(feedbackTotal / feedbackPageSize)}>下一页</button>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>第 {feedbackPage} / {Math.max(1, Math.ceil(feedbackTotal / feedbackPageSize))} 页，共 {feedbackTotal} 条</span>
            </div>
            <button type="button" className="btn-secondary" onClick={handleExportFeedbackTable}>导出表格（Excel/CSV）</button>
          </div>
        </div>

        {/* 问题反馈：查看/编辑弹窗 */}
        {feedbackModal && selectedFeedback && (
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 100,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(0,0,0,0.65)",
            }}
            onClick={(e) => e.target === e.currentTarget && closeFeedbackModal()}
          >
            <div
              style={{
                background: "#fff",
                borderRadius: "var(--radius-lg)",
                padding: 24,
                maxWidth: 520,
                width: "90%",
                maxHeight: "85vh",
                overflow: "auto",
                boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 style={{ margin: "0 0 16px", fontSize: 18 }}>{feedbackModal === "view" ? "查看反馈" : "编辑反馈"}</h3>
              <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "100px 1fr", gap: "10px 16px", fontSize: 14 }}>
                <dt style={{ color: "var(--text-muted)", margin: 0 }}>课程</dt>
                <dd style={{ margin: 0 }}>{selectedFeedback.course_name}</dd>
                <dt style={{ color: "var(--text-muted)", margin: 0 }}>反馈问题</dt>
                <dd style={{ margin: 0, wordBreak: "break-word" }}>{selectedFeedback.feedback_text}</dd>
                <dt style={{ color: "var(--text-muted)", margin: 0 }}>学号</dt>
                <dd style={{ margin: 0 }}>{selectedFeedback.student_no}</dd>
                <dt style={{ color: "var(--text-muted)", margin: 0 }}>学生姓名</dt>
                <dd style={{ margin: 0 }}>{selectedFeedback.student_name}</dd>
                <dt style={{ color: "var(--text-muted)", margin: 0 }}>班级</dt>
                <dd style={{ margin: 0 }}>{selectedFeedback.class_name}</dd>
                <dt style={{ color: "var(--text-muted)", margin: 0 }}>反馈时间</dt>
                <dd style={{ margin: 0 }}>{formatDateTime(selectedFeedback.created_at)}</dd>
                <dt style={{ color: "var(--text-muted)", margin: 0 }}>回复内容</dt>
                <dd style={{ margin: 0 }}>
                  {feedbackModal === "view" ? (
                    <span style={{ wordBreak: "break-word" }}>{selectedFeedback.reply_text || "—"}</span>
                  ) : (
                    <textarea
                      value={editReplyText}
                      onChange={(e) => setEditReplyText(e.target.value)}
                      rows={3}
                      style={{ width: "100%", resize: "vertical", padding: 8, borderRadius: "var(--radius-md)", border: "1px solid var(--border)" }}
                    />
                  )}
                </dd>
                <dt style={{ color: "var(--text-muted)", margin: 0 }}>处理状态</dt>
                <dd style={{ margin: 0 }}>
                  {feedbackModal === "view" ? (
                    selectedFeedback.status
                  ) : (
                    <select
                      value={editStatus}
                      onChange={(e) => setEditStatus(e.target.value)}
                      style={{ padding: "6px 10px", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", minWidth: 120 }}
                    >
                      <option value="待处理">待处理</option>
                      <option value="处理中">处理中</option>
                      <option value="已处理">已处理</option>
                    </select>
                  )}
                </dd>
                {(feedbackModal === "view" || feedbackModal === "edit") && selectedFeedback.processed_at && (
                  <>
                    <dt style={{ color: "var(--text-muted)", margin: 0 }}>处理回复时间</dt>
                    <dd style={{ margin: 0 }}>{formatDateTime(selectedFeedback.processed_at)}</dd>
                  </>
                )}
              </dl>
              <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                {feedbackModal === "edit" ? (
                  <>
                    <button type="button" className="btn-secondary" onClick={closeFeedbackModal}>取消</button>
                    <button type="button" className="btn-primary" onClick={saveFeedbackEdit} disabled={feedbackSaveLoading}>
                      {feedbackSaveLoading ? "保存中…" : "保存"}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn-primary" onClick={closeFeedbackModal}>关闭</button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @media print {
          .learning-data-page .btn-primary, .learning-data-page .btn-secondary, .learning-data-page .nav-link { display: none !important; }
          .learning-data-page .card { break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}
