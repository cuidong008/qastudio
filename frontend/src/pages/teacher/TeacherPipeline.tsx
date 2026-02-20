import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { toast } from "../../utils/toast";

type WorkflowInfo = {
  workflow_id: string;
  title: string;
  chapter_id: number | null;
  created_at: string;
  updated_at: string;
  stages: Record<string, { status?: string; updated_at?: string; outputs?: string[] }>;
};

type PdfDoc = {
  id: number;
  chapter_id: number | null;
  chapter_title: string | null;
  course_id: number | null;
  course_name: string | null;
  title: string;
  file_name: string | null;
  parse_status: string | null;
  created_at: string | null;
  workflow_id: string;
};

type ChapterSplit = {
  chapter_no: number;
  title: string;
  path: string;
  char_count: number;
};

export default function TeacherPipeline() {
  const [pdfDocs, setPdfDocs] = useState<PdfDoc[]>([]);
  const [uploadPdfFile, setUploadPdfFile] = useState<File | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<PdfDoc | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowInfo | null>(null);
  const [chapterSplits, setChapterSplits] = useState<ChapterSplit[]>([]);
  const [selectedSplitPath, setSelectedSplitPath] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const [stage2MaxSlides, setStage2MaxSlides] = useState(20);
  const [stage2PreferLlm, setStage2PreferLlm] = useState(true);
  const [stage4PreferLlm, setStage4PreferLlm] = useState(true);
  const [stage3EditedFile, setStage3EditedFile] = useState<File | null>(null);
  const [stage5Model, setStage5Model] = useState("gpt-4o-mini-tts");
  const [stage5ModelOptions, setStage5ModelOptions] = useState<{ value: string; label: string; provider_type: string }[]>([]);
  const [stage5VoicesByProviderType, setStage5VoicesByProviderType] = useState<
    Record<string, { value: string; label: string }[]>
  >({});
  const [stage5VoicesByModel, setStage5VoicesByModel] = useState<
    Record<string, { value: string; label: string }[]>
  >({});
  const [stage5Voice, setStage5Voice] = useState("alloy");
  const [stage5Speed, setStage5Speed] = useState(1);
  const [stage6DefaultSeconds, setStage6DefaultSeconds] = useState(8);

  const [editorPath, setEditorPath] = useState("stage1/extracted_content.md");
  const [editorContent, setEditorContent] = useState("");

  const setBusyFlag = (k: string, v: boolean) => setBusy((p) => ({ ...p, [k]: v }));

  const activeWorkflowId = workflow?.workflow_id || "";
  const splitKey = useMemo(() => {
    if (!selectedSplitPath) return "";
    const name = selectedSplitPath.split("/").pop() || "";
    return name.replace(/\.md$/i, "");
  }, [selectedSplitPath]);

  const branch = useMemo(() => {
    const key = splitKey || "chapter_01";
    return {
      sourceChapterPath: selectedSplitPath || "stage1/chapters/chapter_01.md",
      stage2Json: `stage_branches/${key}/stage2/slides_content.json`,
      stage3Ppt: `stage_branches/${key}/stage3/generated_draft.pptx`,
      stage3Edited: `stage_branches/${key}/stage3/edited.pptx`,
      stage4Script: `stage_branches/${key}/stage4/narration_script.txt`,
      stage4Segments: `stage_branches/${key}/stage4/script_segments.json`,
      stage5Audio: `stage_branches/${key}/stage5/full_narration.mp3`,
      stage6Video: `stage_branches/${key}/stage6/final_video.mp4`,
      stage6Timeline: `stage_branches/${key}/stage6/timeline.json`,
    };
  }, [selectedSplitPath, splitKey]);

  const loadPdfDocs = async () => {
    setBusyFlag("list", true);
    try {
      const rows = await api.teacher.pipeline.listPdfDocs();
      setPdfDocs(rows);
    } catch (e: any) {
      toast(e?.message || "PDF 列表加载失败", "error");
      setPdfDocs([]);
    } finally {
      setBusyFlag("list", false);
    }
  };

  const loadTtsModels = async () => {
    try {
      const r = await api.teacher.pipeline.ttsModels();
      console.info("[TeacherPipeline] ttsModels payload", {
        options: r.options?.length || 0,
        voicesByProviderType: Object.fromEntries(
          Object.entries(r.voices_by_provider_type || {}).map(([k, v]) => [k, v.length])
        ),
        voicesByModel: Object.keys(r.voices_by_model || {}).length,
        defaultModel: r.default_model,
      });
      setStage5ModelOptions(r.options.map((x) => ({ value: x.value, label: x.label, provider_type: x.provider_type })));
      setStage5VoicesByProviderType(r.voices_by_provider_type || {});
      setStage5VoicesByModel(r.voices_by_model || {});
      if (r.default_model) {
        setStage5Model(r.default_model);
      }
    } catch (e: any) {
      console.error("[TeacherPipeline] ttsModels failed", e);
      toast(e?.message || "TTS 模型与音色加载失败", "error");
      setStage5ModelOptions([]);
      setStage5VoicesByProviderType({});
      setStage5VoicesByModel({});
    }
  };

  const refreshWorkflow = async (workflowId: string) => {
    const data = await api.teacher.pipeline.getWorkflow(workflowId);
    setWorkflow(data);
  };

  const loadChapterSplits = async (workflowId: string) => {
    try {
      const file = await api.teacher.pipeline.readTextFile(workflowId, "stage1/chapter_manifest.json");
      const parsed = JSON.parse(file.content || "{}");
      const chapters: ChapterSplit[] = Array.isArray(parsed?.chapters) ? parsed.chapters : [];
      setChapterSplits(chapters);
      if (chapters.length && !selectedSplitPath) {
        setSelectedSplitPath(chapters[0].path);
      }
    } catch {
      setChapterSplits([]);
      setSelectedSplitPath("");
    }
  };

  useEffect(() => {
    void loadPdfDocs();
    void loadTtsModels();
  }, []);

  const openDocWorkflow = async (doc: PdfDoc) => {
    setBusyFlag("bind", true);
    try {
      const wf = await api.teacher.pipeline.getOrCreatePdfWorkflow(doc.id);
      setSelectedDoc(doc);
      setWorkflow(wf);
      await loadChapterSplits(wf.workflow_id);
      toast("已绑定该 PDF 的流水线", "success");
    } catch (e: any) {
      toast(e?.message || "打开流水线失败", "error");
    } finally {
      setBusyFlag("bind", false);
    }
  };

  const uploadPdfDoc = async () => {
    if (!uploadPdfFile) return toast("请先选择 PDF 文件", "error");
    setBusyFlag("uploadPdf", true);
    try {
      const doc = await api.teacher.pipeline.uploadPdfDoc(uploadPdfFile);
      setUploadPdfFile(null);
      await loadPdfDocs();
      await openDocWorkflow(doc);
      toast("PDF 上传成功", "success");
    } catch (e: any) {
      toast(e?.message || "PDF 上传失败", "error");
    } finally {
      setBusyFlag("uploadPdf", false);
    }
  };

  const stage1Run = async () => {
    if (!activeWorkflowId) return toast("请先在左侧选择一个 PDF", "error");
    setBusyFlag("stage1", true);
    try {
      await api.teacher.pipeline.stage1Extract(activeWorkflowId);
      await refreshWorkflow(activeWorkflowId);
      await loadChapterSplits(activeWorkflowId);
      toast("阶段1完成，已按章节拆分", "success");
    } catch (e: any) {
      toast(e?.message || "阶段1失败", "error");
    } finally {
      setBusyFlag("stage1", false);
    }
  };

  const stage2Run = async () => {
    if (!activeWorkflowId) return toast("请先选择 PDF", "error");
    if (!selectedSplitPath) return toast("请先选择章节", "error");
    setBusyFlag("stage2", true);
    try {
      await api.teacher.pipeline.stage2Generate(activeWorkflowId, {
        source_file: branch.sourceChapterPath,
        max_slides: stage2MaxSlides,
        prefer_llm: stage2PreferLlm,
        title: `${selectedDoc?.file_name || selectedDoc?.title || "教学内容"} - ${splitKey}`,
        output_json_file: branch.stage2Json,
      });
      await refreshWorkflow(activeWorkflowId);
      toast("阶段2完成", "success");
    } catch (e: any) {
      toast(e?.message || "阶段2失败", "error");
    } finally {
      setBusyFlag("stage2", false);
    }
  };

  const stage3Run = async () => {
    if (!activeWorkflowId) return toast("请先选择 PDF", "error");
    setBusyFlag("stage3", true);
    try {
      await api.teacher.pipeline.stage3GeneratePpt(activeWorkflowId, {
        source_file: branch.stage2Json,
        output_file: branch.stage3Ppt,
        template_file: null,
      });
      await refreshWorkflow(activeWorkflowId);
      toast("阶段3完成", "success");
    } catch (e: any) {
      toast(e?.message || "阶段3失败", "error");
    } finally {
      setBusyFlag("stage3", false);
    }
  };

  const stage3UploadEdited = async () => {
    if (!activeWorkflowId) return toast("请先选择 PDF", "error");
    if (!stage3EditedFile) return toast("请先选择 edited.pptx", "error");
    setBusyFlag("stage3Upload", true);
    try {
      await api.teacher.pipeline.uploadFileOverride(activeWorkflowId, branch.stage3Edited, stage3EditedFile);
      await refreshWorkflow(activeWorkflowId);
      toast("已上传编辑后的 PPT", "success");
    } catch (e: any) {
      toast(e?.message || "上传失败", "error");
    } finally {
      setBusyFlag("stage3Upload", false);
    }
  };

  const stage4Run = async () => {
    if (!activeWorkflowId) return toast("请先选择 PDF", "error");
    setBusyFlag("stage4", true);
    try {
      await api.teacher.pipeline.stage4GenerateScript(activeWorkflowId, {
        source_ppt: branch.stage3Edited,
        fallback_ppt: branch.stage3Ppt,
        prefer_llm: stage4PreferLlm,
        output_script_file: branch.stage4Script,
        output_segments_file: branch.stage4Segments,
      });
      await refreshWorkflow(activeWorkflowId);
      toast("阶段4完成", "success");
    } catch (e: any) {
      toast(e?.message || "阶段4失败", "error");
    } finally {
      setBusyFlag("stage4", false);
    }
  };

  const stage5Run = async () => {
    if (!activeWorkflowId) return toast("请先选择 PDF", "error");
    setBusyFlag("stage5", true);
    try {
      await api.teacher.pipeline.stage5Tts(activeWorkflowId, {
        script_file: branch.stage4Script,
        output_file: branch.stage5Audio,
        model: stage5Model,
        voice: stage5Voice,
        speed: stage5Speed,
      });
      await refreshWorkflow(activeWorkflowId);
      toast("阶段5完成", "success");
    } catch (e: any) {
      toast(e?.message || "阶段5失败", "error");
    } finally {
      setBusyFlag("stage5", false);
    }
  };

  const stage6Run = async () => {
    if (!activeWorkflowId) return toast("请先选择 PDF", "error");
    setBusyFlag("stage6", true);
    try {
      await api.teacher.pipeline.stage6RenderVideo(activeWorkflowId, {
        ppt_file: branch.stage3Edited,
        fallback_ppt: branch.stage3Ppt,
        audio_file: branch.stage5Audio,
        output_file: branch.stage6Video,
        timing_file: branch.stage6Timeline,
        default_slide_seconds: stage6DefaultSeconds,
      });
      await refreshWorkflow(activeWorkflowId);
      toast("阶段6完成", "success");
    } catch (e: any) {
      toast(e?.message || "阶段6失败", "error");
    } finally {
      setBusyFlag("stage6", false);
    }
  };

  const selectedModelProviderType =
    stage5ModelOptions.find((x) => x.value === stage5Model)?.provider_type || "openai_compatible";
  const stage5VoiceOptions =
    stage5VoicesByModel[stage5Model] ??
    (selectedModelProviderType === "qianwen"
      ? []
      : stage5VoicesByProviderType[selectedModelProviderType] || []);
  const stage5VoiceValues = stage5VoiceOptions.map((x) => x.value);

  useEffect(() => {
    if (!stage5VoiceValues.length) return;
    if (!stage5VoiceValues.includes(stage5Voice)) {
      setStage5Voice(stage5VoiceValues[0]);
    }
  }, [selectedModelProviderType, stage5VoiceValues.join(","), stage5Voice]);

  const downloadByPath = async (path: string) => {
    if (!activeWorkflowId) return toast("请先选择 PDF", "error");
    try {
      const blob = await api.teacher.pipeline.downloadFile(activeWorkflowId, path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = path.split("/").pop() || "download.bin";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast(e?.message || "下载失败", "error");
    }
  };

  const openEditorPath = async (path: string) => {
    if (!activeWorkflowId) return toast("请先选择 PDF", "error");
    setBusyFlag("editorLoad", true);
    try {
      const data = await api.teacher.pipeline.readTextFile(activeWorkflowId, path);
      setEditorPath(path);
      setEditorContent(data.content || "");
    } catch (e: any) {
      toast(e?.message || "文件读取失败", "error");
    } finally {
      setBusyFlag("editorLoad", false);
    }
  };

  const saveEditorFile = async () => {
    if (!activeWorkflowId) return toast("请先选择 PDF", "error");
    setBusyFlag("editorSave", true);
    try {
      await api.teacher.pipeline.saveTextFile(activeWorkflowId, { path: editorPath, content: editorContent });
      toast("保存成功", "success");
    } catch (e: any) {
      toast(e?.message || "保存失败", "error");
    } finally {
      setBusyFlag("editorSave", false);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 16 }}>
      <div className="card" style={{ alignSelf: "start", position: "sticky", top: 16 }}>
        <h3 style={{ marginTop: 0 }}>PDF 文档列表</h3>
        <p style={{ color: "var(--text-muted)", marginTop: 0 }}>
          这是独立于课程配置的 PDF 处理流水线入口，点击文档即可进入对应流水线。
        </p>
        <div style={{ display: "grid", gap: 8 }}>
          <input
            type="file"
            accept=".pdf,application/pdf"
            onChange={(e) => setUploadPdfFile(e.target.files?.[0] || null)}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn-primary" onClick={uploadPdfDoc} disabled={!!busy.uploadPdf}>
              {busy.uploadPdf ? "上传中..." : "上传 PDF"}
            </button>
            <button type="button" className="btn-secondary" onClick={loadPdfDocs} disabled={!!busy.list}>
              {busy.list ? "刷新中..." : "刷新列表"}
            </button>
          </div>
        </div>
        <div style={{ marginTop: 12, display: "grid", gap: 8, maxHeight: "65vh", overflow: "auto" }}>
          {pdfDocs.map((doc) => (
            <button
              key={doc.id}
              type="button"
              className="btn-secondary"
              style={{
                textAlign: "left",
                borderColor: selectedDoc?.id === doc.id ? "var(--accent)" : undefined,
              }}
              onClick={() => openDocWorkflow(doc)}
              disabled={!!busy.bind}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{doc.file_name || doc.title}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {doc.file_name || doc.title} / {doc.parse_status || "-"}
              </div>
            </button>
          ))}
          {!pdfDocs.length && <div style={{ color: "var(--text-muted)" }}>暂无 PDF 文档</div>}
        </div>
      </div>

      <div style={{ display: "grid", gap: 16 }}>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>PDF 流水线</h2>
          <p style={{ marginTop: 0, color: "var(--text-muted)" }}>
            {selectedDoc ? `${selectedDoc.file_name || selectedDoc.title}（自动绑定 workflow: ${activeWorkflowId}）` : "请先在左侧选择一个 PDF 文档"}
          </p>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" className="btn-primary" onClick={stage1Run} disabled={!activeWorkflowId || !!busy.stage1}>
                {busy.stage1 ? "执行中..." : "阶段1：提取并按章节拆分"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => openEditorPath("stage1/extracted_content.md")} disabled={!activeWorkflowId}>
                在线编辑 extracted_content.md
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ color: "var(--text-secondary)" }}>章节分支</label>
              <select value={selectedSplitPath} onChange={(e) => setSelectedSplitPath(e.target.value)} style={{ minWidth: 360 }}>
                <option value="">请选择章节</option>
                {chapterSplits.map((x) => (
                  <option key={x.path} value={x.path}>
                    第{x.chapter_no}章：{x.title}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-secondary" onClick={() => openEditorPath(selectedSplitPath)} disabled={!selectedSplitPath}>
                在线编辑该章节文本
              </button>
            </div>
            {!!selectedSplitPath && (
              <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
                当前分支输出前缀：`stage_branches/{splitKey || "chapter_01"}`
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>阶段2~6（按选中章节分支执行）</h3>
          <p style={{ marginTop: 0, color: "var(--text-muted)", fontSize: 13 }}>
            参数说明：`最大页数`用于限制阶段2自动生成的PPT页数；`TTS模型/音色/语速`用于阶段5配音；`默认每页时长`用于阶段6在没有时间轴文件时控制翻页节奏。
          </p>
          <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>最大页数</span>
              <input type="number" min={5} max={60} value={stage2MaxSlides} onChange={(e) => setStage2MaxSlides(Number(e.target.value) || 20)} />
              <label><input type="checkbox" checked={stage2PreferLlm} onChange={(e) => setStage2PreferLlm(e.target.checked)} /> 优先LLM</label>
              <button type="button" className="btn-primary" onClick={stage2Run} disabled={!selectedSplitPath || !!busy.stage2}>
                {busy.stage2 ? "执行中..." : "生成PPT大纲与内容"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => openEditorPath(branch.stage2Json)} disabled={!activeWorkflowId}>
                在线编辑 slides_content.json
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" className="btn-primary" onClick={stage3Run} disabled={!selectedSplitPath || !!busy.stage3}>
                {busy.stage3 ? "执行中..." : "生成PPT文件"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => downloadByPath(branch.stage3Ppt)} disabled={!activeWorkflowId}>
                下载 generated_draft.pptx
              </button>
              <input
                type="file"
                accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                onChange={(e) => setStage3EditedFile(e.target.files?.[0] || null)}
              />
              <button type="button" className="btn-secondary" onClick={stage3UploadEdited} disabled={!activeWorkflowId || !!busy.stage3Upload}>
                上传 edited.pptx
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label><input type="checkbox" checked={stage4PreferLlm} onChange={(e) => setStage4PreferLlm(e.target.checked)} /> 阶段4优先LLM</label>
              <button type="button" className="btn-primary" onClick={stage4Run} disabled={!selectedSplitPath || !!busy.stage4}>
                {busy.stage4 ? "执行中..." : "生成讲解脚本"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => openEditorPath(branch.stage4Script)} disabled={!activeWorkflowId}>
                在线编辑 narration_script.txt
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>TTS模型</span>
              {stage5ModelOptions.length ? (
                <select value={stage5Model} onChange={(e) => setStage5Model(e.target.value)} style={{ minWidth: 340 }}>
                  {stage5ModelOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={stage5Model} onChange={(e) => setStage5Model(e.target.value)} placeholder="provider_id:model" />
              )}
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>音色</span>
              {stage5VoiceOptions.length ? (
                <select value={stage5Voice} onChange={(e) => setStage5Voice(e.target.value)} style={{ minWidth: 160 }}>
                  {stage5VoiceOptions.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={stage5Voice} onChange={(e) => setStage5Voice(e.target.value)} placeholder="voice" />
              )}
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>语速</span>
              <input type="number" step={0.1} min={0.5} max={1.5} value={stage5Speed} onChange={(e) => setStage5Speed(Number(e.target.value) || 1)} />
              <button type="button" className="btn-primary" onClick={stage5Run} disabled={!selectedSplitPath || !!busy.stage5}>
                {busy.stage5 ? "执行中..." : "生成讲解音频"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => downloadByPath(branch.stage5Audio)} disabled={!activeWorkflowId}>
                下载音频
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>默认每页时长(秒)</span>
              <input type="number" step={0.5} min={1} max={60} value={stage6DefaultSeconds} onChange={(e) => setStage6DefaultSeconds(Number(e.target.value) || 8)} />
              <button type="button" className="btn-primary" onClick={stage6Run} disabled={!selectedSplitPath || !!busy.stage6}>
                {busy.stage6 ? "执行中..." : "合成讲解视频"}
              </button>
              <button type="button" className="btn-secondary" onClick={() => downloadByPath(branch.stage6Video)} disabled={!activeWorkflowId}>
                下载视频
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>在线编辑器（MD/JSON）</h3>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input value={editorPath} onChange={(e) => setEditorPath(e.target.value)} placeholder="工作流内相对路径，如 stage2/xxx.json" style={{ minWidth: 420 }} />
              <button type="button" className="btn-secondary" onClick={() => openEditorPath(editorPath)} disabled={!activeWorkflowId || !!busy.editorLoad}>
                {busy.editorLoad ? "读取中..." : "读取"}
              </button>
              <button type="button" className="btn-primary" onClick={saveEditorFile} disabled={!activeWorkflowId || !!busy.editorSave}>
                {busy.editorSave ? "保存中..." : "保存"}
              </button>
            </div>
            <textarea
              value={editorContent}
              onChange={(e) => setEditorContent(e.target.value)}
              style={{ minHeight: 320, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
