import { lazy, Suspense } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./api/auth";
import Layout from "./components/Layout";
import Preview from "./pages/student/Preview";
import InClass, { type InClassVariant } from "./pages/student/InClass";
import Review from "./pages/student/Review";
import Exercises from "./pages/student/Exercises";
import Feedback from "./pages/student/Feedback";
import TeacherLayout from "./components/TeacherLayout";
import TeacherLearningData, { TeacherQaInteraction } from "./pages/teacher/TeacherLearningData";
import TeacherCourses from "./pages/teacher/TeacherCourses";
import TeacherChapterMaterials from "./pages/teacher/TeacherChapterMaterials";
import TeacherCourseMaterials from "./pages/teacher/TeacherCourseMaterials";
import TeacherChapterQuestions from "./pages/teacher/TeacherChapterQuestions";

const TeacherClasses = lazy(() => import("./pages/teacher/TeacherClasses"));
import TeacherPipeline from "./pages/teacher/TeacherPipeline";
import TeacherQuestionBank, { TeacherPaperContentPage, TeacherPaperFilesPage } from "./pages/teacher/TeacherQuestionBank";
import AdminLayout from "./components/AdminLayout";
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
        <Route path="/teacher/qa" element={<TeacherLayout requireAuth fluid fullBleed><InClass variant={(user?.role === "teaching_leader" ? "teaching_leader" : "teacher") as InClassVariant} /></TeacherLayout>} />
        <Route path="/teacher" element={<Navigate to="/teacher/qa" replace />} />
        <Route path="/teacher/learning-data" element={<TeacherLayout requireAuth><TeacherLearningData /></TeacherLayout>} />
        <Route path="/teacher/courses" element={<TeacherLayout requireAuth><TeacherCourses /></TeacherLayout>} />
        <Route path="/teacher/course-materials" element={<TeacherLayout requireAuth fluid><TeacherCourseMaterials /></TeacherLayout>} />
        <Route path="/teacher/chapter-materials" element={<TeacherLayout requireAuth fluid><TeacherChapterMaterials /></TeacherLayout>} />
        <Route path="/teacher/chapter-questions" element={<TeacherLayout requireAuth><TeacherChapterQuestions /></TeacherLayout>} />
        <Route path="/teacher/classes" element={<TeacherLayout requireAuth><Suspense fallback={<div style={{ padding: 24, color: "var(--text-muted)" }}>加载中…</div>}><TeacherClasses /></Suspense></TeacherLayout>} />
        <Route path="/teacher/qa-interaction" element={<TeacherLayout requireAuth><TeacherQaInteraction /></TeacherLayout>} />
        <Route path="/teacher/pipeline" element={<TeacherLayout requireAuth fluid><TeacherPipeline /></TeacherLayout>} />
        <Route path="/teacher/question-bank" element={<Navigate to="/teacher/question-bank/exercises/generate" replace />} />
        <Route
          path="/teacher/question-bank/exercises/generate"
          element={<TeacherLayout requireAuth fluid><TeacherQuestionBank pageKey="exercise-generate" /></TeacherLayout>}
        />
        <Route
          path="/teacher/question-bank/exercises/import"
          element={<TeacherLayout requireAuth fluid><TeacherQuestionBank pageKey="exercise-import" /></TeacherLayout>}
        />
        <Route
          path="/teacher/question-bank/exercises/manage"
          element={<TeacherLayout requireAuth fluid><TeacherQuestionBank pageKey="exercise-manage" /></TeacherLayout>}
        />
        <Route
          path="/teacher/question-bank/papers/generate"
          element={<TeacherLayout requireAuth fluid><TeacherQuestionBank pageKey="paper-generate" /></TeacherLayout>}
        />
        <Route
          path="/teacher/question-bank/papers/import"
          element={<TeacherLayout requireAuth fluid><TeacherQuestionBank pageKey="paper-import" /></TeacherLayout>}
        />
        <Route
          path="/teacher/question-bank/papers/manage"
          element={<TeacherLayout requireAuth fluid><TeacherQuestionBank pageKey="paper-manage" /></TeacherLayout>}
        />
        <Route
          path="/teacher/question-bank/papers/content/:paperId"
          element={<TeacherLayout requireAuth fluid><TeacherPaperContentPage /></TeacherLayout>}
        />
        <Route
          path="/teacher/question-bank/papers/files/:paperId"
          element={<TeacherLayout requireAuth fluid><TeacherPaperFilesPage /></TeacherLayout>}
        />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<InClass variant="admin" />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="rag" element={<AdminRag />} />
        </Route>
        <Route path="/" element={<Navigate to={user?.role === "admin" ? "/admin" : (user?.role === "teacher" || user?.role === "teaching_leader") ? "/teacher/qa" : "/student/inclass"} replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastHost />
    </>
  );
}

export default App;
