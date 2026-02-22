import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { toast } from "../../utils/toast";

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

export default function TeacherChapterMaterials() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const chapterId = Number(searchParams.get("chapterId") || 0);
  const chapterTitle = searchParams.get("chapterTitle") || "章节";
  const courseName = searchParams.get("courseName") || "课程";

  const [chapterDocs, setChapterDocs] = useState<ChapterDocItem[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docUploadFile, setDocUploadFile] = useState<File | null>(null);
  const [videoUploadFile, setVideoUploadFile] = useState<File | null>(null);
  const [docUploading, setDocUploading] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState<number | null>(null);
  const [docDetail, setDocDetail] = useState<ChapterDocDetail | null>(null);
  const [docDetailLoading, setDocDetailLoading] = useState(false);
  const [docActionId, setDocActionId] = useState<number | null>(null);
  const [errorLogModal, setErrorLogModal] = useState<string | null>(null);
  const [docTaskByDoc, setDocTaskByDoc] = useState<Record<number, { taskId: number; status: string }>>({});
  const [docTaskErrorByDoc, setDocTaskErrorByDoc] = useState<Record<number, string>>({});
  const [statusPollingDocIds, setStatusPollingDocIds] = useState<Record<number, boolean>>({});

  const title = useMemo(() => `${courseName} / ${chapterTitle} · 章节资料`, [chapterTitle, courseName]);

  const formatFileSize = (bytes: number | null) => {
    if (!bytes || bytes <= 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const loadChapterDocuments = async (targetChapterId: number) => {
    setDocsLoading(true);
    try {
      const rows = await api.teacher.courses.chapterDocuments(targetChapterId);
      setChapterDocs(rows);
    } catch {
      setChapterDocs([]);
    } finally {
      setDocsLoading(false);
    }
  };

  useEffect(() => {
    if (!chapterId) return;
    loadChapterDocuments(chapterId);
  }, [chapterId]);

  useEffect(() => {
    if (!chapterId) return;
    const hasProcessing = chapterDocs.some((d) => d.parse_status === "processing");
    if (!hasProcessing) return;
    const timer = window.setInterval(async () => {
      await loadChapterDocuments(chapterId);
      if (selectedDocId) {
        try {
          const d = await api.teacher.courses.documentDetail(selectedDocId);
          setDocDetail(d);
        } catch {
          // ignore transient errors
        }
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [chapterId, chapterDocs, selectedDocId]);

  const uploadDocumentToChapter = () => {
    if (!chapterId || !docUploadFile) {
      alert("请选择 PDF 文件");
      return;
    }
    setDocUploading(true);
    api.teacher.courses
      .uploadChapterDocument(chapterId, docUploadFile)
      .then((doc) => {
        setDocUploadFile(null);
        loadChapterDocuments(chapterId);
        setSelectedDocId(doc.id);
        return api.teacher.courses.documentDetail(doc.id);
      })
      .then(setDocDetail)
      .catch((e) => alert(e?.message || "上传失败"))
      .finally(() => setDocUploading(false));
  };

  const uploadVideoToChapter = () => {
    if (!chapterId || !videoUploadFile) {
      alert("请选择视频文件");
      return;
    }
    setDocUploading(true);
    api.teacher.courses
      .uploadChapterVideo(chapterId, videoUploadFile)
      .then((doc) => {
        setVideoUploadFile(null);
        loadChapterDocuments(chapterId);
        setSelectedDocId(doc.id);
      })
      .catch((e) => alert(e?.message || "视频上传失败"))
      .finally(() => setDocUploading(false));
  };

  const openDocDetail = (docId: number) => {
    setSelectedDocId(docId);
    setDocDetailLoading(true);
    api.teacher.courses
      .documentDetail(docId)
      .then((d) => {
        setDocDetail(d);
        if (d.parse_status === "processing") {
          void pollDocumentStatus(docId);
        }
      })
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

  const deleteDocument = async (docId: number) => {
    if (!confirm("确定删除该资料吗？删除后将从章节中移除。")) return;
    setDocActionId(docId);
    try {
      await api.teacher.courses.deleteDocument(docId);
      if (selectedDocId === docId) {
        setSelectedDocId(null);
        setDocDetail(null);
      }
      loadChapterDocuments(chapterId);
    } catch (e: any) {
      alert(e?.message || "删除失败");
    } finally {
      setDocActionId(null);
    }
  };

  const reprocessDocument = async (docId: number) => {
    if (!confirm("将重新识别讲义、重新切片并重建索引，是否继续？")) return;
    if (docTaskByDoc[docId]?.status === "pending" || docTaskByDoc[docId]?.status === "running") {
      toast("该文档已有处理任务在执行中");
      return;
    }
    try {
      const r = await api.teacher.courses.reprocessDocument(docId);
      setDocTaskByDoc((prev) => ({ ...prev, [docId]: { taskId: r.task_id, status: r.status } }));
      setDocTaskErrorByDoc((prev) => {
        const next = { ...prev };
        delete next[docId];
        return next;
      });
      toast("任务已开始，系统将在后台处理。");
      void pollDocumentTask(docId, r.task_id);
      void pollDocumentStatus(docId);
      if (selectedDocId === docId) {
        setDocDetail((prev) => (prev ? { ...prev, parse_status: "processing", parse_error: null } : prev));
      }
    } catch (e: any) {
      toast(e?.message || "重新处理失败", "error");
    }
  };

  const pollDocumentStatus = async (docId: number) => {
    if (statusPollingDocIds[docId]) return;
    setStatusPollingDocIds((prev) => ({ ...prev, [docId]: true }));
    const maxPoll = 180;
    try {
      for (let i = 0; i < maxPoll; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        let detail: ChapterDocDetail | null = null;
        try {
          detail = await api.teacher.courses.documentDetail(docId);
        } catch {
          break;
        }
        if (selectedDocId === docId) {
          setDocDetail(detail);
        }
        await loadChapterDocuments(chapterId);
        if (detail.parse_status !== "processing") {
          return;
        }
      }
    } finally {
      setStatusPollingDocIds((prev) => {
        const next = { ...prev };
        delete next[docId];
        return next;
      });
    }
  };

  const pollDocumentTask = async (docId: number, taskId: number) => {
    const maxPoll = 180;
    for (let i = 0; i < maxPoll; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const task = await api.teacher.courses.getDocumentProcessTask(taskId);
        setDocTaskByDoc((prev) => ({ ...prev, [docId]: { taskId, status: task.status } }));
        if (task.status === "success") {
          await loadChapterDocuments(chapterId);
          if (selectedDocId === docId) {
            await api.teacher.courses.documentDetail(docId).then(setDocDetail).catch(() => undefined);
          }
          toast("已完成重新识别、切片与重建索引。", "success");
          return;
        }
        if (task.status === "failed") {
          const msg = task.error_message || "任务处理失败";
          setDocTaskErrorByDoc((prev) => ({ ...prev, [docId]: msg }));
          await loadChapterDocuments(chapterId);
          if (selectedDocId === docId) {
            await api.teacher.courses.documentDetail(docId).then(setDocDetail).catch(() => undefined);
          }
          toast("处理失败，可点击“查看失败日志”。", "error");
          return;
        }
        if (task.status === "cancelled") {
          setDocTaskByDoc((prev) => {
            const next = { ...prev };
            delete next[docId];
            return next;
          });
          await loadChapterDocuments(chapterId);
          if (selectedDocId === docId) {
            await api.teacher.courses.documentDetail(docId).then(setDocDetail).catch(() => undefined);
          }
          toast("任务已停止。", "success");
          return;
        }
      } catch {
        // ignore
      }
    }
  };

  const cancelDocumentTask = async (docId: number) => {
    const entry = docTaskByDoc[docId];
    if (!entry || (entry.status !== "pending" && entry.status !== "running")) return;
    try {
      await api.teacher.courses.cancelDocumentProcessTask(entry.taskId);
      setDocTaskByDoc((prev) => {
        const next = { ...prev };
        delete next[docId];
        return next;
      });
      await loadChapterDocuments(chapterId);
      if (selectedDocId === docId) {
        await api.teacher.courses.documentDetail(docId).then(setDocDetail).catch(() => undefined);
      }
      toast("已发送停止请求，任务将在当前步骤结束后停止。");
    } catch (e: any) {
      toast(e?.message || "停止任务失败", "error");
    }
  };

  if (!chapterId) {
    return (
      <div>
        <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>章节资料</h1>
        <p style={{ color: "var(--text-muted)", marginBottom: 16 }}>缺少 chapterId 参数。</p>
        <button type="button" className="btn-ghost" onClick={() => navigate("/teacher/courses")}>返回课程页</button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>{title}</h1>
        <button type="button" className="btn-ghost" onClick={() => navigate("/teacher/courses")}>返回课程页</button>
      </div>
      <p style={{ color: "var(--text-muted)", marginBottom: 16 }}>资料上传只负责上传；讲义的重新识别/切片/重建索引在下方独立按钮执行。</p>
      <div className="card" style={{ width: "100%", minHeight: "calc(100vh - 170px)", display: "grid", gridTemplateColumns: "360px 1fr", gap: 12 }}>
        <div style={{ borderRight: "1px solid var(--border)", paddingRight: 12, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <input type="file" accept="application/pdf,.pdf" onChange={(e) => setDocUploadFile(e.target.files?.[0] || null)} style={{ flex: 1 }} />
            <button type="button" className="btn-primary" onClick={uploadDocumentToChapter} disabled={docUploading || !docUploadFile}>
              {docUploading ? "上传中…" : "上传PDF"}
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <input type="file" accept="video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.webm,.mov,.mkv,.m4v" onChange={(e) => setVideoUploadFile(e.target.files?.[0] || null)} style={{ flex: 1 }} />
            <button type="button" className="btn-primary" onClick={uploadVideoToChapter} disabled={docUploading || !videoUploadFile}>
              {docUploading ? "上传中…" : "上传教学视频"}
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
                    类型：{doc.source_type === "preview_video" ? "预习视频" : "文档"} · 状态：{doc.parse_status || "unknown"} · 切片：{doc.chunk_count ?? "—"} · 大小：{formatFileSize(doc.file_size)}
                  </div>
                  {doc.parse_error && <div style={{ color: "var(--danger, #c00)", fontSize: 12, marginTop: 4 }}>{doc.parse_error}</div>}
                </button>
              ))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <h3 style={{ marginTop: 0, marginBottom: 8 }}>文档解析情况</h3>
          {docDetailLoading && <p style={{ color: "var(--text-muted)" }}>解析信息加载中…</p>}
          {!docDetailLoading && !docDetail && <p style={{ color: "var(--text-muted)" }}>点击左侧文档查看解析详情</p>}
          {!docDetailLoading && docDetail && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, minHeight: 0, flex: 1 }}>
              <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, overflowY: "auto" }}>
                {(() => {
                  const selectedDoc = chapterDocs.find((d) => d.id === docDetail.id);
                  const effectiveStatus = selectedDoc?.parse_status || docDetail.parse_status;
                  const effectiveError = selectedDoc?.parse_error || docTaskErrorByDoc[docDetail.id] || docDetail.parse_error;
                  return (
                    <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <strong>{docDetail.file_name || docDetail.title}</strong>
                  <div style={{ display: "inline-flex", gap: 8 }}>
                    <button type="button" className="btn-ghost" onClick={() => openDocFile(docDetail.id)} disabled={docActionId === docDetail.id}>
                      {docDetail.source_type === "preview_video" ? "播放视频" : "查看PDF"}
                    </button>
                    {docDetail.source_type !== "preview_video" && (
                      <>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => reprocessDocument(docDetail.id)}
                          disabled={
                            docUploading ||
                            statusPollingDocIds[docDetail.id] ||
                            effectiveStatus === "processing" ||
                            docTaskByDoc[docDetail.id]?.status === "pending" ||
                            docTaskByDoc[docDetail.id]?.status === "running"
                          }
                        >
                          {statusPollingDocIds[docDetail.id] ||
                          effectiveStatus === "processing" ||
                          docTaskByDoc[docDetail.id]?.status === "pending" ||
                          docTaskByDoc[docDetail.id]?.status === "running"
                            ? "处理中…"
                            : "重新识别+切片+重建索引"}
                        </button>
                        {(docTaskByDoc[docDetail.id]?.status === "pending" ||
                          docTaskByDoc[docDetail.id]?.status === "running") && (
                          <button
                            type="button"
                            className="btn-ghost"
                            style={{ color: "var(--danger, #c00)" }}
                            onClick={() => cancelDocumentTask(docDetail.id)}
                          >
                            停止任务
                          </button>
                        )}
                      </>
                    )}
                    {effectiveError && (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => setErrorLogModal(effectiveError || "无失败日志")}
                        disabled={docActionId === docDetail.id || docUploading}
                      >
                        查看失败日志
                      </button>
                    )}
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
                  状态：{effectiveStatus || "unknown"} · 页数：{docDetail.page_ref || "—"} · 切片：{docDetail.chunk_count ?? "—"}
                </div>
                {effectiveError && <p style={{ color: "var(--danger, #c00)" }}>{effectiveError}</p>}
                <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13 }}>
                  {docDetail.source_type === "preview_video" ? "视频文件无需文本解析，可直接播放/下载。" : docDetail.content_preview || "暂无解析文本"}
                </pre>
                    </>
                  );
                })()}
              </div>
              <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, overflowY: "auto" }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>切片结果</div>
                {docDetail.source_type === "preview_video" && <p style={{ color: "var(--text-muted)" }}>视频不参与切片</p>}
                {docDetail.source_type !== "preview_video" && docDetail.chunks.length === 0 && <p style={{ color: "var(--text-muted)" }}>暂无切片</p>}
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
