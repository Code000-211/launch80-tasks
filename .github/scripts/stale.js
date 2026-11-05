// Reminds people who took a task and went quiet, and gives the task back after too long.
const lib = require('./lib.js');

const { config } = lib;

const WARNING = '<!-- launch80-tasks:stale-warning -->';
const DAY = 24 * 60 * 60 * 1000;

module.exports = async ({ github, context, core }) => {
  const repo = context.repo;
  const board = await lib.openBoard(core);
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repo,
    state: 'open',
    labels: 'in-progress',
    per_page: 100,
  });

  for (const issue of issues) {
    if (issue.pull_request || !issue.assignees.length) continue;
    const takers = issue.assignees.map((a) => a.login);
    const comments = await github.paginate(github.rest.issues.listComments, {
      ...repo,
      issue_number: issue.number,
      per_page: 100,
    });
    // `/take` is a comment too, so a taker always has at least one.
    const theirs = comments.filter((c) => takers.some((login) => lib.same(login, c.user.login)));
    if (!theirs.length) continue;
    const lastUpdate = new Date(theirs[theirs.length - 1].created_at).getTime();
    const idleDays = (Date.now() - lastUpdate) / DAY;

    if (idleDays >= config.releaseAfterDays) {
      await github.rest.issues.removeAssignees({ ...repo, issue_number: issue.number, assignees: takers });
      await lib.setStatusLabel(github, repo, issue, 'ready');
      if (board) await board.set(issue, { Status: 'Ready' });
      await github.rest.issues.createComment({
        ...repo,
        issue_number: issue.number,
        body:
          `@${takers.join(', @')} There has been no update for ${config.releaseAfterDays} days, so this task is ` +
          `**Ready** again. If you are still on it, comment \`/take\` to take it back.`,
      });
      await lib.notify(core, `🔓 Available again (no update for ${config.releaseAfterDays} days): ${lib.discordLink(issue)}`);
    } else if (idleDays >= config.warnAfterDays) {
      const warned = comments.some(
        (c) => c.body.includes(WARNING) && new Date(c.created_at).getTime() > lastUpdate,
      );
      if (warned) continue;
      await github.rest.issues.createComment({
        ...repo,
        issue_number: issue.number,
        body:
          `${WARNING}\n@${takers.join(', @')} How is it going? Leave a short update here, or this task goes back ` +
          `to Ready in ${Math.ceil(config.releaseAfterDays - idleDays)} days. Comment \`/drop\` if you cannot ` +
          `finish it.`,
      });
    }
  }
};
