import { useState, useEffect, useMemo } from "react";
import { api } from "../../api/client";

const PAGE_SIZE_OPTIONS = [10, 20, 30, 50, 100] as const;

type User = { id: number; username: string; role: string; display_name: string | null; student_no: string | null; admin_class_or_dept: string | null; created_at: string | null };

export default function AdminUsers() {
  const [list, setList] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  const pagedList = useMemo(
    () => list.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [list, currentPage, pageSize]
  );
  const [roleFilter, setRoleFilter] = useState<string>("");
  const [q, setQ] = useState("");
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ username: "", password: "", role: "student", display_name: "", student_no: "", admin_class_or_dept: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; errors: string[]; message: string } | null>(null);

  const load = () => {
    setLoading(true);
    api.admin.users.list({ role: roleFilter || undefined, q: q || undefined }).then(setList).catch(() => setList([])).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, [roleFilter, q]);
  useEffect(() => {
    setCurrentPage(1);
  }, [roleFilter, q]);
  const openCreate = () => {
    setForm({ username: "", password: "123456", role: "student", display_name: "", student_no: "", admin_class_or_dept: "" });
    setModal("create");
    setError("");
  };
  const openEdit = (u: User) => {
    setEditId(u.id);
    setForm({ username: u.username, password: "", role: u.role, display_name: u.display_name || "", student_no: u.student_no || "", admin_class_or_dept: u.admin_class_or_dept || "" });
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
        admin_class_or_dept: form.admin_class_or_dept.trim() || undefined,
      })
      .then(() => { setModal(null); load(); })
      .catch((e) => setError(e?.message || "创建失败"))
      .finally(() => setSaving(false));
  };
  const submitEdit = () => {
    if (editId == null) return;
    setSaving(true);
    setError("");
    const body: { password?: string; role?: string; display_name?: string; student_no?: string; admin_class_or_dept?: string } = {};
    if (form.password) body.password = form.password;
    body.role = form.role;
    body.display_name = form.display_name.trim() || undefined;
    body.student_no = form.student_no.trim() || undefined;
    body.admin_class_or_dept = form.admin_class_or_dept.trim() || undefined;
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

  const downloadImportTemplate = () => {
    api.admin.users
      .downloadImportTemplate()
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "用户导入模版.csv";
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((e) => alert(e?.message || "下载失败"));
  };

  const submitImport = () => {
    if (!importFile) return;
    setImporting(true);
    setImportResult(null);
    api.admin.users
      .importUsers(importFile)
      .then((res) => {
        setImportResult({
          imported: res.imported,
          errors: res.errors || [],
          message: res.message || "",
        });
        load();
      })
      .catch((e) => alert(e?.message || "导入失败"))
      .finally(() => setImporting(false));
  };

  return (
    <div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600 }}>用户管理</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: 20, fontSize: 15 }}>创建、编辑用户与角色、学号/工号维护</p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
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
          <option value="teaching_leader">教研组长</option>
          <option value="admin">管理员</option>
        </select>
        <button type="button" className="btn-primary" onClick={openCreate}>新建用户</button>
        <button type="button" className="btn-secondary" onClick={() => { setImportModalOpen(true); setImportFile(null); setImportResult(null); }} style={{ marginLeft: "1em" }}>
          批量导入
        </button>
        <button type="button" className="btn-secondary" onClick={downloadImportTemplate} style={{ marginLeft: "1em" }}>
          下载导入模版
        </button>
        <span style={{ color: "var(--text-muted)", fontSize: 13, marginLeft: "1em" }}>
          下载的是批量导入用户时用的CSV模版文件
        </span>
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
                <th style={{ textAlign: "left", padding: "10px 12px", width: "9em", maxWidth: "9em" }}>行政班级/部门</th>
                <th style={{ textAlign: "left", padding: "10px 12px" }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedList.map((u) => (
                <tr key={u.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 12px" }}>{u.id}</td>
                  <td style={{ padding: "10px 12px" }}>{u.username}</td>
                  <td style={{ padding: "10px 12px" }}>{u.student_no || "—"}</td>
                  <td style={{ padding: "10px 12px" }}>{u.display_name || "—"}</td>
                  <td style={{ padding: "10px 12px" }}>{u.role === "admin" ? "管理员" : u.role === "teacher" ? "教师" : u.role === "teaching_leader" ? "教研组长" : "学生"}</td>
                  <td style={{ padding: "10px 12px", width: "9em", maxWidth: "9em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={u.admin_class_or_dept || undefined}>{u.admin_class_or_dept || "—"}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <button type="button" className="btn-ghost" style={{ marginRight: 8 }} onClick={() => openEdit(u)}>编辑</button>
                    <button type="button" className="btn-ghost" style={{ color: "var(--danger, #c00)" }} onClick={() => doDelete(u.id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>每页显示</span>
            <select
              value={String(pageSize)}
              onChange={(e) => {
                const n = Math.max(1, Math.min(100, Number(e.target.value || 10)));
                setPageSize(n);
                setCurrentPage(1);
              }}
              style={{ padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6 }}
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <button type="button" className="btn-secondary" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}>
              上一页
            </button>
            <button type="button" className="btn-secondary" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages}>
              下一页
            </button>
            <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              第 {currentPage} / {totalPages} 页，共 {list.length} 条
            </span>
          </div>
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
                  <option value="teaching_leader">教研组长</option>
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
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>{form.role === "teacher" || form.role === "teaching_leader" ? "工号" : "学号"}</span>
                <input
                  type="text"
                  value={form.student_no}
                  onChange={(e) => setForm((f) => ({ ...f, student_no: e.target.value }))}
                  placeholder={form.role === "teacher" || form.role === "teaching_leader" ? "输入工号" : "输入学生学号"}
                  style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 6 }}
                />
              </label>
              <label>
                <span style={{ display: "block", marginBottom: 4, fontSize: 14 }}>行政班级/部门</span>
                <input
                  type="text"
                  value={form.admin_class_or_dept}
                  onChange={(e) => setForm((f) => ({ ...f, admin_class_or_dept: e.target.value }))}
                  placeholder={form.role === "student" ? "学生填行政班级" : form.role === "teacher" || form.role === "teaching_leader" ? "教师/教研组长填部门" : "可选"}
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

      {importModalOpen && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 110 }}
          onClick={() => !importing && setImportModalOpen(false)}
        >
          <div className="card" style={{ minWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>批量导入用户</h3>
            <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 12 }}>
              请上传已填写的导入模版（CSV），表头：用户名、学号/工号、姓名、角色、行政班级/部门。除「行政班级/部门」外均不能为空。角色可为：学生、教师、教研组长、管理员。新用户默认密码 123456。
            </p>
            <div style={{ marginBottom: 12 }}>
              <input
                type="file"
                accept=".csv"
                onChange={(e) => {
                  setImportFile(e.target.files?.[0] || null);
                  setImportResult(null);
                }}
                style={{ fontSize: 14 }}
              />
              {importFile && <span style={{ marginLeft: 8, fontSize: 13, color: "var(--text-muted)" }}>{importFile.name}</span>}
            </div>
            {importResult && (
              <div style={{ marginBottom: 12, padding: 10, background: "var(--bg-secondary, #f5f5f5)", borderRadius: 8, fontSize: 14 }}>
                <p style={{ margin: "0 0 6px 0" }}>{importResult.message}</p>
                {importResult.errors.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 20, color: "var(--text-muted)", fontSize: 13, maxHeight: 160, overflow: "auto" }}>
                    {importResult.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" className="btn-ghost" onClick={() => setImportModalOpen(false)} disabled={importing}>关闭</button>
              <button type="button" className="btn-primary" onClick={submitImport} disabled={importing || !importFile}>
                {importing ? "导入中…" : "导入"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
