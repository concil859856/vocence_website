// API Service for backend communication (auth, users, credits).
// Uses VITE_API_URL + '/api' (same backend as dashboard).

const API_BASE_URL =
  import.meta.env.VITE_API_URL != null && import.meta.env.VITE_API_URL !== ''
    ? `${import.meta.env.VITE_API_URL.replace(/\/$/, '')}/api`
    : (import.meta.env.PROD ? '' : 'http://localhost:34717/api');

export interface User {
  id: string;
  email: string;
  name: string;
  picture?: string;
  credits: number;
  createdAt: string;
}

export interface LoginRequest {
  email: string;
  name: string;
  picture?: string;
  googleId: string;
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
      throw error;
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
      throw error;
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
      throw error;
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
      throw error;
    }
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
      user = {
        id: userData.googleId,
        email: userData.email,
        name: userData.name,
        picture: userData.picture,
        credits: 100,
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

