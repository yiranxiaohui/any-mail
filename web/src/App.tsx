import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/lib/auth";
import Layout from "@/components/Layout";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import Receive from "@/pages/Receive";
import Inbox from "@/pages/Inbox";
import EmailDetail from "@/pages/EmailDetail";
import Accounts from "@/pages/Accounts";
import Groups from "@/pages/Groups";
import Domains from "@/pages/Domains";
import ApiKeys from "@/pages/ApiKeys";
import Settings from "@/pages/Settings";
import Compose from "@/pages/Compose";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (isAuthenticated) return <Navigate to="/console" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Receive />} />
          <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
          <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
          {/* keep old /receive path as alias */}
          <Route path="/receive" element={<Receive />} />
          <Route path="/console" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route index element={<Inbox />} />
            <Route path="emails/:id" element={<EmailDetail />} />
            <Route path="compose" element={<Compose />} />
            <Route path="accounts" element={<Accounts />} />
            <Route path="groups" element={<Groups />} />
            <Route path="domains" element={<Domains />} />
            <Route path="api-keys" element={<ApiKeys />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
