import { useState, useEffect } from "react";
import { api } from "../../api/client";

type User = { id: number; username: string; role: string; display_name: string | null; student_no: string | null; created_at: string | null };

export default function AdminUsers() {
  const [list, setList] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [roleFilter, setRoleFilter] = useState<string>("");
  const [q, setQ] = useState("");
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ username: "", password: "", role: "student", display_name: "", student_no: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true);
    api.admin.users.list({ role: roleFilter || undefined, q: q || undefined }).then(setList).catch(() => setList([])).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, [roleFilter, q]);
  const openCreate = () => {
    setForm({ username: "", password: "123456", role: "student", display_name: "", student_no: "" });
    setModal("create");
    setError("");
  };
  const openEdit = (u: User) => {
    setEditId(u.id);
    setForm({ username: u.username, password: "", role: u.role, display_name: u.display_name || "", student_no: u.student_no || "" });
    setModal("edit");
    setError("");
  };
  const submitCreate = () => {
    setSaving(true);
    setError("");
    api.admin.users
      .create({
        username: form.username.trim(),
        password: form.password || "123456",
        role: form.role,
        display_name: form.display_name.trim() || undefined,
        student_no: form.student_no.trim() || undefined,
      })
      .then(() => { setModal(null); load(); })
      .catch((e) => setError(e?.message || "创建失败"))
      .finally(() => setSaving(false));
  };
  const submitEdit = () => {
    if (editId == null) return;
    setSaving(true);
    setError("");
    const body: { password?: string; role?: string; display_name?: string; student_no?: string } = {};
    if (form.password) body.password = form.password;
    body.role = form.role;
    body.display_name = form.display_name.trim() || undefined;
    body.student_no = form.student_no.trim() || undefined;
    api.admin.users
      .update(editId, body)
      .then(() => { setModal(null); setEditId(null); load(); })
      .catch((e) => setError(e?.message || "保存失败"))
      .finally(() => setSaving(false));
  };
  const doDelete = (id: number) => {
    if (!confirm("确定删除该用户？")) return;
    api.admin.users.delete(id).then(() => load()).catch((e) => alert(e?.message || "删除失败"));
  };

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>用户管理</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 20, fontSize: 15 }}>创建、编辑用户与角色、学号/工号维护</p>
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="搜索用户名/姓名"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ padding: "8px 12px", minWidth: 160, border: "1px solid var(--border)", borderRadius: 6 }}
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          style={{ padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }}
        >
          <option value="">全部角色</option>
          <option value="student">学生</option>
          <option value="teacher">教师</option>
          <option value="admin">管理员</option>
        </select>
        <button type="button" className="btn-primary" onClick={openCreate}>新建用户</button>
      </div>
      {loading ? <p style={{ color: "var(--text-muted)" }}>加载中…</p> : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>ID</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>用户名</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>学号/工号</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>姓名</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>角色</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 12px" }}>{u.id}</td>
                  <td style={{ padding: "10px 12px" }}>{u.username}</td>
                  <td style={{ padding: "10px 12px" }}>{u.student_no || "—"}</td>
                  <td style={{ padding: "10px 12px" }}>{u.display_name || "—"}</td>
                  <td style={{ padding: "10px 12px" }}>{u.role === "admin" ? "管理员" : u.role === "teacher" ? "教师" : "学生"}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <button type="button" className="btn-ghost" style={{ marginRight: 8 }} onClick={() => openEdit(u)}>编辑</button>
                    <button type="button" className="btn-ghost" style={{ color: "var(--danger, #c00)" }} onClick={() => doDelete(u.id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={() => !saving && setModal(null)}>
          <div className="card" style={{ minWidth: 360, maxWidth: "90vw" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 16 }}>{modal === "create" ? "新建用户" : "编辑用户"}</h3>
            {error && <p style={{ color: "var(--danger, #c00)", marginBottom: 12, fontSize: 14 }}>{error}</p>}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>用户名</span>
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                  disabled={modal === "edit"}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }}
                />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>密码{modal === "edit" ? "（不填则不修改）" : ""}</span>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder={modal === "edit" ? "留空保持不变" : ""}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }}
                />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>角色</span>
                <select
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }}
                >
                  <option value="student">学生</option>
                  <option value="teacher">教师</option>
                  <option value="admin">管理员</option>
                </select>
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>显示名</span>
                <input
                  type="text"
                  value={form.display_name}
                  onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }}
                />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>{form.role === "teacher" ? "工号" : "学号"}</span>
                <input
                  type="text"
                  value={form.student_no}
                  onChange={(e) => setForm((f) => ({ ...f, student_no: e.target.value }))}
                  placeholder={form.role === "teacher" ? "输入教师工号" : "输入学生学号"}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }}
                />
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
