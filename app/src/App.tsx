import { Routes, Route } from 'react-router-dom';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { AuthProvider } from './contexts/AuthContext';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { ScrollToTop } from './components/ScrollToTop';
import { Overview } from './pages/Overview';
import { Dashboard } from './pages/Dashboard';
import { Studio } from './pages/Studio';
import { Docs } from './pages/Docs';
import { Blog } from './pages/Blog';
import { Account } from './pages/Account';
import { History } from './pages/History';
import { Article } from './pages/Article';
import { Admin } from './pages/Admin';
import { DashboardEvaluations } from './pages/DashboardEvaluations';
import { Privacy } from './pages/Privacy';
import { Terms } from './pages/Terms';
import { Whitepaper } from './pages/Whitepaper';

function App() {
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

  // Wrap app content - if no clientId, still render but Google OAuth won't work
  const AppContent = () => (
    <AuthProvider>
      <ScrollToTop />
      <div className="min-h-screen bg-[#07080A] text-[#F5F7FF]">
        <Navbar />
        <main>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/dashboard/evaluations" element={<DashboardEvaluations />} />
            <Route path="/studio" element={<Studio />} />
            <Route path="/docs" element={<Docs />} />
              <Route path="/blog" element={<Blog />} />
              <Route path="/blog/:id" element={<Article />} />
              <Route path="/account" element={<Account />} />
              <Route path="/history" element={<History />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/whitepaper" element={<Whitepaper />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </AuthProvider>
  );

  // Only wrap with GoogleOAuthProvider if clientId is provided
  if (googleClientId) {
    return (
      <GoogleOAuthProvider clientId={googleClientId}>
        <AppContent />
      </GoogleOAuthProvider>
    );
  }

  // Fallback if no clientId (for development)
  return <AppContent />;
}

export default App;
