import { useState, useEffect } from "react";
import { api } from "../../api/client";

type QuestionItem = {
  id: number;
  chapter_id?: number;
  difficulty?: string;
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

export default function Exercises() {
  const [chapters, setChapters] = useState<{ id: number; title: string }[]>([]);
  const [chapterId, setChapterId] = useState<number | null>(null);
  const [difficulty, setDifficulty] = useState<string>("");
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [current, setCurrent] = useState<QuestionItem | null>(null);
  const [userAnswer, setUserAnswer] = useState("");
  const [result, setResult] = useState<{ is_correct: boolean; correct_answer: string; explanation: string | null; ppt_ref: string | null } | null>(null);
  const [tab, setTab] = useState<"practice" | "wrong">("practice");

  useEffect(() => {
    api.chapters.list().then(setChapters);
  }, []);

  useEffect(() => {
    if (tab === "wrong") {
      api.questions.wrong().then((list) => {
        setQuestions(list);
        setCurrent(list[0] ?? null);
      }).catch(() => setQuestions([]));
    } else {
      api.questions.list({ chapter_id: chapterId ?? undefined, difficulty: difficulty || undefined }).then((list) => {
        setQuestions(list);
        setCurrent(list[0] ?? null);
      });
    }
    setResult(null);
    setUserAnswer("");
  }, [tab, chapterId, difficulty]);

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

  const options = current?.options ? (() => {
    try {
      return JSON.parse(current.options) as string[];
    } catch {
      return [];
    }
  })() : [];

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>
        习题训练
      </h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 20, fontSize: 15 }}>
        分层习题、详细解析与 PPT 关联
      </p>
      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <button
          type="button"
          className={tab === "practice" ? "btn-primary" : "btn-secondary"}
          onClick={() => setTab("practice")}
        >
          按章节/难度练习
        </button>
        <button
          type="button"
          className={tab === "wrong" ? "btn-primary" : "btn-secondary"}
          onClick={() => setTab("wrong")}
        >
          错题本
        </button>
      </div>
      {tab === "practice" && (
        <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
          <select
            value={chapterId ?? ""}
            onChange={(e) => setChapterId(e.target.value ? Number(e.target.value) : null)}
            style={{ padding: "10px 14px", minWidth: 160 }}
          >
            <option value="">全部章节</option>
            {chapters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            style={{ padding: "10px 14px", minWidth: 120 }}
          >
            <option value="">全部难度</option>
            <option value="basic">基础</option>
            <option value="applied">应用</option>
            <option value="extended">拓展</option>
          </select>
        </div>
      )}
      {current ? (
        <div className="card">
          <p
            style={{
              color: "var(--text-muted)",
              marginBottom: 12,
              fontSize: 13,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
            }}
          >
            {difficultyLabel[current.difficulty ?? ""] ?? current.difficulty ?? ""}
          </p>
          <p style={{ fontSize: 16, marginBottom: 16, lineHeight: 1.6 }}>
            {current.question_text}
          </p>
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
                  <input
                    type="radio"
                    name="answer"
                    value={opt.slice(0, 1)}
                    checked={userAnswer === opt.slice(0, 1)}
                    onChange={() => setUserAnswer(opt.slice(0, 1))}
                  />
                  {opt}
                </label>
              ))}
            </div>
          ) : (
            <input
              type="text"
              placeholder="输入答案"
              value={userAnswer}
              onChange={(e) => setUserAnswer(e.target.value)}
              style={{ marginBottom: 20, maxWidth: 400 }}
            />
          )}
          {!result ? (
            <button
              type="button"
              className="btn-primary"
              onClick={submitAnswer}
              disabled={!userAnswer.trim()}
            >
              提交答案
            </button>
          ) : (
            <div>
              <p
                style={{
                  color: result.is_correct ? "var(--success)" : "var(--error)",
                  marginBottom: 8,
                  fontWeight: 500,
                }}
              >
                {result.is_correct ? "回答正确" : "回答错误"}，正确答案：{result.correct_answer}
              </p>
              {result.explanation && (
                <p style={{ marginBottom: 8 }}>
                  <strong>解析：</strong>
                  {result.explanation}
                </p>
              )}
              {result.ppt_ref && (
                <p style={{ color: "var(--accent)", marginBottom: 16 }}>
                  参考 PPT：{result.ppt_ref}
                </p>
              )}
              <button type="button" className="btn-primary" onClick={nextQuestion}>
                下一题
              </button>
            </div>
          )}
        </div>
      ) : (
        <p style={{ color: "var(--text-muted)" }}>
          暂无题目，请选择其他章节或难度。
        </p>
      )}
    </div>
  );
}
