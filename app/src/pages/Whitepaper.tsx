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
            Voice Intelligence Layer Network on Bittensor
          </h2>
          <p className="text-lg text-[#A7B0B7]">Whitepaper v1.0</p>
        </div>

        <div className="space-y-10 text-[#A7B0B7] leading-7">
          {/* Abstract */}
          <section className="bg-white/5 border border-white/10 rounded-xl p-8">
            <h2 className="text-2xl font-semibold text-white mb-4">Abstract</h2>
            <p className="mb-4">
              Vocence is a Bittensor subnet focused on the development, evaluation, and enhancement of voice-driven intelligence, encompassing a wide range of technologies including Prompt-based Text-to-Speech (PromptTTS), Speech-to-Text (STT), Speech-to-Speech (STS), voice cloning, and Text-to-Music (TTM). This decentralized network goes beyond traditional voice synthesis by integrating various layers of multimodal voice intelligence, enabling the creation of dynamic voice agents with advanced control and adaptability.
            </p>
            <p className="mb-4">
              Vocence empowers miners to train and improve voice models that respond to highly detailed prompts, including voice characteristics (gender, age, emotion, tone), speaking style, accent, non-native speech patterns, and environmental factors like background noise, recording conditions, and acoustic context. Beyond PromptTTS, Vocence also supports other voice-related layers of intelligence such as Speech-to-Text (STT), Speech-to-Speech (STS), Voice Cloning, and Text-to-Music (TTM), enabling a full spectrum of voice and audio synthesis capabilities. Validators assess the performance of these models, ensuring they adhere to prompts, accurately capture content, and maintain environmental consistency across various use cases, from natural speech generation to interactive voice agents and even music generation.
            </p>
            <p>
              By leveraging a decentralized incentive structure, Vocence aims to foster an open, permissionless ecosystem where voice models not only generate lifelike speech but also evolve into intelligent, context-aware agents that can adapt to a wide array of tasks. The goal is to push the boundaries of what is possible in AI-driven voice technologies, supporting innovation and creating a more flexible, expressive, and controllable voice interface for various applications.
            </p>
          </section>

          {/* Section 1 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">1. What Is Vocence</h2>
            <p className="mb-4">
              Vocence is a Bittensor subnet focused on the development, training, evaluation, and improvement of a wide range of voice intelligence models, including PromptTTS (text-to-speech), STT (speech-to-text), STS (speech-to-speech), voice cloning, TTM (text-to-music), and voice agents.
            </p>
            <p className="mb-4">
              PromptTTS refers to text-to-speech models that accept inputs such as:
            </p>
            <div className="bg-[#0a0a0a] border border-white/10 rounded-lg p-4 my-4 font-mono text-sm">
              &quot;A calm, middle-aged male voice, neutral accent, slow pace, warm tone, reading the following sentence…&quot;
            </div>
            <p className="mb-4">
              These models generate speech that accurately reflects both the textual content and the described voice characteristics. However, Vocence is not limited to just PromptTTS; it also encompasses Speech-to-Text (STT), Speech-to-Speech (STS), Voice Cloning, Text-to-Music (TTM), and the development of intelligent, multimodal voice agents. These voice agents leverage deep learning and multimodal inputs to carry out complex tasks, interacting with both text and speech.
            </p>
            <p>
              Vocence incentivizes miners to train and serve models across these various domains, while validators assess the outputs using standardized, public evaluation pipelines to ensure high-quality and contextually accurate results across the full spectrum of voice intelligence.
            </p>
          </section>

          {/* Section 2 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">2. Why Vocence on Bittensor</h2>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">2.1 Decentralized Model Competition</h3>
            <p className="mb-4">
              Voice model quality improves fastest when many independent teams experiment with architectures, datasets, and training strategies across diverse voice intelligence domains, including PromptTTS, STT, STS, voice cloning, TTM, and voice agents. Bittensor enables this decentralized experimentation, fostering innovation without centralized gatekeepers. This structure empowers a wide range of contributors to push the boundaries of voice-driven AI, encouraging a competitive environment that accelerates progress across all facets of voice intelligence.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">2.2 Continuous Incentive Alignment</h3>
            <p className="mb-4">
              Miners are rewarded only when their models perform better, not for claims or branding. This creates organic pressure toward real improvements in speech quality and controllability.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">2.3 Open Evaluation</h3>
            <p className="mb-4">
              Vocence&apos;s evaluation logic is public, reproducible, and permissionless. There are no hidden benchmarks or private scoring mechanisms. By keeping evaluation open and transparent, Vocence enables more accurate benchmarking, allows broad participation in improving evaluation standards, and accelerates model development beyond what is possible in centralized companies that keep their methods proprietary.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">2.4 Composability with Other Subnets</h3>
            <p>
              Voice intelligence, including PromptTTS, STT, STS, voice cloning, TTM, and voice agents, is a foundational capability for a wide range of applications, such as conversational AI, voice-driven agents, interactive games, virtual characters, accessibility tools, and multimodal systems. These capabilities are highly composable with other Bittensor subnets, enabling seamless integration and collaboration across diverse use cases, and driving the development of innovative, cross-functional voice technologies.
            </p>
          </section>

          {/* Section 3 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">3. Why This Project Idea Exists</h2>
            <p className="mb-4">
              Current voice systems, including TTS, STT, STS, voice cloning, TTM, and voice agents, suffer from several limitations:
            </p>
            <ul className="list-disc list-outside pl-6 space-y-2 mb-4">
              <li>Weak control over voice characteristics</li>
              <li>Prompt descriptions that are partially or fully ignored</li>
              <li>Models optimized only for naturalness, not controllability</li>
              <li>Closed evaluation pipelines and proprietary datasets</li>
            </ul>
            <p>
              PromptTTS and other voice technologies are the natural evolution of voice-driven systems, but training, evaluating, and ensuring prompt adherence remains difficult, expensive, and fragmented. Vocence exists to make all these voice technologies—PromptTTS, STT, STS, voice cloning, TTM, and voice agents—measurable, comparable, improvable, and decentralized. By leveraging Bittensor&apos;s decentralized framework, Vocence enables a more open, accessible, and scalable approach to advancing voice intelligence technologies across various domains.
            </p>
          </section>

          {/* Section 4 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">
              4. Current Problems in TTS, STT, STS, and Voice Agents
            </h2>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">4.1 Lack of Objective Evaluation</h3>
            <p className="mb-4">
              Most benchmarks for voice models, including TTS, STT, STS, voice cloning, TTM, and voice agents, focus on basic audio quality, intelligibility, and mean opinion scores (MOS). However, they fail to evaluate whether the generated voice matches the prompted traits (e.g., age, emotion, tone, accent) or the specified environmental conditions, leading to a lack of fine-grained control and assessment.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">4.2 Closed Datasets and Models</h3>
            <p className="mb-4">
              State-of-the-art systems across these domains are often locked behind proprietary datasets and private evaluation pipelines, restricting access and collaboration within the broader community. This closed approach hinders innovation and limits the generalization of models.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">4.3 Prompt Drift</h3>
            <p className="mb-4">
              Models, whether in TTS, STT, STS, or voice agents, often generate speech or responses that sound natural but fail to adhere to the specific prompt instructions, such as ignoring the specified age, emotion, tone, or style. This issue, known as prompt drift, reduces the ability to control and reliably generate contextually accurate speech or actions across multiple domains.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">4.4 Centralization</h3>
            <p>
              Progress in voice model improvement is often dependent on a small number of organizations with large compute budgets and access to private datasets, resulting in a centralization of innovation. This limits the ability for smaller, independent teams to compete and contribute to the evolution of voice technologies.
            </p>
          </section>

          {/* Section 5 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">5. The Vocence Solution</h2>
            <p className="mb-4">
              Vocence addresses these issues through a decentralized, prompt-aware training and evaluation subnet that spans across TTS, STT, STS, voice cloning, TTM, and voice agents.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">5.1 Task Design</h3>
            <p className="mb-4">
              Validators generate tasks that consist of reference audio clips, extracted voice-trait descriptions, and corresponding text prompts. Miners must generate speech or responses that match both the content and the specified voice traits (e.g., age, emotion, tone) across multiple voice domains. This ensures that models not only produce high-quality audio but also stay true to the prompted characteristics.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">5.2 Dual-Axis Evaluation</h3>
            <p className="mb-4">
              Validator scoring focuses on three core dimensions: content correctness, audio quality, and prompt adherence. These scores are combined into a single reward signal that reflects the model&apos;s performance in generating accurate, natural, and contextually faithful responses across TTS, STT, STS, voice cloning, TTM, and voice agents.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">5.3 Public Evaluation Pipeline</h3>
            <p className="mb-4">
              Evaluation code is open source, and metrics are fully reproducible. There is no private or closed judging system, ensuring transparency and fairness. This open evaluation pipeline allows for consistent comparison of models across all voice intelligence domains, ensuring that improvements are both measurable and verifiable.
            </p>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">5.4 Incentive Alignment</h3>
            <p>
              Miners earn TAO proportional to real performance in generating models that meet validation criteria. Overfitting and prompt cheating are penalized to maintain quality and authenticity. Validators compete on evaluation accuracy, ensuring that the best models are rewarded and incentivized to improve. This decentralized incentive structure fosters ongoing development across the entire ecosystem of voice models.
            </p>
          </section>

          {/* Section 6 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">6. System Architecture</h2>
            <p className="mb-4">
              Miners train or fine-tune models across a range of voice intelligence technologies, including PromptTTS, STT, STS, voice cloning, TTM, and voice agents, and deploy them as inference services on Chutes. These models are made accessible through a standardized API, enabling interaction across multiple voice domains. Validators interact with these deployed models via the Chutes API to submit evaluation tasks, collect generated speech outputs, and compute scores.
            </p>
            <p>
              Validator evaluation is performed using predefined, public benchmarks that assess content correctness, audio quality, prompt adherence, and environmental consistency, across TTS, STT, STS, voice cloning, TTM, and voice agent models. To prevent overfitting and benchmark manipulation, evaluation tasks are continuously sourced from dynamically updated online data streams, such as YouTube and other public platforms. As the underlying data distribution evolves in real time, models are forced to adapt to new content, preventing memorization or overfitting of fixed test sets and ensuring robust, generalizable performance over time.
            </p>
          </section>

          {/* Section 7 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">7. Roadmap</h2>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">Q1 – Foundation</h3>
            <ul className="list-disc list-outside pl-6 space-y-2 mb-6">
              <li>Subnet launch on Bittensor</li>
              <li>Official website and monitoring dashboard</li>
              <li>Baseline evaluation pipeline for PromptTTS, STT, Voice Cloning, and other voice models, focused on voice quality validation, voice trait accuracy, content correctness, and environmental consistency</li>
            </ul>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">Q2 – Scaling and Robustness</h3>
            <ul className="list-disc list-outside pl-6 space-y-2 mb-6">
              <li>Expanded voice-trait and environmental taxonomy</li>
              <li>Start collecting datasets for model training from validator results submitted by miners and generated by validator task generation/evaluation pipeline</li>
              <li>Adversarial prompt testing to reduce overfitting and prompt gaming</li>
              <li>Launch STT and Voice Cloning pipeline on the subnet and begin competition</li>
              <li>Subnet product launch (PromptTTS, STT, Voice Cloning) and API for developers</li>
            </ul>

            <h3 className="text-xl font-semibold text-white mb-3 mt-6">Q3 – Ecosystem Expansion</h3>
            <ul className="list-disc list-outside pl-6 space-y-2">
              <li>Launch Voice STS, TTM pipeline on the subnet and begin competition</li>
              <li>Platform expansion with Voice AI Agents that integrate with developed multimodal models. Make them integrable with voice applications and other platform voice agents</li>
              <li>Platform expansion to support various APIs that integrate with other APIs, services, and external platforms</li>
              <li>Cross-subnet integrations within the Bittensor ecosystem</li>
              <li>Advanced controllability and expressiveness benchmarks across all voice domains</li>
            </ul>
          </section>

          {/* Section 8 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">8. Governance</h2>
            <p>
              Vocence supports permissionless miner and validator participation across all voice technologies, including PromptTTS, STT, STS, voice cloning, TTM, and voice agents. Protocol changes are proposed publicly, with an emphasis on backward-compatible upgrades and transparent updates to evaluation logic, ensuring that all advancements align with the decentralized and open principles of the platform.
            </p>
          </section>

          {/* Section 9 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">9. Risks and Mitigations</h2>
            <p>
              Overfitting to evaluation metrics is mitigated through rotating prompts, dataset expansion, and continuous sourcing of dynamic data, ensuring that models cannot memorize or overfit fixed sets. Validator bias is mitigated through validator competition and stake-weighted consensus, where multiple validators contribute to scoring, ensuring objectivity. Compute centralization is mitigated through reward shaping that favors efficiency rather than brute force, promoting innovation in model design and optimization.
            </p>
          </section>

          {/* Section 10 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">10. Questions and Answers</h2>

            <div className="space-y-6 mt-6">
              <div>
                <p className="font-semibold text-white mb-2">
                  Q: What makes Vocence different from existing voice subnets?
                </p>
                <p className="text-[#A7B0B7]">
                  A: Vocence explicitly evaluates prompt adherence across a wide range of voice technologies, not just audio quality or intelligibility. It supports PromptTTS, STT, STS, voice cloning, TTM, and voice agents, ensuring comprehensive evaluation and development of voice models.
                </p>
              </div>

              <div>
                <p className="font-semibold text-white mb-2">
                  Q: Do miners need to train models from scratch?
                </p>
                <p className="text-[#A7B0B7]">
                  A: No. Miners can fine-tune existing models or develop new architectures, making it easier for contributors to participate and improve upon pre-trained models.
                </p>
              </div>

              <div>
                <p className="font-semibold text-white mb-2">Q: Is the evaluation model public?</p>
                <p className="text-[#A7B0B7]">
                  A: Yes. All evaluation logic is open source and reproducible, ensuring transparency and enabling anyone to verify the evaluation process.
                </p>
              </div>

              <div>
                <p className="font-semibold text-white mb-2">
                  Q: Can Vocence support commercial use cases?
                </p>
                <p className="text-[#A7B0B7]">
                  A: Yes. Outputs are suitable for a wide range of commercial applications, including voice agents, interactive games, virtual assistants, and accessibility tools.
                </p>
              </div>

              <div>
                <p className="font-semibold text-white mb-2">
                  Q: How does Vocence prevent prompt cheating?
                </p>
                <p className="text-[#A7B0B7]">
                  A: Through adversarial prompts, cross-validation between validators, and multi-axis scoring, which ensures models adhere to prompts across multiple voice characteristics (e.g., tone, emotion, accent) and reduces the risk of manipulation.
                </p>
              </div>
            </div>
          </section>

          {/* Section 11 */}
          <section>
            <h2 className="text-2xl font-semibold text-white mb-4">11. Conclusion</h2>
            <p>
              Vocence brings prompt-controlled speech synthesis, voice intelligence, and multimodal voice agent systems into the decentralized AI era. By aligning incentives around controllable, expressive, and accurate voice generation, Vocence enables the next generation of speech systems to be open, competitive, and continuously improving across diverse applications.
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
