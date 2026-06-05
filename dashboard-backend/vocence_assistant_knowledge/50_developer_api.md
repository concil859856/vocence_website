# Developer API

The Developer API gives programmatic access to the same generation backends that power Studio. It exposes endpoints for Text-to-Speech, Speech-to-Text, Voice Cloning, and Music Generation. The full API reference is at vocence.ai/docs/api; SDKs and libraries at vocence.ai/docs/sdk; integration guide at vocence.ai/docs/integration.

# API eligibility — Premium required

API access requires a successful Premium purchase. The API tab on the Account page is locked until then and won't generate keys. Once Premium is active, you can create, name, and revoke API keys at vocence.ai/account. Each key shows a prefix and the last-used timestamp so you can spot inactive or compromised keys.

# API billing

The Developer API is pay-as-you-go from your existing credit balance — there is no separate API meter. Text-based endpoints bill at 2,000 credits per 1,000,000 characters, where "characters" includes both the text and any style or instruction prompt. If no instruction is provided, the default "neutral voice" is used. Failed API calls are auto-refunded the same way Studio failures are.

# API rate limits

The default rate limit is 4 requests per minute per API key. This is enough for batch jobs and most production traffic patterns. Higher limits are available on request once you have an established usage history — email space@vocence.ai with your use case and traffic projections.
