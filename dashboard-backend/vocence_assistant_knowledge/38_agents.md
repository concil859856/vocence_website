# Studio Agents

Studio Agents are user-created voice chat personas you can build, configure, and talk to in real time inside Studio. An agent is defined by a name, a description, an avatar, a system prompt that shapes its personality and behavior, an optional knowledge base of documents the agent can search during a conversation, and a voice that determines how it sounds when it speaks. Open the agents page at vocence.ai/studio/agents.

# What you can do with an agent

Once an agent is created you can chat with it in real time using either text or voice. The agent streams its reply token-by-token, with audio synthesized from its chosen voice as the text comes in. Agents are stateful within a single chat session — they see the conversation history — but memory does not persist across sessions; each new chat starts fresh. Agents can search their knowledge base mid-turn to ground their answers in your documents.

# Voice options for agents

Agents can use any of the 28 sample voices that ship with Studio (the same ones the floating Vocence Assistant and Voice Cloning use), or any voice you've designed yourself in Voice Design and saved to My Voices. Designed voices give agents a distinctive sound that no other Vocence user has — pair a unique persona with a unique voice for the strongest agent identity.

# Knowledge base

Each agent has its own knowledge base — a private document store you can upload text into. The agent indexes the content and retrieves the most relevant passages on every turn, injecting them as context for the model. This lets the agent answer accurately about your specific domain (your product, your wiki, your research notes) without you needing to bake everything into the system prompt.

# Pause, archive, restore

Agents have lifecycle states. An active agent is available for chat. A paused agent is hidden from the chat surface — useful when you're iterating on its prompt and don't want it answering yet. An archived agent is taken offline and grouped under a separate Archived tab; it can be restored at any time. Deleted agents are gone for good.

# The Architect drawer

Studio includes an "Agent Architect" drawer that helps you sketch out a new agent's persona, system prompt, and knowledge structure interactively. Open it from the agents page when you're starting a new agent or want a guided walkthrough of refinements. It's the easiest way to go from "I want an agent that…" to a configured, ready-to-chat agent without staring at a blank system-prompt textbox.

# Logos vs your own agents

Logos — the floating Vocence Assistant — is itself a built-in agent: she's permanent, focused on helping users with Vocence, and ships with the product. Your own agents in Studio are separate — they can have any persona, voice, and knowledge base you want, and live only in your account. Logos's job is to help you use Vocence, including helping you build better agents of your own.
