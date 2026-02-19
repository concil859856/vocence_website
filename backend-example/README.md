# Vocence Backend API

This is a simple Node.js + Express + SQLite backend for the Vocence website.

## Setup

1. **Install dependencies:**
   ```bash
   cd backend-example
   npm install
   ```

2. **Set environment variables (optional):**
   ```bash
   export JWT_SECRET=your-secret-key-here
   export PORT=3001
   ```

3. **Run the server:**
   ```bash
   npm start
   # or for development with auto-reload:
   npm run dev
   ```

4. **Update frontend .env:**
   Add to `app/.env`:
   ```
   VITE_API_BASE_URL=http://localhost:3001/api
   ```

## API Endpoints

### POST /api/auth/login
Login or signup user
```json
{
  "email": "user@example.com",
  "name": "User Name",
  "picture": "https://...",
  "googleId": "google-user-id"
}
```

### POST /api/auth/verify
Verify JWT token
```json
{
  "token": "jwt-token-here"
}
```

### GET /api/users/:id
Get user by ID (requires auth token)

### PATCH /api/users/:id/credits
Update user credits (requires auth token)
```json
{
  "credits": 150
}
```

### POST /api/history
Save history item (requires auth token)
```json
{
  "type": "tts",
  "content": "Text content",
  "style_prompt": "Style description",
  "model": "Model name",
  "meta": "Metadata",
  "duration": "0:12"
}
```

### GET /api/history
Get user history (requires auth token)

## Database

Uses SQLite database (`vocence.db`) with two tables:
- `users`: User accounts
- `history`: User creation history

## Production Considerations

For production, consider:
- Using PostgreSQL or MySQL instead of SQLite
- Adding rate limiting
- Implementing proper error handling
- Adding input validation
- Using environment variables for secrets
- Adding HTTPS
- Implementing refresh tokens
- Adding logging and monitoring

