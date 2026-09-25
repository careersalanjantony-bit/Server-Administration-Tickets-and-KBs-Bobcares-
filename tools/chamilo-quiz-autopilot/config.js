/*
 * Cloud sync settings built into this copy of the add-on.
 *
 * Fill these in once (your Vercel address and the BANK_TOKEN you chose) and
 * every computer that loads this copy connects to your question bank on its
 * own - no setup needed there. Leave them empty to set up sync by hand in the
 * question bank page instead.
 *
 * Keep a filled-in copy private: anyone with the access key can read and
 * change your questions. Don't commit it to a public repository.
 */
globalThis.QUIZ_AUTOPILOT_CONFIG = {
  serverUrl: '', // e.g. 'https://quiz-autopilot-sync.vercel.app'
  accessKey: '', // the BANK_TOKEN value from Vercel
};
