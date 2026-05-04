const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== ЗАЩИТА =====
app.use(helmet());

// CORS — разрешаем все запросы
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '1mb' }));

// ===== API РОУТЫ =====

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' });
});

// Генерация презентации
app.post('/api/generate', async (req, res) => {
  try {
    const { topic, maxSlides = 10 } = req.body;
    
    if (!topic) {
      return res.status(400).json({ error: 'Тема не указана' });
    }

    console.log(`Генерация: "${topic}"`);

    const response = await axios.post(
      'https://api.deepseek.com/v1/chat/completions',
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'Ты — эксперт по созданию презентаций. Создай структуру в формате JSON. Формат: {"title":"...","slides":[{"title":"...","content":["..."]}]}' },
          { role: 'user', content: `Создай структуру презентации на тему: "${topic}". Количество слайдов: ${maxSlides}.` }
        ],
        temperature: 0.7,
        max_tokens: 2000,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    const content = response.data.choices[0].message.content;
    const presentation = JSON.parse(content);
    
    console.log(`Сгенерировано ${presentation.slides.length} слайдов`);
    res.json(presentation);

  } catch (error) {
    console.error('Ошибка:', error.message);
    res.status(500).json({ error: 'Ошибка генерации' });
  }
});

// Поиск картинок
app.post('/api/images/search', async (req, res) => {
  try {
    const { keywords, count = 5 } = req.body;
    
    if (!keywords) {
      return res.status(400).json({ error: 'Ключевые слова не указаны' });
    }

    const response = await axios.get('https://api.unsplash.com/search/photos', {
      params: { query: keywords, per_page: count, orientation: 'landscape', client_id: process.env.UNSPLASH_ACCESS_KEY },
      timeout: 10000
    });

    const images = response.data.results.map(img => img.urls.regular);
    res.json({ images, keywords });

  } catch (error) {
    console.error('Ошибка поиска:', error.message);
    res.json({ images: [], keywords: req.body.keywords, placeholder: true });
  }
});

// ===== ЗАПУСК =====
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
});