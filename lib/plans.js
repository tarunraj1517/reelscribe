// Central place to tune what each plan gets from the new features.
const AI_LIMITS = {            // actions per day
  free:    { ai: 3,   edit: 0  },
  starter: { ai: 15,  edit: 5  },
  pro:     { ai: 50,  edit: 20 },
  agency:  { ai: 200, edit: 60 },
};

const FEATURE_PLANS = {
  scheduler: ["starter", "pro", "agency"],
  editor:    ["starter", "pro", "agency"],
  brandKit:  ["agency"],
  team:      ["agency"],
  api:       ["agency"],   // API keys + webhooks
};

const hasFeature = (plan, feature) => (FEATURE_PLANS[feature] || []).includes(plan);

const planNeeded = (feature) => {
  const first = (FEATURE_PLANS[feature] || [])[0] || "agency";
  return first.charAt(0).toUpperCase() + first.slice(1);
};

const LANGUAGES = [
  "Hindi", "Hinglish", "English", "Bengali", "Tamil", "Telugu", "Marathi", "Gujarati", "Kannada", "Malayalam", "Punjabi", "Urdu",
  "Spanish", "French", "German", "Portuguese", "Italian", "Russian", "Turkish", "Arabic", "Indonesian", "Japanese", "Korean", "Chinese (Simplified)",
];

const langSlug = (l) => String(l).toLowerCase().replace(/[^a-z]/g, "");

module.exports = { AI_LIMITS, FEATURE_PLANS, hasFeature, planNeeded, LANGUAGES, langSlug };
