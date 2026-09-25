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

test('parses answers that span several lines, bullets and numbered lists', () => {
  const e = M.parseKey(
    [
      'Quiz - Full Questions & Answers',
      '1. Which plan provides assistance with AnyDesk',
      'Answer: ✅ Dedicated Engineer Session or PLSM',
      '2. Select correct usage to run a php script',
      'Answer: ✅',
      '',
      '* `user@host [~]# /usr/local/bin/php /home/user/task.php`',
      "* `root@host [~]# sudo -u user bash -c '/usr/local/bin/php /home/user/task.php'`",
      '',
      '3. Match following tasks in order of priority',
      'Answer: ✅',
      '',
      '1. Priority Chats',
      '2. Priority Tickets',
      '3. Standard queue simple tickets',
      '',
      '4. What is the correct two-step process to follow during migrations?',
      'Answer: ✅ Perform migration without DNS change and test.',
      'Do a final data resync, update DNS, and test again.',
      'Additional Questions You Shared Later',
      '5. Which of the following are required steps in a server migration? (Select all that apply)',
      'Answer: ✅ Select ALL:',
      '',
      '* Perform the initial migration',
      '* Verify websites using the hosts file',
      '6. How many websites can be monitored in LSM plan',
      'Answer: ✅ 3',
    ].join('\n')
  );
  assert.deepEqual(
    e.map((x) => [x.q, x.a]),
    [
      ['Which plan provides assistance with AnyDesk', 'Dedicated Engineer Session or PLSM'],
      [
        'Select correct usage to run a php script',
        "user@host [~]# /usr/local/bin/php /home/user/task.php\nroot@host [~]# sudo -u user bash -c '/usr/local/bin/php /home/user/task.php'",
      ],
      ['Match following tasks in order of priority', '1. Priority Chats\n2. Priority Tickets\n3. Standard queue simple tickets'],
      [
        'What is the correct two-step process to follow during migrations?',
        'Perform migration without DNS change and test.\nDo a final data resync, update DNS, and test again.',
      ],
      [
        'Which of the following are required steps in a server migration? (Select all that apply)',
        'Perform the initial migration\nVerify websites using the hosts file',
      ],
      ['How many websites can be monitored in LSM plan', '3'],
    ]
  );
});

test('parses options with the correct one marked, and "Question?" / answer lines', () => {
  const e = M.parseKey(
    [
      'Q1. Which command lists open ports?',
      'a) netstat -r',
      'b) ss -tulpn ✅',
      'c) df -h',
      '',
      'Which file stores DNS resolvers?',
      '/etc/resolv.conf',
      '',
      'Question 3: Default web root?  Answer: /var/www/html',
    ].join('\n')
  );
  assert.deepEqual(
    e.map((x) => [x.q, x.a]),
    [
      ['Which command lists open ports?', 'ss -tulpn'],
      ['Which file stores DNS resolvers?', '/etc/resolv.conf'],
      ['Default web root?', '/var/www/html'],
    ]
  );
});

test('checkbox question ticks every listed statement but not near-identical wrong ones', () => {
  const key = M.parseKey(
    [
      '1. Select correct usage to run a php script like /home/u/task.php with php binary in a cpanel website',
      'Answer:',
      '* `u@host [~]# /usr/local/bin/php /home/u/task.php --failed`',
      "* `root@host [~]# sudo -u u bash -c '/usr/local/bin/php /home/u/task.php --failed'`",
    ].join('\n')
  );
  const r = M.solve(
    {
      text: '5. Select correct usage to run a php script like "/home/u/task.php" with php binary in a cpanel website',
      options: [
        'root@host [~]# php /home/u/task.php --failed',
        'u@host [~]# /usr/local/bin/php /home/u/task.php --failed',
        "root@host [~]# sudo -u u bash -c '/usr/local/bin/php /home/u/task.php --failed'",
        'root@host [~]# /usr/bin/php /home/u/task.php --failed',
      ],
      multi: true,
    },
    key
  );
  assert.deepEqual(r.picks, [1, 2]);
});

test('matching / ordering drop-downs follow the numbered answer list', () => {
  const key = M.parseKey('Match following tasks in order of priority\nAnswer:\n1. Priority Chats\n2. Priority Tickets\n3. Simple tickets');
  const rowsByTask = ['Simple tickets', 'Priority Chats', 'Priority Tickets'];
  for (const opts of [['1', '2', '3'], ['1st', '2nd', '3rd'], ['First', 'Second', 'Third']]) {
    const r = M.solve({ kind: 'select', text: 'Match following tasks in order of priority', rows: rowsByTask.map((label) => ({ label, options: opts })) }, key);
    assert.deepEqual(r.rowPicks, [2, 0, 1], opts.join(','));
    assert.equal(r.confidence, 'high');
  }
  // Rows are positions, drop-downs list the tasks.
  const tasks = ['Priority Tickets', 'Simple tickets', 'Priority Chats'];
  const r = M.solve({ kind: 'select', text: 'Match following tasks in order of priority', rows: ['1', '2', '3'].map((label) => ({ label, options: tasks })) }, key);
  assert.deepEqual(r.rowPicks, [2, 0, 1]);
});

test('drag-and-drop ordering: each item gets its slot from the numbered answer list', () => {
  const key = M.parseKey(
    '### 14. Match following tasks in order of priority\n\n**Answer:**\n\n1. Priority Chats\n2. Priority Tickets\n3. Standard queue Downtime issues\n' +
      '4. Scheduled tasks - try to complete the tasks before off-peak hours get over\n5. Standard queue simple tickets'
  );
  const items = ['Standard queue simple tickets', 'Standard queue Downtime issues', 'Scheduled tasks - try to complete the tasks before off-peak hours get over', 'Priority chats', 'Priority tickets'];
  const slots = ['1', '2', '3', '4', '5'];
  const r = M.solve({ kind: 'drag', text: '17. Match following tasks in order of priority', rows: items.map((label) => ({ label, options: slots })) }, key);
  assert.deepEqual(r.rowPicks.map((i) => slots[i]), ['5', '3', '4', '1', '2']);
  assert.equal(r.confidence, 'high');
});

test('typed-answer questions are filled but always marked for checking', () => {
  const key = M.parseKey('1. Why does MySQL fail after deleting ib_logfile0 without a clean shutdown?\nAnswer: LSN mismatch due to missing redo logs');
  const r = M.solve({ kind: 'text', text: 'Why does MySQL fail to start after deleting ib_logfile0 without a clean shutdown?', fieldCount: 1 }, key);
  assert.deepEqual(r.fills, ['LSN mismatch due to missing redo logs']);
  assert.equal(r.confidence, 'low');
});

test('parses markdown-heading keys ("### 36. Question" / "**Answer:**" / "---")', () => {
  const text = [
    '# Quiz - Full Questions & Answers',
    '',
    '### 35. What is the preferred method to handle load surge in Per Ledin servers',
    '',
    '**Answer:** Check if any website is being targeted, causing a load surge. If so, enable Attack Mode in Cloudflare for that website.',
    '',
    '---',
    '',
    '## Additional Questions You Shared Later',
    '',
    '### 36. What is the correct procedure after completing work on a customer\u2019s Windows server?',
    '',
    '**Answer:** Log out properly from the Windows server',
    '',
    '### Question 37',
    'Which plan provides assistance with AnyDesk',
    '#### Answer',
    'Dedicated Engineer Session or PLSM',
    '',
    '### How many websites can be monitored in LSM plan',
    '3',
  ].join('\n');
  assert.deepEqual(
    M.parseKey(text).map((x) => [x.q, x.a]),
    [
      [
        'What is the preferred method to handle load surge in Per Ledin servers',
        'Check if any website is being targeted, causing a load surge. If so, enable Attack Mode in Cloudflare for that website.',
      ],
      ['What is the correct procedure after completing work on a customer\u2019s Windows server?', 'Log out properly from the Windows server'],
      ['Which plan provides assistance with AnyDesk', 'Dedicated Engineer Session or PLSM'],
      ['How many websites can be monitored in LSM plan', '3'],
    ]
  );
});

test('real quiz page: "Choose ALL correct statements about using AI" picks "All of the statements are correct"', () => {
  const key = M.parseKey('### 15. Choose ALL correct statements about using AI for solutions\n\n**Answer:** All of the statements are correct');
  const r = M.solve(
    {
      text: '14. Choose ALL correct statements about using AI for solutions',
      options: [
        'Never rely on a solution from a single source, especially an AI source unless crosschecked with suitable multiple references',
        'We need to avoid making assumptions',
        'It is important to cross-check any proposed solution using our own judgment and using multiple sources & documentations.',
        'AI can only act as a guidance, we can not blidly trust AI as it can hallucinate by nature.',
        'We should not share any sensitive info (IP, login, client name) in AI tools .',
        'AI-generated content can sometimes include inaccuracies or "hallucinations" by nature.',
        'All of the statements are correct',
      ],
      multi: false,
    },
    key
  );
  assert.deepEqual(r.picks, [6]);
  assert.equal(r.confidence, 'high');
});

test('plain "full question, then correct answer only" blocks', () => {
  const e = M.parseKey(
    [
      'Which plan provides assistance with AnyDesk',
      'Dedicated Engineer Session or PLSM',
      '',
      'What is the correct two-step process to follow during migrations?',
      'Perform migration without DNS change and test.',
      'Do a final data resync, update DNS, and test again.',
      '',
      'Match following tasks in order of priority',
      '1. Priority Chats',
      '2. Priority Tickets',
      'How many websites can be monitored in LSM plan',
      '3',
      '',
      'Which of the following are required steps in a server migration? (Select all that apply)',
      '- Perform the initial migration',
      '- Verify websites using the hosts file',
      '',
      '```text',
      '1  - Dedicated Engineer Session or PLSM',
      '2  - Call or chat to get OTP',
      '```',
    ].join('\n')
  );
  assert.deepEqual(
    e.map((x) => [x.q, x.a]),
    [
      ['Which plan provides assistance with AnyDesk', 'Dedicated Engineer Session or PLSM'],
      ['What is the correct two-step process to follow during migrations?', 'Perform migration without DNS change and test.\nDo a final data resync, update DNS, and test again.'],
      ['Match following tasks in order of priority', '1. Priority Chats\n2. Priority Tickets'],
      ['How many websites can be monitored in LSM plan', '3'],
      ['Which of the following are required steps in a server migration? (Select all that apply)', 'Perform the initial migration\nVerify websites using the hosts file'],
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

test('"A + B + C" key answers map to "All of the above"', () => {
  const r = M.solve(
    {
      text: 'Which are correct about WordPress updates?',
      options: ['Updates can be done via WP-CLI after a backup', 'Updates are billable', 'Test the site and restore if needed', 'All of the above'],
      multi: false,
    },
    M.parseKey(KEY)
  );
  assert.deepEqual(r.picks, [3]);
  assert.equal(r.confidence, 'high');

  // An extra statement the key never mentions: still "All of the above", but ask for a check.
  const r2 = M.solve(
    {
      text: 'Which are correct about WordPress updates?',
      options: ['Updates can be done via WP-CLI after a backup', 'Updates are billable', 'Test the site and restore if needed', 'Updates never need a backup', 'All of the above'],
      multi: false,
    },
    M.parseKey(KEY)
  );
  assert.deepEqual(r2.picks, [4]);
  assert.equal(r2.confidence, 'low');
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
