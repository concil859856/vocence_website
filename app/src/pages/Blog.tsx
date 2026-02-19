import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Clock } from 'lucide-react';
import gsap from 'gsap';
import { dashboardApi } from '../services/dashboardApi';

const DASHBOARD_BASE = import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? '' : 'http://localhost:34717');

type FilterType = 'all' | 'technical' | 'releases' | 'roadmap' | 'community';

interface Article {
  id: string;
  title: string;
  excerpt: string;
  category: string;
  date: string;
  readTime: string;
  image: string;
  featured?: boolean;
}

function imageUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${DASHBOARD_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
}

const filters: { id: FilterType; label: string }[] = [
  { id: 'all', label: 'All Updates' },
  { id: 'technical', label: 'Technical' },
  { id: 'releases', label: 'Product Releases' },
  { id: 'roadmap', label: 'Roadmap' },
  { id: 'community', label: 'Community' },
];

const articles: Article[] = [
  {
    id: '1',
    title: 'Advancing Phase 2: From Prompt Embeddings to Dynamic Prosody',
    excerpt:
      "We're officially transitioning into the next phase of our roadmap. This deep-dive explores how our new latent diffusion model handles complex emotional cues within prompts, significantly increasing MOS scores across the subnet.",
    category: 'Roadmap',
    date: 'March 14, 2024',
    readTime: '8 min read',
    image: '/blog_news_1.jpg',
    featured: true,
  },
  {
    id: '2',
    title: 'Optimizing Miner Efficiency with Tensor Parallelism',
    excerpt:
      'A guide for miners on implementing the latest quantization techniques to reduce VRAM requirements while maintaining high response fidelity for validation.',
    category: 'Technical',
    date: 'March 10, 2024',
    readTime: '5 min read',
    image: '/blog_tech_1.jpg',
  },
  {
    id: '3',
    title: 'Vocence Studio v1.2: Instant Voice Cloning is Here',
    excerpt:
      'Introducing our zero-shot voice cloning interface. Users can now upload 30 seconds of audio to create high-fidelity digital replicas for cross-prompt synthesis.',
    category: 'Product Release',
    date: 'March 05, 2024',
    readTime: '3 min read',
    image: '/blog_release_1.jpg',
  },
  {
    id: '4',
    title: 'Governance Proposal: Subnet Incentive Realignment',
    excerpt:
      'A summary of the community proposal to adjust the weighting of Word Error Rate (WER) versus Latency (RTF) in the validator score calculation.',
    category: 'Community',
    date: 'Feb 28, 2024',
    readTime: '4 min read',
    image: '/blog_community_1.jpg',
  },
  {
    id: '5',
    title: 'Analyzing MOS Distribution Across 1,000 Miners',
    excerpt:
      'An end-of-month technical audit of subnet quality performance. We analyze how decentralized compute affects model consistency and output diversity.',
    category: 'Technical',
    date: 'Feb 22, 2024',
    readTime: '12 min read',
    image: '/blog_tech_2.jpg',
  },
];

export function Blog() {
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const [apiArticles, setApiArticles] = useState<Article[]>([]);
  const blogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dashboardApi.getBlogPosts().then((res) => {
      const list: Article[] = (res.posts || []).map((p) => ({
        id: p.id,
        title: p.title,
        excerpt: p.excerpt,
        category: p.category,
        date: p.date,
        readTime: p.read_time,
        image: imageUrl(p.image),
        featured: p.featured,
      }));
      setApiArticles(list);
    }).catch(() => setApiArticles([]));
  }, []);

  const articlesList = apiArticles.length > 0 ? apiArticles : articles;

  const filteredArticles =
    activeFilter === 'all'
      ? articlesList
      : articlesList.filter((article) => {
          const categoryMap: Record<string, string> = {
            technical: 'Technical',
            releases: 'Product Release',
            roadmap: 'Roadmap',
            community: 'Community',
          };
          return article.category === categoryMap[activeFilter];
        });

  const featuredArticle = articlesList.find((a) => a.featured);
  const regularArticles = filteredArticles.filter((a) => !a.featured);

  useEffect(() => {
    gsap.fromTo(
      '.blog-header',
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.6 }
    );
    gsap.fromTo(
      '.blog-filter',
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.6, delay: 0.1 }
    );
    gsap.fromTo(
      '.blog-card',
      { opacity: 0, y: 30 },
      { opacity: 1, y: 0, duration: 0.5, stagger: 0.1, delay: 0.2 }
    );
  }, [activeFilter]);

  return (
    <div ref={blogRef} className="min-h-screen bg-[#07080A] pt-24 pb-16 px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="blog-header mb-10 mt-12">
          <span className="label-mono mb-4 block">News & Updates</span>
          <h1 className="text-4xl md:text-5xl font-semibold mb-4">Inside Vocence</h1>
          <p className="text-[#A7B0B7] max-w-2xl text-lg">
            The latest announcements, technical breakthroughs, and roadmap progress from the
            decentralized audio frontier.
          </p>
        </div>

        {/* Filters */}
        <div className="blog-filter flex flex-wrap gap-3 mb-10">
          {filters.map((filter) => (
            <button
              key={filter.id}
              onClick={() => setActiveFilter(filter.id)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                activeFilter === filter.id
                  ? 'bg-white text-[#07080A]'
                  : 'bg-[#181818] border border-white/10 text-[#A7B0B7] hover:text-white hover:border-white/20'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {/* Articles Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Featured Article */}
          {featuredArticle && activeFilter === 'all' && (
            <Link
              to={`/blog/${featuredArticle.id}`}
              className="blog-card md:col-span-2 lg:col-span-2 card-vocence overflow-hidden group cursor-pointer block"
            >
              <div className="grid md:grid-cols-2 h-full">
                <div className="h-64 md:h-full overflow-hidden">
                  <img
                    src={featuredArticle.image}
                    alt={featuredArticle.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                </div>
                <div className="p-8 flex flex-col justify-center">
                  <span className="inline-block px-3 py-1 rounded-full bg-black/40 backdrop-blur-sm text-xs font-semibold uppercase tracking-wider mb-4 w-fit">
                    {featuredArticle.category}
                  </span>
                  <div className="flex items-center gap-2 text-sm text-[#666] mb-3">
                    <span>{featuredArticle.date}</span>
                    <span>•</span>
                    <span className="flex items-center gap-1">
                      <Clock size={14} />
                      {featuredArticle.readTime}
                    </span>
                  </div>
                  <h2 className="text-2xl md:text-3xl font-semibold mb-4 group-hover:text-[#DFFF00] transition-colors">
                    {featuredArticle.title}
                  </h2>
                  <p className="text-[#A7B0B7] mb-6 line-clamp-3">
                    {featuredArticle.excerpt}
                  </p>
                  <div className="flex items-center gap-2 text-[#DFFF00] font-medium">
                    Read Article
                    <ArrowRight
                      size={18}
                      className="group-hover:translate-x-1 transition-transform"
                    />
                  </div>
                </div>
              </div>
            </Link>
          )}

          {/* Regular Articles */}
          {regularArticles.map((article) => (
            <Link
              key={article.id}
              to={`/blog/${article.id}`}
              className="blog-card card-vocence overflow-hidden group cursor-pointer flex flex-col block"
            >
              <div className="h-48 overflow-hidden relative">
                <img
                  src={article.image}
                  alt={article.title}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                />
                <span className="absolute top-4 left-4 px-3 py-1 rounded bg-black/40 backdrop-blur-sm text-xs font-semibold uppercase tracking-wider">
                  {article.category}
                </span>
              </div>
              <div className="p-6 flex flex-col flex-1">
                <div className="flex items-center gap-2 text-sm text-[#666] mb-3">
                  <span>{article.date}</span>
                  <span>•</span>
                  <span className="flex items-center gap-1">
                    <Clock size={14} />
                    {article.readTime}
                  </span>
                </div>
                <h3 className="text-lg font-semibold mb-3 group-hover:text-[#DFFF00] transition-colors line-clamp-2">
                  {article.title}
                </h3>
                <p className="text-sm text-[#A7B0B7] mb-4 line-clamp-3 flex-1">
                  {article.excerpt}
                </p>
                <div className="flex items-center gap-2 text-sm text-[#DFFF00] font-medium">
                  Read Article
                  <ArrowRight
                    size={16}
                    className="group-hover:translate-x-1 transition-transform"
                  />
                </div>
              </div>
            </Link>
          ))}
        </div>

        {/* Load More */}
        <div className="mt-12 text-center">
          <button className="btn-outline">Load More Articles</button>
        </div>
      </div>
    </div>
  );
}
