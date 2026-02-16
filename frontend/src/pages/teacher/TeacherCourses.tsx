import React, { useEffect, useState } from "react";
import { api } from "../../api/client";

type CourseItem = {
  id: number;
  name: string;
  code: string | null;
  description: string | null;
  is_active: boolean;
  created_at: string | null;
};

type ChapterItem = {
  id: number;
  course_id: number | null;
  title: string;
  order_index: number;
  syllabus_ref: string | null;
};

type ChapterDocItem = {
  id: number;
  chapter_id: number | null;
  source_type: string;
  title: string;
  page_ref: string | null;
  file_name: string | null;
  file_size: number | null;
  parse_status: string | null;
  parse_error: string | null;
  chunk_count: number | null;
  created_at: string | null;
};

type ChapterDocDetail = ChapterDocItem & {
  content_preview: string;
  chunks: { index: number; text: string }[];
};

export default function TeacherCourses() {
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
  const [newChapterPdf, setNewChapterPdf] = useState<File | null>(null);
  const [addingChapter, setAddingChapter] = useState(false);
  const [chapterEditModal, setChapterEditModal] = useState(false);
  const [editingChapterId, setEditingChapterId] = useState<number | null>(null);
  const [chapterEditForm, setChapterEditForm] = useState({ title: "", order_index: 0, syllabus_ref: "" });
  const [chapterSaving, setChapterSaving] = useState(false);
  const [docsModalChapter, setDocsModalChapter] = useState<ChapterItem | null>(null);
  const [chapterDocs, setChapterDocs] = useState<ChapterDocItem[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docUploadFile, setDocUploadFile] = useState<File | null>(null);
  const [docUploading, setDocUploading] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState<number | null>(null);
  const [docDetail, setDocDetail] = useState<ChapterDocDetail | null>(null);
  const [docDetailLoading, setDocDetailLoading] = useState(false);
  const [reindexingId, setReindexingId] = useState<number | null>(null);
  const [clearingId, setClearingId] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    api.teacher.courses.list().then(setList).catch(() => setList([])).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (expandCourseId == null) {
      setChapters([]);
      return;
    }
    api.teacher.courses.chapters(expandCourseId).then(setChapters).catch(() => setChapters([]));
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
    api.teacher.courses
      .create({
        name: form.name.trim(),
        code: form.code.trim() || undefined,
        description: form.description.trim() || undefined,
        is_active: form.is_active,
      })
      .then(() => {
        setModal(null);
        load();
      })
      .catch((e) => setError(e?.message || "创建失败"))
      .finally(() => setSaving(false));
  };

  const submitEdit = () => {
    if (editId == null) return;
    setSaving(true);
    setError("");
    api.teacher.courses
      .update(editId, {
        name: form.name.trim(),
        code: form.code.trim() || undefined,
        description: form.description.trim() || undefined,
        is_active: form.is_active,
      })
      .then(() => {
        setModal(null);
        setEditId(null);
        load();
      })
      .catch((e) => setError(e?.message || "保存失败"))
      .finally(() => setSaving(false));
  };

  const doDelete = (id: number) => {
    if (!confirm("确定删除该课程？")) return;
    api.teacher.courses.delete(id).then(load).catch((e) => alert(e?.message || "删除失败"));
  };

  const addChapter = () => {
    if (expandCourseId == null) return;
    if (!chapterForm.title.trim()) {
      alert("请填写章节标题");
      return;
    }
    setAddingChapter(true);
    api.teacher.courses
      .createChapter(expandCourseId, {
        title: chapterForm.title.trim(),
        order_index: chapterForm.order_index,
        syllabus_ref: chapterForm.syllabus_ref.trim() || undefined,
      })
      .then(async (chapter) => {
        if (newChapterPdf) {
          await api.teacher.courses.uploadChapterDocument(chapter.id, newChapterPdf);
        }
        setChapterForm({ title: "", order_index: chapters.length + 1, syllabus_ref: "" });
        setNewChapterPdf(null);
        return api.teacher.courses.chapters(expandCourseId!);
      })
      .then(setChapters)
      .catch((e) => alert(e?.message || "添加失败"))
      .finally(() => setAddingChapter(false));
  };

  const deleteChapter = (chapterId: number) => {
    if (!confirm("确定删除该章节？")) return;
    api.teacher.courses
      .deleteChapter(chapterId)
      .then(() => {
        if (expandCourseId != null) {
          return api.teacher.courses.chapters(expandCourseId).then(setChapters);
        }
      })
      .catch((e) => alert(e?.message || "删除失败"));
  };

  const openEditChapter = (ch: ChapterItem) => {
    setEditingChapterId(ch.id);
    setChapterEditForm({
      title: ch.title,
      order_index: ch.order_index,
      syllabus_ref: ch.syllabus_ref || "",
    });
    setChapterEditModal(true);
  };

  const submitEditChapter = () => {
    if (editingChapterId == null || expandCourseId == null) return;
    setChapterSaving(true);
    api.teacher.courses
      .updateChapter(editingChapterId, {
        title: chapterEditForm.title.trim(),
        order_index: chapterEditForm.order_index,
        syllabus_ref: chapterEditForm.syllabus_ref.trim() || undefined,
      })
      .then(() => api.teacher.courses.chapters(expandCourseId))
      .then((rows) => {
        setChapters(rows);
        setChapterEditModal(false);
        setEditingChapterId(null);
      })
      .catch((e) => alert(e?.message || "修改章节失败"))
      .finally(() => setChapterSaving(false));
  };

  const doReindex = (courseId: number, courseName: string) => {
    if (!confirm(`确定为「${courseName}」重建 RAG 向量索引？`)) return;
    setReindexingId(courseId);
    api.teacher.courses
      .reindex(courseId)
      .then((r) => alert(`索引完成，共 ${r.chunks_indexed} 个切片。`))
      .catch((e) => alert(e?.message || "重建索引失败"))
      .finally(() => setReindexingId(null));
  };

  const doClearKnowledge = (courseId: number, courseName: string) => {
    if (!confirm(`确定清空「${courseName}」知识库？将删除该课程下全部章节文档、知识点、PPT 解析结果。`)) return;
    setClearingId(courseId);
    api.teacher.courses
      .clearKnowledge(courseId)
      .then((r) =>
        alert(
          `清理完成：文档 ${r.stats.knowledge_documents}、知识点 ${r.stats.knowledge_points}、PPT ${r.stats.ppt_files}、PPT页 ${r.stats.ppt_slides}、文件 ${r.stats.deleted_files}；索引剩余 ${r.chunks_indexed} 个切片。`
        )
      )
      .catch((e) => alert(e?.message || "一键清理失败"))
      .finally(() => setClearingId(null));
  };

  const loadChapterDocuments = (chapterId: number) => {
    setDocsLoading(true);
    api.teacher.courses
      .chapterDocuments(chapterId)
      .then((rows) => setChapterDocs(rows))
      .catch(() => setChapterDocs([]))
      .finally(() => setDocsLoading(false));
  };

  const openDocsModal = (ch: ChapterItem) => {
    setDocsModalChapter(ch);
    setDocUploadFile(null);
    setSelectedDocId(null);
    setDocDetail(null);
    loadChapterDocuments(ch.id);
  };

  const uploadDocumentToChapter = () => {
    if (!docsModalChapter || !docUploadFile) {
      alert("请选择 PDF 文件");
      return;
    }
    setDocUploading(true);
    api.teacher.courses
      .uploadChapterDocument(docsModalChapter.id, docUploadFile)
      .then((doc) => {
        setDocUploadFile(null);
        loadChapterDocuments(docsModalChapter.id);
        setSelectedDocId(doc.id);
        return api.teacher.courses.documentDetail(doc.id);
      })
      .then(setDocDetail)
      .catch((e) => alert(e?.message || "上传失败"))
      .finally(() => setDocUploading(false));
  };

  const openDocDetail = (docId: number) => {
    setSelectedDocId(docId);
    setDocDetailLoading(true);
    api.teacher.courses
      .documentDetail(docId)
      .then(setDocDetail)
      .catch(() => setDocDetail(null))
      .finally(() => setDocDetailLoading(false));
  };

  const openDocFile = async (docId: number) => {
    try {
      const token = localStorage.getItem("token");
      const res = await fetch(api.teacher.courses.documentFileUrl(docId), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error("文件读取失败");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      alert("打开文档失败");
    }
  };

  const formatFileSize = (bytes: number | null) => {
    if (!bytes || bytes <= 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>我的课程</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 20, fontSize: 15 }}>由你创建与维护的课程与章节</p>
      <div style={{ marginBottom: 20 }}>
        <button type="button" className="btn-primary" onClick={openCreate}>
          新建课程
        </button>
      </div>
      {loading ? (
        <p style={{ color: "var(--text-muted)" }}>加载中…</p>
      ) : (
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
                      <button type="button" className="btn-ghost" style={{ marginRight: 8 }} onClick={() => openEdit(c)}>
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ marginRight: 8 }}
                        onClick={() => setExpandCourseId(expandCourseId === c.id ? null : c.id)}
                      >
                        {expandCourseId === c.id ? "收起章节" : "章节"}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ marginRight: 8 }}
                        onClick={() => doReindex(c.id, c.name)}
                        disabled={reindexingId !== null || clearingId !== null}
                      >
                        {reindexingId === c.id ? "索引中…" : "重建索引"}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ marginRight: 8, color: "var(--danger, #c00)" }}
                        onClick={() => doClearKnowledge(c.id, c.name)}
                        disabled={reindexingId !== null || clearingId !== null}
                      >
                        {clearingId === c.id ? "清理中…" : "一键清理"}
                      </button>
                      <button type="button" className="btn-ghost" style={{ color: "var(--danger, #c00)" }} onClick={() => doDelete(c.id)}>
                        删除
                      </button>
                    </td>
                  </tr>
                  {expandCourseId === c.id && (
                    <tr>
                      <td colSpan={5} style={{ padding: "12px 24px", background: "var(--bg-muted)", borderBottom: "1px solid var(--border)" }}>
                        <div style={{ marginBottom: 12, fontWeight: 600 }}>章节列表</div>
                        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                          <input
                            type="text"
                            placeholder="章节标题"
                            value={chapterForm.title}
                            onChange={(e) => setChapterForm((f) => ({ ...f, title: e.target.value }))}
                            style={{ padding: "6px 10px", width: 220 }}
                          />
                          <input
                            type="number"
                            placeholder="排序"
                            value={chapterForm.order_index}
                            onChange={(e) => setChapterForm((f) => ({ ...f, order_index: parseInt(e.target.value, 10) || 0 }))}
                            style={{ padding: "6px 10px", width: 80 }}
                          />
                          <input
                            type="file"
                            accept="application/pdf,.pdf"
                            onChange={(e) => setNewChapterPdf(e.target.files?.[0] || null)}
                            style={{ maxWidth: 240 }}
                          />
                          <button type="button" className="btn-primary" onClick={addChapter} disabled={addingChapter}>
                            {addingChapter ? "处理中…" : "添加章节"}
                          </button>
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 20 }}>
                          {chapters.map((ch) => (
                            <li key={ch.id} style={{ marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <span>{ch.title}（排序 {ch.order_index}）</span>
                              <span style={{ display: "inline-flex", gap: 6 }}>
                                <button type="button" className="btn-ghost" style={{ fontSize: 13 }} onClick={() => openDocsModal(ch)}>
                                  文档
                                </button>
                                <button type="button" className="btn-ghost" style={{ fontSize: 13 }} onClick={() => openEditChapter(ch)}>
                                  编辑
                                </button>
                                <button type="button" className="btn-ghost" style={{ color: "var(--danger, #c00)", fontSize: 13 }} onClick={() => deleteChapter(ch.id)}>
                                  删除
                                </button>
                              </span>
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
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
          onClick={() => !saving && setModal(null)}
        >
          <div className="card" style={{ minWidth: 360 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 16 }}>{modal === "create" ? "新建课程" : "编辑课程"}</h3>
            {error && <p style={{ color: "var(--danger, #c00)", marginBottom: 12, fontSize: 14 }}>{error}</p>}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>名称</span>
                <input type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} style={{ width: "100%" }} />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>代码（可选）</span>
                <input type="text" value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} style={{ width: "100%" }} />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>简介（可选）</span>
                <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={3} style={{ width: "100%" }} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))} />
                <span style={{ fontSize: 14 }}>启用</span>
              </label>
            </div>
            <div style={{ marginTop: 20, display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="btn-ghost" onClick={() => setModal(null)} disabled={saving}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={modal === "create" ? submitCreate : submitEdit} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {docsModalChapter && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 115 }}
          onClick={() => !docUploading && setDocsModalChapter(null)}
        >
          <div className="card" style={{ width: "min(1200px, 95vw)", height: "min(82vh, 900px)", display: "grid", gridTemplateColumns: "360px 1fr", gap: 12 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ borderRight: "1px solid var(--border)", paddingRight: 12, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <h3 style={{ margin: 0, marginBottom: 8 }}>{docsModalChapter.title} · 章节文档</h3>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                <input type="file" accept="application/pdf,.pdf" onChange={(e) => setDocUploadFile(e.target.files?.[0] || null)} style={{ flex: 1 }} />
                <button type="button" className="btn-primary" onClick={uploadDocumentToChapter} disabled={docUploading || !docUploadFile}>
                  {docUploading ? "上传中…" : "上传"}
                </button>
              </div>
              <div style={{ overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8, flex: 1 }}>
                {docsLoading && <p style={{ color: "var(--text-muted)" }}>加载中…</p>}
                {!docsLoading && chapterDocs.length === 0 && <p style={{ color: "var(--text-muted)" }}>暂无文档</p>}
                {!docsLoading &&
                  chapterDocs.map((doc) => (
                    <button
                      key={doc.id}
                      type="button"
                      onClick={() => openDocDetail(doc.id)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        border: selectedDocId === doc.id ? "1px solid var(--primary)" : "1px solid var(--border)",
                        background: selectedDocId === doc.id ? "rgba(59,130,246,0.08)" : "transparent",
                        borderRadius: 8,
                        padding: 8,
                        marginBottom: 8,
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{doc.file_name || doc.title}</div>
                      <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                        状态：{doc.parse_status || "unknown"} · 切片：{doc.chunk_count ?? "—"} · 大小：{formatFileSize(doc.file_size)}
                      </div>
                      {doc.parse_error && <div style={{ color: "var(--danger, #c00)", fontSize: 12, marginTop: 4 }}>{doc.parse_error}</div>}
                    </button>
                  ))}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>文档解析情况</h3>
                <button type="button" className="btn-ghost" onClick={() => setDocsModalChapter(null)} disabled={docUploading}>
                  关闭
                </button>
              </div>
              {docDetailLoading && <p style={{ color: "var(--text-muted)" }}>解析信息加载中…</p>}
              {!docDetailLoading && !docDetail && <p style={{ color: "var(--text-muted)" }}>点击左侧文档查看解析详情</p>}
              {!docDetailLoading && docDetail && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, minHeight: 0, flex: 1 }}>
                  <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, overflowY: "auto" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <strong>{docDetail.file_name || docDetail.title}</strong>
                      <button type="button" className="btn-ghost" onClick={() => openDocFile(docDetail.id)}>
                        查看PDF
                      </button>
                    </div>
                    <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 8 }}>
                      状态：{docDetail.parse_status || "unknown"} · 页数：{docDetail.page_ref || "—"} · 切片：{docDetail.chunk_count ?? "—"}
                    </div>
                    {docDetail.parse_error && <p style={{ color: "var(--danger, #c00)" }}>{docDetail.parse_error}</p>}
                    <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13 }}>{docDetail.content_preview || "暂无解析文本"}</pre>
                  </div>
                  <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, overflowY: "auto" }}>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>切片结果</div>
                    {docDetail.chunks.length === 0 && <p style={{ color: "var(--text-muted)" }}>暂无切片</p>}
                    {docDetail.chunks.map((chunk) => (
                      <div key={chunk.index} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 8, marginBottom: 8 }}>
                        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>Chunk #{chunk.index}</div>
                        <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{chunk.text}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {chapterEditModal && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 }}
          onClick={() => !chapterSaving && setChapterEditModal(false)}
        >
          <div className="card" style={{ minWidth: 360 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 16 }}>编辑章节</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>章节标题</span>
                <input
                  type="text"
                  value={chapterEditForm.title}
                  onChange={(e) => setChapterEditForm((f) => ({ ...f, title: e.target.value }))}
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>排序</span>
                <input
                  type="number"
                  value={chapterEditForm.order_index}
                  onChange={(e) => setChapterEditForm((f) => ({ ...f, order_index: parseInt(e.target.value, 10) || 0 }))}
                  style={{ width: "100%" }}
                />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>教学大纲引用（可选）</span>
                <input
                  type="text"
                  value={chapterEditForm.syllabus_ref}
                  onChange={(e) => setChapterEditForm((f) => ({ ...f, syllabus_ref: e.target.value }))}
                  style={{ width: "100%" }}
                />
              </label>
            </div>
            <div style={{ marginTop: 20, display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="btn-ghost" onClick={() => setChapterEditModal(false)} disabled={chapterSaving}>
                取消
              </button>
              <button type="button" className="btn-primary" onClick={submitEditChapter} disabled={chapterSaving}>
                {chapterSaving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
