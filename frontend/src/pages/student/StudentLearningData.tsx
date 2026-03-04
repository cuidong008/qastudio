import { useState, useEffect, useMemo } from "react";
import { api } from "../../api/client";

const STAT_PERIODS = [
  { value: "7", label: "近7天" },
  { value: "30", label: "近30天" },
  { value: "month", label: "本月" },
  { value: "custom", label: "自定义" },
] as const;

function formatDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** 根据统计周期与自定义日期得到请求用的 start/end（YYYY-MM-DD），自定义时以 customStart/customEnd 为准 */
function getTimeRange(
  period: string,
  customStart: string,
  customEnd: string
): { start: string; end: string } | null {
  if (period === "custom") {
    if (!customStart || !customEnd) return null;
    return { start: customStart, end: customEnd };
  }
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

type StatsRow = {
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
};

function formatWeakPoints(raw: string): { display: string; title: string } {
  if (!raw || raw === "—") return { display: "—", title: "" };
  const parts = raw.split(";").map((s) => s.trim()).filter(Boolean).slice(0, 5);
  const full = parts.join("; ");
  const maxLen = 20;
  const display = full.length > maxLen ? `${full.slice(0, maxLen)}...` : full;
  return { display, title: full };
}

const PAGE_SIZE_OPTIONS = [10, 20, 30, 50] as const;

export default function StudentLearningData({
  inWorkspace = false,
  onGoQa: _onGoQa,
  courseId: initialCourseId,
}: {
  inWorkspace?: boolean;
  onGoQa?: () => void;
  courseId?: number | null;
}) {
  const [courses, setCourses] = useState<{ id: number; name: string }[]>([]);
  const [chapters, setChapters] = useState<{ id: number; title: string }[]>([]);
  const [courseId, setCourseId] = useState<number | undefined>(initialCourseId ?? undefined);
  const [chapterId, setChapterId] = useState<number | undefined>(undefined);
  const [period, setPeriod] = useState<string>("7");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [rawData, setRawData] = useState<StatsRow[]>([]);
  const [loading, setLoading] = useState(true);
  /** 课程为「全部」时，各课程的章节列表，用于章节表显示正确章节名 */
  const [allChaptersByCourse, setAllChaptersByCourse] = useState<Record<number, { id: number; title: string }[]>>({});

  useEffect(() => {
    api.courses.list().then((list) => setCourses(list.map((c) => ({ id: c.id, name: c.name })))).catch(() => setCourses([]));
  }, []);

  useEffect(() => {
    if (courseId == null) {
      setChapters([]);
      setChapterId(undefined);
      return;
    }
    api.chapters.list({ course_id: courseId }).then((list) => setChapters(list.map((ch) => ({ id: ch.id, title: ch.title })))).catch(() => setChapters([]));
    setChapterId(undefined);
  }, [courseId]);

  const timeRange = useMemo(
    () => getTimeRange(period, customStart, customEnd),
    [period, customStart, customEnd]
  );

  useEffect(() => {
    setLoading(true);
    const params: { courseId?: number; startDate?: string; endDate?: string } = { courseId: courseId ?? undefined };
    if (timeRange) {
      params.startDate = timeRange.start;
      params.endDate = timeRange.end;
    }
    api.student
      .learningStats(params)
      .then(setRawData)
      .catch(() => setRawData([]))
      .finally(() => setLoading(false));
  }, [courseId, timeRange?.start, timeRange?.end]);

  // 课程为「全部」时，拉取 rawData 中每门课的章节，供章节学习情况表显示正确章节名
  useEffect(() => {
    if (courseId != null || rawData.length === 0) {
      setAllChaptersByCourse({});
      return;
    }
    const courseIds = [...new Set(rawData.map((r) => r.course_id))];
    let cancelled = false;
    const next: Record<number, { id: number; title: string }[]> = {};
    Promise.all(
      courseIds.map((cid) =>
        api.chapters.list({ course_id: cid }).then((list) => {
          if (!cancelled) next[cid] = list.map((ch) => ({ id: ch.id, title: ch.title }));
        })
      )
    ).then(() => { if (!cancelled) setAllChaptersByCourse(next); }).catch(() => { if (!cancelled) setAllChaptersByCourse({}); });
    return () => { cancelled = true; };
  }, [courseId, rawData]);

  const handleReset = () => {
    setCourseId(undefined);
    setChapterId(undefined);
    setPeriod("7");
  };

  // 课程学习情况表：班级名称与教师端学情课程统计一致（该课程下、当前学生所属班级）
  const courseTableRows = useMemo(() => rawData, [rawData]);

  // 章节学习情况表：从 rawData + chapters 展开；班级与教师端学情章节统计一致，按 (课程,学生) 取 class_name
  const chapterTableRows = useMemo(() => {
    const rows: { course_name: string; class_name: string; chapter_name: string; preview_rate: string; completed_count: number; accuracy_rate: string; weak_points: string }[] = [];
    const chapterList: { id: number; title: string }[] = chapterId != null ? chapters.filter((ch) => ch.id === chapterId) : [...chapters];
    if (chapterList.length === 0 && courseId != null) {
      chapterList.push({ id: 0, title: "全部" });
    }
    for (const r of rawData) {
      let chList: { id: number; title: string }[];
      if (courseId != null) {
        chList = chapterList.length > 0 ? chapterList : [{ id: 0, title: "全部" }];
      } else {
        const courseChapters = allChaptersByCourse[r.course_id];
        if (courseChapters && courseChapters.length > 0) {
          chList = courseChapters;
        } else {
          chList = [{ id: 0, title: "全部" }];
        }
      }
      const completedByCh = new Map((r.completed_question_count_by_chapter ?? []).map((x) => [x.chapter_id, x.count]));
      const correctByCh = new Map((r.correct_question_count_by_chapter ?? []).map((x) => [x.chapter_id, x.count]));
      const weakByCh = new Map((r.weak_knowledge_points_by_chapter ?? []).map((x) => [x.chapter_id, x.weak_knowledge_points || "—"]));
      const previewSet = new Set(r.preview_completed_chapter_ids ?? []);
      for (const ch of chList) {
        const chId = ch.id;
        const chTitle = ch.title;
        const completed_count = chId === 0 ? r.completed_question_count : (completedByCh.get(chId) ?? 0);
        const preview_rate = chId === 0 ? "—" : (previewSet.has(chId) ? "100%" : "0%");
        const weak_points = chId === 0 ? (r.completed_question_count > 0 ? r.weak_knowledge_points : "—") : (weakByCh.get(chId) ?? "—");
        const accuracy_rate =
          chId === 0
            ? r.accuracy_rate
            : completed_count > 0
              ? `${(((correctByCh.get(chId) ?? 0) / completed_count) * 100).toFixed(1)}%`
              : "—";
        rows.push({
          course_name: r.course_name,
          class_name: r.class_name ?? "—",
          chapter_name: chTitle,
          preview_rate,
          completed_count,
          accuracy_rate,
          weak_points,
        });
      }
    }
    return rows;
  }, [rawData, chapters, courseId, chapterId, allChaptersByCourse]);

  const [coursePage, setCoursePage] = useState(1);
  const [coursePageSize, setCoursePageSize] = useState(10);
  const courseTotal = courseTableRows.length;
  const coursePaged = useMemo(
    () => courseTableRows.slice((coursePage - 1) * coursePageSize, coursePage * coursePageSize),
    [courseTableRows, coursePage, coursePageSize]
  );

  const [chapterPage, setChapterPage] = useState(1);
  const [chapterPageSize, setChapterPageSize] = useState(10);
  const chapterTotal = chapterTableRows.length;
  const chapterPaged = useMemo(
    () => chapterTableRows.slice((chapterPage - 1) * chapterPageSize, chapterPage * chapterPageSize),
    [chapterTableRows, chapterPage, chapterPageSize]
  );

  return (
    <div className="student-learning-data" style={{ padding: inWorkspace ? "12px 0" : "24px 0", maxWidth: 1200, margin: "0 auto" }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 600 }}>我的学情</h2>

      {/* 筛选区：课程、章节、统计周期 */}
      <section className="card" style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>学情综合统计分析筛选区</div>
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
      </section>

      {/* 课程学习情况表 */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>课程学习情况表（合计：{courseTotal} 条）</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "10px 8px" }}>课程</th>
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
              {loading ? (
                <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>加载中…</td></tr>
              ) : coursePaged.length === 0 ? (
                <tr><td colSpan={9} style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>暂无数据</td></tr>
              ) : (
                coursePaged.map((r, i) => {
                  const wp = formatWeakPoints(r.completed_question_count > 0 ? r.weak_knowledge_points : "—");
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "10px 8px" }}>{r.course_name}</td>
                      <td style={{ padding: "10px 8px" }}>{r.class_name ?? "—"}</td>
                      <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.preview_rate}</td>
                      <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.completed_question_count}</td>
                      <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.accuracy_rate}</td>
                      <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.feedback_question_count}</td>
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
        <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>每页显示</span>
          <select
            value={String(coursePageSize)}
            onChange={(e) => { const n = Number(e.target.value) || 10; setCoursePageSize(n); setCoursePage(1); }}
            style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6 }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (<option key={n} value={n}>{n}</option>))}
          </select>
          <button type="button" className="btn-secondary" onClick={() => setCoursePage((p) => Math.max(1, p - 1))} disabled={coursePage <= 1}>上一页</button>
          <button type="button" className="btn-secondary" onClick={() => setCoursePage((p) => Math.min(Math.ceil(courseTotal / coursePageSize), p + 1))} disabled={coursePage >= Math.ceil(courseTotal / coursePageSize) || courseTotal === 0}>下一页</button>
          <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>第 {coursePage} / {Math.max(1, Math.ceil(courseTotal / coursePageSize))} 页，共 {courseTotal} 条</span>
        </div>
      </div>

      {/* 章节学习情况表 */}
      <div className="card" style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>章节学习情况表（合计：{chapterTotal} 条）</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "10px 8px" }}>课程</th>
                <th style={{ textAlign: "left", padding: "10px 8px" }}>章节</th>
                <th style={{ textAlign: "left", padding: "10px 8px" }}>班级</th>
                <th style={{ textAlign: "right", padding: "10px 8px" }}>预习完成率</th>
                <th style={{ textAlign: "right", padding: "10px 8px" }}>完成习题数</th>
                <th style={{ textAlign: "right", padding: "10px 8px" }}>平均正确率</th>
                <th style={{ textAlign: "left", padding: "10px 8px" }}>高频薄弱知识点</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>加载中…</td></tr>
              ) : chapterPaged.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 24, textAlign: "center", color: "var(--text-muted)" }}>暂无数据（请先选择课程以查看章节）</td></tr>
              ) : (
                chapterPaged.map((r, i) => {
                  const wp = formatWeakPoints(r.weak_points);
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "10px 8px" }}>{r.course_name}</td>
                      <td style={{ padding: "10px 8px" }}>{r.chapter_name}</td>
                      <td style={{ padding: "10px 8px" }}>{r.class_name}</td>
                      <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.preview_rate}</td>
                      <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.completed_count}</td>
                      <td style={{ padding: "10px 8px", textAlign: "right" }}>{r.accuracy_rate}</td>
                      <td style={{ padding: "10px 8px" }} title={wp.title}>{wp.display}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>每页显示</span>
          <select
            value={String(chapterPageSize)}
            onChange={(e) => { const n = Number(e.target.value) || 10; setChapterPageSize(n); setChapterPage(1); }}
            style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6 }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (<option key={n} value={n}>{n}</option>))}
          </select>
          <button type="button" className="btn-secondary" onClick={() => setChapterPage((p) => Math.max(1, p - 1))} disabled={chapterPage <= 1}>上一页</button>
          <button type="button" className="btn-secondary" onClick={() => setChapterPage((p) => Math.min(Math.ceil(chapterTotal / chapterPageSize), p + 1))} disabled={chapterPage >= Math.ceil(chapterTotal / chapterPageSize) || chapterTotal === 0}>下一页</button>
          <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>第 {chapterPage} / {Math.max(1, Math.ceil(chapterTotal / chapterPageSize))} 页，共 {chapterTotal} 条</span>
        </div>
      </div>
    </div>
  );
}
