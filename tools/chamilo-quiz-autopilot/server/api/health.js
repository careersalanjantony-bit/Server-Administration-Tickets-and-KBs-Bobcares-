/*
 * /api/health - is the deployment set up? (no access key needed, reveals nothing
 * about the stored questions)
 */
'use strict';

const { getStore } = require('../lib/store');
const { cors, send } = require('../lib/http');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  const store = getStore();
  let database = store ? 'connected' : 'missing';
  if (store) {
    try {
      await store.rev();
    } catch (e) {
      database = 'error: ' + e.message;
    }
  }
  send(res, 200, { ok: database === 'connected' && !!process.env.BANK_TOKEN, accessKey: process.env.BANK_TOKEN ? 'set' : 'missing', database });
};
