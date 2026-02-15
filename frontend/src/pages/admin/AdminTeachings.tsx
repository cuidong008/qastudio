import { useState, useEffect } from "react";
import { api } from "../../api/client";

type TeachingItem = {
  id: number;
  course_id: number;
  class_id: number;
  teacher_id: number;
  term: string | null;
  is_active: boolean;
  course_name: string | null;
  class_name: string | null;
  teacher_name: string | null;
};
type CourseItem = { id: number; name: string };
type ClassItem = { id: number; name: string };
type UserItem = { id: number; username: string; role: string; display_name: string | null };

export default function AdminTeachings() {
  const [list, setList] = useState<TeachingItem[]>([]);
  const [courses, setCourses] = useState<CourseItem[]>([]);
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [teachers, setTeachers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ course_id: "", class_id: "", teacher_id: "", term: "", is_active: true });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true);
    api.admin.teachings.list().then(setList).catch(() => setList([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    api.admin.courses.list().then((r) => setCourses(r));
    api.admin.classes.list().then((r) => setClasses(r));
    api.admin.users.list({ role: "teacher" }).then((r) => setTeachers(r));
  }, []);

  const openCreate = () => {
    setForm({ course_id: "", class_id: "", teacher_id: "", term: "", is_active: true });
    setModal("create");
    setError("");
  };
  const openEdit = (t: TeachingItem) => {
    setEditId(t.id);
    setForm({
      course_id: String(t.course_id),
      class_id: String(t.class_id),
      teacher_id: String(t.teacher_id),
      term: t.term || "",
      is_active: t.is_active,
    });
    setModal("edit");
    setError("");
  };
  const submitCreate = () => {
    const course_id = parseInt(form.course_id, 10);
    const class_id = parseInt(form.class_id, 10);
    const teacher_id = parseInt(form.teacher_id, 10);
    if (!course_id || !class_id || !teacher_id) {
      setError("请选择课程、班级和授课教师");
      return;
    }
    setSaving(true);
    setError("");
    api.admin.teachings.create({
      course_id,
      class_id,
      teacher_id,
      term: form.term.trim() || undefined,
      is_active: form.is_active,
    })
      .then(() => { setModal(null); load(); })
      .catch((e) => setError(e?.message || "创建失败"))
      .finally(() => setSaving(false));
  };
  const submitEdit = () => {
    if (editId == null) return;
    const teacher_id = form.teacher_id ? parseInt(form.teacher_id, 10) : undefined;
    setSaving(true);
    setError("");
    api.admin.teachings.update(editId, {
      teacher_id,
      term: form.term.trim() || undefined,
      is_active: form.is_active,
    })
      .then(() => { setModal(null); setEditId(null); load(); })
      .catch((e) => setError(e?.message || "保存失败"))
      .finally(() => setSaving(false));
  };
  const doDelete = (id: number) => {
    if (!confirm("确定删除该开课记录？")) return;
    api.admin.teachings.delete(id).then(() => load()).catch((e) => alert(e?.message || "删除失败"));
  };

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>开课分配</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 20, fontSize: 15 }}>将课程开给班级并指定授课教师</p>
      <div style={{ marginBottom: 20 }}>
        <button type="button" className="btn-primary" onClick={openCreate}>新建开课</button>
      </div>
      {loading ? <p style={{ color: "var(--text-muted)" }}>加载中…</p> : (
        <div className="card" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>课程</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>班级</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>授课教师</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>学期</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>状态</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 12px" }}>{t.course_name ?? t.course_id}</td>
                  <td style={{ padding: "10px 12px" }}>{t.class_name ?? t.class_id}</td>
                  <td style={{ padding: "10px 12px" }}>{t.teacher_name ?? t.teacher_id}</td>
                  <td style={{ padding: "10px 12px" }}>{t.term || "—"}</td>
                  <td style={{ padding: "10px 12px" }}>{t.is_active ? "有效" : "停用"}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <button type="button" className="btn-ghost" style={{ marginRight: 8 }} onClick={() => openEdit(t)}>编辑</button>
                    <button type="button" className="btn-ghost" style={{ color: "var(--danger, #c00)" }} onClick={() => doDelete(t.id)}>删除</button>
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
            <h3 style={{ marginBottom: 16 }}>{modal === "create" ? "新建开课" : "编辑开课"}</h3>
            {error && <p style={{ color: "var(--danger, #c00)", marginBottom: 12, fontSize: 14 }}>{error}</p>}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>课程</span>
                <select
                  value={form.course_id}
                  onChange={(e) => setForm((f) => ({ ...f, course_id: e.target.value }))}
                  disabled={modal === "edit"}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }}
                >
                  <option value="">请选择</option>
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>班级</span>
                <select
                  value={form.class_id}
                  onChange={(e) => setForm((f) => ({ ...f, class_id: e.target.value }))}
                  disabled={modal === "edit"}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }}
                >
                  <option value="">请选择</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>授课教师</span>
                <select
                  value={form.teacher_id}
                  onChange={(e) => setForm((f) => ({ ...f, teacher_id: e.target.value }))}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }}
                >
                  <option value="">请选择</option>
                  {teachers.map((u) => (
                    <option key={u.id} value={u.id}>{u.display_name || u.username}</option>
                  ))}
                </select>
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>学期（可选）</span>
                <input type="text" value={form.term} onChange={(e) => setForm((f) => ({ ...f, term: e.target.value }))} placeholder="如 2024-秋" style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))} />
                <span style={{ fontSize: 14 }}>有效</span>
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
