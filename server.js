const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '1mb' }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyCt-BrxHd6OhO-aUkAo28qG3GBZx24Kyzc';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '3.0.0', api: 'Gemini' });
});

// Тестовый эндпоинт для проверки Gemini API
app.get('/api/test-gemini', async (req, res) => {
  try {
    const response = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: 'Say "Hello, World!" in JSON format: {"message": "Hello, World!"}' }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 50 }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    
    res.json({ success: true, data: response.data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, details: error.response?.data || 'No details' });
  }
});

// Генерация презентации
app.post('/api/generate', async (req, res) => {
  try {
    const { topic, maxSlides = 10 } = req.body;
    
    if (!topic) {
      return res.status(400).json({ error: 'Тема не указана' });
    }

    console.log(`Генерация (Gemini): "${topic}"`);

    const prompt = `Создай структуру презентации на тему: "${topic}". Количество слайдов: ${maxSlides}.

Верни ТОЛЬКО JSON-объект в таком формате:
{
  "title": "Заголовок презентации",
  "slides": [
    {
      "title": "Заголовок слайда",
      "content": ["Пункт 1", "Пункт 2", "Пункт 3"]
    }
  ]
}`;

    const response = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2000 }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const text = response.data.candidates[0].content.parts[0].text;
    const cleanText = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const presentation = JSON.parse(cleanText);
    
    console.log(`Сгенерировано ${presentation.slides.length} слайдов`);
    res.json(presentation);

  } catch (error) {
    console.error('Ошибка Gemini:', error.message);
    if (error.response) console.error('Gemini ответ:', JSON.stringify(error.response.data).substring(0, 500));
    res.status(500).json({ error: 'Ошибка генерации презентации' });
  }
});

// Поиск картинок
app.post('/api/images/search', async (req, res) => {
  try {
    const { keywords, count = 5 } = req.body;
    if (!keywords) return res.status(400).json({ error: 'Нет ключевых слов' });

    const response = await axios.get('https://api.unsplash.com/search/photos', {
      params: { query: keywords, per_page: count, orientation: 'landscape', client_id: process.env.UNSPLASH_ACCESS_KEY },
      timeout: 10000
    });

    res.json({ images: response.data.results.map(img => img.urls.regular), keywords });
  } catch (error) {
    res.json({ images: [], keywords: req.body.keywords, placeholder: true });
  }
});

// Запуск
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен (Gemini API): http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  console.log(`🧪 Test Gemini: http://localhost:${PORT}/api/test-gemini`);
});