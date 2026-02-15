import { useState, useEffect } from "react";
import { api } from "../../api/client";

type ClassItem = { id: number; name: string; term: string | null; created_at: string | null };

export default function AdminClasses() {
  const [list, setList] = useState<ClassItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", term: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true);
    api.admin.classes.list().then(setList).catch(() => setList([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setForm({ name: "", term: "" });
    setModal("create");
    setError("");
  };
  const openEdit = (c: ClassItem) => {
    setEditId(c.id);
    setForm({ name: c.name, term: c.term || "" });
    setModal("edit");
    setError("");
  };
  const submitCreate = () => {
    setSaving(true);
    setError("");
    api.admin.classes.create({ name: form.name.trim(), term: form.term.trim() || undefined })
      .then(() => { setModal(null); load(); })
      .catch((e) => setError(e?.message || "创建失败"))
      .finally(() => setSaving(false));
  };
  const submitEdit = () => {
    if (editId == null) return;
    setSaving(true);
    setError("");
    api.admin.classes.update(editId, { name: form.name.trim(), term: form.term.trim() || undefined })
      .then(() => { setModal(null); setEditId(null); load(); })
      .catch((e) => setError(e?.message || "保存失败"))
      .finally(() => setSaving(false));
  };
  const doDelete = (id: number) => {
    if (!confirm("确定删除该班级？")) return;
    api.admin.classes.delete(id).then(() => load()).catch((e) => alert(e?.message || "删除失败"));
  };

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>班级管理</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 20, fontSize: 15 }}>班级与学期</p>
      <div style={{ marginBottom: 20 }}>
        <button type="button" className="btn-primary" onClick={openCreate}>新建班级</button>
      </div>
      {loading ? <p style={{ color: "var(--text-muted)" }}>加载中…</p> : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>ID</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>名称</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>学期</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 12px" }}>{c.id}</td>
                  <td style={{ padding: "10px 12px" }}>{c.name}</td>
                  <td style={{ padding: "10px 12px" }}>{c.term || "—"}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <button type="button" className="btn-ghost" style={{ marginRight: 8 }} onClick={() => openEdit(c)}>编辑</button>
                    <button type="button" className="btn-ghost" style={{ color: "var(--danger, #c00)" }} onClick={() => doDelete(c.id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={() => !saving && setModal(null)}>
          <div className="card" style={{ minWidth: 360 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 16 }}>{modal === "create" ? "新建班级" : "编辑班级"}</h3>
            {error && <p style={{ color: "var(--danger, #c00)", marginBottom: 12, fontSize: 14 }}>{error}</p>}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>名称</span>
                <input type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }} />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>学期</span>
                <input type="text" value={form.term} onChange={(e) => setForm((f) => ({ ...f, term: e.target.value }))} placeholder="如 2024-秋" style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }} />
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
