const express = require('express');
const path = require('path');
const session = require('express-session');
require('dotenv').config();  // Load environment variables from .env file

const app = express();
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

// Ensure SESSION_SECRET is set
if (!process.env.SESSION_SECRET) {
    throw new Error('SESSION_SECRET is not defined in the environment variables.');
}

// Set EJS as the template engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware to serve static files from the public directory
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET,  // Securely store your session secret
  resave: false,
  saveUninitialized: true
}));

app.get('/', (req, res) => {
  const user = req.session.user;
  res.render('index', { CLIENT_ID, user });
});

app.get('/login', async (req, res) => {
  const { OAuth2Client } = await import('google-auth-library');
  const oauth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/blogger', 'https://www.googleapis.com/auth/userinfo.profile'],
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const { OAuth2Client } = await import('google-auth-library');
    const oauth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info
    const userInfoUrl = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
    const fetch = await import('node-fetch').then(module => module.default);
    const userInfoResponse = await fetch(userInfoUrl, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    });
    const user = await userInfoResponse.json();

    req.session.tokens = tokens;
    req.session.user = user;

    res.redirect('/');  // Redirect to home page after successful login
  } catch (error) {
    console.error('Error during OAuth callback:', error);
    res.status(500).send('Authentication failed');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send('Failed to logout.');
    }
    res.redirect('/');
  });
});

app.get('/blogs', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).send('User not authenticated');
  }

  try {
    const { OAuth2Client } = await import('google-auth-library');
    const oauth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    oauth2Client.setCredentials(req.session.tokens);
    const fetch = await import('node-fetch').then(module => module.default);
    const response = await fetch('https://www.googleapis.com/blogger/v3/users/self/blogs', {
      headers: {
        Authorization: `Bearer ${oauth2Client.credentials.access_token}`,
      },
    });
    const data = await response.json();

    if (!data.items || data.items.length === 0) {
      return res.json([]);
    }

    res.json(data.items);
  } catch (error) {
    console.error('Error retrieving blogs:', error);
    res.status(500).send('Error retrieving blogs');
  }
});

app.get('/export/:blogId', async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).send('User not authenticated');
  }

  const { blogId } = req.params;
  try {
    const { OAuth2Client } = await import('google-auth-library');
    const oauth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    oauth2Client.setCredentials(req.session.tokens);
    const fetch = await import('node-fetch').then(module => module.default);

    let posts = [];
    let nextPageToken = '';
    const url = `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts`;

    do {
      const response = await fetch(`${url}${nextPageToken}`, {
        headers: {
          Authorization: `Bearer ${oauth2Client.credentials.access_token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch posts');
      }

      const data = await response.json();
      if (data.items && data.items.length > 0) {
        posts = posts.concat(data.items);
      }

      nextPageToken = data.nextPageToken ? `?pageToken=${data.nextPageToken}` : '';
    } while (nextPageToken);

    // Generate SQL in chunks to avoid memory issues with large blogs
    const sqlDumpChunks = posts.map(post => {
      return `INSERT INTO posts (id, title, content, permalink) VALUES (${post.id}, "${post.title.replace(/"/g, '\\"')}", "${post.content.replace(/"/g, '\\"')}", "${post.url.replace(/"/g, '\\"')}");`;
    });

    res.json({ sql: sqlDumpChunks.join('\n') });
  } catch (error) {
    console.error('Error exporting blog:', error);
    res.status(500).send('Error exporting blog');
  }
});

const server = app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Trying another port...`);
        
        // Retry with a different port
        setTimeout(() => {
            const newPort = PORT + 1;  // Increment the port number
            app.listen(newPort, () => {
                console.log(`Server is now running on http://localhost:${newPort}`);
            });
        }, 1000);  // Wait 1 second before trying the new port
    } else {
        console.error('Server error:', error);
    }
});

