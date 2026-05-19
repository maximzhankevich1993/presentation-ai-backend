const express = require('express');
const router = express.Router();
const { generateLessonPlan } = require('../controllers/lessonPlanController');
const { generateQuizByTopic, generateQuizFromPresentation } = require('../controllers/quizController');

// Планы уроков
router.post('/generate', generateLessonPlan);

// Тесты
router.post('/quiz/generate', generateQuizByTopic);
router.post('/quiz/from-presentation', generateQuizFromPresentation);

module.exports = router;