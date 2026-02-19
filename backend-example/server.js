// Example Backend Server (Node.js + Express)
// This is a reference implementation. You can use this or integrate with your preferred backend.

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Middleware
app.use(cors());
app.use(express.json());

// Initialize SQLite database
const dbPath = path.join(__dirname, 'vocence.db');
const db = new sqlite3.Database(dbPath);

// Create users table if it doesn't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      picture TEXT,
      credits INTEGER DEFAULT 100,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS history (
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
    )
  `);
});

// Helper function to generate JWT token
function generateToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Helper function to verify JWT token
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Routes

// Login or Signup
app.post('/api/auth/login', (req, res) => {
  const { email, name, picture, googleId } = req.body;

  if (!email || !name || !googleId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Check if user exists
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, existingUser) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (existingUser) {
      // User exists - login
      const token = generateToken(existingUser);
      return res.json({ user: existingUser, token });
    } else {
      // New user - signup
      const newUser = {
        id: googleId,
        email,
        name,
        picture: picture || null,
        credits: 100,
        created_at: new Date().toISOString(),
      };

      db.run(
        'INSERT INTO users (id, email, name, picture, credits, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [newUser.id, newUser.email, newUser.name, newUser.picture, newUser.credits, newUser.created_at],
        function(err) {
          if (err) {
            return res.status(500).json({ error: 'Failed to create user' });
          }

          const token = generateToken(newUser);
          res.json({ user: newUser, token });
        }
      );
    }
  });
});

// Verify token
app.post('/api/auth/verify', (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Get user from database
    db.get('SELECT * FROM users WHERE id = ?', [decoded.userId], (err, user) => {
      if (err || !user) {
        return res.status(401).json({ error: 'User not found' });
      }

      res.json({ user });
    });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Get user by ID
app.get('/api/users/:id', verifyToken, (req, res) => {
  const { id } = req.params;

  if (id !== req.userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  });
});

// Update user credits
app.patch('/api/users/:id/credits', verifyToken, (req, res) => {
  const { id } = req.params;
  const { credits } = req.body;

  if (id !== req.userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (typeof credits !== 'number') {
    return res.status(400).json({ error: 'Invalid credits value' });
  }

  db.run(
    'UPDATE users SET credits = ? WHERE id = ?',
    [credits, id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to update credits' });
      }

      // Get updated user
      db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
        if (err || !user) {
          return res.status(500).json({ error: 'Failed to fetch updated user' });
        }

        res.json(user);
      });
    }
  );
});

// Save history item
app.post('/api/history', verifyToken, (req, res) => {
  const { type, content, style_prompt, model, meta, duration } = req.body;
  const historyId = Date.now().toString();

  db.run(
    'INSERT INTO history (id, user_id, type, content, style_prompt, model, meta, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [historyId, req.userId, type, content, style_prompt || null, model, meta, duration],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to save history' });
      }

      res.json({ id: historyId, success: true });
    }
  );
});

// Get user history
app.get('/api/history', verifyToken, (req, res) => {
  db.all(
    'SELECT * FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
    [req.userId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to fetch history' });
      }

      res.json(rows);
    }
  );
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`API base URL: http://localhost:${PORT}/api`);
});

