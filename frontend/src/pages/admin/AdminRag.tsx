import { useState, useEffect, useMemo } from "react";
import { api, type RagConfig, type RagProvider, type RagProvidersResponse } from "../../api/client";

const MASKED = "***";

export default function AdminRag() {
  const [config, setConfig] = useState<RagConfig | null>(null);
  const [providersData, setProvidersData] = useState<RagProvidersResponse | null>(null);
  const [form, setForm] = useState<Partial<RagConfig>>({});
  const [providers, setProviders] = useState<RagProvider[]>([]);
  const [defaultLlm, setDefaultLlm] = useState("");
  const [defaultEmbedding, setDefaultEmbedding] = useState("");
  const [defaultVlm, setDefaultVlm] = useState("");
  const [defaultRerank, setDefaultRerank] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [editingProvider, setEditingProvider] = useState<RagProvider | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);
  const [providerForm, setProviderForm] = useState({ type: "openai_compatible", name: "", base_url: "", api_key: "" });

  const load = () => {
    setLoading(true);
    setError("");
    Promise.all([api.admin.rag.config(), api.admin.rag.providers()])
      .then(([c, p]) => {
        setConfig(c);
        setForm({ ...c });
        setProvidersData(p);
        setProviders(p.providers);
        setDefaultLlm(p.default_llm || "");
        setDefaultEmbedding(p.default_embedding || "");
        setDefaultVlm(p.default_vlm || "");
        setDefaultRerank(p.default_rerank || "");
      })
      .catch((e) => setError(e?.message || "获取配置失败"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const update = (key: keyof RagConfig, value: string | number | boolean) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const providerTypes = providersData?.provider_types ?? [];
  const llmModelsByType = providersData?.llm_models_by_type ?? {};
  const embeddingModelsByType = providersData?.embedding_models_by_type ?? {};
  const vlmModelsByType = providersData?.vlm_models_by_type ?? {};
  const rerankModelsByType = providersData?.rerank_models_by_type ?? {};

  const defaultLlmOptions = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    for (const p of providers) {
      const models = llmModelsByType[p.type];
      if (models?.length) {
        for (const m of models) {
          if (m === "custom") continue;
          out.push({ value: `${p.id}:${m}`, label: `${p.name} — ${m}` });
        }
      }
    }
    return out;
  }, [providers, llmModelsByType]);

  const defaultEmbeddingOptions = useMemo(() => {
    const out: { value: string; label: string }[] = [
      { value: "builtin", label: "程序自带（sentence-transformers）" },
    ];
    for (const p of providers) {
      const models = embeddingModelsByType[p.type];
      if (models?.length) {
        for (const m of models) {
          if (m === "custom") continue;
          out.push({ value: `${p.id}:${m}`, label: `${p.name} — ${m}` });
        }
      }
    }
    return out;
  }, [providers, embeddingModelsByType]);

  const defaultVlmOptions = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    for (const p of providers) {
      const models = vlmModelsByType[p.type];
      if (models?.length) {
        for (const m of models) {
          if (m === "custom") continue;
          out.push({ value: `${p.id}:${m}`, label: `${p.name} — ${m}` });
        }
      }
    }
    return out;
  }, [providers, vlmModelsByType]);

  const defaultRerankOptions = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    for (const p of providers) {
      const models = rerankModelsByType[p.type];
      if (models?.length) {
        for (const m of models) {
          if (m === "custom") continue;
          out.push({ value: `${p.id}:${m}`, label: `${p.name} — ${m}` });
        }
      }
    }
    return out;
  }, [providers, rerankModelsByType]);

  const save = () => {
    setSaving(true);
    setMessage("");
    setError("");
    const configPayload: Partial<RagConfig> = {
      enabled: form.enabled,
      vector_store_path: form.vector_store_path,
      vector_collection_name: form.vector_collection_name,
      top_k: form.top_k,
      chunk_size: form.chunk_size,
      chunk_overlap: form.chunk_overlap,
      llm_max_tokens: form.llm_max_tokens,
      llm_temperature: form.llm_temperature,
    };
    api.admin.rag
      .updateProviders({
        providers: providers.map((p) => ({
          id: p.id,
          type: p.type,
          name: p.name,
          base_url: p.base_url || "",
          api_key: p.api_key === MASKED ? "" : p.api_key,
        })),
        default_llm: defaultLlm,
        default_embedding: defaultEmbedding,
        default_vlm: defaultVlm,
        default_rerank: defaultRerank,
      })
      .then(() =>
        api.admin.rag.updateConfig(configPayload)
      )
      .then((c) => {
        setConfig(c);
        setForm({ ...c });
        setMessage("已保存，RAG 将使用新配置。");
        load();
      })
      .catch((e) => setError(e?.message || "保存失败"))
      .finally(() => setSaving(false));
  };

  const addOrUpdateProvider = () => {
    const { type, name, base_url, api_key } = providerForm;
    if (editingProvider) {
      setProviders((prev) =>
        prev.map((p) =>
          p.id === editingProvider.id
            ? { ...p, type, name: name || "未命名", base_url, api_key: api_key || p.api_key }
            : p
        )
      );
      setEditingProvider(null);
    } else {
      setProviders((prev) => [
        ...prev,
        {
          id: `tmp-${Date.now()}`,
          type,
          name: name || "未命名",
          base_url,
          api_key,
        },
      ]);
      setAddingProvider(false);
    }
    setProviderForm({ type: "openai_compatible", name: "", base_url: "", api_key: "" });
  };

  const removeProvider = (id: string) => {
    setProviders((prev) => prev.filter((p) => p.id !== id));
    if (editingProvider?.id === id) {
      setEditingProvider(null);
      setProviderForm({ type: "openai_compatible", name: "", base_url: "", api_key: "" });
    }
    setDefaultLlm((v) => (v.startsWith(id + ":") ? "" : v));
    setDefaultEmbedding((v) => (v.startsWith(id + ":") ? "" : v));
    setDefaultVlm((v) => (v.startsWith(id + ":") ? "" : v));
    setDefaultRerank((v) => (v.startsWith(id + ":") ? "" : v));
  };

  const startEdit = (p: RagProvider) => {
    setEditingProvider(p);
    setProviderForm({
      type: p.type,
      name: p.name,
      base_url: p.base_url || "",
      api_key: p.api_key === MASKED ? "" : p.api_key,
    });
  };

  if (loading) return <p style={{ color: "var(--text-muted)" }}>加载中…</p>;
  if (error && !config) return <p style={{ color: "var(--danger, #c00)" }}>{error}</p>;
  if (!config) return null;

  const c = form as RagConfig;
  const inputStyle: React.CSSProperties = {
    width: "100%",
    maxWidth: 400,
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    fontSize: 14,
  };
  const labelStyle: React.CSSProperties = { display: "block", marginBottom: 4, fontSize: 13, color: "var(--text-muted)" };
  const blockStyle = { marginBottom: 16 };
  const sectionStyle = { marginBottom: 28 };
  const needBaseUrl = (typeId: string) => providerTypes.find((t) => t.id === typeId)?.need_base_url ?? true;

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>RAG 配置</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 24, fontSize: 15 }}>
        参考 RAGFlow：先配置「模型提供商」（同一提供商的 API Key 可复用于 LLM / Embedding 等），再在「设置默认模型」中选择使用的 LLM 与 Embedding。保存后立即生效。
      </p>

      {message && <p style={{ color: "var(--success, #0a0)", marginBottom: 12 }}>{message}</p>}
      {error && <p style={{ color: "var(--danger, #c00)", marginBottom: 12 }}>{error}</p>}

      {/* 总开关 */}
      <div className="card" style={{ maxWidth: 640, marginBottom: 24 }}>
        <h3 style={{ marginBottom: 12, fontSize: 16 }}>总开关</h3>
        <div style={blockStyle}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={!!c.enabled}
              onChange={(e) => update("enabled", e.target.checked)}
            />
            <span>启用 RAG 答疑（否则使用关键词检索）</span>
          </label>
        </div>
      </div>

      {/* 模型提供商 */}
      <div className="card" style={{ maxWidth: 640, marginBottom: 24 }}>
        <h3 style={{ marginBottom: 12, fontSize: 16 }}>模型提供商</h3>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>
          添加一个或多个提供商并填写 API Key（及 Base URL）。同一提供商可同时提供 LLM、Embedding 等，在下方选择默认模型即可。
        </p>

        <div style={{ marginBottom: 12 }}>
          {providers.map((p) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 12px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                marginBottom: 8,
                background: "var(--bg-card, #fafafa)",
              }}
            >
              <div>
                <strong>{p.name || "未命名"}</strong>
                <span style={{ marginLeft: 8, fontSize: 13, color: "var(--text-muted)" }}>
                  {providerTypes.find((t) => t.id === p.type)?.name ?? p.type}
                </span>
                {p.base_url && (
                  <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-muted)" }}>{p.base_url}</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn-secondary" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => startEdit(p)}>
                  编辑
                </button>
                <button type="button" className="btn-secondary" style={{ padding: "4px 10px", fontSize: 13 }} onClick={() => removeProvider(p.id)}>
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>

        {(addingProvider || editingProvider) ? (
          <div style={{ padding: 12, border: "1px dashed var(--border)", borderRadius: 8, marginBottom: 12 }}>
            <div style={blockStyle}>
              <label style={labelStyle}>类型</label>
              <select
                style={inputStyle}
                value={providerForm.type}
                onChange={(e) => setProviderForm((f) => ({ ...f, type: e.target.value }))}
              >
                {providerTypes.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div style={blockStyle}>
              <label style={labelStyle}>名称（便于区分）</label>
              <input
                style={inputStyle}
                value={providerForm.name}
                onChange={(e) => setProviderForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="例如：自建 vLLM"
              />
            </div>
            {needBaseUrl(providerForm.type) && (
              <div style={blockStyle}>
                <label style={labelStyle}>Base URL</label>
                <input
                  style={inputStyle}
                  value={providerForm.base_url}
                  onChange={(e) => setProviderForm((f) => ({ ...f, base_url: e.target.value }))}
                  placeholder="https://api.openai.com/v1 或 http://localhost:8000/v1"
                />
              </div>
            )}
            <div style={blockStyle}>
              <label style={labelStyle}>API Key</label>
              <input
                type="password"
                style={inputStyle}
                value={providerForm.api_key}
                onChange={(e) => setProviderForm((f) => ({ ...f, api_key: e.target.value }))}
                placeholder="已配置则显示为 ***，留空则不修改"
              />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn-primary" onClick={addOrUpdateProvider}>
                {editingProvider ? "更新" : "添加"}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setAddingProvider(false);
                  setEditingProvider(null);
                  setProviderForm({ type: "openai_compatible", name: "", base_url: "", api_key: "" });
                }}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn-secondary" onClick={() => setAddingProvider(true)}>
            + 添加提供商
          </button>
        )}
      </div>

      {/* 设置默认模型 */}
      <div className="card" style={{ maxWidth: 640, marginBottom: 24 }}>
        <h3 style={{ marginBottom: 12, fontSize: 16 }}>设置默认模型</h3>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>
          从已添加的提供商中选择默认使用的 LLM 与 Embedding；Embedding 也可选「程序自带」。
        </p>
        <div style={sectionStyle}>
          <label style={labelStyle}>默认 LLM（大模型）</label>
          <select
            style={inputStyle}
            value={defaultLlm}
            onChange={(e) => setDefaultLlm(e.target.value)}
          >
            <option value="">请先添加提供商</option>
            {defaultLlmOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div style={sectionStyle}>
          <label style={labelStyle}>默认 Embedding（向量化）</label>
          <select
            style={inputStyle}
            value={defaultEmbedding}
            onChange={(e) => setDefaultEmbedding(e.target.value)}
          >
            <option value="">请选择</option>
            {defaultEmbeddingOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div style={sectionStyle}>
          <label style={labelStyle}>默认 VLM（视觉语言模型，图文理解）</label>
          <select
            style={inputStyle}
            value={defaultVlm}
            onChange={(e) => setDefaultVlm(e.target.value)}
          >
            <option value="">暂不使用</option>
            {defaultVlmOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div style={sectionStyle}>
          <label style={labelStyle}>默认 Rerank（检索重排）</label>
          <select
            style={inputStyle}
            value={defaultRerank}
            onChange={(e) => setDefaultRerank(e.target.value)}
          >
            <option value="">暂不使用</option>
            {defaultRerankOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={blockStyle}>
            <label style={labelStyle}>生成长度 max_tokens</label>
            <input
              type="number"
              style={{ ...inputStyle, width: 100 }}
              value={c.llm_max_tokens ?? 512}
              onChange={(e) => update("llm_max_tokens", parseInt(e.target.value, 10) || 512)}
              min={1}
              max={4096}
            />
          </div>
          <div style={blockStyle}>
            <label style={labelStyle}>temperature</label>
            <input
              type="number"
              step={0.1}
              style={{ ...inputStyle, width: 100 }}
              value={c.llm_temperature ?? 0.3}
              onChange={(e) => update("llm_temperature", parseFloat(e.target.value) || 0.3)}
              min={0}
              max={2}
            />
          </div>
        </div>
      </div>

      {/* 向量库与切片 */}
      <div className="card" style={{ maxWidth: 640, marginBottom: 24 }}>
        <h3 style={{ marginBottom: 12, fontSize: 16 }}>向量库与切片</h3>
        <div style={blockStyle}>
          <label style={labelStyle}>存储路径 vector_store_path</label>
          <input
            style={inputStyle}
            value={c.vector_store_path ?? ""}
            onChange={(e) => update("vector_store_path", e.target.value)}
            placeholder="./data/rag_vector_db"
          />
        </div>
        <div style={blockStyle}>
          <label style={labelStyle}>集合名 vector_collection_name</label>
          <input
            style={inputStyle}
            value={c.vector_collection_name ?? ""}
            onChange={(e) => update("vector_collection_name", e.target.value)}
            placeholder="qastudio_chunks"
          />
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={blockStyle}>
            <label style={labelStyle}>检索条数 top_k</label>
            <input
              type="number"
              style={{ ...inputStyle, width: 100 }}
              value={c.top_k ?? 5}
              onChange={(e) => update("top_k", parseInt(e.target.value, 10) || 5)}
              min={1}
              max={20}
            />
          </div>
          <div style={blockStyle}>
            <label style={labelStyle}>chunk_size</label>
            <input
              type="number"
              style={{ ...inputStyle, width: 100 }}
              value={c.chunk_size ?? 400}
              onChange={(e) => update("chunk_size", parseInt(e.target.value, 10) || 400)}
              min={100}
            />
          </div>
          <div style={blockStyle}>
            <label style={labelStyle}>chunk_overlap</label>
            <input
              type="number"
              style={{ ...inputStyle, width: 100 }}
              value={c.chunk_overlap ?? 80}
              onChange={(e) => update("chunk_overlap", parseInt(e.target.value, 10) || 80)}
              min={0}
            />
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <button type="button" className="btn-primary" onClick={save} disabled={saving}>
          {saving ? "保存中…" : "保存配置"}
        </button>
      </div>

      <div className="card" style={{ maxWidth: 640 }}>
        <h3 style={{ marginBottom: 8, fontSize: 16 }}>课程知识库索引</h3>
        <p style={{ fontSize: 14, color: "var(--text-muted)", marginBottom: 12 }}>
          启用 RAG 后，需在「课程管理」中为各课程执行「重建索引」，索引来源为课程下知识库文档、知识点与 PPT 幻灯片。
        </p>
      </div>
    </div>
  );
}
