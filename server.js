const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const COHERE_API_KEY = 'cohere_2tieM0pkzVnWwCshDTC8Jw1QJtSatDjh60k3Uamx0YB9aP';
const PORT = process.env.PORT || 10000;

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Генерация через Chat API
app.post('/api/generate', async (req, res) => {
    try {
        const { topic, maxSlides = 5 } = req.body;
        
        if (!topic) {
            return res.status(400).json({ error: 'Укажите topic' });
        }

        const slidesCount = Math.min(Math.max(parseInt(maxSlides) || 5, 1), 10);
        
        console.log(`Генерация: "${topic}", слайдов: ${slidesCount}`);

        // Используем Chat API (более новый и стабильный)
        const response = await axios.post(
            'https://api.cohere.ai/v1/chat',
            {
                model: 'command-r',
                message: `Создай структуру презентации на тему "${topic}" на русском языке.
Ответь ТОЛЬКО JSON-массивом (без markdown, без пояснений):
[
  {"title": "Заголовок слайда", "content": ["Пункт 1", "Пункт 2", "Пункт 3"]}
]
Создай ровно ${slidesCount} слайдов.`,
                temperature: 0.7,
                max_tokens: 2000
            },
            {
                headers: {
                    'Authorization': `Bearer ${COHERE_API_KEY}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                timeout: 30000
            }
        );

        const rawText = response.data.text || '';
        console.log('Ответ Cohere:', rawText.substring(0, 300));

        // Парсим JSON
        let slides = [];
        
        // Ищем JSON массив
        const jsonMatch = rawText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
            try {
                slides = JSON.parse(jsonMatch[0]);
            } catch (e) {
                console.log('Ошибка парсинга JSON:', e.message);
            }
        }

        // Заглушка если пусто
        if (!slides || slides.length === 0) {
            slides = [
                { title: 'Введение', content: ['Пункт 1', 'Пункт 2', 'Пункт 3'] },
                { title: 'Основная часть', content: ['Пункт 1', 'Пункт 2', 'Пункт 3'] },
                { title: 'Заключение', content: ['Пункт 1', 'Пункт 2', 'Пункт 3'] }
            ];
        }

        console.log(`Слайдов: ${slides.length}`);
        
        res.json({
            success: true,
            topic: topic,
            slides: slides,
            count: slides.length
        });

    } catch (error) {
        console.error('Ошибка:', error.message);
        
        if (error.response) {
            console.error('Статус:', error.response.status);
            console.error('Данные:', JSON.stringify(error.response.data));
        }
        
        res.status(500).json({
            success: false,
            error: error.message,
            details: error.response?.data || 'Нет деталей'
        });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log('Health: /api/health');
    console.log('Generate: /api/generate');
});