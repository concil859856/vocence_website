import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export function Whitepaper() {
  const navigate = useNavigate();
  const backToHome = () => navigate('/');

  return (
    <div className="min-h-screen bg-[#07080A] pt-24">
      <div className="max-w-4xl mx-auto px-6 lg:px-8 py-16">
        <button
          type="button"
          onClick={backToHome}
          className="inline-flex items-center gap-2 text-sm text-[#A7B0B7] hover:text-[#DFFF00] transition-colors mb-8 bg-transparent border-0 cursor-pointer p-0 font-inherit"
        >
          <ArrowLeft size={16} />
          Back to home
        </button>

        {/* Header */}
        <div className="mb-12 text-center">
          <h1 className="text-4xl md:text-5xl font-bold mb-2">Vocence</h1>
          <h2 className="text-2xl md:text-3xl font-semibold text-[#DFFF00] mb-4">
            PromptTTS Model Training Subnet on Bittensor
          </h2>
          <p className="text-lg text-[#A7B0B7]">Whitepaper v1.0</p>
        </div>

        <div className="space-y-10 text-[#A7B0B7] leading-7">
          {/* Abstract */}
          <section className="bg-white/5 border border-white/10 rounded-xl p-8">
            <h2 className="text-2xl font-semibold text-white mb-4">Abstract</h2>
            <p className="mb-4">
              Vocence is a Bittensor subnet dedicated to training, evaluating, and improving prompt-based
              text-to-speech (PromptTTS) models. Unlike traditional TTS systems that merely convert text into
              audio, PromptTTS models generate speech from all-in prompts that combine transcription with explicit
              control signals, including voice characteristics (gender, age, emotion, tone), speaking style,
              accent and non-native speech patterns, as well as environmental attributes such as background noise,
              recording conditions, and overall acoustic context
            </p>
            <p>
              Vocence introduces a decentralized incentive system where miners compete to produce PromptTTS models
              that accurately follow these multi-dimensional prompts, while validators objectively evaluate audio
              quality, content correctness, prompt adherence, and environmental consistency. The goal is to create
              an open, permissionless network for advancing highly controllable, expressive, and context-aware
              speech synthesis.
            </p>
          </section>

          {/* Section 1 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">1. What Is Vocence</h2>
            <p className="mb-4">
              Vocence is a PromptTTS model training subnet built on Bittensor.
            </p>
            <p className="mb-4">
              PromptTTS refers to text-to-speech models that accept inputs such as:
            </p>
            <div className="bg-[#0a0a0a] border border-white/10 rounded-lg p-4 my-4 font-mono text-sm">
              &quot;A calm, middle-aged male voice, neutral accent, slow pace, warm tone, reading the following
              sentence…&quot;
            </div>
            <p>
              These models generate speech that accurately reflects both the textual content and the described
              voice characteristics. Vocence incentivizes miners to train and serve such models, while validators
              continuously score outputs using a standardized, public evaluation pipeline.
            </p>
          </section>

          {/* Section 2 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">2. Why Vocence on Bittensor</h2>
            
            <h3 className="text-xl font-semibold text-white mb-3 mt-6">2.1 Decentralized Model Competition</h3>
            <p className="mb-4">
              TTS quality improves fastest when many independent teams experiment with architectures, datasets,
              and training strategies. Bittensor enables this without centralized gatekeepers.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">2.2 Continuous Incentive Alignment</h3>
            <p className="mb-4">
              Miners are rewarded only when their models perform better, not for claims or branding. This creates
              organic pressure toward real improvements in speech quality and controllability.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">2.3 Open Evaluation</h3>
            <p className="mb-4">
              Vocence&apos;s evaluation logic is public, reproducible, and permissionless. There are no hidden
              benchmarks or private scoring mechanisms. By keeping evaluation open and transparent, Vocence enables
              more accurate benchmarking, allows broad participation in improving evaluation standards, and
              accelerates model development beyond what is possible in centralized companies that keep their methods
              proprietary.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">2.4 Composability with Other Subnets</h3>
            <p>
              PromptTTS is a foundational capability for conversational AI, voice agents, games and virtual
              characters, accessibility tools, and multimodal systems.
            </p>
          </section>

          {/* Section 3 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">3. Why This Project Idea Exists</h2>
            <p className="mb-4">
              Current TTS systems suffer from several limitations:
            </p>
            <ul className="list-disc list-inside space-y-2 ml-2 mb-4">
              <li>Weak control over voice characteristics</li>
              <li>Prompt descriptions that are partially or fully ignored</li>
              <li>Models optimized only for naturalness, not controllability</li>
              <li>Closed evaluation pipelines and proprietary datasets</li>
            </ul>
            <p>
              PromptTTS is the natural evolution of TTS, but training and evaluating prompt adherence remains
              difficult, expensive, and fragmented. Vocence exists to make PromptTTS measurable, comparable,
              improvable, and decentralized.
            </p>
          </section>

          {/* Section 4 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">
              4. Current Problems in TTS and PromptTTS
            </h2>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">4.1 Lack of Objective Evaluation</h3>
            <p className="mb-4">
              Most TTS benchmarks focus on mean opinion score (MOS), intelligibility, and basic audio quality.
              They do not evaluate whether the generated speech actually matches the prompted voice traits or the
              specified environmental conditions.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">4.2 Closed Datasets and Models</h3>
            <p className="mb-4">
              State-of-the-art systems are often locked behind proprietary data and private evaluation loops.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">4.3 Prompt Drift</h3>
            <p className="mb-4">
              Models often produce speech that sounds natural but ignores age, emotion, tone, and style specified
              in the prompt.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">4.4 Centralization</h3>
            <p>
              Improvements depend on a small number of organizations with large compute budgets and private
              datasets.
            </p>
          </section>

          {/* Section 5 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">5. The Vocence Solution</h2>
            <p className="mb-4">
              Vocence addresses these issues through a prompt-aware training and evaluation subnet.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">5.1 Task Design</h3>
            <p className="mb-4">
              Validators generate tasks consisting of reference audio clips, extracted voice-trait descriptions,
              and corresponding text prompts. Miners must generate speech that matches both the content and the
              voice traits.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">5.2 Dual-Axis Evaluation</h3>
            <p className="mb-4">
              Validator scoring focuses on three core dimensions: content correctness, audio quality, and prompt
              adherence. These scores are combined into a single reward signal.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">5.3 Public Evaluation Pipeline</h3>
            <p className="mb-4">
              Evaluation code is open source, metrics are reproducible, and there is no private judging.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">5.4 Incentive Alignment</h3>
            <p>
              Miners earn TAO proportional to real performance. Overfitting and prompt cheating are penalized, and
              validators compete on evaluation accuracy.
            </p>
          </section>

          {/* Section 6 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">6. System Architecture</h2>
            <p className="mb-4">
              Miners train or fine-tune PromptTTS models and deploy them as inference services on Chutes, where
              models are made accessible through a standardized API. Validators interact with these deployed models
              via the Chutes API to submit evaluation tasks, collect generated speech outputs, and compute scores.
            </p>
            <p>
              Validator evaluation is performed using predefined, public benchmarks that assess content
              correctness, audio quality, prompt adherence, and environmental consistency. To prevent overfitting
              and benchmark gaming, evaluation tasks are continuously sourced from dynamically updated online data
              streams, such as YouTube and other public platforms. Because the underlying data distribution
              evolves in real time, models cannot memorize or overfit fixed test sets, ensuring robust and
              generalizable performance over time.
            </p>
          </section>

          {/* Section 7 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">7. Roadmap</h2>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">Q1 – Foundation</h3>
            <ul className="list-disc list-inside space-y-2 ml-2 mb-6">
              <li>Subnet launch on Bittensor</li>
              <li>
                Baseline PromptTTS evaluation pipeline focused on voice quality validation, voice trait accuracy,
                and content correctness
              </li>
              <li>Official website and monitoring dashboard</li>
            </ul>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">Q2 – Scaling and Robustness</h3>
            <ul className="list-disc list-inside space-y-2 ml-2 mb-6">
              <li>Expanded voice-trait and environmental taxonomy</li>
              <li>Improved prompt adherence metrics</li>
              <li>
                Adversarial prompt testing to reduce overfitting and prompt gaming
              </li>
              <li>Subnet product launch and API for developers</li>
            </ul>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">Q3 – Ecosystem Expansion</h3>
            <ul className="list-disc list-inside space-y-2 ml-2">
              <li>Multilingual PromptTTS support</li>
              <li>
                Platform expansion into prompt-driven voice agents, prompt-based voice cloning, and real-time
                voice chat applications
              </li>
              <li>Cross-subnet integrations within the Bittensor ecosystem</li>
              <li>Advanced controllability and expressiveness benchmarks</li>
              <li>Community-driven dataset contributions and evaluation extensions</li>
            </ul>
          </section>

          {/* Section 8 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">8. Governance</h2>
            <p>
              Vocence supports permissionless miner and validator participation. Protocol changes are proposed
              publicly, with an emphasis on backward-compatible upgrades and transparent evaluation logic updates.
            </p>
          </section>

          {/* Section 9 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">9. Risks and Mitigations</h2>
            <p>
              Overfitting to evaluation metrics is mitigated through rotating prompts and dataset expansion.
              Validator bias is mitigated through validator competition and stake-weighted consensus. Compute
              centralization is mitigated through reward shaping that favors efficiency rather than brute force.
            </p>
          </section>

          {/* Section 10 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">10. Questions and Answers</h2>
            
            <div className="space-y-6 mt-6">
              <div>
                <p className="font-semibold text-white mb-2">
                  Q: What makes Vocence different from existing TTS subnets?
                </p>
                <p className="text-[#A7B0B7]">
                  A: Vocence explicitly evaluates prompt adherence, not just audio quality or intelligibility.
                </p>
              </div>

              <div>
                <p className="font-semibold text-white mb-2">
                  Q: Do miners need to train models from scratch?
                </p>
                <p className="text-[#A7B0B7]">
                  A: No. Miners may fine-tune existing models or develop new architectures.
                </p>
              </div>

              <div>
                <p className="font-semibold text-white mb-2">Q: Is the evaluation model public?</p>
                <p className="text-[#A7B0B7]">
                  A: Yes. All evaluation logic is open and reproducible.
                </p>
              </div>

              <div>
                <p className="font-semibold text-white mb-2">
                  Q: Can Vocence support commercial use cases?
                </p>
                <p className="text-[#A7B0B7]">
                  A: Yes. Outputs are suitable for voice agents, games, assistants, and accessibility tools.
                </p>
              </div>

              <div>
                <p className="font-semibold text-white mb-2">
                  Q: How does Vocence prevent prompt cheating?
                </p>
                <p className="text-[#A7B0B7]">
                  A: Through adversarial prompts, cross-validation, and multi-axis scoring.
                </p>
              </div>
            </div>
          </section>

          {/* Section 11 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">11. Conclusion</h2>
            <p>
              Vocence brings prompt-controlled speech synthesis into the decentralized AI era. By aligning
              incentives around controllable, expressive, and accurate voice generation, Vocence enables the next
              generation of speech systems to be open, competitive, and continuously improving.
            </p>
          </section>
        </div>

        <div className="mt-16 pt-8 border-t border-white/10">
          <button
            type="button"
            onClick={backToHome}
            className="inline-flex items-center gap-2 text-sm text-[#A7B0B7] hover:text-[#DFFF00] transition-colors bg-transparent border-0 cursor-pointer p-0 font-inherit"
          >
            <ArrowLeft size={16} />
            Back to home
          </button>
        </div>
      </div>
    </div>
  );
}
