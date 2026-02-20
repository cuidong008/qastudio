import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./api/auth";
import Layout from "./components/Layout";
import Preview from "./pages/student/Preview";
import InClass from "./pages/student/InClass";
import Review from "./pages/student/Review";
import Exercises from "./pages/student/Exercises";
import Feedback from "./pages/student/Feedback";
import TeacherLayout from "./components/TeacherLayout";
import TeacherDashboard from "./pages/teacher/TeacherDashboard";
import TeacherCourses from "./pages/teacher/TeacherCourses";
import TeacherChapterMaterials from "./pages/teacher/TeacherChapterMaterials";
import TeacherClasses from "./pages/teacher/TeacherClasses";
import TeacherChapterQuestions from "./pages/teacher/TeacherChapterQuestions";
import AdminLayout from "./components/AdminLayout";
import AdminHome from "./pages/admin/AdminHome";
import AdminUsers from "./pages/admin/AdminUsers";
import AdminRag from "./pages/admin/AdminRag";
import Login from "./pages/Login";
import ToastHost from "./components/ToastHost";

function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg-base)",
          color: "var(--text-muted)",
        }}
      >
        加载中…
      </div>
    );
  }

  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/student" element={<Navigate to="/student/inclass" replace />} />
        <Route path="/student/preview" element={<Layout role="student" requireAuth><Preview /></Layout>} />
        <Route path="/student/inclass" element={<Layout role="student" requireAuth><InClass /></Layout>} />
        <Route path="/student/review" element={<Layout role="student" requireAuth><Review /></Layout>} />
        <Route path="/student/exercises" element={<Layout role="student" requireAuth><Exercises /></Layout>} />
        <Route path="/student/feedback" element={<Layout role="student" requireAuth><Feedback /></Layout>} />
        <Route path="/teacher" element={<TeacherLayout requireAuth><TeacherDashboard /></TeacherLayout>} />
        <Route path="/teacher/courses" element={<TeacherLayout requireAuth><TeacherCourses /></TeacherLayout>} />
        <Route path="/teacher/chapter-materials" element={<TeacherLayout requireAuth fluid><TeacherChapterMaterials /></TeacherLayout>} />
        <Route path="/teacher/chapter-questions" element={<TeacherLayout requireAuth><TeacherChapterQuestions /></TeacherLayout>} />
        <Route path="/teacher/classes" element={<TeacherLayout requireAuth><TeacherClasses /></TeacherLayout>} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminHome />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="rag" element={<AdminRag />} />
        </Route>
        <Route path="/" element={<Navigate to={user?.role === "admin" ? "/admin" : user?.role === "teacher" ? "/teacher" : "/student/inclass"} replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastHost />
    </>
  );
}

export default App;
