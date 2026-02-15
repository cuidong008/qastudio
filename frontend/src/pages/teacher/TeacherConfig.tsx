import { useState, useEffect } from "react";
import { api } from "../../api/client";

type ChapterConfigItem = {
  chapter_id: number;
  title: string;
  preview_enabled: boolean;
  difficulty_filter: string[];
  question_limit: number | null;
};

const DIFFICULTY_OPTIONS = [
  { value: "basic", label: "基础" },
  { value: "applied", label: "应用" },
  { value: "extended", label: "拓展" },
];

export default function TeacherConfig() {
  const [configs, setConfigs] = useState<ChapterConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api.teacher
      .configChapters()
      .then(setConfigs)
      .catch(() => setConfigs([]))
      .finally(() => setLoading(false));
  }, []);

  const updateLocal = (chapterId: number, patch: Partial<ChapterConfigItem>) => {
    setConfigs((prev) =>
      prev.map((c) => (c.chapter_id === chapterId ? { ...c, ...patch } : c))
    );
  };

  const save = async (c: ChapterConfigItem) => {
    setSavingId(c.chapter_id);
    setMessage(null);
    try {
      await api.teacher.updateChapterConfig({
        chapter_id: c.chapter_id,
        preview_enabled: c.preview_enabled,
        difficulty_filter: c.difficulty_filter.length ? c.difficulty_filter : null,
        question_limit: c.question_limit ?? null,
      });
      setMessage("配置已保存");
    } catch (e) {
      setMessage("保存失败，请重试");
    } finally {
      setSavingId(null);
    }
  };

  const toggleDifficulty = (chapterId: number, value: string) => {
    setConfigs((prev) =>
      prev.map((c) => {
        if (c.chapter_id !== chapterId) return c;
        const arr = c.difficulty_filter.includes(value)
          ? c.difficulty_filter.filter((x) => x !== value)
          : [...c.difficulty_filter, value];
        return { ...c, difficulty_filter: arr };
      })
    );
  };

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 200,
          color: "var(--text-muted)",
        }}
      >
        加载配置…
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>
        教学内容配置
      </h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 24, fontSize: 15 }}>
        按章节设置预习开关、习题难度与题量限制；保存后立即生效。
      </p>
      {message && (
        <p
          style={{
            color: message.startsWith("保存") ? "var(--success)" : "var(--error)",
            marginBottom: 20,
            fontSize: 14,
          }}
        >
          {message}
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {configs.map((c) => (
          <div key={c.chapter_id} className="card">
            <h3 style={{ marginTop: 0, marginBottom: 20, fontSize: 17, fontWeight: 600 }}>
              {c.title}
            </h3>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 20,
                alignItems: "center",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  cursor: "pointer",
                  color: "var(--text-secondary)",
                }}
              >
                <input
                  type="checkbox"
                  checked={c.preview_enabled}
                  onChange={(e) => updateLocal(c.chapter_id, { preview_enabled: e.target.checked })}
                />
                开放预习
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>
                  习题难度：
                </span>
                {DIFFICULTY_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: "pointer",
                      color: "var(--text-secondary)",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={c.difficulty_filter.includes(opt.value)}
                      onChange={() => toggleDifficulty(c.chapter_id, opt.value)}
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ color: "var(--text-secondary)", fontSize: 14 }}>
                  题量上限：
                </label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={c.question_limit ?? ""}
                  onChange={(e) =>
                    updateLocal(c.chapter_id, {
                      question_limit: e.target.value ? parseInt(e.target.value, 10) : null,
                    })
                  }
                  style={{ width: 72, padding: "8px 12px" }}
                />
              </div>
              <button
                type="button"
                className="btn-primary"
                onClick={() => save(c)}
                disabled={savingId === c.chapter_id}
              >
                {savingId === c.chapter_id ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        ))}
      </div>
      {configs.length === 0 && (
        <p style={{ color: "var(--text-muted)" }}>暂无章节配置</p>
      )}
    </div>
  );
}
