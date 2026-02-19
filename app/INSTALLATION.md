# Installation & Running Guide

## Prerequisites

- **Node.js** (v18 or higher recommended)
- **npm** (comes with Node.js) or **yarn**/**pnpm**

### Check if you have Node.js installed:
```bash
node --version
npm --version
```

### Install Node.js (if not installed):
- **Linux/Ubuntu:**
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```

- **macOS:**
  ```bash
  brew install node
  ```

- **Windows:**
  Download from [nodejs.org](https://nodejs.org/)

## Installation Steps

### 1. Navigate to the project directory
```bash
cd app
```

### 2. Install dependencies
```bash
npm install
```

This will install all required packages listed in `package.json`.

## Running the Application

### Development Mode (with hot reload)
```bash
npm run dev
```

The application will start on `http://localhost:5173` (or another port if 5173 is busy).

**Features:**
- Hot Module Replacement (HMR) - changes reflect instantly
- Fast refresh for React components
- Development optimizations

### Production Build

#### 1. Build for production
```bash
npm run build
```

This creates an optimized production build in the `dist/` directory.

#### 2. Preview the production build locally
```bash
npm run preview
```

This serves the production build on `http://localhost:4173` for testing.

## Deploying to a Server

### Option 1: Using a Static File Server (Recommended)

After building (`npm run build`), serve the `dist/` directory:

#### Using Nginx:
```nginx
server {
    listen 80;
    server_name your-domain.com;
    root /path/to/vocence_website/app/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

#### Using Apache:
```apache
<VirtualHost *:80>
    ServerName your-domain.com
    DocumentRoot /path/to/vocence_website/app/dist

    <Directory /path/to/vocence_website/app/dist>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>

    # Handle React Router
    RewriteEngine On
    RewriteBase /
    RewriteRule ^index\.html$ - [L]
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteRule . /index.html [L]
</VirtualHost>
```

#### Using Node.js (serve package):
```bash
# Install serve globally
npm install -g serve

# Build the project
npm run build

# Serve the dist directory
serve -s dist -l 3000
```

### Option 2: Using PM2 (Process Manager)

For a Node.js-based server setup:

```bash
# Install PM2 globally
npm install -g pm2

# Build the project
npm run build

# Install serve locally
npm install serve

# Create ecosystem file (ecosystem.config.js)
```

Create `ecosystem.config.js`:
```javascript
module.exports = {
  apps: [{
    name: 'vocence-website',
    script: 'npx',
    args: 'serve -s dist -l 3000',
    cwd: '/path/to/vocence_website/app',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    }
  }]
}
```

Then run:
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## Dashboard (real-time subnet data)

The **Dashboard** page shows live data from the Vocence subnet (miners, validators, evaluations). To enable it:

1. **Run the dashboard backend** (Python FastAPI; reads from the owner's Vocence PostgreSQL DB):
   ```bash
   cd ../dashboard-backend
   python -m venv .venv && source .venv/bin/activate   # or .venv\Scripts\activate on Windows
   pip install -r requirements.txt
   # Set POSTGRES_* or DATABASE_URL to the same DB as Vocence API
   python main.py
   ```
   It runs on port **3002** by default. See `dashboard-backend/README.md` for more options.

2. **Point the app at the dashboard API** — in `app/.env`:
   ```env
   VITE_DASHBOARD_API_URL=http://localhost:3002
   ```
   For production, set this to your deployed dashboard-backend URL.

See `dashboard-backend/README.md` for full setup.

## Environment Variables (if needed)

If you need to configure environment variables, create a `.env` file in the `app/` directory (see `.env.example`):

```env
VITE_API_BASE_URL=http://localhost:3001/api   # Auth/history backend
VITE_DASHBOARD_API_URL=http://localhost:3002  # Dashboard (owner DB)
VITE_GOOGLE_CLIENT_ID=your-google-client-id
```

Access them in code with `import.meta.env.VITE_*`

## Troubleshooting

### Port already in use
If port 5173 is busy, Vite will automatically use the next available port. Check the terminal output.

### Permission errors
On Linux, if you get permission errors:
```bash
sudo npm install -g serve
```

### Build errors
- Make sure all dependencies are installed: `npm install`
- Clear node_modules and reinstall: `rm -rf node_modules package-lock.json && npm install`
- Check Node.js version: `node --version` (should be 18+)

### Missing dependencies
If you see module not found errors:
```bash
npm install
```

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run lint` - Run ESLint

## Production Checklist

- [ ] Run `npm run build` successfully
- [ ] Test `npm run preview` locally
- [ ] Configure your web server (Nginx/Apache)
- [ ] Set up SSL certificate (Let's Encrypt)
- [ ] Configure domain DNS
- [ ] Set up monitoring/logging
- [ ] Test all routes work correctly (React Router)

