import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Clock, Calendar } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { dashboardApi } from '../services/dashboardApi';
import { API_ORIGIN_BASE } from '../services/baseUrl';

gsap.registerPlugin(ScrollTrigger);

const DASHBOARD_BASE = API_ORIGIN_BASE;

function imageUrl(url: string): string {
  if (!url || url.startsWith('http')) return url || '';
  return `${DASHBOARD_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
}

// Article data - in a real app, this would come from an API
const articleData: Record<string, {
  id: string;
  title: string;
  excerpt: string;
  category: string;
  date: string;
  readTime: string;
  image: string;
  content: string[];
}> = {
  '1': {
    id: '1',
    title: 'Advancing Phase 2: From Prompt Embeddings to Dynamic Prosody',
    excerpt: "We're officially transitioning into the next phase of our roadmap. This deep-dive explores how our new latent diffusion model handles complex emotional cues within prompts, significantly increasing MOS scores across the subnet.",
    category: 'Roadmap',
    date: 'March 14, 2024',
    readTime: '8 min read',
    image: '/blog_news_1.jpg',
    content: [
      "We're excited to announce the official transition into Phase 2 of the Vocence roadmap. This milestone represents a significant leap forward in our mission to create the most expressive decentralized voice synthesis network.",
      
      "Our new latent diffusion model introduces sophisticated handling of complex emotional cues within prompts. Unlike traditional text-to-speech systems that rely on simple prosody markers, our approach leverages multi-dimensional prompt embeddings that capture nuanced emotional states, speaking styles, and vocal characteristics.",
      
      "The technical breakthrough comes from our novel architecture that processes prompt embeddings through a series of attention mechanisms, allowing the model to understand and reproduce subtle emotional variations. This has resulted in a 23% increase in Mean Opinion Score (MOS) across the entire subnet.",
      
      "Key improvements include:",
      "• Enhanced emotional range: The model can now distinguish between 47 distinct emotional states",
      "• Better prompt adherence: 94% accuracy in matching requested vocal characteristics",
      "• Reduced latency: 40% faster inference times compared to Phase 1",
      "• Improved diversity: 3x more variation in output styles",
      
      "Validators have reported unprecedented quality in submissions, with many noting that the generated speech feels more natural and expressive than ever before. The decentralized training approach has allowed us to leverage the collective intelligence of our miner network, resulting in a model that outperforms centralized alternatives.",
      
      "Looking ahead, we're planning to introduce real-time voice modulation capabilities and expand our prompt vocabulary to support even more granular control. The community's feedback has been instrumental in shaping these improvements, and we're grateful for the continued support.",
      
      "For miners, this update requires upgrading to the latest model checkpoint. Detailed migration guides are available in our documentation. Validators will automatically benefit from the improved scoring mechanisms.",
    ],
  },
  '2': {
    id: '2',
    title: 'Optimizing Miner Efficiency with Tensor Parallelism',
    excerpt: 'A guide for miners on implementing the latest quantization techniques to reduce VRAM requirements while maintaining high response fidelity for validation.',
    category: 'Technical',
    date: 'March 10, 2024',
    readTime: '5 min read',
    image: '/blog_tech_1.jpg',
    content: [
      "As the Vocence network continues to grow, miners are constantly seeking ways to optimize their operations. One of the most effective strategies is implementing tensor parallelism, which can significantly reduce VRAM requirements while maintaining output quality.",
      
      "Tensor parallelism allows you to split model layers across multiple GPUs, enabling you to run larger models on hardware that would otherwise be insufficient. This technique is particularly valuable for miners operating on consumer-grade hardware.",
      
      "Here's a step-by-step guide to implementing tensor parallelism:",
      
      "1. **Model Partitioning**: Divide your model into logical chunks that can be distributed across GPUs. Each GPU handles a portion of the computation, and results are synchronized at specific points.",
      
      "2. **Gradient Synchronization**: Implement efficient gradient synchronization to ensure all GPUs stay in sync during training. This is crucial for maintaining model consistency.",
      
      "3. **Memory Optimization**: Use gradient checkpointing to trade computation for memory. This allows you to store fewer activations during the forward pass.",
      
      "4. **Quantization**: Apply 8-bit or 4-bit quantization to further reduce memory footprint. Modern quantization techniques maintain 95%+ of original model quality.",
      
      "Miners who have implemented these techniques report:",
      "• 60% reduction in VRAM usage",
      "• 2x increase in batch size capacity",
      "• 15% improvement in inference speed",
      "• No significant degradation in output quality",
      
      "The Vocence team has prepared comprehensive documentation and example implementations. We encourage all miners to explore these optimization strategies to improve their competitive position on the network.",
    ],
  },
  '3': {
    id: '3',
    title: 'Vocence Studio v1.2: Instant Voice Cloning is Here',
    excerpt: 'Introducing our zero-shot voice cloning interface. Users can now upload 30 seconds of audio to create high-fidelity digital replicas for cross-prompt synthesis.',
    category: 'Product Release',
    date: 'March 05, 2024',
    readTime: '3 min read',
    image: '/blog_release_1.jpg',
    content: [
      "We're thrilled to announce the release of Vocence Studio v1.2, featuring our revolutionary zero-shot voice cloning technology. This update represents a major leap forward in making professional voice synthesis accessible to everyone.",
      
      "The new voice cloning feature allows users to create high-fidelity digital replicas of any voice using just 30 seconds of audio. Our advanced neural architecture analyzes vocal characteristics, speaking patterns, and unique timbral qualities to create an accurate voice model.",
      
      "Key features of the new voice cloning system:",
      "• **Zero-shot capability**: No training required - works instantly with minimal audio",
      "• **High fidelity**: 95%+ similarity to source voice",
      "• **Cross-prompt synthesis**: Use cloned voice with any text or style prompt",
      "• **Privacy-first**: All processing happens locally or on encrypted servers",
      "• **Multi-language support**: Clone voices in 12+ languages",
      
      "The interface has been completely redesigned to make voice cloning intuitive. Users simply upload their audio sample, optionally adjust similarity and stability parameters, and within seconds, they have a ready-to-use voice clone.",
      
      "We've also introduced several quality-of-life improvements:",
      "• Faster generation times (40% improvement)",
      "• Better mobile responsiveness",
      "• Enhanced audio preview with waveform visualization",
      "• Batch processing for multiple voices",
      
      "Early users have been amazed by the quality and speed of the cloning process. Content creators, developers, and businesses are already finding innovative uses for this technology.",
      
      "Try it out today in the Studio section. We're excited to see what you create!",
    ],
  },
  '4': {
    id: '4',
    title: 'Governance Proposal: Subnet Incentive Realignment',
    excerpt: 'A summary of the community proposal to adjust the weighting of Word Error Rate (WER) versus Latency (RTF) in the validator score calculation.',
    category: 'Community',
    date: 'Feb 28, 2024',
    readTime: '4 min read',
    image: '/blog_community_1.jpg',
    content: [
      "The Vocence community has been actively discussing how to best balance quality metrics in our validator scoring system. After extensive debate and analysis, a governance proposal has been submitted to realign the incentive structure.",
      
      "The current system weights Word Error Rate (WER) and Latency (Real-Time Factor, RTF) equally. However, community feedback suggests that quality should be prioritized over speed, especially as the network matures.",
      
      "The proposed changes:",
      "• Increase WER weight from 50% to 70%",
      "• Decrease RTF weight from 50% to 30%",
      "• Add a new 'Prompt Adherence' metric weighted at 20%",
      "• Implement gradual rollout over 4 weeks",
      
      "Proponents argue that this change will:",
      "• Encourage miners to focus on quality over speed",
      "• Better align incentives with user expectations",
      "• Reduce low-quality submissions that flood the network",
      "• Improve overall network reputation",
      
      "Opponents raise concerns about:",
      "• Potential exclusion of miners with slower hardware",
      "• Increased validation time requirements",
      "• Possible reduction in network throughput",
      
      "The proposal is currently open for community voting. All token holders can participate in the governance process. Voting closes on March 15, 2024, and if passed, implementation will begin on March 20, 2024.",
      
      "We encourage all community members to review the full proposal and participate in the discussion. Your voice matters in shaping the future of Vocence.",
    ],
  },
  '5': {
    id: '5',
    title: 'Analyzing MOS Distribution Across 1,000 Miners',
    excerpt: 'An end-of-month technical audit of subnet quality performance. We analyze how decentralized compute affects model consistency and output diversity.',
    category: 'Technical',
    date: 'Feb 22, 2024',
    readTime: '12 min read',
    image: '/blog_tech_2.jpg',
    content: [
      "This month, we conducted a comprehensive analysis of Mean Opinion Score (MOS) distribution across our network of 1,000+ active miners. The results provide fascinating insights into how decentralized compute affects model performance.",
      
      "Key findings:",
      "• Average MOS across all miners: 4.2/5.0",
      "• Top 10% of miners achieve MOS > 4.6",
      "• Standard deviation: 0.3 (indicating consistent quality)",
      "• 78% of miners score above 4.0",
      
      "The distribution follows a normal curve with a slight positive skew, suggesting that while most miners perform well, there's a long tail of exceptional performers. This is exactly what we want to see in a competitive network.",
      
      "Geographic distribution analysis reveals interesting patterns:",
      "• North American miners: 4.3 average MOS",
      "• European miners: 4.25 average MOS",
      "• Asian miners: 4.15 average MOS",
      "• Other regions: 4.1 average MOS",
      
      "Hardware analysis shows that:",
      "• GPU memory capacity correlates with quality (r=0.42)",
      "• Model architecture choice has significant impact",
      "• Training data quality matters more than quantity",
      "• Network latency has minimal effect on MOS",
      
      "One surprising finding is that miners using consumer-grade hardware (RTX 3060, RTX 3070) often outperform those with enterprise hardware. This suggests that optimization and model selection are more important than raw compute power.",
      
      "The diversity of outputs is another key metric. We measure this using a novel diversity index that quantifies how different outputs are from each other. Higher diversity indicates a more robust network that can handle varied use cases.",
      
      "Our analysis shows:",
      "• Diversity index: 0.78 (target: >0.7)",
      "• Style coverage: 94% of requested styles successfully generated",
      "• Language coverage: 89% of supported languages",
      "• Emotional range: 87% of emotional states accurately reproduced",
      
      "These metrics indicate a healthy, diverse network that's meeting user needs effectively. The decentralized approach is clearly working, with no single point of failure and consistent quality across the board.",
      
      "Moving forward, we'll be publishing monthly reports like this to keep the community informed about network health and performance trends.",
    ],
  },
};

type ArticleShape = {
  id: string;
  title: string;
  excerpt: string;
  category: string;
  date: string;
  readTime: string;
  image: string;
  content: string[];
};

export function Article() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const articleRef = useRef<HTMLDivElement>(null);
  const [apiArticle, setApiArticle] = useState<ArticleShape | null | undefined>(undefined);

  useEffect(() => {
    if (!id) return;
    setApiArticle(undefined);
    dashboardApi.getBlogPost(id).then((p) => {
      const paragraphs = (p.content || '').split(/\n\n+/).filter(Boolean);
      setApiArticle({
        id: p.id,
        title: p.title,
        excerpt: p.excerpt,
        category: p.category,
        date: p.date,
        readTime: p.read_time,
        image: imageUrl(p.image),
        content: paragraphs.length > 0 ? paragraphs : [p.content || ''],
      });
    }).catch(() => setApiArticle(null));
  }, [id]);

  const staticArticle = id ? articleData[id] : null;
  const article: ArticleShape | null = apiArticle !== undefined ? (apiArticle ?? staticArticle) : staticArticle;

  useEffect(() => {
    if (!article) return;

    const ctx = gsap.context(() => {
      gsap.fromTo(
        '.article-header',
        { opacity: 0, y: 30 },
        { opacity: 1, y: 0, duration: 0.8 }
      );
      gsap.fromTo(
        '.article-image',
        { opacity: 0, scale: 0.95 },
        { opacity: 1, scale: 1, duration: 0.8, delay: 0.2 }
      );
      gsap.fromTo(
        '.article-content',
        { opacity: 0, y: 20 },
        {
          opacity: 1,
          y: 0,
          duration: 0.6,
          stagger: 0.05,
          delay: 0.4,
          scrollTrigger: {
            trigger: articleRef.current,
            start: 'top 80%',
          },
        }
      );
    });

    return () => ctx.revert();
  }, [article]);

  if (!article) {
    const loading = id && apiArticle === undefined && !staticArticle;
    return (
      <div className="min-h-screen bg-[#07080A] pt-24 pb-12 px-6 lg:px-8">
        <div className="max-w-4xl mx-auto text-center">
          {loading ? (
            <p className="text-[#A7B0B7]">Loading...</p>
          ) : (
            <>
              <h1 className="text-3xl font-semibold mb-4">Article Not Found</h1>
              <p className="text-[#A7B0B7] mb-8">The article you're looking for doesn't exist.</p>
              <Link to="/blog" className="btn-primary">
                Back to Blog
              </Link>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={articleRef} className="min-h-screen bg-[#07080A] pt-24 pb-16 px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        {/* Back Button */}
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-[#A7B0B7] hover:text-white transition-colors mb-8"
        >
          <ArrowLeft size={18} />
          <span>Back to Blog</span>
        </button>

        {/* Header */}
        <div className="article-header mb-8">
          <span className="inline-block px-4 py-1.5 rounded-full bg-[#DFFF00]/10 border border-[#DFFF00]/20 text-[#DFFF00] text-xs font-mono uppercase tracking-wider mb-6">
            {article.category}
          </span>
          <h1 className="text-4xl md:text-5xl font-semibold mb-6 leading-tight">
            {article.title}
          </h1>
          <div className="flex items-center gap-4 text-sm text-[#A7B0B7] mb-8">
            <div className="flex items-center gap-2">
              <Calendar size={16} />
              <span>{article.date}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock size={16} />
              <span>{article.readTime}</span>
            </div>
          </div>
        </div>

        {/* Featured Image */}
        <div className="article-image mb-12 rounded-2xl overflow-hidden">
          <img
            src={article.image}
            alt={article.title}
            className="w-full h-[400px] md:h-[500px] object-cover"
          />
        </div>

        {/* Content */}
        <article className="prose prose-invert max-w-none">
          <div className="article-content space-y-6 text-[#A7B0B7] leading-relaxed">
            {article.content.map((paragraph, index) => {
              // Check if paragraph is a bullet point
              if (paragraph.startsWith('•')) {
                return (
                  <div key={index} className="flex items-start gap-3 pl-4">
                    <span className="text-[#DFFF00] mt-1">•</span>
                    <p className="flex-1">{paragraph.substring(1).trim()}</p>
                  </div>
                );
              }
              // Check if paragraph is a numbered list item
              if (/^\d+\./.test(paragraph)) {
                return (
                  <div key={index} className="flex items-start gap-3 pl-4">
                    <span className="text-[#DFFF00] mt-1 font-mono">
                      {paragraph.match(/^\d+\./)?.[0]}
                    </span>
                    <p className="flex-1">{paragraph.replace(/^\d+\.\s*/, '')}</p>
                  </div>
                );
              }
              // Regular paragraph
              return (
                <p key={index} className="text-lg leading-8">
                  {paragraph}
                </p>
              );
            })}
          </div>
        </article>

        {/* Footer Actions */}
        <div className="mt-16 pt-8 border-t border-white/10">
          <Link
            to="/blog"
            className="inline-flex items-center gap-2 text-[#A7B0B7] hover:text-white transition-colors"
          >
            <ArrowLeft size={18} />
            <span>Back to Blog</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
