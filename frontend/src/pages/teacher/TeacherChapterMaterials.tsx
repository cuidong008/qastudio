import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";

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

  const title = useMemo(() => `${courseName} / ${chapterTitle} · 章节资料`, [chapterTitle, courseName]);

  const formatFileSize = (bytes: number | null) => {
    if (!bytes || bytes <= 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const loadChapterDocuments = (targetChapterId: number) => {
    setDocsLoading(true);
    api.teacher.courses
      .chapterDocuments(targetChapterId)
      .then((rows) => setChapterDocs(rows))
      .catch(() => setChapterDocs([]))
      .finally(() => setDocsLoading(false));
  };

  useEffect(() => {
    if (!chapterId) return;
    loadChapterDocuments(chapterId);
  }, [chapterId]);

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
      <p style={{ color: "var(--text-muted)", marginBottom: 16 }}>上传 PDF 讲义与教学视频，并查看文档解析情况。</p>
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
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <strong>{docDetail.file_name || docDetail.title}</strong>
                  <button type="button" className="btn-ghost" onClick={() => openDocFile(docDetail.id)}>
                    {docDetail.source_type === "preview_video" ? "播放视频" : "查看PDF"}
                  </button>
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 8 }}>
                  状态：{docDetail.parse_status || "unknown"} · 页数：{docDetail.page_ref || "—"} · 切片：{docDetail.chunk_count ?? "—"}
                </div>
                {docDetail.parse_error && <p style={{ color: "var(--danger, #c00)" }}>{docDetail.parse_error}</p>}
                <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13 }}>
                  {docDetail.source_type === "preview_video" ? "视频文件无需文本解析，可直接播放/下载。" : docDetail.content_preview || "暂无解析文本"}
                </pre>
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
    </div>
  );
}
