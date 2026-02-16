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
  student_no: string | null;
  display_name: string | null;
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

  const [addModalClassId, setAddModalClassId] = useState<number | null>(null);
  const [manageModalClassId, setManageModalClassId] = useState<number | null>(null);
  const [candidateStudents, setCandidateStudents] = useState<StudentItem[]>([]);
  const [classStudents, setClassStudents] = useState<StudentItem[]>([]);
  const [selectedStudentIds, setSelectedStudentIds] = useState<number[]>([]);
  const [addSearchKeyword, setAddSearchKeyword] = useState("");
  const [manageSearchKeyword, setManageSearchKeyword] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [removingStudentId, setRemovingStudentId] = useState<number | null>(null);

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

  const loadClassStudents = (classId: number, keyword = "") => {
    api.teacher.classes
      .students(classId, { q: keyword || undefined })
      .then(setClassStudents)
      .catch(() => setClassStudents([]));
  };

  const loadCandidateStudents = (classId: number, keyword = "") => {
    Promise.all([api.teacher.classes.students(classId), api.teacher.students.list({ q: keyword || undefined })])
      .then(([inClass, allStudents]) => {
        const inClassSet = new Set(inClass.map((s) => s.id));
        setCandidateStudents(allStudents.filter((s) => !inClassSet.has(s.id)));
      })
      .catch(() => setCandidateStudents([]));
  };

  const openAddStudentsModal = (classId: number) => {
    setAddModalClassId(classId);
    setSelectedStudentIds([]);
    setAddSearchKeyword("");
    loadCandidateStudents(classId, "");
  };

  const openManageStudentsModal = (classId: number) => {
    setManageModalClassId(classId);
    setManageSearchKeyword("");
    loadClassStudents(classId, "");
  };

  const toggleCandidate = (id: number) => {
    setSelectedStudentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const searchAddStudents = () => {
    if (addModalClassId == null) return;
    loadCandidateStudents(addModalClassId, addSearchKeyword.trim());
  };

  const resetAddStudentsSearch = () => {
    if (addModalClassId == null) return;
    setAddSearchKeyword("");
    setSelectedStudentIds([]);
    loadCandidateStudents(addModalClassId, "");
  };

  const searchManageStudents = () => {
    if (manageModalClassId == null) return;
    loadClassStudents(manageModalClassId, manageSearchKeyword.trim());
  };

  const resetManageStudentsSearch = () => {
    if (manageModalClassId == null) return;
    setManageSearchKeyword("");
    loadClassStudents(manageModalClassId, "");
  };

  const assignStudents = () => {
    if (addModalClassId == null || selectedStudentIds.length === 0) return;
    setAssigning(true);
    api.teacher.classes
      .assignStudents(addModalClassId, { student_ids: selectedStudentIds })
      .then(() => {
        setSelectedStudentIds([]);
        loadCandidateStudents(addModalClassId, addSearchKeyword.trim());
        load();
      })
      .catch((e) => alert(e?.message || "添加学生失败"))
      .finally(() => setAssigning(false));
  };

  const removeStudent = (studentId: number) => {
    if (manageModalClassId == null) return;
    if (!confirm("确定将该学生从当前班级移除？")) return;
    setRemovingStudentId(studentId);
    api.teacher.classes
      .removeStudent(manageModalClassId, studentId)
      .then(() => {
        loadClassStudents(manageModalClassId, manageSearchKeyword.trim());
        load();
      })
      .catch((e) => alert(e?.message || "移除失败"))
      .finally(() => setRemovingStudentId(null));
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
                    <button type="button" className="btn-ghost" style={{ marginRight: 8 }} onClick={() => openAddStudentsModal(c.id)}>
                      添加学生
                    </button>
                    <button type="button" className="btn-ghost" style={{ marginRight: 8 }} onClick={() => openManageStudentsModal(c.id)}>
                      管理学生
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

      {addModalClassId != null && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 110 }}
          onClick={() => !assigning && setAddModalClassId(null)}
        >
          <div className="card" style={{ width: "min(760px, 92vw)", maxHeight: "80vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>添加学生到班级</h3>
            <div style={{ marginBottom: 12 }}>
              <div style={{ position: "relative", minWidth: 280, maxWidth: 420 }}>
                <input
                  type="text"
                  value={addSearchKeyword}
                  onChange={(e) => setAddSearchKeyword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      searchAddStudents();
                    }
                  }}
                  placeholder="按学号、姓名或用户名搜索"
                  style={{ width: "100%", paddingRight: addSearchKeyword ? 28 : undefined }}
                />
                {addSearchKeyword && (
                  <button
                    type="button"
                    onClick={resetAddStudentsSearch}
                    aria-label="清空搜索"
                    style={{
                      position: "absolute",
                      right: 6,
                      top: "50%",
                      transform: "translateY(-50%)",
                      border: 0,
                      background: "transparent",
                      cursor: "pointer",
                      color: "var(--text-muted)",
                      fontSize: 16,
                      lineHeight: 1,
                      padding: 2,
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 340, overflow: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 10 }}>
              {candidateStudents.map((s) => (
                <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" checked={selectedStudentIds.includes(s.id)} onChange={() => toggleCandidate(s.id)} />
                  <span>{s.student_no || "无学号"} · {s.display_name || s.username}</span>
                </label>
              ))}
              {candidateStudents.length === 0 && <span style={{ color: "var(--text-muted)" }}>无匹配学生</span>}
            </div>
            <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="btn-ghost" onClick={() => setAddModalClassId(null)} disabled={assigning}>
                关闭
              </button>
              <button type="button" className="btn-primary" onClick={assignStudents} disabled={assigning || selectedStudentIds.length === 0}>
                {assigning ? "添加中…" : "添加到班级"}
              </button>
            </div>
          </div>
        </div>
      )}

      {manageModalClassId != null && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 110 }}
          onClick={() => setManageModalClassId(null)}
        >
          <div className="card" style={{ width: "min(760px, 92vw)", maxHeight: "80vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>管理班级学生</h3>
            <div style={{ marginBottom: 12 }}>
              <div style={{ position: "relative", minWidth: 280, maxWidth: 420 }}>
                <input
                  type="text"
                  value={manageSearchKeyword}
                  onChange={(e) => setManageSearchKeyword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      searchManageStudents();
                    }
                  }}
                  placeholder="按学号、姓名或用户名搜索"
                  style={{ width: "100%", paddingRight: manageSearchKeyword ? 28 : undefined }}
                />
                {manageSearchKeyword && (
                  <button
                    type="button"
                    onClick={resetManageStudentsSearch}
                    aria-label="清空搜索"
                    style={{
                      position: "absolute",
                      right: 6,
                      top: "50%",
                      transform: "translateY(-50%)",
                      border: 0,
                      background: "transparent",
                      cursor: "pointer",
                      color: "var(--text-muted)",
                      fontSize: 16,
                      lineHeight: 1,
                      padding: 2,
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {classStudents.map((s) => (
                <li key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span>{s.student_no || "无学号"} · {s.display_name || s.username}</span>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => removeStudent(s.id)}
                    disabled={removingStudentId === s.id}
                    style={{ color: "var(--danger, #c00)", minHeight: 28, padding: "4px 8px" }}
                  >
                    {removingStudentId === s.id ? "移除中…" : "移除"}
                  </button>
                </li>
              ))}
              {classStudents.length === 0 && <li style={{ color: "var(--text-muted)" }}>无匹配学生</li>}
            </ul>
            <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="btn-ghost" onClick={() => setManageModalClassId(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
