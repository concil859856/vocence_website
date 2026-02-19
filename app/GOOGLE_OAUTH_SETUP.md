# Google OAuth Setup Guide

To enable Google authentication, you need to set up a Google OAuth 2.0 Client ID.

## Steps:

1. **Go to Google Cloud Console**
   - Visit: https://console.cloud.google.com/

2. **Create a New Project** (or select existing)
   - Click on the project dropdown at the top
   - Click "New Project"
   - Enter project name: "Vocence Website"
   - Click "Create"

3. **Enable Google+ API**
   - Go to "APIs & Services" > "Library"
   - Search for "Google+ API" or "Google Identity Services"
   - Click "Enable"

4. **Create OAuth 2.0 Credentials**
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "OAuth client ID"
   - If prompted, configure the OAuth consent screen first:
     - User Type: External
     - App name: Vocence
     - User support email: your-email@example.com
     - Developer contact: your-email@example.com
     - Click "Save and Continue"
     - Add scopes: `email`, `profile`, `openid`
     - Click "Save and Continue"
     - Add test users (optional for development)
     - Click "Save and Continue"

5. **Create OAuth Client ID**
   - Application type: "Web application"
   - Name: "Vocence Web Client"
   - Authorized JavaScript origins:
     - `http://localhost:5173` (for development)
     - `http://localhost:3000` (if using different port)
     - Your production domain (e.g., `https://vocence.com`)
   - Authorized redirect URIs:
     - `http://localhost:5173` (for development)
     - Your production domain
   - Click "Create"

6. **Copy the Client ID**
   - Copy the Client ID (looks like: `123456789-abc.apps.googleusercontent.com`)

7. **Create .env file**
   - In the `app/` directory, create a `.env` file
   - Add: `VITE_GOOGLE_CLIENT_ID=your-client-id-here.apps.googleusercontent.com`
   - Replace `your-client-id-here` with your actual Client ID

8. **Restart Development Server**
   - Stop your dev server (Ctrl+C)
   - Run `npm run dev` again

## Testing

1. Click "Log In" button in the navbar
2. Click "Sign in with Google"
3. Select your Google account
4. You should be logged in!

## Notes

- For production, make sure to add your production domain to authorized origins
- Never commit your `.env` file to version control
- The `.env.example` file shows the required format

