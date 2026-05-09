const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
});

const COHERE_API_KEY = process.env.COHERE_API_KEY || 'cohere_2tieM0pkzVnWwCshDTC8Jw1QJtSatDjh60k3Uamx0YB9aP';
const PORT = process.env.PORT || 10000;

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        api: 'Cohere', 
        encoding: 'utf-8',
        timestamp: new Date().toISOString() 
    });
});

// Генерация
app.post('/api/generate', async (req, res) => {
    try {
        const { topic, maxSlides = 5 } = req.body;
        
        if (!topic) {
            return res.status(400).json({ error: 'Укажите topic' });
        }

        console.log('Generating for topic:', topic);
        console.log('Max slides:', maxSlides);

        const prompt = `Создай структуру презентации на тему "${topic}" на русском языке.
Формат ответа - только JSON, без пояснений:
{"slides":[{"title":"Заголовок","content":["Пункт 1","Пункт 2","Пункт 3"]}]}
Количество слайдов: ${maxSlides}.`;

        const response = await axios.post(
            'https://api.cohere.ai/v1/generate',
            {
                model: 'command',
                prompt: prompt,
                max_tokens: 1500,
                temperature: 0.7,
                k: 0,
                p: 0.75
            },
            {
                headers: {
                    'Authorization': `Bearer ${COHERE_API_KEY}`,
                    'Content-Type': 'application/json; charset=utf-8',
                    'Accept': 'application/json'
                },
                timeout: 30000
            }
        );

        const rawText = response.data.generations[0].text;
        console.log('Raw response:', rawText.substring(0, 300));

        // Парсим JSON
        let slides = [];
        try {
            const cleanJson = rawText.replace(/```json\n?|```/g, '').trim();
            const parsed = JSON.parse(cleanJson);
            slides = parsed.slides || [];
        } catch (e) {
            console.log('JSON parse error, using fallback');
            // Простой парсинг
            const lines = rawText.split('\n').filter(l => l.includes('"title"') || l.includes('"content"'));
            let current = null;
            for (const line of lines) {
                const titleMatch = line.match(/"title"\s*:\s*"([^"]+)"/);
                if (titleMatch) {
                    if (current) slides.push(current);
                    current = { title: titleMatch[1], content: [] };
                }
                const contentMatch = line.match(/"content"\s*:\s*"([^"]+)"/);
                if (contentMatch && current) {
                    current.content.push(contentMatch[1]);
                }
            }
            if (current) slides.push(current);
        }

        // Заглушка если пусто
        if (slides.length === 0) {
            slides = [{ title: topic, content: ['Введение', 'Основная часть', 'Заключение'] }];
        }

        console.log('Slides generated:', slides.length);

        res.json({
            success: true,
            topic: topic,
            slides: slides,
            count: slides.length
        });

    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ 
            error: 'Ошибка генерации',
            message: error.message 
        });
    }
});

// Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});