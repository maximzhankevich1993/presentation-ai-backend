const express = require('express');
const router = express.Router();
const { generateLessonPlan } = require('../controllers/lessonPlanController');

router.post('/generate', generateLessonPlan);

module.exports = router;