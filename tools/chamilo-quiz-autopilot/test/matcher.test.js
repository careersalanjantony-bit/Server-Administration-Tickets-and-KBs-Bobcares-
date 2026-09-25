// Run with: node --test tools/chamilo-quiz-autopilot/test/matcher.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../matcher.js');

const KEY = `
| # | Question | Correct Answer |
|---|---|---|
| **1** | Select correct statements about MySQL recovery | **All of the above** |
| **2** | SSH \`REMOTE HOST IDENTIFICATION HAS CHANGED\` on custom key server | **\`rmkh 12345\`** |
| **3** | Verify MySQL is fully stopped | **Use \`pstree\` and \`ps aux | egrep "mysql\\|mariadb"\`; kill leftovers** |
| **4** | Which is not a billable task? | **Server hack** |
| **5** | Correct usage to run a PHP script | **\`/usr/local/bin/php ...\`** OR **\`sudo -u <user> /usr/local/bin/php ...\`** |
| **6** | Correct WordPress update statements | **WP-CLI with backup + billable + test/restore if needed** |

\`\`\`text
1  - All of the above
\`\`\`
`;

test('parses a markdown table, including pipes inside backticks', () => {
  const e = M.parseKey(KEY);
  assert.equal(e.length, 6);
  assert.deepEqual(e[0], { q: 'Select correct statements about MySQL recovery', a: 'All of the above' });
  assert.equal(e[1].a, 'rmkh 12345');
  assert.equal(e[2].a, 'Use pstree and ps aux | egrep "mysql|mariadb"; kill leftovers');
});

test('parses other formats', () => {
  const e = M.parseKey(
    [
      'What port does SSH use? => 22',
      'Default web root | /var/www/html',
      'Q: Which command lists open ports?',
      'A: ss -tulpn',
      'Which file stores DNS resolvers?',
      '/etc/resolv.conf',
    ].join('\n')
  );
  assert.deepEqual(
    e.map((x) => [x.q, x.a]),
    [
      ['What port does SSH use?', '22'],
      ['Default web root', '/var/www/html'],
      ['Which command lists open ports?', 'ss -tulpn'],
      ['Which file stores DNS resolvers?', '/etc/resolv.conf'],
    ]
  );
  assert.equal(M.parseKey('[{"q":"a question","a":"an answer"}]').length, 1);
});

test('parses numbered bold questions with "Answer:" lines', () => {
  const e = M.parseKey(
    [
      '## Quiz - Questions & Answers',
      '',
      '**1. Which plan provides assistance with AnyDesk?**  ',
      '**Answer:** Dedicated Engineer Session or PLSM',
      '',
      '**2. When verifying MySQL is fully stopped, which is the correct approach**  ',
      '**Answer:** Use `pstree` and `ps aux | egrep "mysql|mariadb"`',
      '',
      '3. Answer on the next line',
      'Answer:',
      'All of the above',
      '',
      '**4. Which plan provides assistance with AnyDesk?**',
      '**Answer:** Dedicated Engineer Session or PLSM',
    ].join('\n')
  );
  assert.deepEqual(
    e.map((x) => [x.q, x.a]),
    [
      ['Which plan provides assistance with AnyDesk?', 'Dedicated Engineer Session or PLSM'],
      ['When verifying MySQL is fully stopped, which is the correct approach', 'Use pstree and ps aux | egrep "mysql|mariadb"'],
      ['Answer on the next line', 'All of the above'],
    ]
  );
});

test('pauses when a second key entry for the question accepts two options', () => {
  const key = M.parseKey(
    [
      'Correct usage to run a PHP script in cPanel | Use /usr/local/bin/php; either directly as the cPanel user or via sudo -u',
      'Correct usage to run a PHP script like /home/u/cli/task.php | /usr/local/bin/php ... OR sudo -u <user> bash -c \'/usr/local/bin/php ...\'',
    ].join('\n')
  );
  const r = M.solve(
    {
      text: 'What is the correct usage to run a PHP script in a cPanel website?',
      options: ['php x.php', '/usr/local/bin/php x.php', "sudo -u user bash -c '/usr/local/bin/php x.php'", '/usr/bin/php x.php'],
      multi: false,
    },
    key
  );
  assert.equal(r.confidence, 'low');
});

test('matches the screenshot question to "All of the above" even with shuffled options', () => {
  const r = M.solve(
    {
      text: '4. Select correct statements about mysql recovery',
      options: [
        'Most MySQL tables now use the InnoDB storage engine, which has strict file handling rules.',
        'All of the above',
        'If you attempt to fix issues by manually modifying these files, it will likely lead to data corruption or permanent data loss.',
        'The only safe way to recover or work with InnoDB tables is through recovery mode, followed by a logical dump and restore.',
        'You must not move or delete InnoDB-related files manually - this includes critical files like ibdata.',
      ],
      multi: false,
    },
    M.parseKey(KEY)
  );
  assert.deepEqual(r.picks, [1]);
  assert.equal(r.confidence, 'high');
});

test('matches a heavily reworded question by its content', () => {
  const r = M.solve(
    {
      text: "7. While connecting over SSH to a server that uses a custom key you get 'REMOTE HOST IDENTIFICATION HAS CHANGED'. What do you run?",
      options: ['ssh-keygen -R host', 'rmkh', 'rm -rf ~/.ssh', 'rmkh 12345'],
      multi: false,
    },
    M.parseKey(KEY)
  );
  assert.deepEqual(r.picks, [3]);
  assert.equal(r.confidence, 'high');
});

test('"not" questions keep their meaning', () => {
  const r = M.solve(
    { text: 'Which of the following is NOT a billable task?', options: ['Migration', 'Server hack', 'WordPress update'], multi: false },
    M.parseKey(KEY)
  );
  assert.deepEqual(r.picks, [1]);
  assert.equal(r.confidence, 'high');
});

test('ambiguous "A OR B" answers pause instead of guessing blindly', () => {
  const r = M.solve(
    {
      text: 'What is the correct usage to run a PHP script?',
      options: ['php x.php', '/usr/local/bin/php x.php', 'sudo -u user /usr/local/bin/php x.php', '/usr/bin/php x.php'],
      multi: false,
    },
    M.parseKey(KEY)
  );
  assert.equal(r.confidence, 'low');
  assert.ok([1, 2].includes(r.picks[0]));
});

test('"A + B + C" key answers map to "All of the above" but ask for a check', () => {
  const r = M.solve(
    {
      text: 'Which are correct about WordPress updates?',
      options: ['Updates can be done via WP-CLI after a backup', 'Updates are billable', 'Test the site and restore if needed', 'All of the above'],
      multi: false,
    },
    M.parseKey(KEY)
  );
  assert.deepEqual(r.picks, [3]);
  assert.equal(r.confidence, 'low');
});

test('unknown questions are not answered', () => {
  const r = M.solve(
    { text: 'What colour is the company logo?', options: ['Red', 'Blue', 'All of the above'], multi: false },
    M.parseKey(KEY)
  );
  assert.notEqual(r.confidence, 'high');
});

test('multiple-answer (checkbox) questions tick every matching option', () => {
  const r = M.solve(
    {
      text: 'Correct WordPress update statements',
      options: ['Use WP-CLI with a backup', 'It is billable', 'Never test after updating', 'Test and restore if needed'],
      multi: true,
    },
    M.parseKey(KEY)
  );
  assert.deepEqual(r.picks, [0, 1, 3]);
});
