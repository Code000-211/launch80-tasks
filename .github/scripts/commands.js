// Carries out the commands in comments (/ready, /take, ...) and keeps the board in line with the issues.
const lib = require('./lib.js');

const { config } = lib;

const HELP = `**Commands** (as the first line of a comment)

| Command | Who | What it does |
|---|---|---|
| \`/ready\` | Poster | Offers the task: Draft → Ready |
| \`/draft\` | Poster | Takes it back to Draft (only while nobody has it) |
| \`/take\` | Anyone | Takes the task: Ready → In progress, assigns you |
| \`/drop\` | Taker or poster | Gives the task back: → Ready |
| \`/review <link>\` | Taker | Says the work is ready to look at: In progress → In review |
| \`/done\` | Poster | Closes the task: → Done |
| \`/thread <link>\` | Poster or taker | Links the Discord thread on the board |
| \`/help\` | Anyone | Shows this list |`;

const DISCORD_THREAD = /^https:\/\/((ptb|canary)\.)?discord(app)?\.com\/channels\/\S+$/;

module.exports = async ({ github, context, core }) => {
  const repo = context.repo;
  const board = await lib.openBoard(core);
  if (context.eventName === 'issues') {
    await onIssue({ github, context, core, repo, board });
  } else if (context.eventName === 'issue_comment') {
    await onComment({ github, context, core, repo, board });
  }
};

async function onIssue({ github, context, core, repo, board }) {
  const { action, issue } = context.payload;

  if (action === 'opened') {
    if (!lib.labelNames(issue).some((name) => lib.STATUS_LABELS[name])) {
      await lib.setStatusLabel(github, repo, issue, 'draft');
    }
    await lib.syncForm(github, repo, issue, board);
    if (board) await board.set(issue, { Status: 'Draft' });
    await github.rest.issues.createComment({
      ...repo,
      issue_number: issue.number,
      body:
        `Thanks @${issue.user.login}! This task is a **draft** for now. Check that someone who does not know your ` +
        `project could start from it, then comment \`/ready\` to offer it.\n\n${HELP}`,
    });
  } else if (action === 'edited') {
    if (context.payload.changes && context.payload.changes.body) await lib.syncForm(github, repo, issue, board);
  } else if (action === 'closed') {
    await lib.setStatusLabel(github, repo, issue, null);
    if (issue.state_reason === 'not_planned') {
      if (board) await board.archive(issue);
    } else {
      if (board) await board.set(issue, { Status: 'Done' });
      await lib.notify(core, `✅ Done: ${lib.discordLink(issue)}`);
    }
  } else if (action === 'reopened') {
    const label = lib.labelNames(issue).find((name) => lib.STATUS_LABELS[name]);
    if (!label) await lib.setStatusLabel(github, repo, issue, issue.assignees.length ? 'in-progress' : 'draft');
    const fresh = (await github.rest.issues.get({ ...repo, issue_number: issue.number })).data;
    if (board) await board.set(fresh, { Status: lib.statusOf(fresh) });
  }
}

async function onComment({ github, context, core, repo, board }) {
  const { comment } = context.payload;
  const line = comment.body.trim().split('\n')[0].trim();
  if (!line.startsWith('/')) return;
  const [word, ...rest] = line.split(/\s+/);
  const command = word.slice(1).toLowerCase();
  const argument = rest.join(' ');
  const actor = comment.user.login;

  // Re-read the issue: the event's copy may be stale when commands arrive one after another.
  const issue = (await github.rest.issues.get({ ...repo, issue_number: context.payload.issue.number })).data;
  const poster = issue.user.login;
  const isPoster = lib.same(poster, actor) || lib.isModerator(actor);
  const takers = issue.assignees.map((a) => a.login);
  const isTaker = takers.some((login) => lib.same(login, actor));
  const status = lib.statusOf(issue);
  const form = lib.parseForm(issue.body);
  const contact = form['Your Discord name'] || `@${poster}`;

  const reply = (body) => github.rest.issues.createComment({ ...repo, issue_number: issue.number, body });
  const ok = () =>
    github.rest.reactions.createForIssueComment({ ...repo, comment_id: comment.id, content: '+1' });
  const setStatus = async (label) => {
    await lib.setStatusLabel(github, repo, issue, label);
    if (board) await board.set(issue, { Status: lib.STATUS_LABELS[label] });
  };

  if (command !== 'help' && issue.state === 'closed') {
    return reply(`@${actor} This task is closed. Reopen it first.`);
  }

  switch (command) {
    case 'help':
      return reply(HELP);

    case 'ready': {
      if (!isPoster) return reply(`@${actor} Only the person who posted this task (@${poster}) can mark it ready.`);
      if (status !== 'Draft') return reply(`@${actor} This task is already **${status}**.`);
      await setStatus('ready');
      await ok();
      const details = [lib.firstWord(form['Size']), form['Area'], `from ${contact}`].filter(Boolean).join(' · ');
      return lib.notify(core, `📌 New task ready: ${lib.discordLink(issue)}\n${details}`);
    }

    case 'draft': {
      if (!isPoster) return reply(`@${actor} Only the person who posted this task (@${poster}) can do that.`);
      if (status !== 'Ready') return reply(`@${actor} Only a task that is **Ready** can go back to Draft.`);
      await setStatus('draft');
      return ok();
    }

    case 'take': {
      if (status !== 'Ready') {
        return reply(`@${actor} This task is **${status}**, so it cannot be taken right now.`);
      }
      if (takers.length) return reply(`@${actor} @${takers.join(', @')} already has this task.`);

      const active = [];
      for (const label of ['in-progress', 'in-review']) {
        const issues = await github.paginate(github.rest.issues.listForRepo, {
          ...repo,
          state: 'open',
          labels: label,
          per_page: 100,
        });
        active.push(...issues.filter((i) => i.assignees.some((a) => lib.same(a.login, actor))));
      }
      if (active.length >= config.maxTasksPerPerson) {
        const list = active.map((i) => `#${i.number}`).join(', ');
        return reply(
          `@${actor} You already have ${active.length} tasks (${list}), the most anyone can have at a time. ` +
            `Finish or \`/drop\` one first.`,
        );
      }

      const assigned = await github.rest.issues.addAssignees({ ...repo, issue_number: issue.number, assignees: [actor] });
      if (!assigned.data.assignees.some((a) => lib.same(a.login, actor))) {
        return reply(`@${actor} GitHub would not assign this task to you, so it stays Ready.`);
      }
      await setStatus('in-progress');
      const where = form['Discord thread'] ? `in [the Discord thread](${form['Discord thread']})` : 'on Discord';
      await reply(
        `@${actor} took this task. 🎉\n\n` +
          `- Talk to ${contact} ${where}.\n` +
          `- Leave a short update here at least every ${config.releaseAfterDays} days, or the task goes back to Ready.\n` +
          `- When your work is ready to look at, comment \`/review <link>\`. Changed your mind? Comment \`/drop\`.`,
      );
      return lib.notify(core, `🙋 ${actor} took ${lib.discordLink(issue)}`);
    }

    case 'drop': {
      if (!isTaker && !isPoster) return reply(`@${actor} Only the person who has this task or its poster can drop it.`);
      if (status !== 'In progress' && status !== 'In review') {
        return reply(`@${actor} Nobody has this task, so there is nothing to drop.`);
      }
      if (takers.length) {
        await github.rest.issues.removeAssignees({ ...repo, issue_number: issue.number, assignees: takers });
      }
      await setStatus('ready');
      await reply(`This task is **Ready** again and can be taken with \`/take\`.`);
      return lib.notify(core, `🔓 Available again: ${lib.discordLink(issue)}`);
    }

    case 'review': {
      if (!isTaker && !lib.isModerator(actor)) {
        return reply(`@${actor} Only the person who has this task can send it to review.`);
      }
      if (status !== 'In progress') return reply(`@${actor} Only a task that is **In progress** can go to review.`);
      await setStatus('in-review');
      await reply(
        `@${poster} This is ready for you to look at${argument ? `: ${argument}` : ''}. ` +
          `Comment \`/done\` when you are happy with it.`,
      );
      return lib.notify(core, `👀 Ready for review: ${lib.discordLink(issue)} (${contact}, please have a look)`);
    }

    case 'done': {
      if (!isPoster) return reply(`@${actor} Only the person who posted this task (@${poster}) can mark it done.`);
      await lib.setStatusLabel(github, repo, issue, null);
      await github.rest.issues.update({ ...repo, issue_number: issue.number, state: 'closed', state_reason: 'completed' });
      if (board) await board.set(issue, { Status: 'Done' });
      await ok();
      const thanks = takers.length ? `, thanks ${takers.join(', ')}!` : '';
      return lib.notify(core, `✅ Done: ${lib.discordLink(issue)}${thanks}`);
    }

    case 'thread': {
      if (!isPoster && !isTaker) return reply(`@${actor} Only the poster or the person who has this task can do that.`);
      if (!DISCORD_THREAD.test(argument)) {
        return reply(`@${actor} That does not look like a Discord link. Use \`/thread https://discord.com/channels/...\`.`);
      }
      if (!board) return reply(`@${actor} The board is not connected yet, so the thread could not be linked.`);
      await board.set(issue, { 'Discord thread': argument });
      return ok();
    }

    default:
      // Not one of ours: leave it alone.
      return undefined;
  }
}
