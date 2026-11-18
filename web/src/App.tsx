import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ChangePasswordPage } from "./auth/ChangePasswordPage";
import { IdleWarning } from "./auth/IdleWarning";
import { postAuthRedirectPath } from "./auth/idle";
import { LoginPage } from "./auth/LoginPage";
import { CalendarPage } from "./calendar/CalendarPage";
import { ChooseModule } from "./ChooseModule";

function AppRoutes() {
  const { state } = useAuth();
  const location = useLocation();
  const redirectPath = postAuthRedirectPath(
    state.status,
    state.status === "signed-in" && state.user.mustChangePassword,
    location.pathname,
  );

  if (redirectPath) {
    return <Navigate to={redirectPath} replace />;
  }

  if (state.status === "loading") {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <div className="brand brand--dark">
            <span className="brand__name">Hydrop Deepo</span>
            <span className="brand__tag">Water refilling station</span>
          </div>
          <p className="muted" role="status">
            Checking session…
          </p>
        </div>
      </main>
    );
  }

  if (state.status === "signed-out") {
    return <LoginPage notice={state.notice} />;
  }

  // Enforce password replacement across all URLs before any module access.
  if (state.user.mustChangePassword) {
    return <ChangePasswordPage />;
  }

  return (
    <Routes>
      <Route path="/" element={<ChooseModule />} />
      <Route path="/calendar" element={<CalendarPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <IdleWarning />
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
