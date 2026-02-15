import React, { useState, useEffect } from "react";
import { api } from "../../api/client";

type CourseItem = { id: number; name: string; code: string | null; description: string | null; is_active: boolean; created_at: string | null };
type ChapterItem = { id: number; course_id: number | null; title: string; order_index: number; syllabus_ref: string | null };

export default function AdminCourses() {
  const [list, setList] = useState<CourseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", code: "", description: "", is_active: true });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [expandCourseId, setExpandCourseId] = useState<number | null>(null);
  const [chapters, setChapters] = useState<ChapterItem[]>([]);
  const [chapterForm, setChapterForm] = useState({ title: "", order_index: 0, syllabus_ref: "" });
  const [reindexingId, setReindexingId] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    api.admin.courses.list().then(setList).catch(() => setList([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (expandCourseId == null) { setChapters([]); return; }
    api.admin.courses.chapters(expandCourseId).then(setChapters).catch(() => setChapters([]));
  }, [expandCourseId]);

  const openCreate = () => {
    setForm({ name: "", code: "", description: "", is_active: true });
    setModal("create");
    setError("");
  };
  const openEdit = (c: CourseItem) => {
    setEditId(c.id);
    setForm({ name: c.name, code: c.code || "", description: c.description || "", is_active: c.is_active });
    setModal("edit");
    setError("");
  };
  const submitCreate = () => {
    setSaving(true);
    setError("");
    api.admin.courses.create({
      name: form.name.trim(),
      code: form.code.trim() || undefined,
      description: form.description.trim() || undefined,
      is_active: form.is_active,
    })
      .then(() => { setModal(null); load(); })
      .catch((e) => setError(e?.message || "创建失败"))
      .finally(() => setSaving(false));
  };
  const submitEdit = () => {
    if (editId == null) return;
    setSaving(true);
    setError("");
    api.admin.courses.update(editId, {
      name: form.name.trim(),
      code: form.code.trim() || undefined,
      description: form.description.trim() || undefined,
      is_active: form.is_active,
    })
      .then(() => { setModal(null); setEditId(null); load(); })
      .catch((e) => setError(e?.message || "保存失败"))
      .finally(() => setSaving(false));
  };
  const doDelete = (id: number) => {
    if (!confirm("确定删除该课程？")) return;
    api.admin.courses.delete(id).then(() => load()).catch((e) => alert(e?.message || "删除失败"));
  };

  const addChapter = () => {
    if (expandCourseId == null) return;
    api.admin.courses.createChapter(expandCourseId, {
      title: chapterForm.title.trim(),
      order_index: chapterForm.order_index,
      syllabus_ref: chapterForm.syllabus_ref.trim() || undefined,
    }).then(() => {
      setChapterForm({ title: "", order_index: chapters.length + 1, syllabus_ref: "" });
      api.admin.courses.chapters(expandCourseId!).then(setChapters);
    }).catch((e) => alert(e?.message || "添加失败"));
  };
  const deleteChapter = (chapterId: number) => {
    if (!confirm("确定删除该章节？")) return;
    api.admin.courses.deleteChapter(chapterId).then(() => expandCourseId != null && api.admin.courses.chapters(expandCourseId).then(setChapters)).catch((e) => alert(e?.message || "删除失败"));
  };

  const doReindex = (courseId: number, courseName: string) => {
    if (!confirm(`确定为「${courseName}」重建 RAG 向量索引？将根据当前知识库文档、知识点与 PPT 重新建索引。`)) return;
    setReindexingId(courseId);
    api.admin.courses
      .reindex(courseId)
      .then((r) => alert(`索引完成，共 ${r.chunks_indexed} 个切片。`))
      .catch((e) => alert(e?.message || "重建索引失败"))
      .finally(() => setReindexingId(null));
  };

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>课程管理</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 20, fontSize: 15 }}>课程与章节</p>
      <div style={{ marginBottom: 20 }}>
        <button type="button" className="btn-primary" onClick={openCreate}>新建课程</button>
      </div>
      {loading ? <p style={{ color: "var(--text-muted)" }}>加载中…</p> : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>ID</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>名称</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>代码</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>状态</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <React.Fragment key={c.id}>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "10px 12px" }}>{c.id}</td>
                    <td style={{ padding: "10px 12px" }}>{c.name}</td>
                    <td style={{ padding: "10px 12px" }}>{c.code || "—"}</td>
                    <td style={{ padding: "10px 12px" }}>{c.is_active ? "启用" : "停用"}</td>
                    <td style={{ padding: "10px 12px" }}>
                      <button type="button" className="btn-ghost" style={{ marginRight: 8 }} onClick={() => openEdit(c)}>编辑</button>
                      <button type="button" className="btn-ghost" style={{ marginRight: 8 }} onClick={() => setExpandCourseId(expandCourseId === c.id ? null : c.id)}>
                        {expandCourseId === c.id ? "收起章节" : "章节"}
                      </button>
                      <button type="button" className="btn-ghost" style={{ marginRight: 8 }} onClick={() => doReindex(c.id, c.name)} disabled={reindexingId !== null}>
                        {reindexingId === c.id ? "索引中…" : "重建索引"}
                      </button>
                      <button type="button" className="btn-ghost" style={{ color: "var(--danger, #c00)" }} onClick={() => doDelete(c.id)}>删除</button>
                    </td>
                  </tr>
                  {expandCourseId === c.id && (
                    <tr key={`${c.id}-ch`}>
                      <td colSpan={5} style={{ padding: "12px 24px", background: "var(--bg-muted)", borderBottom: "1px solid var(--border)" }}>
                        <div style={{ marginBottom: 12, fontWeight: 600 }}>章节列表</div>
                        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                          <input type="text" placeholder="章节标题" value={chapterForm.title} onChange={(e) => setChapterForm((f) => ({ ...f, title: e.target.value }))} style={{ padding: "6px 10px", width: 200, border: "1px solid var(--border)", borderRadius: 6 }} />
                          <input type="number" placeholder="排序" value={chapterForm.order_index} onChange={(e) => setChapterForm((f) => ({ ...f, order_index: parseInt(e.target.value, 10) || 0 }))} style={{ padding: "6px 10px", width: 70, border: "1px solid var(--border)", borderRadius: 6 }} />
                          <button type="button" className="btn-primary" onClick={addChapter}>添加章节</button>
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 20 }}>
                          {chapters.map((ch) => (
                            <li key={ch.id} style={{ marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <span>{ch.title}（排序 {ch.order_index}）</span>
                              <button type="button" className="btn-ghost" style={{ color: "var(--danger, #c00)", fontSize: 13 }} onClick={() => deleteChapter(ch.id)}>删除</button>
                            </li>
                          ))}
                          {chapters.length === 0 && <li style={{ color: "var(--text-muted)" }}>暂无章节</li>}
                        </ul>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={() => !saving && setModal(null)}>
          <div className="card" style={{ minWidth: 360 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 16 }}>{modal === "create" ? "新建课程" : "编辑课程"}</h3>
            {error && <p style={{ color: "var(--danger, #c00)", marginBottom: 12, fontSize: 14 }}>{error}</p>}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>名称</span>
                <input type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }} />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>代码（可选）</span>
                <input type="text" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }} />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>简介（可选）</span>
                <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))} />
                <span style={{ fontSize: 14 }}>启用</span>
              </label>
            </div>
            <div style={{ marginTop: 20, display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="btn-ghost" onClick={() => setModal(null)} disabled={saving}>取消</button>
              <button type="button" className="btn-primary" onClick={modal === "create" ? submitCreate : submitEdit} disabled={saving}>{saving ? "保存中…" : "保存"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
