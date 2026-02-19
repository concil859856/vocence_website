# Authentication System Summary

## ✅ What's Implemented

### 1. **User Sign Up** ✅
- When a new user signs up with Google:
  - User data is saved to the database (via API)
  - If API unavailable, saves to localStorage as fallback
  - Creates account with 100 starting credits
  - Returns session token

### 2. **User Log In** ✅
- When user logs in:
  - System verifies user exists in database
  - If user doesn't exist, automatically creates account (signup)
  - Returns user data and session token
  - Saves to localStorage for persistence

### 3. **Session Persistence** ✅
- User stays logged in when returning to browser:
  - On page load, checks for stored token
  - Verifies token with backend API
  - If valid, automatically logs user in
  - If API unavailable, uses localStorage fallback
  - User doesn't need to log in again

## How It Works

### Sign Up Flow:
```
User → Google OAuth → Frontend → API: POST /api/auth/login
                                    ↓
                            Check DB for user
                                    ↓
                        New user? → Create in DB
                        Existing? → Return user
                                    ↓
                        Return user + token
                                    ↓
                    Save to localStorage
```

### Log In Flow:
```
User → Google OAuth → Frontend → API: POST /api/auth/login
                                    ↓
                            Check DB for user
                                    ↓
                        User exists? → Return user + token
                        Not found? → Create account (signup)
                                    ↓
                    Save to localStorage
```

### Session Restoration:
```
Page Load → Check localStorage for token
                ↓
        Token exists? → Verify with API
                ↓
        Valid? → Auto login
        Invalid? → Clear session
        API down? → Use localStorage fallback
```

## Files Created

1. **`app/src/services/api.ts`** - API service layer
   - Handles all backend communication
   - Falls back to localStorage if API unavailable

2. **`app/src/contexts/AuthContext.tsx`** - Updated
   - Now uses API for user operations
   - Handles session persistence
   - Falls back to localStorage

3. **`backend-example/server.js`** - Example backend
   - Node.js + Express + SQLite
   - Full CRUD operations for users
   - JWT token authentication

4. **`backend-example/package.json`** - Backend dependencies

5. **`app/BACKEND_SETUP.md`** - Setup instructions

## Quick Start

### Option 1: With Backend (Recommended)

1. **Start backend:**
   ```bash
   cd backend-example
   npm install
   npm start
   ```

2. **Configure frontend:**
   Create `app/.env`:
   ```
   VITE_API_BASE_URL=http://localhost:3001/api
   VITE_GOOGLE_CLIENT_ID=your-google-client-id
   ```

3. **Start frontend:**
   ```bash
   cd app
   npm install
   npm run dev
   ```

### Option 2: Without Backend (Development)

The system automatically uses localStorage if API is unavailable. Just run:
```bash
cd app
npm install
npm run dev
```

## Database Schema

The backend uses SQLite with:

**users table:**
- `id` (TEXT, PRIMARY KEY) - Google user ID
- `email` (TEXT, UNIQUE) - User email
- `name` (TEXT) - User name
- `picture` (TEXT) - Profile picture URL
- `credits` (INTEGER) - User credits (default: 100)
- `created_at` (TEXT) - Account creation date

**history table:**
- `id` (TEXT, PRIMARY KEY)
- `user_id` (TEXT, FOREIGN KEY) - References users.id
- `type` (TEXT) - tts, stt, cloning, chat
- `content` (TEXT) - Content text
- `style_prompt` (TEXT) - Style description
- `model` (TEXT) - Model used
- `meta` (TEXT) - Metadata
- `duration` (TEXT) - Duration
- `created_at` (TEXT) - Creation timestamp

## Testing Checklist

- [x] New user signup saves to database
- [x] Existing user login verifies from database
- [x] Session persists across browser sessions
- [x] Token verification on page load
- [x] Fallback to localStorage if API unavailable
- [x] Credits update in database
- [x] History saved to database

## Production Notes

For production, consider:
- Using PostgreSQL/MySQL instead of SQLite
- Adding refresh tokens
- Implementing rate limiting
- Adding input validation
- Setting up HTTPS
- Configuring CORS properly
- Adding monitoring and logging

