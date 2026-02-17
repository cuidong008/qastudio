import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";

export default function Review({ inWorkspace = false, onGoQa, courseId }: { inWorkspace?: boolean; onGoQa?: () => void; courseId?: number | null }) {
  const [chapters, setChapters] = useState<{ id: number; title: string }[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [task, setTask] = useState<{
    chapter_id: number;
    chapter_title: string;
    key_points: string[];
    recall_card_rule: string;
    basic_questions: { id: number; question_type: string | null; difficulty: string; question_text: string; options: string | null }[];
    variant_questions: { id: number; question_type: string | null; difficulty: string; question_text: string; options: string | null }[];
    comprehensive_question: { id: number; question_type: string | null; difficulty: string; question_text: string; options: string | null } | null;
  } | null>(null);
  const [recallPoints, setRecallPoints] = useState(["", "", ""]);
  const [recallSubmitted, setRecallSubmitted] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [results, setResults] = useState<Record<number, { answer_record_id: number; is_correct: boolean; correct_answer: string }>>({});

  useEffect(() => {
    api.chapters.list({ course_id: courseId ?? undefined }).then((list) => {
      setChapters(list);
      if (list.length) {
        setSelected((prev) => (prev && list.some((c) => c.id === prev) ? prev : list[0].id));
      } else {
        setSelected(null);
      }
    });
  }, [courseId]);

  useEffect(() => {
    if (!selected) return;
    api.review.task(selected).then(setTask);
    setRecallPoints(["", "", ""]);
    setRecallSubmitted(false);
    setAnswers({});
    setResults({});
  }, [selected]);

  const submitRecallCard = async () => {
    if (!selected) return;
    const clean = recallPoints.map((item) => item.trim());
    if (clean.some((item) => !item)) return;
    await api.review.submitRecall(selected, clean);
    setRecallSubmitted(true);
  };

  const submitQuestion = async (questionId: number) => {
    const answer = (answers[questionId] || "").trim();
    if (!answer) return;
    const res = await api.questions.submit(questionId, answer, "review");
    setResults((prev) => ({ ...prev, [questionId]: res }));
  };

  const parseOptions = (options: string | null): string[] => {
    if (!options) return [];
    try {
      return JSON.parse(options) as string[];
    } catch {
      return [];
    }
  };

  const allQuestions = [
    ...(task?.basic_questions || []),
    ...(task?.variant_questions || []),
    ...(task?.comprehensive_question ? [task.comprehensive_question] : []),
  ];

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>
        课后复习
      </h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 16, fontSize: 15 }}>
        3分钟回忆卡 + 分层巩固练习 + 错题闭环
      </p>
      <p style={{ marginBottom: 20 }}>
        {inWorkspace ? (
          <button type="button" className="btn-ghost" onClick={onGoQa} style={{ padding: "0 6px", minHeight: "auto" }}>
            7×24 答疑入口
          </button>
        ) : (
          <Link to="/student/inclass">7×24 答疑入口</Link>
        )}
        （与课中辅助共用）
      </p>
      <div style={{ marginBottom: 20 }}>
        <label style={{ marginRight: 10, color: "var(--text-secondary)", fontSize: 14 }}>
          选择章节
        </label>
        <select
          value={selected ?? ""}
          onChange={(e) => setSelected(Number(e.target.value))}
          style={{ padding: "10px 14px", minWidth: 280 }}
        >
          {chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </div>
      {task && (
        <div className="card">
          <h2 style={{ marginTop: 0, marginBottom: 16, fontSize: 18, fontWeight: 600 }}>
            {task.chapter_title}
          </h2>
          <h4 style={{ marginBottom: 8, fontSize: 15, fontWeight: 600 }}>
            当天回顾（3分钟回忆卡）
          </h4>
          <p style={{ color: "var(--text-muted)", marginBottom: 12 }}>{task.recall_card_rule}</p>
          <ul style={{ marginBottom: 12, paddingLeft: 20 }}>
            {task.key_points.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
          {[0, 1, 2].map((i) => (
            <input
              key={i}
              type="text"
              placeholder={`关键点 ${i + 1}`}
              value={recallPoints[i]}
              onChange={(e) =>
                setRecallPoints((prev) => {
                  const next = [...prev];
                  next[i] = e.target.value;
                  return next;
                })
              }
              style={{ display: "block", marginBottom: 8, maxWidth: 480 }}
            />
          ))}
          {!recallSubmitted ? (
            <button type="button" className="btn-secondary" onClick={submitRecallCard} disabled={recallPoints.some((item) => !item.trim())}>
              提交回忆卡
            </button>
          ) : (
            <p style={{ color: "var(--success)", marginBottom: 16 }}>回忆卡已提交。</p>
          )}
          <h4 style={{ marginBottom: 8, marginTop: 16, fontSize: 15, fontWeight: 600 }}>
            巩固练习（基础题+变式题+1道综合题）
          </h4>
          {allQuestions.length === 0 ? <p style={{ color: "var(--text-muted)" }}>当前章节暂无可用复习题。</p> : null}
          {allQuestions.map((q, idx) => {
            const qResult = results[q.id];
            const qOptions = parseOptions(q.options);
            return (
              <div key={q.id} style={{ marginBottom: 16, padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
                <p style={{ margin: "0 0 10px", fontWeight: 500 }}>
                  {idx + 1}. [{q.difficulty}] {q.question_text}
                </p>
                {qOptions.length > 0 ? (
                  <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
                    {qOptions.map((opt, i) => (
                      <label key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input
                          type="radio"
                          name={`review-q-${q.id}`}
                          value={opt.slice(0, 1)}
                          checked={(answers[q.id] || "") === opt.slice(0, 1)}
                          onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                        />
                        {opt}
                      </label>
                    ))}
                  </div>
                ) : (
                  <input
                    type="text"
                    placeholder="输入答案"
                    value={answers[q.id] || ""}
                    onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    style={{ marginBottom: 10, maxWidth: 300 }}
                  />
                )}
                {!qResult ? (
                  <button type="button" className="btn-secondary" onClick={() => submitQuestion(q.id)} disabled={!answers[q.id]?.trim()}>
                    提交本题
                  </button>
                ) : (
                  <div>
                    <p style={{ color: qResult.is_correct ? "var(--success)" : "var(--error)", margin: "0 0 8px" }}>
                      {qResult.is_correct ? "回答正确" : `回答错误，正确答案：${qResult.correct_answer}`}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
          <p style={{ color: "var(--text-muted)", margin: 0 }}>
            复习和预习作答都来自预生成题库，错题自动进入错题本。
          </p>
        </div>
      )}
    </div>
  );
}
