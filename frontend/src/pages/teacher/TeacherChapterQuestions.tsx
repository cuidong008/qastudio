import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";

type TeacherQuestionItem = {
  id: number;
  course_id: number | null;
  course_name: string | null;
  chapter_id: number;
  chapter_title: string;
  question_type: string;
  difficulty: string;
  question_text: string;
  options: string | null;
  correct_answer: string;
  explanation: string | null;
  created_at: string | null;
};

const questionTypeLabel: Record<string, string> = {
  single_choice: "单选题",
  multiple_choice: "多选题",
  judge: "判断题",
  qa: "问答题",
  blank: "填空题",
};

function stripTypePrefix(text: string): string {
  return (text || "").replace(/^\s*\[[^\]]+\]\s*/, "").trim();
}

function parseOptionArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => String(x ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export default function TeacherChapterQuestions() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const chapterId = Number(searchParams.get("chapterId") || 0);
  const [loading, setLoading] = useState(false);
  const [list, setList] = useState<TeacherQuestionItem[]>([]);
  const [filterDifficulty, setFilterDifficulty] = useState("");
  const [filterType, setFilterType] = useState("");
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [editing, setEditing] = useState<TeacherQuestionItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    difficulty: "basic",
    question_text: "",
    options: ["", "", "", ""],
    correct_answer: "",
    explanation: "",
  });

  const header = useMemo(() => {
    if (!list.length) return "章节习题管理";
    const first = list[0];
    return `${first.course_name || "课程"} / ${first.chapter_title} · 习题管理`;
  }, [list]);

  const filteredList = useMemo(
    () =>
      list.filter((q) => {
        if (filterDifficulty && q.difficulty !== filterDifficulty) return false;
        if (filterType && q.question_type !== filterType) return false;
        return true;
      }),
    [list, filterDifficulty, filterType]
  );

  const load = () => {
    if (!chapterId) return;
    setLoading(true);
    api.teacher.courses
      .chapterQuestions(chapterId)
      .then((rows) => {
        setList(rows);
        setSelectedIds([]);
      })
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [chapterId]);

  const openEdit = (q: TeacherQuestionItem) => {
    setEditing(q);
    const parsedOptions = parseOptionArray(q.options);
    const defaultOptions =
      q.question_type === "judge"
        ? ["A. 正确", "B. 错误"]
        : [parsedOptions[0] || "", parsedOptions[1] || "", parsedOptions[2] || "", parsedOptions[3] || ""];
    setForm({
      difficulty: q.difficulty,
      question_text: stripTypePrefix(q.question_text),
      options: defaultOptions,
      correct_answer: q.correct_answer,
      explanation: q.explanation || "",
    });
  };

  const submitEdit = () => {
    if (!editing) return;
    const qt = editing.question_type;
    let optionPayload: string[] | null = null;
    if (qt === "single_choice" || qt === "multiple_choice") {
      const clean = form.options.map((x) => x.trim()).filter(Boolean);
      if (clean.length !== 4) {
        alert("单选/多选题必须提供 4 个选项");
        return;
      }
      optionPayload = clean;
    } else if (qt === "judge") {
      optionPayload = ["A. 正确", "B. 错误"];
    }

    setSaving(true);
    api.teacher.courses
      .updateQuestion(editing.id, {
        difficulty: form.difficulty,
        question_text: form.question_text.trim(),
        options: optionPayload,
        correct_answer: form.correct_answer.trim(),
        explanation: form.explanation.trim() || null,
      })
      .then(() => {
        setEditing(null);
        load();
      })
      .catch((e) => alert(e?.message || "保存失败"))
      .finally(() => setSaving(false));
  };

  const deleteQuestion = (id: number) => {
    if (!confirm("确定删除该习题？")) return;
    api.teacher.courses
      .deleteQuestion(id)
      .then(() => load())
      .catch((e) => alert(e?.message || "删除失败"));
  };

  const allFilteredSelected = filteredList.length > 0 && filteredList.every((q) => selectedIds.includes(q.id));

  const toggleSelectOne = (id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      if (checked) return prev.includes(id) ? prev : [...prev, id];
      return prev.filter((x) => x !== id);
    });
  };

  const toggleSelectAllFiltered = (checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...filteredList.map((q) => q.id)])));
      return;
    }
    const filteredSet = new Set(filteredList.map((q) => q.id));
    setSelectedIds((prev) => prev.filter((id) => !filteredSet.has(id)));
  };

  const batchDelete = async () => {
    if (!selectedIds.length) {
      alert("请先选择要删除的习题");
      return;
    }
    if (!confirm(`确定批量删除已选择的 ${selectedIds.length} 道习题？`)) return;
    setBatchDeleting(true);
    try {
      const ids = [...selectedIds];
      let ok = 0;
      for (const id of ids) {
        try {
          await api.teacher.courses.deleteQuestion(id);
          ok += 1;
        } catch {
          // keep going
        }
      }
      alert(`批量删除完成：成功 ${ok}，失败 ${ids.length - ok}`);
      load();
    } finally {
      setBatchDeleting(false);
    }
  };

  if (!chapterId) {
    return (
      <div>
        <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>章节习题管理</h1>
        <p style={{ color: "var(--text-muted)" }}>缺少 chapterId 参数。</p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>{header}</h1>
        <button type="button" className="btn-ghost" onClick={() => navigate("/teacher/courses")}>
          返回课程页
        </button>
      </div>
      <p style={{ color: "var(--text-muted)", marginBottom: 12 }}>可查看答案并对题目进行修改或删除。</p>
      <div className="card" style={{ marginBottom: 12, padding: 12 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select value={filterDifficulty} onChange={(e) => setFilterDifficulty(e.target.value)} style={{ minWidth: 140 }}>
            <option value="">全部难度</option>
            <option value="basic">基础</option>
            <option value="applied">应用</option>
            <option value="extended">拓展</option>
          </select>
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)} style={{ minWidth: 160 }}>
            <option value="">全部题型</option>
            <option value="single_choice">单选题</option>
            <option value="multiple_choice">多选题</option>
            <option value="judge">判断题</option>
            <option value="qa">问答题</option>
            <option value="blank">填空题</option>
          </select>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={allFilteredSelected} onChange={(e) => toggleSelectAllFiltered(e.target.checked)} />
            全选当前筛选结果
          </label>
          <button type="button" className="btn-ghost" style={{ color: "var(--danger, #c00)" }} onClick={batchDelete} disabled={batchDeleting || !selectedIds.length}>
            {batchDeleting ? "删除中…" : `批量删除（${selectedIds.length}）`}
          </button>
        </div>
      </div>
      {loading ? (
        <p style={{ color: "var(--text-muted)" }}>加载中…</p>
      ) : filteredList.length === 0 ? (
        <p style={{ color: "var(--text-muted)" }}>暂无习题</p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {filteredList.map((q, idx) => (
            <div key={q.id} className="card">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                <div>
                  <div style={{ color: "var(--text-muted)", marginBottom: 8, fontSize: 13 }}>
                    #{idx + 1} · {questionTypeLabel[q.question_type] || q.question_type} · {q.difficulty}
                  </div>
                  <div style={{ marginBottom: 10, lineHeight: 1.7 }}>{q.question_text}</div>
                  {q.options && <pre style={{ margin: "0 0 8px 0", whiteSpace: "pre-wrap", fontSize: 13 }}>{q.options}</pre>}
                  <div style={{ marginBottom: 6 }}>
                    <strong>答案：</strong>
                    {q.correct_answer}
                  </div>
                  {q.explanation && (
                    <div>
                      <strong>解析：</strong>
                      {q.explanation}
                    </div>
                  )}
                </div>
                <div style={{ display: "inline-flex", gap: 6 }}>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 6 }}>
                    <input type="checkbox" checked={selectedIds.includes(q.id)} onChange={(e) => toggleSelectOne(q.id, e.target.checked)} />
                    选择
                  </label>
                  <button type="button" className="btn-ghost" onClick={() => openEdit(q)}>
                    编辑
                  </button>
                  <button type="button" className="btn-ghost" style={{ color: "var(--danger, #c00)" }} onClick={() => deleteQuestion(q.id)}>
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 140 }}
          onClick={() => !saving && setEditing(null)}
        >
          <div className="card" style={{ width: "min(900px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>编辑习题</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>题型</span>
                <input value={questionTypeLabel[editing.question_type] || editing.question_type} readOnly style={{ width: "100%", background: "var(--bg-muted)" }} />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>难度</span>
                <select value={form.difficulty} onChange={(e) => setForm((f) => ({ ...f, difficulty: e.target.value }))} style={{ width: "100%" }}>
                  <option value="basic">基础</option>
                  <option value="applied">应用</option>
                  <option value="extended">拓展</option>
                </select>
              </label>
            </div>
            <label style={{ display: "block", marginTop: 10 }}>
              <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>题干</span>
              <textarea rows={4} value={form.question_text} onChange={(e) => setForm((f) => ({ ...f, question_text: e.target.value }))} style={{ width: "100%" }} />
            </label>
            {(editing.question_type === "single_choice" || editing.question_type === "multiple_choice") && (
              <div style={{ marginTop: 10 }}>
                <div style={{ marginBottom: 4, fontSize: 14 }}>选项</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {["A", "B", "C", "D"].map((letter, idx) => (
                    <label key={letter}>
                      <span style={{ display: "block", marginBottom: 4, fontSize: 13 }}>{letter} 选项</span>
                      <input
                        value={form.options[idx] || ""}
                        onChange={(e) =>
                          setForm((f) => {
                            const next = [...f.options];
                            next[idx] = e.target.value;
                            return { ...f, options: next };
                          })
                        }
                        style={{ width: "100%" }}
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
            {editing.question_type === "judge" && (
              <div style={{ marginTop: 10, color: "var(--text-muted)", fontSize: 14 }}>判断题选项固定为：A. 正确 / B. 错误</div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>答案</span>
                <input value={form.correct_answer} onChange={(e) => setForm((f) => ({ ...f, correct_answer: e.target.value }))} style={{ width: "100%" }} />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>解析</span>
                <input value={form.explanation} onChange={(e) => setForm((f) => ({ ...f, explanation: e.target.value }))} style={{ width: "100%" }} />
              </label>
            </div>
            <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn-ghost" onClick={() => setEditing(null)} disabled={saving}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={submitEdit} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
