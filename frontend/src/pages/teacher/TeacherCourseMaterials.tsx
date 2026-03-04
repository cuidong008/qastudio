import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { toast } from "../../utils/toast";
import type { DocWithChapters } from "../../api/client";

type ChapterItem = {
  id: number;
  course_id: number | null;
  title: string;
  order_index: number;
  syllabus_ref: string | null;
  question_count: number;
};

const ALL_CHAPTERS_VALUE = 0;

export default function TeacherCourseMaterials() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const courseId = Number(searchParams.get("courseId") || 0);
  const courseName = searchParams.get("courseName") || "课程";

  const [chapters, setChapters] = useState<ChapterItem[]>([]);
  const [docs, setDocs] = useState<DocWithChapters[]>([]);
  const [loading, setLoading] = useState(true);
  const [docsLoading, setDocsLoading] = useState(false);
  const [uploadChapterIds, setUploadChapterIds] = useState<number[]>([]);
  const [docUploadFile, setDocUploadFile] = useState<File | null>(null);
  const [videoUploadFile, setVideoUploadFile] = useState<File | null>(null);
  const [docUploading, setDocUploading] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState<number | null>(null);
  const [docDetail, setDocDetail] = useState<(DocWithChapters & { content_preview: string; chunks: { index: number; text: string }[] }) | null>(null);
  const [docDetailLoading, setDocDetailLoading] = useState(false);
  const [docActionId, setDocActionId] = useState<number | null>(null);
  const [errorLogModal, setErrorLogModal] = useState<string | null>(null);
  const [editDocId, setEditDocId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<{
    student_visible: boolean;
    downloadable: boolean;
    chapter_ids: number[];
  }>({ student_visible: true, downloadable: true, chapter_ids: [] });
  const [docTaskByDoc, setDocTaskByDoc] = useState<Record<number, { taskId: number; status: string }>>({});
  const [docTaskErrorByDoc, setDocTaskErrorByDoc] = useState<Record<number, string>>({});

  const loadChapters = () => {
    if (!courseId) return;
    setLoading(true);
    api.teacher.courses
      .chapters(courseId)
      .then((rows) => setChapters(rows))
      .catch(() => setChapters([]))
      .finally(() => setLoading(false));
  };

  const loadCourseDocuments = () => {
    if (!courseId) return;
    setDocsLoading(true);
    api.teacher.courses
      .courseDocuments(courseId)
      .then(setDocs)
      .catch(() => setDocs([]))
      .finally(() => setDocsLoading(false));
  };

  useEffect(() => {
    if (!courseId) {
      setLoading(false);
      return;
    }
    loadChapters();
  }, [courseId]);

  useEffect(() => {
    if (!courseId) return;
    loadCourseDocuments();
  }, [courseId]);

  const formatFileSize = (bytes: number | null) => {
    if (!bytes || bytes <= 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const chapterIdsForUpload = useMemo(() => {
    if (uploadChapterIds.includes(ALL_CHAPTERS_VALUE) || uploadChapterIds.length === 0) return [];
    return uploadChapterIds.filter((id) => id !== ALL_CHAPTERS_VALUE);
  }, [uploadChapterIds]);

  const uploadDocument = () => {
    if (!courseId || !docUploadFile) {
      toast("请选择 PDF 文件", "error");
      return;
    }
    setDocUploading(true);
    api.teacher.courses
      .uploadCourseDocument(courseId, docUploadFile, chapterIdsForUpload)
      .then((doc) => {
        setDocUploadFile(null);
        loadCourseDocuments();
        setSelectedDocId(doc.id);
        return api.teacher.courses.documentDetail(doc.id);
      })
      .then(setDocDetail)
      .catch((e) => toast(e?.message || "上传失败", "error"))
      .finally(() => setDocUploading(false));
  };

  const uploadVideo = () => {
    if (!courseId || !videoUploadFile) {
      toast("请选择视频文件", "error");
      return;
    }
    setDocUploading(true);
    api.teacher.courses
      .uploadCourseVideo(courseId, videoUploadFile, chapterIdsForUpload)
      .then((doc) => {
        setVideoUploadFile(null);
        loadCourseDocuments();
        setSelectedDocId(doc.id);
        return api.teacher.courses.documentDetail(doc.id);
      })
      .then(setDocDetail)
      .catch((e) => toast(e?.message || "视频上传失败", "error"))
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
      toast("打开文档失败", "error");
    }
  };

  const deleteDocument = async (docId: number) => {
    if (!confirm("确定删除该资料吗？")) return;
    setDocActionId(docId);
    try {
      await api.teacher.courses.deleteDocument(docId);
      if (selectedDocId === docId) {
        setSelectedDocId(null);
        setDocDetail(null);
      }
      loadCourseDocuments();
    } catch (e: unknown) {
      toast((e as { message?: string })?.message || "删除失败", "error");
    } finally {
      setDocActionId(null);
    }
  };

  const patchDocument = async (
    docId: number,
    patch: { student_visible?: boolean; downloadable?: boolean; chapter_ids?: number[] }
  ) => {
    try {
      await api.teacher.courses.patchDocument(docId, patch);
      loadCourseDocuments();
      if (selectedDocId === docId && docDetail) {
        setDocDetail({ ...docDetail, ...patch });
      }
      setEditDocId(null);
      toast("已更新");
    } catch (e: unknown) {
      toast((e as { message?: string })?.message || "更新失败", "error");
    }
  };

  const reprocessDocument = async (docId: number) => {
    if (!confirm("将重新识别讲义、重新切片并重建索引，是否继续？")) return;
    const entry = docTaskByDoc[docId];
    if (entry?.status === "pending" || entry?.status === "running") {
      toast("该文档已有处理任务在执行中");
      return;
    }
    try {
      const r = await api.teacher.courses.reprocessDocument(docId);
      setDocTaskByDoc((prev) => ({ ...prev, [docId]: { taskId: r.task_id, status: r.status } }));
      toast("任务已开始，系统将在后台处理。");
      if (selectedDocId === docId && docDetail) {
        setDocDetail({ ...docDetail, parse_status: "processing", parse_error: null });
      }
      loadCourseDocuments();
    } catch (e: unknown) {
      toast((e as { message?: string })?.message || "重新处理失败", "error");
    }
  };

  const formatChapterLabel = (doc: DocWithChapters) => {
    const ids = doc.chapter_ids ?? [];
    if (ids.length === 0) return chapters.length === 0 ? "课程" : "—";
    if (chapters.length > 0 && ids.length >= chapters.length) return "全部";
    return ids
      .map((id) => chapters.find((c) => c.id === id)?.title ?? `#${id}`)
      .join("、");
  };

  if (!courseId) {
    return (
      <div>
        <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>课程资料</h1>
        <p style={{ color: "var(--text-muted)", marginBottom: 16 }}>缺少 courseId 参数。</p>
        <button type="button" className="btn-ghost" onClick={() => navigate("/teacher/courses")}>
          返回课程页
        </button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>{courseName} · 课程资料</h1>
        <button type="button" className="btn-ghost" onClick={() => navigate("/teacher/courses")}>
          返回课程页
        </button>
      </div>
      <p style={{ color: "var(--text-muted)", marginBottom: 16 }}>
        {chapters.length > 0
          ? "选择关联章节后上传；选「全部」表示与整门课程相关。学生预习某章节时，仅显示与该章节关联且学生可见的资料。"
          : "当前课程暂无章节，资料按课程维度管理，解析内容不关联到具体章节。"}
      </p>

      {loading && <p style={{ color: "var(--text-muted)" }}>加载章节中…</p>}
      {!loading && (
        <div className="card" style={{ width: "100%", minHeight: "calc(100vh - 200px)", display: "grid", gridTemplateColumns: "minmax(280px, 38%) 1fr", gap: 12 }}>
          <div style={{ borderRight: "1px solid var(--border)", paddingRight: 12, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 14 }}>
                {chapters.length > 0 ? "上传时关联章节（多选）" : "上传资料（当前无章节，按课程维度）"}
              </div>
              <details>
                <summary
                  style={{
                    listStyle: "none",
                    cursor: "pointer",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: "10px 12px",
                    background: "var(--bg-base)",
                    color: "var(--text-primary)",
                    userSelect: "none",
                  }}
                >
                  {chapters.length === 0
                    ? "按课程维度（当前无章节）"
                    : uploadChapterIds.includes(ALL_CHAPTERS_VALUE)
                      ? "全部章节"
                      : uploadChapterIds.length === 0
                        ? `已选 0 / ${chapters.length} 个章节（点击展开）`
                        : `已选 ${uploadChapterIds.length} / ${chapters.length} 个章节${uploadChapterIds.length > 0 ? "：" + uploadChapterIds.map((id) => chapters.find((c) => c.id === id)?.title ?? `#${id}`).slice(0, 3).join("、") + (uploadChapterIds.length > 3 ? "…" : "") : ""}`}
                </summary>
                <div
                  style={{
                    marginTop: 8,
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: 10,
                    display: "grid",
                    gap: 8,
                    maxHeight: 220,
                    overflowY: "auto",
                    background: "var(--bg-base)",
                  }}
                >
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={uploadChapterIds.includes(ALL_CHAPTERS_VALUE)}
                      onChange={(e) =>
                        setUploadChapterIds((prev) =>
                          e.target.checked ? [ALL_CHAPTERS_VALUE] : prev.filter((id) => id !== ALL_CHAPTERS_VALUE)
                        )
                      }
                    />
                    全部章节
                  </label>
                  {chapters.map((ch) => (
                    <label key={ch.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 14, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={uploadChapterIds.includes(ch.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setUploadChapterIds((prev) => (prev.includes(ALL_CHAPTERS_VALUE) ? [ch.id] : [...prev.filter((id) => id !== ALL_CHAPTERS_VALUE), ch.id]));
                          } else {
                            setUploadChapterIds((prev) => prev.filter((id) => id !== ch.id));
                          }
                        }}
                      />
                      {ch.title}
                    </label>
                  ))}
                  {!chapters.length && <span style={{ color: "var(--text-muted)" }}>暂无章节</span>}
                </div>
              </details>
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(e) => setDocUploadFile(e.target.files?.[0] || null)}
                  style={{ flex: "1 1 120px", minWidth: 0 }}
                />
                <button type="button" className="btn-primary" onClick={uploadDocument} disabled={docUploading || !docUploadFile}>
                  {docUploading ? "上传中…" : "上传 PDF"}
                </button>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.webm,.mov,.mkv,.m4v"
                  onChange={(e) => setVideoUploadFile(e.target.files?.[0] || null)}
                  style={{ flex: "1 1 120px", minWidth: 0 }}
                />
                <button type="button" className="btn-primary" onClick={uploadVideo} disabled={docUploading || !videoUploadFile}>
                  {docUploading ? "上传中…" : "上传视频"}
                </button>
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "scroll", border: "1px solid var(--border)", borderRadius: 8 }}>
              {docsLoading && <p style={{ padding: 8, color: "var(--text-muted)" }}>加载中…</p>}
              {!docsLoading && docs.length === 0 && <p style={{ padding: 8, color: "var(--text-muted)" }}>暂无资料，请先上传</p>}
              {!docsLoading && docs.length > 0 && (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-muted, #f5f5f5)" }}>
                      <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 600 }}>文件</th>
                      <th style={{ textAlign: "left", padding: "6px 10px 6px 4px", fontWeight: 600, width: 88 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {docs.map((doc) => {
                      const isSelected = selectedDocId === doc.id;
                      const isProcessing =
                        doc.parse_status === "processing" ||
                        docTaskByDoc[doc.id]?.status === "pending" ||
                        docTaskByDoc[doc.id]?.status === "running";
                      const singleChapter = (doc.chapter_ids?.length ?? 0) === 1;
                      const canParse = doc.source_type === "pdf_upload" && !isProcessing;
                      return (
                        <tr
                          key={doc.id}
                          onClick={() => openDocDetail(doc.id)}
                          style={{
                            cursor: "pointer",
                            borderBottom: "1px solid var(--border)",
                            background: isSelected ? "rgba(59,130,246,0.08)" : undefined,
                          }}
                        >
                          <td style={{ padding: 6, verticalAlign: "top" }}>
                            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{doc.file_name || doc.title || "—"}</div>
                            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                              类型：{doc.source_type === "preview_video" ? "视频" : "文档"} · 状态：{doc.parse_status || "—"} · 大小：{formatFileSize(doc.file_size)} · 关联章节：{formatChapterLabel(doc)} · 学生可见：{doc.student_visible ? "是" : "否"} · 可下载：{doc.downloadable ? "是" : "否"}
                            </div>
                            {doc.parse_error && <div style={{ color: "var(--danger, #c00)", fontSize: 12, marginTop: 4 }}>{doc.parse_error}</div>}
                          </td>
                          <td style={{ padding: "6px 10px 6px 4px", verticalAlign: "middle" }} onClick={(e) => e.stopPropagation()}>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, width: 76 }}>
                              <button type="button" className="btn-ghost" style={{ padding: "2px 4px", fontSize: 11 }} onClick={() => openDocFile(doc.id)}>
                                查看
                              </button>
                              <button
                                type="button"
                                className="btn-ghost"
                                style={{ padding: "2px 4px", fontSize: 11 }}
                                onClick={() => {
                                  setEditDocId(doc.id);
                                  setEditForm({
                                    student_visible: doc.student_visible,
                                    downloadable: doc.downloadable,
                                    chapter_ids: doc.chapter_ids ?? [],
                                  });
                                }}
                              >
                                编辑
                              </button>
                              {doc.source_type === "pdf_upload" ? (
                                <button
                                  type="button"
                                  className="btn-ghost"
                                  style={{ padding: "2px 4px", fontSize: 11 }}
                                  disabled={!canParse}
                                  title={
                                    singleChapter
                                      ? "解析后将自动提取知识点并填入该章节"
                                      : "解析后不会自动填写知识点（仅单章节时会自动填入）"
                                  }
                                  onClick={() => reprocessDocument(doc.id)}
                                >
                                  {isProcessing ? "…" : "解析"}
                                </button>
                              ) : (
                                <span />
                              )}
                              <button
                                type="button"
                                className="btn-ghost"
                                style={{ padding: "2px 4px", fontSize: 11, color: "var(--danger, #c00)" }}
                                disabled={docActionId === doc.id}
                                onClick={() => deleteDocument(doc.id)}
                              >
                                {docActionId === doc.id ? "…" : "删除"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ minHeight: 95, marginBottom: 8, display: "flex", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>文档解析情况</h3>
            </div>
            {docDetailLoading && <p style={{ color: "var(--text-muted)" }}>解析信息加载中…</p>}
            {!docDetailLoading && !docDetail && <p style={{ color: "var(--text-muted)" }}>点击左侧文档查看解析详情</p>}
            {!docDetailLoading && docDetail && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, minHeight: 0, flex: 1 }}>
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, overflowY: "auto" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <strong>{docDetail.file_name || docDetail.title}</strong>
                    <div style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
                      <button type="button" className="btn-ghost" onClick={() => openDocFile(docDetail.id)} disabled={docActionId === docDetail.id}>
                        {docDetail.source_type === "preview_video" ? "播放视频" : "查看PDF"}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ color: "var(--danger, #c00)" }}
                        onClick={() => deleteDocument(docDetail.id)}
                        disabled={docActionId === docDetail.id || docUploading}
                      >
                        {docActionId === docDetail.id ? "处理中…" : "删除资料"}
                      </button>
                    </div>
                  </div>
                  <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 8 }}>
                    状态：{docDetail.parse_status || "unknown"} · 页数：{docDetail.page_ref || "—"} · 切片：{docDetail.chunk_count ?? "—"}
                  </div>
                  {(docTaskErrorByDoc[docDetail.id] || docDetail.parse_error) && (
                    <p style={{ color: "var(--danger, #c00)" }}>{docTaskErrorByDoc[docDetail.id] || docDetail.parse_error}</p>
                  )}
                  <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13 }}>
                    {docDetail.source_type === "preview_video" ? "视频文件无需文本解析，可直接播放/下载。" : docDetail.content_preview || "暂无解析文本"}
                  </pre>
                </div>
                <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, overflowY: "auto" }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>切片结果</div>
                  {docDetail.source_type === "preview_video" && <p style={{ color: "var(--text-muted)" }}>视频不参与切片</p>}
                  {docDetail.source_type !== "preview_video" && docDetail.chunks?.length === 0 && <p style={{ color: "var(--text-muted)" }}>暂无切片</p>}
                  {docDetail.chunks?.map((chunk) => (
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
      )}

      {editDocId != null && (() => {
        const doc = docs.find((d) => d.id === editDocId);
        if (!doc) return null;
        const isAllChapters = chapters.length > 0 && (editForm.chapter_ids.length === 0 || editForm.chapter_ids.length >= chapters.length);
        return (
          <div
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 130 }}
            onClick={() => setEditDocId(null)}
          >
            <div className="card" style={{ width: "min(480px, 92vw)", padding: 16 }} onClick={(e) => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 12px" }}>编辑资料</h3>
              <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 12 }}>{doc.file_name || doc.title}</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={editForm.student_visible}
                    onChange={(e) => setEditForm((f) => ({ ...f, student_visible: e.target.checked }))}
                  />
                  <span>学生预习页中可见</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={editForm.downloadable}
                    onChange={(e) => setEditForm((f) => ({ ...f, downloadable: e.target.checked }))}
                  />
                  <span>学生预习页中可下载</span>
                </label>
                <div>
                  <span style={{ display: "block", marginBottom: 6, fontSize: 14 }}>关联章节（多选）</span>
                  {chapters.length === 0 ? (
                    <p style={{ color: "var(--text-muted)", margin: 0, fontSize: 13 }}>当前无章节，资料归属课程</p>
                  ) : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, maxHeight: 120, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={isAllChapters}
                          onChange={(e) =>
                            setEditForm((f) => ({
                              ...f,
                              chapter_ids: e.target.checked ? [] : (f.chapter_ids.length >= chapters.length ? [] : f.chapter_ids),
                            }))
                          }
                        />
                        <span>全部</span>
                      </label>
                      {chapters.map((ch) => (
                        <label key={ch.id} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={editForm.chapter_ids.includes(ch.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setEditForm((f) => ({ ...f, chapter_ids: [...f.chapter_ids, ch.id] }));
                              } else {
                                setEditForm((f) => ({ ...f, chapter_ids: f.chapter_ids.filter((id) => id !== ch.id) }));
                              }
                            }}
                          />
                          <span>{ch.title}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="btn-ghost" onClick={() => setEditDocId(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() =>
                    patchDocument(editDocId, {
                      student_visible: editForm.student_visible,
                      downloadable: editForm.downloadable,
                      chapter_ids: chapters.length === 0 ? [] : (isAllChapters ? chapters.map((c) => c.id) : editForm.chapter_ids),
                    })
                  }
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {errorLogModal && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 130 }}
          onClick={() => setErrorLogModal(null)}
        >
          <div className="card" style={{ width: "min(820px, 92vw)", maxHeight: "78vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>失败日志</h3>
              <button type="button" className="btn-ghost" onClick={() => setErrorLogModal(null)}>
                关闭
              </button>
            </div>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13 }}>{errorLogModal}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
