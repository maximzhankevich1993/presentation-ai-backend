const yandexGPT = require('../services/yandexGPT');

exports.generateLessonPlan = async (req, res) => {
  try {
    const { topic, subject, standard, grade, durationMinutes } = req.body;
    
    const prompt = `
      Создай план урока по теме "${topic}" для предмета "${subject}", 
      класс "${grade}", стандарт "${standard}", длительность ${durationMinutes} минут.
      
      Верни JSON в формате:
      {
        "topic": "тема",
        "subject": "предмет", 
        "grade": "класс",
        "standard": "стандарт",
        "duration": "длительность",
        "objectives": ["цель1", "цель2", "цель3"],
        "stages": [
          {
            "name": "название этапа",
            "minutes": 5,
            "teacherActions": "действия учителя",
            "studentActions": "действия учеников",
            "resources": "ресурсы"
          }
        ],
        "homework": "домашнее задание",
        "assessment": "оценивание",
        "differentiation": ["дифференциация1", "дифференциация2"]
      }
    `;
    
    const response = await yandexGPT.generate(prompt);
    res.json(JSON.parse(response));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════
// ГЕНЕРАЦИЯ ТЕСТА ПО ТЕМЕ
// ═══════════════════════════════════════════════════════════════
exports.generateQuizByTopic = async (req, res) => {
  try {
    const { topic, textbook, grade, questionCount, countryCode } = req.body;
    
    if (!topic) {
      return res.status(400).json({ error: 'Тема не указана' });
    }
    
    console.log(`📝 Генерация теста по теме: "${topic}" (${questionCount} вопросов)`);
    
    const countryName = getCountryName(countryCode || 'RU');
    const textbookText = textbook ? `\nУчебник: ${textbook}` : '';
    
    const prompt = `Ты — эксперт по педагогике. Создай тест по теме "${topic}" для ${grade} класса.${textbookText}
Страна: ${countryName}

Создай ${questionCount || 5} вопросов с 4 вариантами ответов.
Для каждого вопроса укажи:
- вопрос
- 4 варианта ответов (A, B, C, D)
- правильный ответ (номер 0-3)
- краткое пояснение

Верни ТОЛЬКО JSON без лишнего текста в формате:
{
  "questions": [
    {
      "question": "текст вопроса",
      "options": ["вариант A", "вариант B", "вариант C", "вариант D"],
      "correct": 0,
      "explanation": "почему это правильно"
    }
  ],
  "difficulty": "medium",
  "timeLimitMinutes": ${(questionCount || 5) * 2}
}`;

    const response = await yandexGPT.generate(prompt);
    const cleanResponse = cleanJsonResponse(response);
    const quiz = JSON.parse(cleanResponse);
    
    console.log(`✅ Тест по теме создан: "${topic}"`);
    res.json(quiz);
    
  } catch (error) {
    console.error('❌ Quiz generation error:', error);
    res.status(500).json({ error: 'Ошибка генерации теста: ' + error.message });
  }
};

// ═══════════════════════════════════════════════════════════════
// ГЕНЕРАЦИЯ ТЕСТА ИЗ ПРЕЗЕНТАЦИИ
// ═══════════════════════════════════════════════════════════════
exports.generateQuizFromPresentation = async (req, res) => {
  try {
    const { title, slides, questionCount } = req.body;
    
    if (!title || !slides || slides.length === 0) {
      return res.status(400).json({ error: 'Некорректные данные презентации' });
    }
    
    console.log(`📝 Генерация теста из презентации: "${title}"`);
    
    // Берём первые 3-5 слайдов для контекста
    const relevantSlides = slides.slice(0, Math.min(5, slides.length));
    const slidesText = relevantSlides.map((s, i) => {
      const text = typeof s === 'string' ? s : (s.title + ' ' + (s.content || []).join(' '));
      return `Слайд ${i+1}: ${text.substring(0, 500)}`;
    }).join('\n');
    
    const prompt = `Ты — эксперт по педагогике. На основе содержания презентации "${title}" создай тест.

Содержание презентации:
${slidesText}

Создай ${questionCount || 5} вопросов с 4 вариантами ответов.
Для каждого вопроса укажи:
- вопрос
- 4 варианта ответов (A, B, C, D)
- правильный ответ (номер 0-3)
- краткое пояснение

Верни ТОЛЬКО JSON без лишнего текста в формате:
{
  "title": "${title}",
  "questions": [
    {
      "question": "текст вопроса",
      "options": ["вариант A", "вариант B", "вариант C", "вариант D"],
      "correct": 0,
      "explanation": "почему это правильно"
    }
  ],
  "difficulty": "medium",
  "timeLimitMinutes": ${(questionCount || 5) * 2}
}`;

    const response = await yandexGPT.generate(prompt);
    const cleanResponse = cleanJsonResponse(response);
    const quiz = JSON.parse(cleanResponse);
    
    console.log(`✅ Тест из презентации создан: "${title}"`);
    res.json(quiz);
    
  } catch (error) {
    console.error('❌ Quiz from presentation error:', error);
    res.status(500).json({ error: 'Ошибка генерации теста из презентации: ' + error.message });
  }
};

// ═══════════════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════════════════════════════
function getCountryName(code) {
  const countries = {
    'RU': 'Россия', 'BY': 'Беларусь', 'KZ': 'Казахстан',
    'UA': 'Украина', 'US': 'США', 'GB': 'Великобритания',
    'DE': 'Германия', 'FR': 'Франция', 'IT': 'Италия',
    'ES': 'Испания', 'PL': 'Польша', 'TR': 'Турция',
    'CN': 'Китай', 'IN': 'Индия', 'BR': 'Бразилия'
  };
  return countries[code] || 'международный';
}

function cleanJsonResponse(response) {
  let cleaned = response;
  cleaned = cleaned.replace(/```json\n?/g, '');
  cleaned = cleaned.replace(/```\n?/g, '');
  cleaned = cleaned.trim();
  
  // Если ответ начинается не с {, ищем первый {
  if (!cleaned.startsWith('{')) {
    const startIndex = cleaned.indexOf('{');
    if (startIndex !== -1) {
      cleaned = cleaned.substring(startIndex);
    }
  }
  
  // Если ответ заканчивается не на }, ищем последний }
  if (!cleaned.endsWith('}')) {
    const endIndex = cleaned.lastIndexOf('}');
    if (endIndex !== -1) {
      cleaned = cleaned.substring(0, endIndex + 1);
    }
  }
  
  return cleaned;
}