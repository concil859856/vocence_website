import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Play, Cpu, Mic, Globe, Zap, Shield, Check, Square } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { dashboardApi, type DashboardOverview, type BlogPost } from '../services/dashboardApi';

gsap.registerPlugin(ScrollTrigger);

const DASHBOARD_BASE = import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? '' : 'http://localhost:34717');
function blogImageUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${DASHBOARD_BASE}${url.startsWith('/') ? '' : '/'}${url}`;
}

export function Overview() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [latestPosts, setLatestPosts] = useState<BlogPost[]>([]);
  const [postsLoading, setPostsLoading] = useState(true);
  const [samplePlaying, setSamplePlaying] = useState(false);
  const sampleAudioRef = useRef<HTMLAudioElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const featuresRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);
  const howItWorksRef = useRef<HTMLDivElement>(null);
  const useCasesRef = useRef<HTMLDivElement>(null);
  const newsRef = useRef<HTMLDivElement>(null);
  const videoElementRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    dashboardApi.getOverview().then(setOverview).catch(() => setOverview(null));
  }, []);

  useEffect(() => {
    setPostsLoading(true);
    dashboardApi
      .getBlogPosts(3, 0)
      .then((res) => setLatestPosts((res.posts || []).slice(0, 3)))
      .catch(() => setLatestPosts([]))
      .finally(() => setPostsLoading(false));
  }, []);

  const toggleSamplePlayback = () => {
    const el = sampleAudioRef.current;
    if (!el) return;
    if (samplePlaying) {
      el.pause();
      el.currentTime = 0;
      setSamplePlaying(false);
    } else {
      el.loop = true;
      el.play().catch(() => setSamplePlaying(false));
      setSamplePlaying(true);
    }
  };

  useEffect(() => {
    const el = sampleAudioRef.current;
    if (!el) return;
    const onEnded = () => setSamplePlaying(false);
    const onPause = () => setSamplePlaying(false);
    el.addEventListener('ended', onEnded);
    el.addEventListener('pause', onPause);
    return () => {
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('pause', onPause);
    };
  }, []);

  useEffect(() => {
    const ctx = gsap.context(() => {
      // Hero animations
      gsap.fromTo(
        '.hero-eyebrow',
        { opacity: 0, y: 20 },
        { opacity: 1, y: 0, duration: 0.6, delay: 0.3 }
      );
      gsap.fromTo(
        '.hero-title',
        { opacity: 0, y: 40 },
        { opacity: 1, y: 0, duration: 0.8, delay: 0.5 }
      );
      gsap.fromTo(
        '.hero-subtitle',
        { opacity: 0, y: 20 },
        { opacity: 1, y: 0, duration: 0.6, delay: 0.7 }
      );
      gsap.fromTo(
        '.hero-cta',
        { opacity: 0, y: 20 },
        { opacity: 1, y: 0, duration: 0.6, delay: 0.9 }
      );

      // Features section - more dramatic
      gsap.fromTo(
        '.feature-card',
        { opacity: 0, y: 60, scale: 0.9, rotationX: -15 },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          rotationX: 0,
          duration: 0.8,
          stagger: 0.15,
          ease: 'back.out(1.7)',
          scrollTrigger: {
            trigger: featuresRef.current,
            start: 'top 85%',
          },
        }
      );

      // Feature icons animation
      gsap.fromTo(
        '.feature-icon',
        { scale: 0, rotation: -180 },
        {
          scale: 1,
          rotation: 0,
          duration: 0.6,
          stagger: 0.1,
          ease: 'elastic.out(1, 0.5)',
          scrollTrigger: {
            trigger: featuresRef.current,
            start: 'top 85%',
          },
        }
      );

      // Stats section - more dramatic
      gsap.fromTo(
        '.stat-item',
        { opacity: 0, x: -50, scale: 0.8 },
        {
          opacity: 1,
          x: 0,
          scale: 1,
          duration: 0.7,
          stagger: 0.12,
          ease: 'power3.out',
          scrollTrigger: {
            trigger: statsRef.current,
            start: 'top 85%',
          },
        }
      );

      // Stat numbers animation (pulse effect)
      gsap.utils.toArray('.stat-number').forEach((stat: any) => {
        gsap.fromTo(
          stat,
          { scale: 0.8, opacity: 0.5 },
          {
            scale: 1,
            opacity: 1,
            duration: 0.8,
            ease: 'back.out(1.7)',
            scrollTrigger: {
              trigger: stat,
              start: 'top 85%',
            },
          }
        );
      });

      // How it works - more dramatic
      gsap.fromTo(
        '.step-card',
        { opacity: 0, y: 80, scale: 0.85, rotationY: 15 },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          rotationY: 0,
          duration: 0.9,
          stagger: 0.2,
          ease: 'power3.out',
          scrollTrigger: {
            trigger: howItWorksRef.current,
            start: 'top 85%',
          },
        }
      );

      // Step images parallax effect
      gsap.utils.toArray('.step-image').forEach((img: any) => {
        gsap.to(img, {
          y: -30,
          scrollTrigger: {
            trigger: img,
            start: 'top bottom',
            end: 'bottom top',
            scrub: 1,
          },
        });
      });

      // Use cases - more dramatic
      gsap.fromTo(
        '.usecase-card',
        { opacity: 0, scale: 0.7, rotation: -5 },
        {
          opacity: 1,
          scale: 1,
          rotation: 0,
          duration: 0.7,
          stagger: 0.1,
          ease: 'back.out(1.4)',
          scrollTrigger: {
            trigger: useCasesRef.current,
            start: 'top 85%',
          },
        }
      );

      // News section - more dramatic
      gsap.fromTo(
        '.news-card',
        { opacity: 0, y: 50, scale: 0.9 },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          duration: 0.8,
          stagger: 0.12,
          ease: 'power2.out',
          scrollTrigger: {
            trigger: newsRef.current,
            start: 'top 85%',
          },
        }
      );

      // Demo video section animation
      if (videoRef.current) {
        gsap.fromTo(
          '.demo-video-container',
          { opacity: 0, scale: 0.95, y: 60 },
          {
            opacity: 1,
            scale: 1,
            y: 0,
            duration: 1,
            ease: 'power3.out',
            scrollTrigger: {
              trigger: videoRef.current,
              start: 'top 85%',
            },
          }
        );

        gsap.fromTo(
          '.demo-video-content',
          { opacity: 0, x: -40 },
          {
            opacity: 1,
            x: 0,
            duration: 0.8,
            delay: 0.3,
            ease: 'power2.out',
            scrollTrigger: {
              trigger: videoRef.current,
              start: 'top 85%',
            },
          }
        );
      }

      // Section headers animation
      gsap.utils.toArray('.section-header').forEach((header: any) => {
        gsap.fromTo(
          header,
          { opacity: 0, y: 30 },
          {
            opacity: 1,
            y: 0,
            duration: 0.8,
            scrollTrigger: {
              trigger: header,
              start: 'top 90%',
            },
          }
        );
      });
    });

    return () => ctx.revert();
  }, []);

  return (
    <div className="bg-[#07080A]">
      {/* Hero Section */}
      <section
        ref={heroRef}
        className="relative min-h-screen flex items-center justify-center overflow-hidden"
      >
        {/* Background Image */}
        <div className="absolute inset-0">
          <img
            src="/hero_portrait.jpg"
            alt="Hero background"
            className="w-full h-full object-cover opacity-60"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-[#07080A] via-[#07080A]/80 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-t from-[#07080A] via-transparent to-[#07080A]/50" />
        </div>

        {/* Content */}
        <div className="relative z-10 max-w-7xl mx-auto px-6 lg:px-8 pt-32 pb-20">
          <div className="max-w-3xl">
            <span className="hero-eyebrow inline-block px-4 py-1.5 rounded-full bg-[#DFFF00]/10 border border-[#DFFF00]/20 text-[#DFFF00] text-xs font-mono uppercase tracking-wider mb-6">
              Bittensor Subnet 22
            </span>
            <h1 className="hero-title text-5xl md:text-7xl font-semibold tracking-tight leading-[1.1] mb-6">
              The voice layer for{' '}
              <span className="gradient-text">decentralized intelligence.</span>
            </h1>
            <p className="hero-subtitle text-lg md:text-xl text-[#A7B0B7] leading-relaxed mb-8 max-w-2xl">
            Vocence is an open network dedicated to training the world’s most expressive 
            prompt-to-speech models, governed by on-chain incentive mechanisms within the Bittensor network
            </p>
            <div className="hero-cta flex flex-wrap gap-4">
              <Link to="/studio" className="btn-primary">
                Open Studio
                <ArrowRight size={18} className="ml-2" />
              </Link>
              <Link to="/dashboard" className="btn-outline">
                Network Dashboard
              </Link>
              <Link to="/whitepaper" className="btn-outline">
                Whitepaper
              </Link>
              <Link to="/docs" className="btn-outline">
                Read the Docs
              </Link>
            </div>
          </div>
        </div>

        {/* Bottom Status Bar */}
        <div className="absolute bottom-8 left-6 lg:left-8 flex items-center gap-2 px-4 py-2 rounded-full border border-white/10 bg-white/5">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-xs font-mono text-[#A7B0B7]">Mainnet</span>
          <span className="text-xs text-[#666]">|</span>
          <span className="text-xs text-[#A7B0B7]">Network Status: Healthy</span>
        </div>

        {/* Scroll Hint */}
        <div className="absolute bottom-8 right-6 lg:right-8 text-xs text-[#666]">
          Scroll to explore
        </div>
      </section>

      {/* What is Vocence Section */}
      <section ref={featuresRef} className="py-24 px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16 section-header">
            <span className="label-mono mb-4 block">What is Vocence?</span>
            <h2 className="text-3xl md:text-4xl font-semibold mb-4">
            All-in-One Prompt-to-Speech
            </h2>
            <p className="text-[#A7B0B7] max-w-2xl mx-auto">
            Vocence turns rich, multi-dimensional speech prompts into natural audio, 
            trained by a decentralized network and verified through open, prompt-faithful benchmarks
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                icon: Mic,
                title: 'Prompt-to-Speech',
                description: 'Describe tone, pace, and emotion in plain language.',
              },
              {
                icon: Cpu,
                title: 'Decentralized Training',
                description: 'Miners compete to improve quality; validators keep scoring honest.',
              },
              {
                icon: Shield,
                title: 'Open Evaluation',
                description: 'No black boxes. Metrics, datasets, and code are public.',
              },
            ].map((feature, index) => (
              <div
                key={index}
                className="feature-card card-vocence p-8 hover:border-[#DFFF00]/30 transition-all duration-300 hover:scale-105 hover:shadow-lg hover:shadow-[#DFFF00]/20"
              >
                <div className="feature-icon w-12 h-12 rounded-xl bg-[#DFFF00]/10 flex items-center justify-center mb-6 transition-transform duration-300 group-hover:scale-110 group-hover:rotate-6">
                  <feature.icon size={24} className="text-[#DFFF00]" />
                </div>
                <h3 className="text-xl font-semibold mb-3">{feature.title}</h3>
                <p className="text-[#A7B0B7]">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Demo Video Section */}
      <section ref={videoRef} className="py-24 px-6 lg:px-8 border-y border-white/5">
        <div className="max-w-7xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            {/* Content */}
            <div className="demo-video-content">
              <span className="label-mono mb-4 block">See It In Action</span>
              <h2 className="text-3xl md:text-4xl font-semibold mb-4">
                Experience Vocence Studio
              </h2>
              <p className="text-[#A7B0B7] mb-6 leading-relaxed">
                See how easy it is to create natural, impressive speech with just a prompt. Describe voice, tone, and style—then get the exact speech you want.
              </p>
              <ul className="space-y-3 mb-8">
                {[
                  'Real-time speech generation',
                  'Emotional control and style prompts',
                  'Professional-grade audio quality',
                ].map((item, index) => (
                  <li key={index} className="flex items-center gap-3">
                    <span className="text-[#DFFF00]">
                      <Check size={18} />
                    </span>
                    <span className="text-[#A7B0B7]">{item}</span>
                  </li>
                ))}
              </ul>
              <Link to="/studio" className="btn-primary inline-flex items-center">
                Try It Now
                <ArrowRight size={18} className="ml-2" />
              </Link>
            </div>

            {/* Video */}
            <div className="demo-video-container">
              <div 
                className="relative rounded-2xl overflow-hidden border border-white/10 bg-[#0D1117] shadow-2xl group cursor-pointer"
                onClick={() => {
                  if (videoElementRef.current) {
                    if (videoElementRef.current.paused) {
                      videoElementRef.current.play();
                    } else {
                      videoElementRef.current.pause();
                    }
                  }
                }}
              >
                <div className="aspect-video">
                  <video
                    ref={videoElementRef}
                    autoPlay
                    loop
                    muted
                    playsInline
                    className="w-full h-full object-cover"
                  >
                    <source src="/demo.mp4" type="video/mp4" />
                    Your browser does not support the video tag.
                  </video>
                </div>
                {/* Video overlay gradient */}
                <div className="absolute inset-0 bg-gradient-to-t from-[#07080A]/30 via-transparent to-transparent pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Live Network Stats Section */}
      <section ref={statsRef} className="py-24 px-6 lg:px-8 border-y border-white/5">
        <div className="max-w-7xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <span className="label-mono mb-4 block">Live Network</span>
              <h2 className="text-3xl md:text-4xl font-semibold mb-4">
                Real-time Performance
              </h2>
              <p className="text-[#A7B0B7] mb-8">
                Validators score miners every few seconds. The best models rise to the top.
                View the full network dashboard for miners, validators, win rates, and evaluation activity.
              </p>

              <div className="grid grid-cols-3 gap-6">
                <div className="stat-item">
                  <div className="stat-number text-4xl font-bold text-[#DFFF00] mb-1">
                    {overview?.valid_miners != null ? overview.valid_miners.toLocaleString() : '—'}
                  </div>
                  <div className="text-sm text-[#A7B0B7]">Active miners</div>
                </div>
                <div className="stat-item">
                  <div className="stat-number text-4xl font-bold text-white mb-1">
                    {overview?.total_validators != null ? overview.total_validators.toLocaleString() : '—'}
                  </div>
                  <div className="text-sm text-[#A7B0B7]">Validators</div>
                </div>
                <div className="stat-item">
                  <div className="stat-number text-4xl font-bold text-white mb-1">
                    {overview?.total_evaluations != null ? overview.total_evaluations.toLocaleString() : '—'}
                  </div>
                  <div className="text-sm text-[#A7B0B7]">Evaluations</div>
                </div>
              </div>

              <Link
                to="/dashboard"
                className="stat-item mt-8 inline-flex items-center gap-2 px-6 py-3 rounded-xl border border-[#DFFF00]/30 bg-[#DFFF00]/5 text-[#DFFF00] font-medium hover:bg-[#DFFF00]/10 hover:border-[#DFFF00]/50 transition-colors"
              >
                Open Network Dashboard
                <ArrowRight size={18} />
              </Link>
            </div>

            <div className="space-y-3">
              <p className="text-sm text-[#A7B0B7] mb-4">
                The dashboard shows live data from the owner database: miner rankings by win rate, validator activity, and evaluation counts over time.
              </p>
              <Link
                to="/dashboard"
                className="stat-item flex items-center justify-between p-4 rounded-xl border border-l-2 border-l-[#DFFF00] bg-white/5 hover:bg-white/10 transition-colors group"
              >
                <div className="flex items-center gap-4">
                  <span className="text-sm font-medium text-white">Network Dashboard</span>
                  <span className="text-xs text-[#666]">Miners · Validators · Metrics</span>
                </div>
                <ArrowRight size={18} className="text-[#DFFF00] group-hover:translate-x-1 transition-transform" />
              </Link>
              <div className="p-4 rounded-xl border border-white/5 bg-white/[0.02]">
                <p className="text-xs text-[#666]">
                  Data is collected from validators via the Vocence API and aggregated for transparent, real-time visibility.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section ref={howItWorksRef} className="py-24 px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <span className="label-mono mb-4 block">How It Works</span>
            <h2 className="text-3xl md:text-4xl font-semibold mb-4">
              Built on Decentralized Intelligence
            </h2>
            <p className="text-[#A7B0B7] max-w-2xl mx-auto">
              Vocence leverages the Bittensor network to create the most advanced
              prompt-controlled voice synthesis models through distributed training.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                step: '01',
                title: 'Generate Task',
                description:
                  'Validators create prompts with target voice traits and reference audio.',
                image: '/step_01.jpg',
              },
              {
                step: '02',
                title: 'Mine & Submit',
                description:
                  'Miners continuously improve their models and submit them to the network',
                image: '/step_02.jpg',
              },
              {
                step: '03',
                title: 'Score & Reward',
                description:
                  'Validators evaluate quality and prompt adherence; rewards flow on-chain.',
                image: '/step_03.jpg',
              },
            ].map((step, index) => (
              <div key={index} className="step-card card-vocence overflow-hidden group">
                <div className="h-48 overflow-hidden">
                  <img
                    src={step.image}
                    alt={step.title}
                    className="step-image w-full h-full object-cover opacity-80 group-hover:opacity-100 group-hover:brightness-110 group-hover:scale-110 transition-all duration-500"
                  />
                </div>
                <div className="p-6">
                  <span className="text-5xl font-bold text-white/10 absolute top-4 right-4">
                    {step.step}
                  </span>
                  <h3 className="text-xl font-semibold mb-2">{step.title}</h3>
                  <p className="text-[#A7B0B7] text-sm">{step.description}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Prompt-to-Speech Demo Section */}
      <section className="py-24 px-6 lg:px-8 border-y border-white/5">
        <div className="max-w-7xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <span className="label-mono mb-4 block">Prompt-to-Speech: PromptTTS Models</span>
              <h2 className="text-3xl md:text-4xl font-semibold mb-4">
                Fine-Grained Emotional Control
              </h2>
              <p className="text-[#A7B0B7] mb-6">
                Describe voice, mood, and pacing. The model follows your intent—not just
                the text.
              </p>

              <ul className="space-y-3 mb-8">
                {[
                  'Gender, age, accent, emotion',
                  'Speaking style and emphasis',
                  'Accent, tone, speed, environment',
                ].map((item, index) => (
                  <li key={index} className="flex items-center gap-3">
                    <span className="text-[#DFFF00]">
                      <Check size={18} />
                    </span>
                    <span className="text-[#A7B0B7]">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="card-vocence p-6">
              <audio ref={sampleAudioRef} src="/generated_audio.wav" preload="metadata" />
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-mono text-[#666]">Example prompt</span>
                <button
                  type="button"
                  onClick={toggleSamplePlayback}
                  className="flex items-center gap-2 text-sm text-[#DFFF00] hover:opacity-90"
                >
                  {samplePlaying ? <Square size={16} /> : <Play size={16} />}
                  {samplePlaying ? 'Stop' : 'Play sample'}
                </button>
              </div>
              <p className="text-sm text-[#A7B0B7] mb-6">
                &quot;swamps, omnipresent streams, and viscous mud from the daily rains. The Amtracs proved amazingly flexible. They moved men, ammunition, rations, water, barbed wire, and even radio jeeps to the front lines where they were most needed. Heading back, they evacuated the wounded to reach the | gender: male | emotion: neutral | pitch: normal | tone: formal | environment: quiet | speed: normal | accent: american&quot;
              </p>
              <div className="flex items-end gap-1 h-16">
                {Array.from({ length: 32 }).map((_, i) => (
                  <div
                    key={i}
                    className="w-1 bg-[#DFFF00] rounded-full waveform-bar"
                    style={{
                      height: `${20 + Math.random() * 80}%`,
                      animationDelay: `${i * 0.05}s`,
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Use Cases Section */}
      <section ref={useCasesRef} className="py-24 px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <span className="label-mono mb-4 block">Use Cases</span>
            <h2 className="text-3xl md:text-4xl font-semibold mb-4">
              Built for Every Voice Application
            </h2>
            <p className="text-[#A7B0B7] max-w-2xl mx-auto">
              From agents to entertainment—anywhere voice needs to be expressive and
              controllable.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              {
                title: 'AI Agents',
                image: '/usecase_agents.jpg',
                icon: Cpu,
              },
              {
                title: 'Accessibility',
                image: '/usecase_accessibility.jpg',
                icon: Mic,
              },
              {
                title: 'Gaming & Characters',
                image: '/usecase_gaming.jpg',
                icon: Zap,
              },
              {
                title: 'Content & Dubbing',
                image: '/usecase_dubbing.jpg',
                icon: Globe,
              },
            ].map((usecase, index) => (
              <div
                key={index}
                className="usecase-card group relative overflow-hidden rounded-2xl aspect-square cursor-pointer"
              >
                <img
                  src={usecase.image}
                  alt={usecase.title}
                  className="absolute inset-0 w-full h-full object-cover opacity-60 group-hover:opacity-100 group-hover:brightness-110 group-hover:scale-110 transition-all duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#07080A] via-[#07080A]/50 to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 p-6">
                  <div className="w-10 h-10 rounded-lg bg-[#DFFF00]/20 flex items-center justify-center mb-3">
                    <usecase.icon size={20} className="text-[#DFFF00]" />
                  </div>
                  <h3 className="text-lg font-semibold">{usecase.title}</h3>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Latest Updates Section */}
      <section ref={newsRef} className="py-24 px-6 lg:px-8 border-y border-white/5">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-between mb-12">
            <div>
              <span className="label-mono mb-4 block">Latest Updates</span>
              <h2 className="text-3xl md:text-4xl font-semibold">News & Updates</h2>
            </div>
            <Link
              to="/blog"
              className="hidden md:flex items-center gap-2 text-[#A7B0B7] hover:text-[#DFFF00] transition-colors"
            >
              View all <ArrowRight size={18} />
            </Link>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {postsLoading ? (
              [...Array(3)].map((_, i) => (
                <div key={i} className="news-card card-vocence overflow-hidden animate-pulse">
                  <div className="h-48 bg-white/5" />
                  <div className="p-6 space-y-3">
                    <div className="h-4 bg-white/10 rounded w-1/3" />
                    <div className="h-5 bg-white/10 rounded w-full" />
                    <div className="h-4 bg-white/10 rounded w-full" />
                    <div className="h-4 bg-white/10 rounded w-2/3" />
                  </div>
                </div>
              ))
            ) : latestPosts.length === 0 ? (
              <p className="col-span-full text-center text-[#A7B0B7] py-8">No blog posts yet.</p>
            ) : (
              latestPosts.map((post) => (
                <Link
                  key={post.id}
                  to={`/blog/${post.id}`}
                  className="news-card card-vocence overflow-hidden group cursor-pointer block"
                >
                  <div className="h-48 overflow-hidden">
                    <img
                      src={blogImageUrl(post.image)}
                      alt={post.title}
                      className="w-full h-full object-cover group-hover:scale-110 group-hover:brightness-110 transition-all duration-500"
                    />
                  </div>
                  <div className="p-6">
                    <span className="inline-block px-3 py-1 rounded-full bg-white/5 text-xs font-mono text-[#A7B0B7] mb-3">
                      {post.category}
                    </span>
                    <h3 className="text-lg font-semibold mb-2 group-hover:text-[#DFFF00] transition-colors">
                      {post.title}
                    </h3>
                    <p className="text-sm text-[#A7B0B7] mb-4 line-clamp-2">
                      {post.excerpt}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-[#666]">
                      <span>{post.date}</span>
                      <span>•</span>
                      <span>{post.read_time}</span>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>
      </section>

      {/* Roadmap Section */}
      <section className="py-24 px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <span className="label-mono mb-4 block">Roadmap</span>
            <h2 className="text-3xl md:text-4xl font-semibold mb-4">Project Roadmap</h2>
            <p className="text-[#A7B0B7] max-w-2xl mx-auto">
              Our journey to build the most expressive decentralized voice synthesis network.
            </p>
          </div>

          <div className="card-vocence p-8 md:p-12">
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-4 md:left-6 top-0 bottom-0 w-0.5 bg-white/10" />

              <div className="space-y-12">
                {[
                  {
                    phase: 'Q1 – Foundation',
                    completed: true,
                    items: [
                      'Subnet launch on Bittensor',
                      'Baseline PromptTTS evaluation pipeline focused on voice quality validation, voice trait accuracy, and content correctness',
                      'Official website and monitoring dashboard',
                    ],
                  },
                  {
                    phase: 'Q2 – Scaling and Robustness',
                    completed: false,
                    items: [
                      'Expanded voice-trait and environmental taxonomy',
                      'Improved prompt adherence metrics',
                      'Adversarial prompt testing to reduce overfitting and prompt gaming',
                      'Subnet product launch and API for developers',
                    ],
                  },
                  {
                    phase: 'Q3 – Ecosystem Expansion',
                    completed: false,
                    items: [
                      'Multilingual PromptTTS support',
                      'Platform expansion into prompt-driven voice agents, prompt-based voice cloning, and real-time voice chat applications',
                      'Cross-subnet integrations within the Bittensor ecosystem',
                      'Advanced controllability and expressiveness benchmarks',
                      'Community-driven dataset contributions and evaluation extensions',
                    ],
                  },
                ].map((item, index) => (
                  <div key={index} className="relative pl-12 md:pl-16">
                    <div
                      className={`absolute left-0 md:left-2 top-1 w-8 h-8 rounded-full border-2 flex items-center justify-center ${
                        item.completed
                          ? 'border-[#DFFF00] bg-[#DFFF00]'
                          : 'border-white/20 bg-[#07080A]'
                      }`}
                    >
                      {item.completed && <Check size={14} className="text-[#07080A]" />}
                    </div>
                    <h3 className="text-xl font-semibold mb-3">{item.phase}</h3>
                    <ul className="text-[#A7B0B7] space-y-1.5 list-disc list-inside">
                      {item.items.map((bullet, i) => (
                        <li key={i}>{bullet}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-24 px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="grid md:grid-cols-2 gap-6">
            {/* Studio CTA */}
            <div className="card-vocence p-8 md:p-12 relative overflow-hidden">
              <div className="relative z-10">
                <span className="label-mono mb-4 block">Try the Studio</span>
                <h3 className="text-2xl md:text-3xl font-semibold mb-4">
                  Generate Speech in Seconds
                </h3>
                <p className="text-[#A7B0B7] mb-6">
                  Generate speech, clone voices, and tune style prompts—in one interface.
                </p>
                <Link to="/studio" className="btn-primary">
                  Launch Studio
                  <ArrowRight size={18} className="ml-2" />
                </Link>
              </div>
              <img
                src="/studio_ui.jpg"
                alt="Studio UI"
                className="absolute right-0 bottom-0 w-2/3 opacity-30 hover:opacity-40 hover:scale-105 transition-all duration-500"
              />
            </div>

            {/* Docs CTA */}
            <div className="card-vocence p-8 md:p-12 relative overflow-hidden">
              <div className="relative z-10">
                <span className="label-mono mb-4 block">Build with Vocence</span>
                <h3 className="text-2xl md:text-3xl font-semibold mb-4">
                  Developer Ready
                </h3>
                <p className="text-[#A7B0B7] mb-6">
                  REST API, Python SDK, and real-time WebSocket streams. Get started in
                  minutes.
                </p>
                <Link to="/docs" className="btn-primary">
                  Read Docs
                  <ArrowRight size={18} className="ml-2" />
                </Link>
              </div>
              <img
                src="/docs_code.jpg"
                alt="Code"
                className="absolute right-0 bottom-0 w-2/3 opacity-30 hover:opacity-40 hover:scale-105 transition-all duration-500"
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
