import { useState, useEffect } from "react";
import { api } from "../../api/client";

export default function Preview({ courseId }: { courseId?: number | null }) {
  const embeddedCourseId = courseId ?? null;
  const [chapters, setChapters] = useState<{ id: number; title: string }[]>([]);
  const [courses, setCourses] = useState<{ id: number; name: string }[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<number | null>(embeddedCourseId);
  const [selected, setSelected] = useState<number | null>(null);
  const [task, setTask] = useState<{
    chapter_id: number;
    chapter_title: string;
    summary: string;
    learning_goals: string[];
    materials: { pdf_ready: boolean; pdf_count: number; video_ready: boolean; video_url: string | null };
    pdf_materials: { id: number; title: string; file_name: string | null }[];
    video_materials: { id: number; title: string; file_name: string | null }[];
    preview_questions: { id: number; question_type: string | null; question_text: string; options: string | null }[];
    duration_minutes: number;
  } | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [materialsReady, setMaterialsReady] = useState(false);
  const [checkingPaper, setCheckingPaper] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [results, setResults] = useState<Record<number, { answer_record_id: number; is_correct: boolean; correct_answer: string; explanation: string | null }>>({});

  useEffect(() => {
    if (embeddedCourseId != null) {
      setSelectedCourseId(embeddedCourseId);
      setCourses([]);
      return;
    }
    api.courses.list()
      .then((list) => {
        const next = list.map((c) => ({ id: c.id, name: c.name }));
        setCourses(next);
        setSelectedCourseId((prev) => (prev && next.some((c) => c.id === prev) ? prev : next[0]?.id ?? null));
      })
      .catch(() => {
        setCourses([]);
        setSelectedCourseId(null);
      });
  }, [embeddedCourseId]);

  useEffect(() => {
    if (selectedCourseId == null) {
      setChapters([]);
      setSelected(null);
      setTask(null);
      return;
    }
    api.chapters.list({ course_id: selectedCourseId }).then((list) => {
      setChapters(list);
      if (list.length) {
        setSelected((prev) => (prev && list.some((c) => c.id === prev) ? prev : list[0].id));
      } else {
        setSelected(null);
        setTask(null);
      }
    });
  }, [selectedCourseId]);

  useEffect(() => {
    if (selected == null) return;
    api.preview.task(selected).then(setTask);
    setSubmitted(false);
    setAnswers({});
    setResults({});
    setMaterialsReady(false);
  }, [selected]);

  const handleSubmit = () => {
    if (selected == null) return;
    api.preview.submit(selected).then(() => setSubmitted(true));
  };

  const submitPreviewPaper = async () => {
    if (!task || checkingPaper) return;
    setCheckingPaper(true);
    try {
      const nextResults: Record<number, { answer_record_id: number; is_correct: boolean; correct_answer: string; explanation: string | null }> = { ...results };
      for (const q of task.preview_questions) {
        const answer = (answers[q.id] || "").trim();
        if (!answer) continue;
        if (!nextResults[q.id]) {
          const res = await api.questions.submit(q.id, answer, "preview");
          nextResults[q.id] = res;
        }
      }
      setResults(nextResults);
    } finally {
      setCheckingPaper(false);
    }
  };

  const parseOptions = (options: string | null): string[] => {
    if (!options) return [];
    try {
      return JSON.parse(options) as string[];
    } catch {
      return [];
    }
  };

  const openMaterial = async (materialId: number, fileName: string | null, viewInline = false) => {
    try {
      const blob = await api.preview.materialFile(materialId);
      const url = URL.createObjectURL(blob);
      if (viewInline) window.open(url, "_blank", "noopener,noreferrer");
      else {
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName || `material-${materialId}`;
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      alert("材料打开失败");
    }
  };

  const getPickedMulti = (questionId: number): string[] =>
    (answers[questionId] || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  const toggleMultiAnswer = (questionId: number, letter: string) => {
    const picked = new Set(getPickedMulti(questionId));
    if (picked.has(letter)) picked.delete(letter);
    else picked.add(letter);
    setAnswers((prev) => ({ ...prev, [questionId]: Array.from(picked).sort().join(",") }));
  };

  const allAnswered = !!task && task.preview_questions.every((q) => (answers[q.id] || "").trim().length > 0);
  const allChecked = !!task && task.preview_questions.every((q) => !!results[q.id]);
  const canCompletePreview = !!task && materialsReady && (task.preview_questions.length === 0 || allChecked);

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>
        课前预习
      </h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 20, fontSize: 15 }}>
        先选择课程，再选择章节获取预习任务（约 10–15 分钟）
      </p>
      {embeddedCourseId == null && (
        <div style={{ marginBottom: 12 }}>
          <select
            value={selectedCourseId ?? ""}
            onChange={(e) => setSelectedCourseId(e.target.value ? Number(e.target.value) : null)}
            style={{ padding: "10px 14px", minWidth: 280 }}
          >
            <option value="">请选择课程</option>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <select
        value={selected ?? ""}
        onChange={(e) => setSelected(Number(e.target.value))}
        disabled={selectedCourseId == null}
        style={{ padding: "10px 14px", marginBottom: 24, minWidth: 280 }}
      >
        {selectedCourseId == null && <option value="">请先选择课程</option>}
        {chapters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>
      {selectedCourseId == null && (
        <p style={{ color: "var(--text-muted)", marginBottom: 16 }}>你当前没有可用课程，请先加入班级或联系教师分配开课。</p>
      )}
      {task && (
        <div className="card">
          <h2 style={{ marginTop: 0, marginBottom: 16, fontSize: 18, fontWeight: 600 }}>
            {task.chapter_title}
          </h2>
          <p style={{ marginBottom: 12 }}>
            <strong>概览：</strong>
            {task.summary}
          </p>
          <p style={{ marginBottom: 16, color: "var(--text-secondary)" }}>
            <strong>预计时间：</strong>
            {task.duration_minutes} 分钟
          </p>
          <h4 style={{ marginBottom: 8, fontSize: 15, fontWeight: 600 }}>
            学习目标（本节要会什么）
          </h4>
          <ul style={{ marginBottom: 16, paddingLeft: 20 }}>
            {task.learning_goals.map((p, i) => (
              <li key={i} style={{ marginBottom: 4 }}>{p}</li>
            ))}
          </ul>
          <h4 style={{ marginBottom: 8, fontSize: 15, fontWeight: 600 }}>预习材料（先学习资料，再做题）</h4>
          <div className="material-block">
            <p style={{ margin: "0 0 8px", fontWeight: 600 }}>讲义 PDF：{task.materials.pdf_ready ? "可查看/下载" : "未上传"}</p>
          {task.pdf_materials.length > 0 && (
            <ul className="material-list">
              {task.pdf_materials.map((item) => (
                <li key={item.id} className="material-item">
                  <div className="material-file">
                    <span className="material-tag">PDF讲义</span>
                    {item.file_name || item.title}
                  </div>
                  <div className="material-actions">
                    <button type="button" className="btn-material-open" onClick={() => openMaterial(item.id, item.file_name, true)}>
                      查看
                    </button>
                    <button type="button" className="btn-material-download" onClick={() => openMaterial(item.id, item.file_name)}>
                      下载
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          </div>
          <div className="material-block">
          <p style={{ margin: "0 0 8px", fontWeight: 600 }}>
            章节视频：{task.materials.video_ready || task.materials.video_url ? "可观看" : "未上传（需按章节补齐）"}
          </p>
          {task.materials.video_url && (
            <p style={{ margin: "0 0 8px" }}>
              <a href={task.materials.video_url} target="_blank" rel="noreferrer">外部视频链接</a>
            </p>
          )}
          {task.video_materials.length > 0 && (
            <ul className="material-list">
              {task.video_materials.map((item) => (
                <li key={item.id} className="material-item">
                  <div className="material-file">
                    <span className="material-tag">教学视频</span>
                    {item.file_name || item.title}
                  </div>
                  <div className="material-actions">
                    <button type="button" className="btn-material-open" onClick={() => openMaterial(item.id, item.file_name, true)}>
                      观看
                    </button>
                    <button type="button" className="btn-material-download" onClick={() => openMaterial(item.id, item.file_name)}>
                      下载
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          </div>
          {!materialsReady ? (
            <button type="button" className="btn-secondary" onClick={() => setMaterialsReady(true)} style={{ marginBottom: 16 }}>
              我已完成资料学习，开始做题
            </button>
          ) : (
            <p style={{ color: "var(--success)", marginBottom: 16 }}>已进入预习做题阶段。</p>
          )}
          {materialsReady && <h4 style={{ marginBottom: 8, fontSize: 15, fontWeight: 600 }}>预习单（5-8道基础题：判断+选择）</h4>}
          {materialsReady && task.preview_questions.length === 0 && (
            <p style={{ color: "var(--text-muted)", marginBottom: 20 }}>当前章节暂无符合规则的预习题，请联系教师先生成题库。</p>
          )}
          {materialsReady &&
            task.preview_questions.map((q, idx) => {
              const qResult = results[q.id];
              const qOptions = parseOptions(q.options);
              const isMultiChoice = (q.question_type || "") === "multiple_choice";
              const pickedMulti = getPickedMulti(q.id);
              return (
                <div key={q.id} style={{ marginBottom: 20, padding: 14, border: "1px solid var(--border)", borderRadius: 8 }}>
                  <p style={{ margin: "0 0 10px", fontWeight: 500 }}>
                    {idx + 1}. {q.question_text}
                  </p>
                  {qOptions.length > 0 ? (
                    <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
                      {qOptions.map((opt, i) => (
                        <label key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          {isMultiChoice ? (
                            <input
                              type="checkbox"
                              checked={pickedMulti.includes(opt.slice(0, 1))}
                              disabled={allChecked}
                              onChange={() => toggleMultiAnswer(q.id, opt.slice(0, 1))}
                            />
                          ) : (
                            <input
                              type="radio"
                              name={`preview-q-${q.id}`}
                              value={opt.slice(0, 1)}
                              checked={(answers[q.id] || "") === opt.slice(0, 1)}
                              disabled={allChecked}
                              onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                            />
                          )}
                          {opt}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <input
                      type="text"
                      placeholder="输入答案"
                      value={answers[q.id] || ""}
                      disabled={allChecked}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                      style={{ marginBottom: 10, maxWidth: 300 }}
                    />
                  )}
                  {!qResult ? (
                    <p style={{ margin: 0, color: "var(--text-muted)" }}>完成全部题目后统一提交批改。</p>
                  ) : (
                    <div>
                      <p style={{ color: qResult.is_correct ? "var(--success)" : "var(--error)", margin: "0 0 6px" }}>
                        {qResult.is_correct ? "回答正确" : `回答错误，正确答案：${qResult.correct_answer}`}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          {materialsReady && !submitted && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" className="btn-secondary" onClick={submitPreviewPaper} disabled={task.preview_questions.length === 0 || !allAnswered || checkingPaper || allChecked}>
                {checkingPaper ? "批改中…" : allChecked ? "预习单已批改" : "提交并批改预习单"}
              </button>
              <button type="button" className="btn-primary" onClick={handleSubmit} disabled={!canCompletePreview}>
                完成预习并提交
              </button>
              {!allAnswered && task.preview_questions.length > 0 && (
                <span style={{ color: "var(--text-muted)", fontSize: 13 }}>请先完成全部题目</span>
              )}
            </div>
          )}
          {submitted && (
            <p style={{ color: "var(--success)" }}>
              已记录预习完成，错题已进入错题本。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
