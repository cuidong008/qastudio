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
  const [modal, setModal] = useState<"create" | "edit" | "batch" | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ course_id: "", class_id: "", teacher_id: "", term: "", is_active: true });
  const [batchForm, setBatchForm] = useState({ course_id: "", teacher_id: "", term: "", is_active: true, class_ids: [] as number[] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [batchResult, setBatchResult] = useState<{ created: number; skipped: { class_name?: string; reason: string }[] } | null>(null);

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
    setBatchResult(null);
  };
  const openBatch = () => {
    setBatchForm({ course_id: "", teacher_id: "", term: "", is_active: true, class_ids: [] });
    setModal("batch");
    setError("");
    setBatchResult(null);
  };
  const toggleBatchClass = (classId: number) => {
    setBatchForm((f) => ({
      ...f,
      class_ids: f.class_ids.includes(classId) ? f.class_ids.filter((id) => id !== classId) : [...f.class_ids, classId],
    }));
  };
  const submitBatch = () => {
    const course_id = parseInt(batchForm.course_id, 10);
    const teacher_id = parseInt(batchForm.teacher_id, 10);
    if (!course_id || !teacher_id) {
      setError("请选择课程和授课教师");
      return;
    }
    if (batchForm.class_ids.length === 0) {
      setError("请至少选择一个班级");
      return;
    }
    setSaving(true);
    setError("");
    api.admin.teachings.createBatch({
      course_id,
      teacher_id,
      class_ids: batchForm.class_ids,
      term: batchForm.term.trim() || undefined,
      is_active: batchForm.is_active,
    })
      .then((res) => {
        setBatchResult({
          created: res.created.length,
          skipped: res.skipped.map((s) => ({ class_name: s.class_name, reason: s.reason })),
        });
        if (res.created.length > 0) load();
      })
      .catch((e) => setError(e?.message || "批量创建失败"))
      .finally(() => setSaving(false));
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

  const listSorted = [...list].sort((a, b) => {
    const cn = (a.course_name ?? "") || String(a.course_id);
    const cn2 = (b.course_name ?? "") || String(b.course_id);
    if (cn !== cn2) return cn.localeCompare(cn2);
    const cl = (a.class_name ?? "") || String(a.class_id);
    const cl2 = (b.class_name ?? "") || String(b.class_id);
    return cl.localeCompare(cl2);
  });

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>开课分配</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 8, fontSize: 15 }}>将课程开给班级并指定授课教师。一门课程可以开给多个班级（例如同一教师给多个班开同一门课），同一课程、同一班级、同一学期仅保留一条开课记录。</p>
      <div style={{ marginBottom: 20, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button type="button" className="btn-primary" onClick={openCreate}>新建开课（单条）</button>
        <button type="button" className="btn-ghost" style={{ border: "1px solid var(--border)" }} onClick={openBatch}>批量分配（一门课多班级）</button>
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
              {listSorted.map((t) => (
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

      {modal === "batch" && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }} onClick={() => !saving && setModal(null)}>
          <div className="card" style={{ minWidth: 400, maxWidth: "90vw", maxHeight: "85vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 16 }}>批量分配（一门课多班级）</h3>
            {error && <p style={{ color: "var(--danger, #c00)", marginBottom: 12, fontSize: 14 }}>{error}</p>}
            {batchResult ? (
              <>
                <p style={{ marginBottom: 8, fontSize: 15 }}>已创建 <strong>{batchResult.created}</strong> 条开课记录。</p>
                {batchResult.skipped.length > 0 && (
                  <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 4 }}>跳过 {batchResult.skipped.length} 条（已存在）：</p>
                )}
                <ul style={{ margin: "0 0 16px 0", paddingLeft: 20, color: "var(--text-muted)", fontSize: 14 }}>
                  {batchResult.skipped.map((s, i) => (
                    <li key={i}>{s.class_name ?? "班级"}：{s.reason}</li>
                  ))}
                </ul>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button type="button" className="btn-primary" onClick={() => { setModal(null); setBatchResult(null); }}>关闭</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <label>
                    <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>课程</span>
                    <select
                      value={batchForm.course_id}
                      onChange={(e) => setBatchForm((f) => ({ ...f, course_id: e.target.value }))}
                      style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }}
                    >
                      <option value="">请选择</option>
                      {courses.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>授课教师</span>
                    <select
                      value={batchForm.teacher_id}
                      onChange={(e) => setBatchForm((f) => ({ ...f, teacher_id: e.target.value }))}
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
                    <input type="text" value={batchForm.term} onChange={(e) => setBatchForm((f) => ({ ...f, term: e.target.value }))} placeholder="如 2024-秋" style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }} />
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={batchForm.is_active} onChange={(e) => setBatchForm((f) => ({ ...f, is_active: e.target.checked }))} />
                    <span style={{ fontSize: 14 }}>有效</span>
                  </label>
                  <label>
                    <span style={{ display: "block", marginBottom: 6, fontSize: 14 }}>选择班级（可多选）</span>
                    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "8px 12px", maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                      {classes.map((c) => (
                        <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                          <input type="checkbox" checked={batchForm.class_ids.includes(c.id)} onChange={() => toggleBatchClass(c.id)} />
                          <span>{c.name}</span>
                        </label>
                      ))}
                    </div>
                  </label>
                </div>
                <div style={{ marginTop: 20, display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button type="button" className="btn-ghost" onClick={() => setModal(null)} disabled={saving}>取消</button>
                  <button type="button" className="btn-primary" onClick={submitBatch} disabled={saving}>{saving ? "提交中…" : "批量创建"}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {modal && modal !== "batch" && (
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
