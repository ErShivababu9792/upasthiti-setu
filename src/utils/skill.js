/**
 * Turns the worker's registration answers into a SUGGESTED level and wage.
 * The contractor always makes the final decision while approving.
 */
const LEVELS = ['helper', 'semi_skilled', 'skilled', 'head_mistri'];

const DEFAULT_WAGE = {
  helper: 600,
  semi_skilled: 800,
  skilled: 1000,
  head_mistri: 1300,
};

function scoreSkill(skill = {}) {
  let score = 0;
  const years = Number(skill.experienceYears) || 0;

  if (years >= 10) score += 4;
  else if (years >= 5) score += 3;
  else if (years >= 2) score += 2;
  else if (years >= 1) score += 1;

  score += Math.min((skill.tools || []).length, 3); // max 3 points for tools
  score += Math.min((skill.workTypes || []).length, 3); // max 3 points for kinds of work done
  if (skill.canReadDrawings) score += 2;
  if (skill.canLeadTeam) score += 2;

  return score; // 0 – 14
}

function suggestLevel(skill, trade) {
  if (trade === 'helper') return 'helper';
  const score = scoreSkill(skill);
  if (score >= 11) return 'head_mistri';
  if (score >= 7) return 'skilled';
  if (score >= 3) return 'semi_skilled';
  return 'helper';
}

module.exports = { LEVELS, DEFAULT_WAGE, scoreSkill, suggestLevel };
