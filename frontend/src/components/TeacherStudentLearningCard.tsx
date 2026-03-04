import { useMemo, useState } from "react";
import { api } from "../api/client";

const STAT_PERIODS = [
  { value: "7", label: "近7天" },
  { value: "30", label: "近30天" },
  { value: "month", label: "本月" },
  { value: "custom", label: "自定义" },
] as const;

function formatDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function getTimeRange(
  period: string,
  customStart: string,
  customEnd: string
): { start: string; end: string } {
  if (period === "custom" && customStart && customEnd) {
    return { start: customStart, end: customEnd };
  }
  const end = new Date();
  const start = new Date();
  if (period === "7") start.setDate(start.getDate() - 6);
  else if (period === "30") start.setDate(start.getDate() - 29);
  else if (period === "month") start.setDate(1);
  else start.setDate(start.getDate() - 6);
  return { start: formatDate(start), end: formatDate(end) };
}

function formatWeakPoints(raw: string): { display: string; title: string } {
  if (!raw || raw === "—") return { display: "—", title: "" };
  const parts = raw.split(";").map((s) => s.trim()).filter(Boolean).slice(0, 5);
  const full = parts.join("; ");
  const display = full.length > 20 ? `${full.slice(0, 20)}...` : full;
  return { display, title: full };
}

export type StatsRow = {
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

export type StudentLearningPayload = {
  type: "student_learning";
  keyword: string;
  candidates: { id: number; student_no: string | null; display_name: string | null }[];
  selectedStudentId: number | null;
  selectedStudentName: string | null;
  timeRange: { start: string; end: string } | null;
  period: string;
  customStart: string;
  customEnd: string;
  courseRows: StatsRow[];
  allChaptersByCourse: Record<number, { id: number; title: string }[]>;
};

type ChapterRow = {
  course_id: number;
  chapter_id: number;
  course_name: string;
  class_name: string;
  chapter_name: string;
  preview_rate: string;
  completed_count: number;
  accuracy_rate: string;
  weak_points: string;
};

function buildChapterRows(
  rawData: StatsRow[] | undefined,
  allChaptersByCourse: Record<number, { id: number; title: string }[]> | undefined
): ChapterRow[] {
  const rows: ChapterRow[] = [];
  const data = Array.isArray(rawData) ? rawData : [];
  const byCourse = allChaptersByCourse && typeof allChaptersByCourse === "object" ? allChaptersByCourse : {};
  for (const r of data) {
    const courseChapters = byCourse[r.course_id];
    const chList = courseChapters && courseChapters.length > 0 ? courseChapters : [{ id: 0, title: "全部" }];
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
        course_id: r.course_id,
        chapter_id: chId,
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
}

type Props = {
  messageId: number;
  payload: StudentLearningPayload;
  onSelectStudent: (messageId: number, studentId: number, studentName: string) => void;
  onTimeRangeChange?: (messageId: number, period: string, customStart: string, customEnd: string) => void;
  onRefetchWithTimeRange: (
    messageId: number,
    studentId: number,
    start: string,
    end: string,
    period: string,
    customStart: string,
    customEnd: string,
    courseRows: StatsRow[],
    allChaptersByCourse: Record<number, { id: number; title: string }[]>
  ) => void;
};

export default function TeacherStudentLearningCard({
  messageId,
  payload: rawPayload,
  onSelectStudent,
  onTimeRangeChange,
  onRefetchWithTimeRange,
}: Props) {
  const payload: StudentLearningPayload = {
    type: "student_learning",
    keyword: rawPayload.keyword ?? "",
    candidates: Array.isArray(rawPayload.candidates) ? rawPayload.candidates : [],
    selectedStudentId: rawPayload.selectedStudentId ?? null,
    selectedStudentName: rawPayload.selectedStudentName ?? null,
    timeRange: rawPayload.timeRange ?? null,
    period: rawPayload.period ?? "7",
    customStart: rawPayload.customStart ?? "",
    customEnd: rawPayload.customEnd ?? "",
    courseRows: Array.isArray(rawPayload.courseRows) ? rawPayload.courseRows : [],
    allChaptersByCourse: rawPayload.allChaptersByCourse && typeof rawPayload.allChaptersByCourse === "object" ? rawPayload.allChaptersByCourse : {},
  };
  const period = payload.period;
  const customStart = payload.customStart;
  const customEnd = payload.customEnd;
  const setPeriod = (v: string) => onTimeRangeChange?.(messageId, v, customStart, customEnd);
  const setCustomStart = (v: string) => onTimeRangeChange?.(messageId, period, v, customEnd);
  const setCustomEnd = (v: string) => onTimeRangeChange?.(messageId, period, customStart, v);
  const [refetching, setRefetching] = useState(false);
  const [filterCourseId, setFilterCourseId] = useState<number | "">("");
  const [filterChapterId, setFilterChapterId] = useState<number | "">("");

  const chapterRows = useMemo(
    () => buildChapterRows(payload.courseRows, payload.allChaptersByCourse),
    [payload.courseRows, payload.allChaptersByCourse]
  );

  const courseOptions = useMemo(() => {
    const seen = new Set<number>();
    return payload.courseRows
      .filter((r) => { if (seen.has(r.course_id)) return false; seen.add(r.course_id); return true; })
      .map((r) => ({ id: r.course_id, name: r.course_name }));
  }, [payload.courseRows]);

  const chapterOptions = useMemo(() => {
    if (filterCourseId === "" || filterCourseId === null) return [];
    const list = payload.allChaptersByCourse[Number(filterCourseId)] ?? [];
    return [{ id: 0, title: "全部" }, ...list];
  }, [filterCourseId, payload.allChaptersByCourse]);

  const filteredCourseRows = useMemo(() => {
    if (filterCourseId === "" || filterCourseId === null) return payload.courseRows;
    return payload.courseRows.filter((r) => r.course_id === Number(filterCourseId));
  }, [payload.courseRows, filterCourseId]);

  const filteredChapterRows = useMemo(() => {
    let rows = chapterRows;
    if (filterCourseId !== "" && filterCourseId != null) {
      rows = rows.filter((r) => r.course_id === Number(filterCourseId));
    }
    if (filterChapterId !== "" && filterChapterId != null) {
      rows = rows.filter((r) => r.chapter_id === Number(filterChapterId));
    }
    return rows;
  }, [chapterRows, filterCourseId, filterChapterId]);

  const handleRefetch = async () => {
    if (!payload.selectedStudentId) return;
    const tr = getTimeRange(period, customStart, customEnd);
    setRefetching(true);
    try {
      const list = await api.teacher.statsByCourseStudent({
        studentId: payload.selectedStudentId,
        startDate: tr.start,
        endDate: tr.end,
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
      onRefetchWithTimeRange(messageId, payload.selectedStudentId, tr.start, tr.end, period, customStart, customEnd, list, allChaptersByCourse);
    } finally {
      setRefetching(false);
    }
  };

  if (payload.candidates.length === 0) {
    return (
      <div className="teacher-learning-card" style={{ padding: 12, background: "var(--bg-subtle)", borderRadius: 8, marginTop: 8 }}>
        <p style={{ margin: 0, color: "var(--text-muted)" }}>未找到匹配「{payload.keyword || "关键词"}」的学生（按姓名或学号）。</p>
      </div>
    );
  }

  if (payload.candidates.length > 1 && !payload.selectedStudentId) {
    return (
      <div className="teacher-learning-card" style={{ padding: 12, background: "var(--bg-subtle)", borderRadius: 8, marginTop: 8 }}>
        <p style={{ margin: "0 0 10px", fontSize: 13 }}>找到多位匹配学生，请选择要查看学情的一位：</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {payload.candidates.map((s) => (
            <button
              key={s.id}
              type="button"
              className="btn-secondary"
              onClick={() => onSelectStudent(messageId, s.id, (s.display_name || s.student_no || `学生${s.id}`).trim())}
            >
              {s.display_name || s.student_no || s.id} {s.student_no ? `（${s.student_no}）` : ""}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (payload.selectedStudentId && payload.courseRows.length === 0 && !refetching) {
    return (
      <div className="teacher-learning-card" style={{ padding: 12, background: "var(--bg-subtle)", borderRadius: 8, marginTop: 8 }}>
        <p style={{ margin: 0, color: "var(--text-muted)" }}>
          {payload.selectedStudentName ?? "该学生"} 在您所管班级中暂无学情数据（当前统计周期内）。
        </p>
      </div>
    );
  }

  const timeRange = getTimeRange(period, customStart, customEnd);

  return (
    <div className="teacher-learning-card" style={{ padding: 12, background: "var(--bg-subtle)", borderRadius: 8, marginTop: 8 }}>
      <p style={{ margin: "0 0 12px", fontSize: 13 }}>
        <strong>{payload.selectedStudentName}</strong> 的学情统计
        {payload.timeRange && (
          <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
            （{payload.timeRange.start} 至 {payload.timeRange.end}）
          </span>
        )}
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end", marginBottom: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <span style={{ color: "var(--text-muted)" }}>课程</span>
          <select
            value={filterCourseId === "" ? "" : String(filterCourseId)}
            onChange={(e) => {
              const v = e.target.value;
              setFilterCourseId(v === "" ? "" : Number(v));
              setFilterChapterId("");
            }}
            style={{ padding: "6px 8px", minWidth: 120 }}
          >
            <option value="">全部</option>
            {courseOptions.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <span style={{ color: "var(--text-muted)" }}>章节</span>
          <select
            value={filterChapterId === "" ? "" : String(filterChapterId)}
            onChange={(e) => {
              const v = e.target.value;
              setFilterChapterId(v === "" ? "" : Number(v));
            }}
            disabled={filterCourseId === ""}
            style={{ padding: "6px 8px", minWidth: 120 }}
          >
            <option value="">全部</option>
            {chapterOptions.map((ch) => (
              <option key={ch.id} value={ch.id}>{ch.title}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <span style={{ color: "var(--text-muted)" }}>统计周期</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value)} style={{ padding: "6px 8px" }}>
            {STAT_PERIODS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </label>
        {period === "custom" && (
          <>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <span>开始</span>
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} style={{ padding: 4 }} />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <span>结束</span>
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} style={{ padding: 4 }} />
            </label>
          </>
        )}
        <button type="button" className="btn-primary" onClick={handleRefetch} disabled={refetching}>
          {refetching ? "查询中…" : "再次查询"}
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>课程学习情况表</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--border)" }}>
              <th style={{ textAlign: "left", padding: "6px 6px" }}>课程</th>
              <th style={{ textAlign: "left", padding: "6px 6px" }}>班级</th>
              <th style={{ textAlign: "right", padding: "6px 6px" }}>预习完成率</th>
              <th style={{ textAlign: "right", padding: "6px 6px" }}>完成习题数</th>
              <th style={{ textAlign: "right", padding: "6px 6px" }}>平均正确率</th>
              <th style={{ textAlign: "right", padding: "6px 6px" }}>反馈数</th>
              <th style={{ textAlign: "right", padding: "6px 6px" }}>AI提问</th>
              <th style={{ textAlign: "left", padding: "6px 6px" }}>薄弱知识点</th>
            </tr>
          </thead>
          <tbody>
            {filteredCourseRows.map((r, i) => {
              const wp = formatWeakPoints(r.completed_question_count > 0 ? r.weak_knowledge_points : "—");
              return (
                <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "6px 6px" }}>{r.course_name}</td>
                  <td style={{ padding: "6px 6px" }}>{r.class_name ?? "—"}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right" }}>{r.preview_rate}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right" }}>{r.completed_question_count}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right" }}>{r.accuracy_rate}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right" }}>{r.feedback_question_count}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right" }}>{r.ai_ask_count}</td>
                  <td style={{ padding: "6px 6px" }} title={wp.title}>{wp.display}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 16, marginBottom: 8 }}>章节学习情况表</div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid var(--border)" }}>
              <th style={{ textAlign: "left", padding: "6px 6px" }}>课程</th>
              <th style={{ textAlign: "left", padding: "6px 6px" }}>章节</th>
              <th style={{ textAlign: "left", padding: "6px 6px" }}>班级</th>
              <th style={{ textAlign: "right", padding: "6px 6px" }}>预习完成率</th>
              <th style={{ textAlign: "right", padding: "6px 6px" }}>完成习题数</th>
              <th style={{ textAlign: "right", padding: "6px 6px" }}>平均正确率</th>
              <th style={{ textAlign: "left", padding: "6px 6px" }}>薄弱知识点</th>
            </tr>
          </thead>
          <tbody>
            {filteredChapterRows.slice(0, 50).map((r, i) => {
              const wp = formatWeakPoints(r.weak_points);
              return (
                <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "6px 6px" }}>{r.course_name}</td>
                  <td style={{ padding: "6px 6px" }}>{r.chapter_name}</td>
                  <td style={{ padding: "6px 6px" }}>{r.class_name}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right" }}>{r.preview_rate}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right" }}>{r.completed_count}</td>
                  <td style={{ padding: "6px 6px", textAlign: "right" }}>{r.accuracy_rate}</td>
                  <td style={{ padding: "6px 6px" }} title={wp.title}>{wp.display}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filteredChapterRows.length > 50 && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>仅显示前 50 条，共 {filteredChapterRows.length} 条</p>
        )}
      </div>
    </div>
  );
}
