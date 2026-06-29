import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Serve HTML files
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(join(__dirname, 'admin.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0.0' });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ KINGPIN 3.0 Server running on http://0.0.0.0:${PORT}`);
  console.log(`🎮 Client: http://0.0.0.0:${PORT}`);
  console.log(`🛠️  Admin: http://0.0.0.0:${PORT}/admin`);
});
