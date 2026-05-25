// API Service for backend communication (auth, users, credits).
// Uses VITE_API_URL + '/api' (same backend as dashboard), with Vite proxy
// support in dev when the backend target is localhost.
import { API_BASE_URL, withNetworkHint } from './baseUrl';

export interface User {
  id: string;
  email: string;
  name: string;
  picture?: string;
  credits: number;
  planCode?: string;
  planStatus?: string;
  createdAt: string;
  referralCode?: string;
}

export interface PricingPlan {
  code: string;
  name: string;
  priceUsd: number | null;
  billingType: string;
  creditsIncluded: number;
  /** NOWPayments list USD when different from card (Stripe uses priceUsd). */
  cryptoPriceUsd?: number | null;
  /** Credits granted on successful crypto checkout when different from creditsIncluded. */
  cryptoCreditsIncluded?: number | null;
  creditsPerPack?: number | null;
  priceSubtitle?: string | null;
  description?: string | null;
  highlighted: boolean;
  ctaLabel: string;
  features: string[];
}

export interface CreditTransaction {
  id: string;
  transactionType: string;
  amount: number;
  balanceAfter: number;
  description: string;
  referenceType?: string | null;
  referenceId?: string | null;
  createdAt: string;
}

export interface AccountSummary {
  user: User;
  plan: PricingPlan | null;
  transactions: CreditTransaction[];
  totalTtsGenerations: number;
  totalCreditsUsed: number;
}

export interface CreditTransactionsPage {
  items: CreditTransaction[];
  total: number;
  offset: number;
  limit: number;
}

export interface DailyCreditsDay {
  day: string;
  creditsUsed: number;
}

export interface DailyCreditsUsage {
  days: DailyCreditsDay[];
  totalCreditsUsed: number;
}

export interface CheckoutSessionResponse {
  sessionId: string;
  provider: string;
  status: string;
  checkoutUrl?: string | null;
  amountUsd: number;
  creditsGranted: number;
  message?: string | null;
}

export interface NowPaymentsPayCurrencyOption {
  ticker: string;
  label: string;
  hint: string | null;
}

export interface NowPaymentsPayCurrencyOptions {
  planCode: string;
  defaultTicker: string;
  currencies: NowPaymentsPayCurrencyOption[];
}

export interface SalesInquiryRequest {
  name: string;
  email: string;
  company?: string;
  message: string;
}

export interface SalesInquiryResponse {
  success: boolean;
  message: string;
}

export interface DeveloperApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  tier: 'normal' | 'premium';
  rateLimitRpm: number;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeveloperApiUsageLog {
  id: string;
  endpoint: string;
  provider?: string | null;
  status: string;
  httpStatus: number;
  creditsUsed: number;
  requestChars?: number | null;
  latencyMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
}

export interface LoginRequest {
  /** The raw Google ID token (JWT) from Google Identity Services'
   *  ``credentialResponse.credential``. The backend verifies this
   *  against Google's tokeninfo endpoint before trusting any claim. */
  credential: string;
  /** Optional hints — IGNORED by the backend when ``credential`` is
   *  present (the verified JWT claims always win). Kept so old
   *  callers don't break the type checker while we migrate. */
  email?: string;
  name?: string;
  picture?: string;
  googleId?: string;
  referral_code?: string;
  device_fingerprint?: string;
}

export interface LoginResponse {
  user: User;
  token: string;
}

// API Functions
export const api = {
  // Sign up or login user
  async loginOrSignup(userData: LoginRequest): Promise<LoginResponse> {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(userData),
      });

      if (!response.ok) {
        throw new Error('Login failed');
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('API Error:', error);
      // Fallback to localStorage if API is not available
      throw withNetworkHint(error);
    }
  },

  // Get user by ID
  async getUser(userId: string, token: string): Promise<User> {
    try {
      const response = await fetch(`${API_BASE_URL}/users/${userId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch user');
      }

      return await response.json();
    } catch (error) {
      console.error('API Error:', error);
      throw withNetworkHint(error);
    }
  },

  // Update user credits
  async updateCredits(userId: string, credits: number, token: string): Promise<User> {
    try {
      const response = await fetch(`${API_BASE_URL}/users/${userId}/credits`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ credits }),
      });

      if (!response.ok) {
        throw new Error('Failed to update credits');
      }

      return await response.json();
    } catch (error) {
      console.error('API Error:', error);
      throw withNetworkHint(error);
    }
  },

  // Verify token
  async verifyToken(token: string): Promise<User> {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
      });

      if (!response.ok) {
        throw new Error('Token verification failed');
      }

      const data = await response.json();
      return data.user;
    } catch (error) {
      console.error('API Error:', error);
      throw withNetworkHint(error);
    }
  },

  async getPricingPlans(): Promise<{ plans: PricingPlan[] }> {
    try {
      const response = await fetch(`${API_BASE_URL}/pricing/plans`);
      if (!response.ok) {
        throw new Error('Failed to fetch pricing plans');
      }
      return response.json();
    } catch (error) {
      throw withNetworkHint(error);
    }
  },

  async getNowPaymentsPayCurrencyOptions(planCode: string): Promise<NowPaymentsPayCurrencyOptions> {
    try {
      const q = new URLSearchParams({ planCode });
      const response = await fetch(
        `${API_BASE_URL}/payments/nowpayments/pay-currency-options?${q.toString()}`
      );
      if (!response.ok) {
        throw new Error('Failed to load crypto payment options');
      }
      return response.json();
    } catch (error) {
      throw withNetworkHint(error);
    }
  },

  async getAccountSummary(token: string): Promise<AccountSummary> {
    try {
      const response = await fetch(`${API_BASE_URL}/account/summary`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error('Failed to fetch account summary');
      }
      return response.json();
    } catch (error) {
      throw withNetworkHint(error);
    }
  },

  async getCreditTransactions(
    token: string,
    opts: { offset?: number; limit?: number } = {},
  ): Promise<CreditTransactionsPage> {
    const { offset = 0, limit = 25 } = opts;
    try {
      const response = await fetch(
        `${API_BASE_URL}/account/transactions?limit=${limit}&offset=${offset}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) {
        throw new Error('Failed to fetch credit transactions');
      }
      return response.json();
    } catch (error) {
      throw withNetworkHint(error);
    }
  },

  async getDailyCreditsUsage(token: string, days = 14): Promise<DailyCreditsUsage> {
    try {
      const response = await fetch(`${API_BASE_URL}/account/credits/usage/daily?days=${days}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        throw new Error('Failed to fetch daily credits usage');
      }
      return response.json();
    } catch (error) {
      throw withNetworkHint(error);
    }
  },

  async createCheckoutSession(
    token: string,
    payload: { provider: 'stripe' | 'crypto'; planCode: string; payCurrency?: string }
  ): Promise<CheckoutSessionResponse> {
    try {
      const response = await fetch(`${API_BASE_URL}/payments/checkout-session`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const raw = await response.text();
        let detail = raw;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            detail =
              typeof parsed.detail === 'string'
                ? parsed.detail
                : typeof parsed.message === 'string'
                  ? parsed.message
                  : raw;
          }
        } catch {
          // keep raw text
        }
        throw new Error(detail || `Failed to create checkout session (${response.status})`);
      }
      return response.json();
    } catch (error) {
      throw withNetworkHint(error);
    }
  },

  async sendSalesInquiry(payload: SalesInquiryRequest): Promise<SalesInquiryResponse> {
    try {
      const response = await fetch(`${API_BASE_URL}/sales/contact`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const raw = await response.text();
        let detail = raw;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && typeof parsed.detail === 'string') {
            detail = parsed.detail;
          }
        } catch {
          // keep raw text
        }
        throw new Error(detail || `Failed to send inquiry (${response.status})`);
      }
      return response.json();
    } catch (error) {
      throw withNetworkHint(error);
    }
  },

  async createDeveloperKey(token: string, payload: { name: string }) {
    const response = await fetch(`${API_BASE_URL}/developer/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(raw || 'Failed to create API key');
    }
    return response.json() as Promise<{ key: DeveloperApiKey; plainKey: string }>;
  },

  async listDeveloperKeys(token: string): Promise<{ keys: DeveloperApiKey[] }> {
    const response = await fetch(`${API_BASE_URL}/developer/keys`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error('Failed to load API keys');
    }
    return response.json();
  },

  async revokeDeveloperKey(token: string, keyId: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/developer/keys/${keyId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error('Failed to revoke API key');
    }
  },

  async getDeveloperUsage(token: string, limit = 50): Promise<{ logs: DeveloperApiUsageLog[] }> {
    const response = await fetch(`${API_BASE_URL}/developer/usage?limit=${limit}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error('Failed to load developer usage');
    }
    return response.json();
  },
};

// Fallback to localStorage if API is not available (for development)
export const localStorageFallback = {
  loginOrSignup(userData: LoginRequest): LoginResponse {
    const existingUsers = JSON.parse(localStorage.getItem('vocence_users') || '[]');
    let user: User;

    const existingUser = existingUsers.find((u: User) => u.email === userData.email);
    
    if (existingUser) {
      user = existingUser;
    } else {
      // Fallback path runs offline / when the API is unreachable. The
      // backend normally derives id/email/name from the verified Google
      // JWT (``credential``); here we accept the caller-supplied hints
      // but require them to be present — without an id/email/name we
      // can't construct a usable User.
      if (!userData.googleId || !userData.email || !userData.name) {
        throw new Error('localStorageFallback: googleId, email, and name are required');
      }
      user = {
        id: userData.googleId,
        email: userData.email,
        name: userData.name,
        picture: userData.picture,
        credits: 50,
        planCode: 'normal',
        planStatus: 'active',
        createdAt: new Date().toISOString(),
      };
      existingUsers.push(user);
      localStorage.setItem('vocence_users', JSON.stringify(existingUsers));
    }

    // Generate a simple token (in production, use JWT from backend)
    const token = btoa(JSON.stringify({ userId: user.id, email: user.email }));

    return { user, token };
  },

  getUser(userId: string): User | null {
    const existingUsers = JSON.parse(localStorage.getItem('vocence_users') || '[]');
    return existingUsers.find((u: User) => u.id === userId) || null;
  },

  updateCredits(userId: string, credits: number): User | null {
    const existingUsers = JSON.parse(localStorage.getItem('vocence_users') || '[]');
    const userIndex = existingUsers.findIndex((u: User) => u.id === userId);
    
    if (userIndex === -1) return null;

    existingUsers[userIndex].credits = credits;
    localStorage.setItem('vocence_users', JSON.stringify(existingUsers));
    return existingUsers[userIndex];
  },
};
