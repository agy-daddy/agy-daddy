'use strict';

const HIGH_RISK_RULES = [
  { label: 'rm -r / rm -rf', re: /(?:^|[\s;|&`(])rm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/ },
  { label: 'git reset --hard', re: /\bgit\s+reset\s+--hard\b/ },
  { label: 'git clean -f', re: /\bgit\s+clean\s+-[a-zA-Z]*f/ },
  { label: 'git push', re: /\bgit\s+push\b/ },
  { label: 'git checkout -- / restore', re: /\bgit\s+(?:checkout\s+--(?=\s|$)|restore\b)/ },
  { label: 'sudo / mkfs / dd', re: /(?:^|[\s;|&`(])(?:sudo|mkfs(?:\.\w+)?)\b|\bdd\s+if=/ },
  { label: 'kill -9 / pkill / killall', re: /(?:^|[\s;|&`(])(?:kill\s+-9|pkill|killall)\b/ },
  { label: 'SQL DROP / TRUNCATE / DELETE', re: /\b(?:DROP\s+(?:TABLE|DATABASE)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i },
  { label: '1Password op item 变更', re: /\bop\s+item\s+(?:delete|edit|create)\b/ }
];

function detectHighRiskLabels(text) {
  const s = String(text || '');
  if (!s || s.length < 4) return [];
  const hits = [];
  for (const rule of HIGH_RISK_RULES) {
    if (rule.re.test(s)) hits.push(rule.label);
  }
  return hits;
}

function shouldBlockAutoAccept(text) {
  const labels = detectHighRiskLabels(text);
  return {
    blocked: labels.length > 0,
    labels
  };
}

module.exports = {
  HIGH_RISK_RULES,
  detectHighRiskLabels,
  shouldBlockAutoAccept
};
