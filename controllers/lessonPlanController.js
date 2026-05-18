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