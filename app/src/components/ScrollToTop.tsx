import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export function ScrollToTop() {
  const { pathname, search } = useLocation();

  // Include search so /admin/website_usage?user=… scrolls to top when opening a user view
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname, search]);

  return null;
}

