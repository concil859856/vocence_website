# Backend Setup Guide

The authentication system now supports both:
1. **Backend API** (recommended for production)
2. **localStorage fallback** (for development/testing)

## Current Implementation

### ✅ What Works Now:

1. **Sign Up**: When a new user signs up, the system:
   - Saves user data to the database (via API or localStorage)
   - Creates account with 100 starting credits
   - Returns a session token

2. **Log In**: When a user logs in, the system:
   - Verifies the user exists in the database
   - Returns user data and session token
   - If user doesn't exist, creates new account (signup)

3. **Session Persistence**: 
   - User stays logged in when they return to the browser
   - Session is stored in localStorage
   - On page load, system verifies token with backend
   - If backend is unavailable, falls back to localStorage

## Setup Options

### Option 1: Use the Example Backend (Recommended for Quick Start)

1. **Navigate to backend folder:**
   ```bash
   cd backend-example
   npm install
   ```

2. **Start the backend server:**
   ```bash
   npm start
   ```

3. **Update frontend .env:**
   Create `app/.env` file:
   ```
   VITE_API_BASE_URL=http://localhost:3001/api
   VITE_GOOGLE_CLIENT_ID=your-google-client-id
   ```

4. **Restart frontend:**
   ```bash
   cd app
   npm run dev
   ```

### Option 2: Use localStorage Only (Development)

The system automatically falls back to localStorage if the API is not available. No setup needed - just use the app!

### Option 3: Use Your Own Backend

1. **Update API base URL:**
   In `app/.env`:
   ```
   VITE_API_BASE_URL=https://your-api-domain.com/api
   ```

2. **Implement the API endpoints:**
   See `backend-example/server.js` for reference implementation.

Required endpoints:
- `POST /api/auth/login` - Login/signup
- `POST /api/auth/verify` - Verify token
- `GET /api/users/:id` - Get user
- `PATCH /api/users/:id/credits` - Update credits

## How It Works

### Sign Up Flow:
1. User clicks "Log In" → Google OAuth
2. Google returns user info
3. Frontend calls `POST /api/auth/login` with user data
4. Backend checks if user exists in database
5. If new user: Creates account in database, returns user + token
6. If existing user: Returns user + token
7. Frontend saves token and user to localStorage

### Log In Flow:
1. User clicks "Log In" → Google OAuth
2. Frontend calls `POST /api/auth/login`
3. Backend verifies user exists in database
4. Returns user data + token
5. Frontend saves to localStorage

### Session Persistence:
1. On page load, frontend checks localStorage for token
2. If token exists, calls `POST /api/auth/verify`
3. Backend verifies token and returns user
4. User is automatically logged in
5. If API fails, falls back to localStorage user data

## Database Schema

The example backend uses SQLite with this schema:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  credits INTEGER DEFAULT 100,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE history (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT,
  style_prompt TEXT,
  model TEXT,
  meta TEXT,
  duration TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

## Testing

1. **Start backend** (if using):
   ```bash
   cd backend-example
   npm start
   ```

2. **Start frontend:**
   ```bash
   cd app
   npm run dev
   ```

3. **Test signup:**
   - Click "Log In"
   - Sign in with Google (new account)
   - Check backend logs/database - user should be created

4. **Test login:**
   - Log out
   - Log in again with same account
   - Should work without creating duplicate

5. **Test session persistence:**
   - Log in
   - Close browser
   - Reopen browser
   - Should still be logged in

## Production Checklist

- [ ] Set up production database (PostgreSQL/MySQL)
- [ ] Configure JWT_SECRET environment variable
- [ ] Set up HTTPS
- [ ] Add rate limiting
- [ ] Add input validation
- [ ] Add error logging
- [ ] Set up monitoring
- [ ] Configure CORS for production domain
- [ ] Set up backup strategy

