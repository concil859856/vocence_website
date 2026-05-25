import { Link } from 'react-router-dom';
import { Wrench } from 'lucide-react';

export function StudioMaintenance() {
  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 rounded-full bg-[#D1F840]/10 flex items-center justify-center">
            <Wrench className="w-8 h-8 text-[#D1F840]" />
          </div>
        </div>
        <h1 className="text-3xl font-bold mb-3">Studio is Under Maintenance</h1>
        <p className="text-[#A0A0B0] mb-8">
          We're making some improvements to the Studio. Please check back soon.
        </p>
        <Link
          to="/"
          className="inline-flex items-center gap-2 px-6 py-3 bg-[#D1F840] text-black font-semibold rounded-lg hover:bg-[#bde038] transition-colors"
        >
          Back to Home
        </Link>
      </div>
    </div>
  );
}
