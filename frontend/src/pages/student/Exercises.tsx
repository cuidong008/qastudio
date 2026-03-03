import { useState, useEffect } from "react";
import { api } from "../../api/client";

type QuestionItem = {
  id: number;
  chapter_id?: number;
  course_id?: number | null;
  difficulty?: string;
  question_type?: string | null;
  question_text: string;
  options: string | null;
  explanation: string | null;
  ppt_ref?: string | null;
};

const difficultyLabel: Record<string, string> = {
  basic: "基础",
  applied: "应用",
  extended: "拓展",
};

export default function Exercises({ courseId }: { courseId?: number | null }) {
  const embeddedCourseId = courseId ?? null;
  const [courses, setCourses] = useState<{ id: number; name: string }[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<number | null>(embeddedCourseId);
  const [chapters, setChapters] = useState<{ id: number; title: string }[]>([]);
  const [chapterId, setChapterId] = useState<number | null>(null);
  const [difficulty, setDifficulty] = useState<string>("");
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [current, setCurrent] = useState<QuestionItem | null>(null);
  const [userAnswer, setUserAnswer] = useState("");
  const [result, setResult] = useState<{
    is_correct: boolean;
    correct_answer: string;
    explanation: string | null;
    ppt_ref: string | null;
    grading_source?: string | null;
    grading_confidence?: number | null;
    grading_reason?: string | null;
  } | null>(null);
  const [tab, setTab] = useState<"practice" | "wrong">("practice");
  const hasAvailableCourse = courses.length > 0;

  useEffect(() => {
    api.courses.list()
      .then((list) => {
        const next = list.map((c) => ({ id: c.id, name: c.name }));
        setCourses(next);
        setSelectedCourseId((prev) => {
          if (embeddedCourseId != null) return next.some((c) => c.id === embeddedCourseId) ? embeddedCourseId : null;
          return prev && next.some((c) => c.id === prev) ? prev : next[0]?.id ?? null;
        });
      })
      .catch(() => {
        setCourses([]);
        setSelectedCourseId(null);
      });
  }, [embeddedCourseId]);

  useEffect(() => {
    if (selectedCourseId == null) {
      setChapters([]);
      setChapterId(null);
      setDifficulty("");
      return;
    }
    api.chapters.list({ course_id: selectedCourseId }).then((list) => {
      setChapters(list);
      if (!list.length) {
        setChapterId(null);
        return;
      }
      setChapterId((prev) => (prev && list.some((c) => c.id === prev) ? prev : null));
    });
  }, [selectedCourseId]);

  useEffect(() => {
    if (selectedCourseId == null) {
      setQuestions([]);
      setCurrent(null);
    } else if (tab === "wrong") {
      api.questions
        .wrong()
        .then((list) => {
          setQuestions(list);
          setCurrent(list[0] ?? null);
        })
        .catch(() => setQuestions([]));
    } else if (chapterId != null) {
      api.questions
        .list({ chapter_id: chapterId ?? undefined, difficulty: difficulty || undefined })
        .then((list) => {
          setQuestions(list);
          setCurrent(list[0] ?? null);
        });
    } else {
      setQuestions([]);
      setCurrent(null);
    }
    setResult(null);
    setUserAnswer("");
  }, [tab, chapterId, difficulty, selectedCourseId]);

  const submitAnswer = async () => {
    if (!current || !userAnswer.trim()) return;
    const res = await api.questions.submit(current.id, userAnswer.trim());
    setResult(res);
  };

  const nextQuestion = () => {
    const idx = questions.findIndex((q) => q.id === current?.id);
    const next = idx >= 0 && idx < questions.length - 1 ? questions[idx + 1] : null;
    setCurrent(next ?? null);
    setResult(null);
    setUserAnswer("");
  };

  const options = current?.options
    ? (() => {
        try {
          return JSON.parse(current.options) as string[];
        } catch {
          return [];
        }
      })()
    : [];
  const isMultiChoice = (current?.question_type || "") === "multiple_choice";
  const pickedMulti = userAnswer
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const toggleMultiAnswer = (letter: string) => {
    const next = new Set(pickedMulti);
    if (next.has(letter)) next.delete(letter);
    else next.add(letter);
    setUserAnswer(Array.from(next).sort().join(","));
  };

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>习题训练</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 20, fontSize: 15 }}>分层习题、详细解析与 PPT 关联</p>
      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <button type="button" className={tab === "practice" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("practice")}>
          按章节/难度练习
        </button>
        <button type="button" className={tab === "wrong" ? "btn-primary" : "btn-secondary"} onClick={() => setTab("wrong")} disabled={!hasAvailableCourse}>
          错题本
        </button>
      </div>
      {tab === "practice" && (
        <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
          {embeddedCourseId == null && (
            <select
              value={selectedCourseId ?? ""}
              onChange={(e) => setSelectedCourseId(e.target.value ? Number(e.target.value) : null)}
              disabled={!courses.length}
              style={{ padding: "10px 14px", minWidth: 180 }}
            >
              <option value="">{courses.length ? "请选择课程" : "暂无可选课程"}</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <select
            value={chapterId ?? ""}
            onChange={(e) => setChapterId(e.target.value ? Number(e.target.value) : null)}
            disabled={selectedCourseId == null}
            style={{ padding: "10px 14px", minWidth: 160 }}
          >
            {selectedCourseId == null && <option value="">请先选择课程</option>}
            <option value="">请选择章节</option>
            {chapters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            disabled={selectedCourseId == null}
            style={{ padding: "10px 14px", minWidth: 120 }}
          >
            <option value="">全部难度</option>
            <option value="basic">基础</option>
            <option value="applied">应用</option>
            <option value="extended">拓展</option>
          </select>
        </div>
      )}
      {tab === "practice" && selectedCourseId == null && (
        <p style={{ color: "var(--text-muted)" }}>你当前没有可用课程，请先加入班级或联系教师分配开课。</p>
      )}
      {tab === "wrong" && selectedCourseId == null && (
        <p style={{ color: "var(--text-muted)" }}>你当前没有可用课程，暂不显示习题。</p>
      )}
      {current ? (
        <div className="card">
          <p style={{ color: "var(--text-muted)", marginBottom: 12, fontSize: 13, textTransform: "uppercase", letterSpacing: "0.5px" }}>
            {difficultyLabel[current.difficulty ?? ""] ?? current.difficulty ?? ""}
          </p>
          <p style={{ fontSize: 16, marginBottom: 16, lineHeight: 1.6 }}>{current.question_text}</p>
          {options.length > 0 ? (
            <div style={{ marginBottom: 20 }}>
              {options.map((opt, i) => (
                <label
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 10,
                    cursor: "pointer",
                    padding: "10px 14px",
                    background: "var(--bg-elevated)",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {isMultiChoice && (
                    <input type="checkbox" checked={pickedMulti.includes(opt.slice(0, 1))} onChange={() => toggleMultiAnswer(opt.slice(0, 1))} />
                  )}
                  {!isMultiChoice && (
                    <input type="radio" name="answer" value={opt.slice(0, 1)} checked={userAnswer === opt.slice(0, 1)} onChange={() => setUserAnswer(opt.slice(0, 1))} />
                  )}
                  {opt}
                </label>
              ))}
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: "1em", marginBottom: 20, flexWrap: "wrap" }}>
              <input
                type="text"
                placeholder="输入答案"
                value={userAnswer}
                onChange={(e) => setUserAnswer(e.target.value)}
                style={{ flex: "1 1 200px", maxWidth: 800, minWidth: 0, boxSizing: "border-box" }}
              />
              {!result && (
                <button type="button" className="btn-primary" onClick={submitAnswer} disabled={!userAnswer.trim()}>
                  提交答案
                </button>
              )}
            </div>
          )}
          {options.length > 0 && !result && (
            <button type="button" className="btn-primary" onClick={submitAnswer} disabled={!userAnswer.trim()}>
              提交答案
            </button>
          )}
          {result ? (
            <div>
              <p style={{ color: result.is_correct ? "var(--success)" : "var(--error)", marginBottom: 8, fontWeight: 500 }}>
                {result.is_correct ? "回答正确，正确答案" : "回答有误，参考答案"}：{result.correct_answer}
              </p>
              {result.explanation && (
                <p style={{ marginBottom: 8 }}>
                  <strong>解析：</strong>
                  {result.explanation}
                </p>
              )}
              {(result.grading_source === "llm" || result.grading_reason) && (
                <p style={{ marginBottom: 8, color: "var(--text-muted)" }}>
                  <strong>判卷：</strong>
                  {result.grading_source === "llm" ? "LLM 语义判卷" : "规则判卷"}
                  {typeof result.grading_confidence === "number" ? `（置信度 ${(result.grading_confidence * 100).toFixed(0)}%）` : ""}
                  {result.grading_reason ? `，${result.grading_reason}` : ""}
                </p>
              )}
              {result.ppt_ref && <p style={{ color: "var(--accent)", marginBottom: 16 }}>参考 PPT：{result.ppt_ref}</p>}
              <button type="button" className="btn-primary" onClick={nextQuestion}>
                下一题
              </button>
            </div>
          ) : null}
        </div>
      ) : tab === "practice" && (selectedCourseId == null || chapterId == null) ? null : (
        <p style={{ color: "var(--text-muted)" }}>暂无题目，请选择其他章节或难度。</p>
      )}
    </div>
  );
}
