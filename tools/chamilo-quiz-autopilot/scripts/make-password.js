#!/usr/bin/env node
/*
 * Makes the passwordHash value for config.js (salted PBKDF2-SHA256):
 *
 *   node tools/chamilo-quiz-autopilot/scripts/make-password.js "your password"
 *
 * Paste the printed line into config.js as passwordHash. Leave passwordHash
 * empty for no lock.
 */
'use strict';
const crypto = require('crypto');

function makeHash(password, iterations = 200000) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256');
  return ['pbkdf2-sha256', iterations, salt.toString('base64'), hash.toString('base64')].join('$');
}

if (require.main === module) {
  const pw = process.argv[2];
  if (!pw) {
    console.error('Usage: node make-password.js "your password"');
    process.exit(1);
  }
  console.log(makeHash(pw));
}

module.exports = { makeHash };
