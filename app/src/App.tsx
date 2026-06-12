import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Routes, Route } from 'react-router-dom';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { captureReferralFromUrl } from './lib/referral';
import { AuthProvider } from './contexts/AuthContext';
import { StudioPlayerProvider } from './contexts/StudioPlayerContext';
import { GenerationsProvider } from './contexts/GenerationsContext';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { ScrollToTop } from './components/ScrollToTop';
import { StudioPlayerBar } from './components/StudioPlayerBar';
// Logos now lives inside the Studio home StudioVoiceAgentSpotlight card
// (the floating VocenceBot launcher was retired). The panel + hook
// instance the old bot used are no longer mounted globally, that
// avoids a second useVoiceChat running in parallel with the active
// call surface.
import { Toaster } from './components/ui/sonner';

// Route-level code splitting: heavy pages load only when visited (named exports → default for lazy)
const Overview = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Overview })));
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Studio = lazy(() => import('./pages/Studio').then((m) => ({ default: m.Studio })));
const StudioDesignedVoiceWorkspace = lazy(() =>
  import('./pages/StudioDesignedVoiceWorkspace').then((m) => ({ default: m.StudioDesignedVoiceWorkspace }))
);
const StudioResult = lazy(() => import('./pages/StudioResult').then((m) => ({ default: m.StudioResult })));
const AgentsList = lazy(() => import('./pages/agents/AgentsList').then((m) => ({ default: m.AgentsList })));
const AgentBuilder = lazy(() => import('./pages/agents/AgentBuilder').then((m) => ({ default: m.AgentBuilder })));
const AgentDetail = lazy(() => import('./pages/agents/AgentDetail').then((m) => ({ default: m.AgentDetail })));
const AgentRunViewer = lazy(() => import('./pages/agents/AgentRunViewer').then((m) => ({ default: m.AgentRunViewer })));
const AgentSessionReplay = lazy(() => import('./pages/agents/AgentSessionReplay').then((m) => ({ default: m.AgentSessionReplay })));
const Docs = lazy(() => import('./pages/Docs').then((m) => ({ default: m.Docs })));
const Blog = lazy(() => import('./pages/Blog').then((m) => ({ default: m.Blog })));
const Article = lazy(() => import('./pages/Article').then((m) => ({ default: m.Article })));
const Account = lazy(() => import('./pages/Account').then((m) => ({ default: m.Account })));
const History = lazy(() => import('./pages/History').then((m) => ({ default: m.History })));
const CliAuthorize = lazy(() => import('./pages/CliAuthorize').then((m) => ({ default: m.CliAuthorize })));
const Admin = lazy(() => import('./pages/Admin').then((m) => ({ default: m.Admin })));
const AdminOps = lazy(() => import('./pages/AdminOps').then((m) => ({ default: m.AdminOps })));

// AdminGate isn't lazy, it's a thin wrapper that needs to render the
// unlock modal synchronously, and the chunk overhead would only save ~3 KB.
// eslint-disable-next-line import/order
import { AdminGate } from './components/admin/AdminGate';
const DashboardEvaluations = lazy(() => import('./pages/DashboardEvaluations').then((m) => ({ default: m.DashboardEvaluations })));
const Pricing = lazy(() => import('./pages/Pricing').then((m) => ({ default: m.Pricing })));
const Privacy = lazy(() => import('./pages/Privacy').then((m) => ({ default: m.Privacy })));
const Terms = lazy(() => import('./pages/Terms').then((m) => ({ default: m.Terms })));
const Whitepaper = lazy(() => import('./pages/Whitepaper').then((m) => ({ default: m.Whitepaper })));
const Sales = lazy(() => import('./pages/Sales').then((m) => ({ default: m.Sales })));
const SalesEmail = lazy(() => import('./pages/SalesEmail').then((m) => ({ default: m.SalesEmail })));
const AdminWebsiteUsage = lazy(() =>
  import('./pages/AdminWebsiteUsage').then((m) => ({ default: m.AdminWebsiteUsage }))
);
const NotFound = lazy(() => import('./pages/NotFound').then((m) => ({ default: m.NotFound })));
const VerifyEmail = lazy(() => import('./pages/auth/VerifyEmail').then((m) => ({ default: m.VerifyEmail })));
const ResetPassword = lazy(() => import('./pages/auth/ResetPassword').then((m) => ({ default: m.ResetPassword })));

function PageFallback() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-[#D1F840] border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function AppContent() {
  return (
    <AuthProvider>
      <StudioPlayerProvider>
      <GenerationsProvider>
      <ScrollToTop />
      <Toaster position="bottom-right" richColors closeButton />
      <div className="min-h-screen bg-[#07080A] text-[#F5F7FF]">
        <Navbar />
        <main>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/auth/verify" element={<VerifyEmail />} />
              <Route path="/auth/reset" element={<ResetPassword />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/dashboard/evaluations" element={<DashboardEvaluations />} />
              <Route path="/studio/result/:id" element={<StudioResult />} />
              <Route path="/studio" element={<Navigate to="/studio/home" replace />} />
              <Route path="/studio/my-voices/:voiceId" element={<StudioDesignedVoiceWorkspace />} />
              <Route path="/studio/playbooks/:playbookId" element={<Studio />} />
              {/* Admin pages. All three are gated by <AdminGate>:
                    1. Anonymous / non-ADMIN_EMAIL → silent <Navigate to="/">
                    2. Admin without a valid sudo unlock → AdminUnlockModal pops
                    3. Admin with unlock → renders the cross-link nav + child
                  /admin/ops lives here (NOT /studio/ops) so admin surfaces
                  share a namespace. Non-admins discover nothing. */}
              <Route path="/admin/ops" element={<AdminGate><AdminOps /></AdminGate>} />
              <Route path="/studio/agents" element={<AgentsList />} />
              <Route path="/studio/agents/new" element={<AgentBuilder />} />
              <Route path="/studio/agents/:id/runs/:runId" element={<AgentRunViewer />} />
              <Route path="/studio/agents/:id/calls/:sessionId" element={<AgentSessionReplay />} />
              <Route path="/studio/agents/:id" element={<AgentDetail />} />
              <Route path="/studio/:view" element={<Studio />} />
              <Route path="/docs" element={<Navigate to="/docs/getting-started" replace />} />
              <Route path="/docs/:section" element={<Docs />} />
              <Route path="/blog" element={<Blog />} />
              <Route path="/blog/:id" element={<Article />} />
              <Route path="/account" element={<Account />} />
              <Route path="/account/:tab" element={<Account />} />
              <Route path="/history" element={<History />} />
              <Route path="/cli/authorize" element={<CliAuthorize />} />
              <Route path="/admin" element={<AdminGate><Admin /></AdminGate>} />
              <Route path="/admin/website_usage" element={<AdminGate><AdminWebsiteUsage /></AdminGate>} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/sales" element={<Sales />} />
              <Route path="/sales/email" element={<SalesEmail />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/whitepaper" element={<Whitepaper />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </main>
        <Footer />
        <StudioPlayerBar />
      </div>
      </GenerationsProvider>
      </StudioPlayerProvider>
    </AuthProvider>
  );
}


function App() {
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

  useEffect(() => {
    captureReferralFromUrl();
  }, []);

  if (googleClientId) {
    return (
      <GoogleOAuthProvider clientId={googleClientId}>
        <AppContent />
      </GoogleOAuthProvider>
    );
  }

  return <AppContent />;
}

export default App;
