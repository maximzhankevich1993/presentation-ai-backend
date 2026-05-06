const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0', mode: 'test' });
});

// Тестовая генерация (без API)
app.post('/api/generate', async (req, res) => {
  const { topic, maxSlides = 5 } = req.body;
  
  if (!topic) {
    return res.status(400).json({ error: 'Тема не указана' });
  }

  console.log(`Тестовая генерация: "${topic}"`);

  // Создаём тестовые слайды
  const slides = [];
  for (let i = 0; i < maxSlides; i++) {
    slides.push({
      title: i === 0 ? topic : `${topic} — часть ${i + 1}`,
      content: [
        `Ключевой пункт ${i * 3 + 1} по теме "${topic}"`,
        `Ключевой пункт ${i * 3 + 2} по теме "${topic}"`,
        `Ключевой пункт ${i * 3 + 3} по теме "${topic}"`
      ]
    });
  }

  const presentation = {
    title: topic,
    slides: slides
  };

  console.log(`Сгенерировано ${slides.length} слайдов`);
  res.json(presentation);
});

app.listen(PORT, () => {
  console.log(`🚀 Тестовый сервер: http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
});