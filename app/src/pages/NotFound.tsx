import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="min-h-screen bg-[#07080A] flex flex-col items-center justify-center text-center px-6 pt-20">
      <h1 className="text-7xl font-bold text-[#DFFF00] mb-4">404</h1>
      <p className="text-xl text-white mb-2">Page not found</p>
      <p className="text-sm text-[#A7B0B7] mb-8 max-w-md">
        The page you're looking for doesn't exist or has been moved.
      </p>
      <div className="flex gap-3">
        <Link to="/" className="btn-primary h-10 px-5 text-sm inline-flex items-center">
          Go home
        </Link>
        <Link to="/studio/home" className="h-10 px-5 text-sm inline-flex items-center rounded-lg border border-white/10 text-[#A7B0B7] hover:text-white hover:border-white/20">
          Open Studio
        </Link>
      </div>
    </div>
  );
}
