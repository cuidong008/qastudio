import { useEffect, useState } from "react";
import { api } from "../../api/client";

type ClassItem = {
  id: number;
  name: string;
  term: string | null;
  course_id: number | null;
  course_name: string | null;
  student_count: number;
  created_at: string | null;
};

type CourseItem = {
  id: number;
  name: string;
  code: string | null;
};

type StudentItem = {
  id: number;
  username: string;
  display_name: string | null;
  class_id: number | null;
};

export default function TeacherClasses() {
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [courses, setCourses] = useState<CourseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", term: "", course_id: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [studentsModalClassId, setStudentsModalClassId] = useState<number | null>(null);
  const [classStudents, setClassStudents] = useState<StudentItem[]>([]);
  const [candidateStudents, setCandidateStudents] = useState<StudentItem[]>([]);
  const [selectedStudentIds, setSelectedStudentIds] = useState<number[]>([]);
  const [assigning, setAssigning] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([api.teacher.classes.list(), api.teacher.courses.list()])
      .then(([classList, courseList]) => {
        setClasses(classList);
        setCourses(courseList.map((c) => ({ id: c.id, name: c.name, code: c.code })));
      })
      .catch(() => {
        setClasses([]);
        setCourses([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const openCreate = () => {
    setForm({ name: "", term: "", course_id: courses[0] ? String(courses[0].id) : "" });
    setModal("create");
    setError("");
  };

  const openEdit = (c: ClassItem) => {
    setEditId(c.id);
    setForm({ name: c.name, term: c.term || "", course_id: c.course_id ? String(c.course_id) : "" });
    setModal("edit");
    setError("");
  };

  const submitCreate = () => {
    if (!form.course_id) {
      setError("请选择关联课程");
      return;
    }
    setSaving(true);
    setError("");
    api.teacher.classes
      .create({
        name: form.name.trim(),
        term: form.term.trim() || undefined,
        course_id: Number(form.course_id),
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
    if (!form.course_id) {
      setError("请选择关联课程");
      return;
    }
    setSaving(true);
    setError("");
    api.teacher.classes
      .update(editId, {
        name: form.name.trim(),
        term: form.term.trim() || undefined,
        course_id: Number(form.course_id),
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
    if (!confirm("确定删除该班级？")) return;
    api.teacher.classes.delete(id).then(load).catch((e) => alert(e?.message || "删除失败"));
  };

  const openStudentsModal = (classId: number) => {
    setStudentsModalClassId(classId);
    setSelectedStudentIds([]);
    Promise.all([api.teacher.classes.students(classId), api.teacher.students.list({ only_unassigned: true })])
      .then(([inClass, unassigned]) => {
        setClassStudents(inClass);
        setCandidateStudents(unassigned);
      })
      .catch(() => {
        setClassStudents([]);
        setCandidateStudents([]);
      });
  };

  const toggleCandidate = (id: number) => {
    setSelectedStudentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const assignStudents = () => {
    if (studentsModalClassId == null || selectedStudentIds.length === 0) return;
    setAssigning(true);
    api.teacher.classes
      .assignStudents(studentsModalClassId, selectedStudentIds)
      .then(() => openStudentsModal(studentsModalClassId))
      .catch((e) => alert(e?.message || "添加学生失败"))
      .finally(() => setAssigning(false));
  };

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>我的班级</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 20, fontSize: 15 }}>教师自主管理班级，创建时绑定课程并可添加学生</p>
      <div style={{ marginBottom: 20 }}>
        <button type="button" className="btn-primary" onClick={openCreate}>
          新建班级
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
                <th style={{ textAlign: "left", padding: "10px 12px" }}>班级</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>学期</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>关联课程</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>学生数</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {classes.map((c) => (
                <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 12px" }}>{c.id}</td>
                  <td style={{ padding: "10px 12px" }}>{c.name}</td>
                  <td style={{ padding: "10px 12px" }}>{c.term || "—"}</td>
                  <td style={{ padding: "10px 12px" }}>{c.course_name || "—"}</td>
                  <td style={{ padding: "10px 12px" }}>{c.student_count}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <button type="button" className="btn-ghost" style={{ marginRight: 8 }} onClick={() => openEdit(c)}>
                      编辑
                    </button>
                    <button type="button" className="btn-ghost" style={{ marginRight: 8 }} onClick={() => openStudentsModal(c.id)}>
                      学生管理
                    </button>
                    <button type="button" className="btn-ghost" style={{ color: "var(--danger, #c00)" }} onClick={() => doDelete(c.id)}>
                      删除
                    </button>
                  </td>
                </tr>
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
          <div className="card" style={{ minWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 16 }}>{modal === "create" ? "新建班级" : "编辑班级"}</h3>
            {error && <p style={{ color: "var(--danger, #c00)", marginBottom: 12, fontSize: 14 }}>{error}</p>}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>班级名称</span>
                <input type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} style={{ width: "100%" }} />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>学期</span>
                <input type="text" value={form.term} onChange={(e) => setForm((f) => ({ ...f, term: e.target.value }))} placeholder="如 2026-春" style={{ width: "100%" }} />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>关联课程</span>
                <select value={form.course_id} onChange={(e) => setForm((f) => ({ ...f, course_id: e.target.value }))} style={{ width: "100%" }}>
                  <option value="">请选择课程</option>
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
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

      {studentsModalClassId != null && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 110 }}
          onClick={() => !assigning && setStudentsModalClassId(null)}
        >
          <div className="card" style={{ width: "min(860px, 92vw)", maxHeight: "80vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>班级学生管理</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div>
                <h4 style={{ marginTop: 0 }}>已在班级</h4>
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {classStudents.map((s) => (
                    <li key={s.id}>{s.display_name || s.username}</li>
                  ))}
                  {classStudents.length === 0 && <li style={{ color: "var(--text-muted)" }}>暂无学生</li>}
                </ul>
              </div>
              <div>
                <h4 style={{ marginTop: 0 }}>可添加学生（未分配班级）</h4>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflow: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
                  {candidateStudents.map((s) => (
                    <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input type="checkbox" checked={selectedStudentIds.includes(s.id)} onChange={() => toggleCandidate(s.id)} />
                      <span>{s.display_name || s.username}</span>
                    </label>
                  ))}
                  {candidateStudents.length === 0 && <span style={{ color: "var(--text-muted)" }}>暂无可添加学生</span>}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn-ghost" onClick={() => setStudentsModalClassId(null)} disabled={assigning}>
                关闭
              </button>
              <button type="button" className="btn-primary" onClick={assignStudents} disabled={assigning || selectedStudentIds.length === 0}>
                {assigning ? "添加中…" : "添加到班级"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
