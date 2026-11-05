// Shared by the command and the stale workflows: settings, issue labels, the board and Discord.
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tasks.json'), 'utf8'));

// The status label on an issue is the source of truth; the board follows it.
const STATUS_LABELS = {
  draft: 'Draft',
  ready: 'Ready',
  'in-progress': 'In progress',
  'in-review': 'In review',
};

// Options of the form's "Area" dropdown and the labels they become.
const AREA_LABELS = {
  'Code': 'area: code',
  'Design': 'area: design',
  'Docs & writing': 'area: docs',
  'Testing': 'area: testing',
  'DevOps & infrastructure': 'area: devops',
  'Other': 'area: other',
};

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const isModerator = (login) => config.moderators.some((m) => same(m, login));

const labelNames = (issue) => issue.labels.map((l) => (typeof l === 'string' ? l : l.name));

function statusOf(issue) {
  if (issue.state === 'closed') return 'Done';
  const label = labelNames(issue).find((name) => STATUS_LABELS[name]);
  return label ? STATUS_LABELS[label] : 'Draft';
}

async function removeLabel(github, repo, issue, name) {
  try {
    await github.rest.issues.removeLabel({ ...repo, issue_number: issue.number, name });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

// Replaces the issue's status label with `label`, or removes it when `label` is null.
async function setStatusLabel(github, repo, issue, label) {
  const current = labelNames(issue);
  for (const name of current) {
    if (STATUS_LABELS[name] && name !== label) await removeLabel(github, repo, issue, name);
  }
  if (label && !current.includes(label)) {
    await github.rest.issues.addLabels({ ...repo, issue_number: issue.number, labels: [label] });
  }
}

// Reads an issue form's body: "### Label\n\nvalue" sections.
function parseForm(body) {
  const fields = {};
  for (const section of (body || '').split(/^### /m).slice(1)) {
    const end = section.indexOf('\n');
    const label = (end === -1 ? section : section.slice(0, end)).trim();
    const value = end === -1 ? '' : section.slice(end + 1).trim();
    fields[label] = value === '_No response_' ? '' : value;
  }
  return fields;
}

// "M (about a day)" -> "M"
const firstWord = (value) => (value || '').split(/\s+/)[0];

// Brings the area labels and the board's fields in line with the issue's form.
async function syncForm(github, repo, issue, board) {
  const form = parseForm(issue.body);
  const wanted = (form['Area'] || '')
    .split(',')
    .map((area) => AREA_LABELS[area.trim()])
    .filter(Boolean);
  const current = labelNames(issue);
  for (const name of current) {
    if (name.startsWith('area: ') && !wanted.includes(name)) await removeLabel(github, repo, issue, name);
  }
  const missing = wanted.filter((name) => !current.includes(name));
  if (missing.length) await github.rest.issues.addLabels({ ...repo, issue_number: issue.number, labels: missing });

  if (board) {
    await board.set(issue, {
      'Project link': form['Project'],
      Contact: form['Your Discord name'],
      Size: firstWord(form['Size']),
      Priority: firstWord(form['Priority']),
      'Discord thread': form['Discord thread'],
    });
  }
}

async function graphql(token, query, variables) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await response.json();
  if (!response.ok || json.errors) throw new Error(`GitHub GraphQL: ${JSON.stringify(json.errors || json)}`);
  return json.data;
}

// The board, or null when BOARD_TOKEN is not set.
async function openBoard(core) {
  const token = process.env.BOARD_TOKEN;
  if (!token) {
    core.warning('BOARD_TOKEN is not set, so the board is not updated.');
    return null;
  }
  const gql = (query, variables) => graphql(token, query, variables);

  const data = await gql(
    `query($owner: String!, $number: Int!) {
      repositoryOwner(login: $owner) {
        ... on ProjectV2Owner {
          projectV2(number: $number) {
            id
            fields(first: 50) {
              nodes {
                ... on ProjectV2FieldCommon { id name }
                ... on ProjectV2SingleSelectField { options { id name } }
              }
            }
          }
        }
      }
    }`,
    { owner: config.board.owner, number: config.board.number },
  );
  const project = data.repositoryOwner && data.repositoryOwner.projectV2;
  if (!project) throw new Error(`Board ${config.board.owner}/${config.board.number} not found.`);
  const fields = new Map(project.fields.nodes.map((field) => [field.name, field]));

  // Adding an issue that is already on the board returns its existing item.
  async function itemOf(issue) {
    const added = await gql(
      `mutation($project: ID!, $content: ID!) {
        addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
      }`,
      { project: project.id, content: issue.node_id },
    );
    return added.addProjectV2ItemById.item.id;
  }

  return {
    // Sets fields by name; empty values are left as they are.
    async set(issue, values) {
      const item = await itemOf(issue);
      for (const [name, value] of Object.entries(values)) {
        if (!value) continue;
        const field = fields.get(name);
        if (!field) {
          core.warning(`The board has no field "${name}".`);
          continue;
        }
        let fieldValue = { text: value };
        if (field.options) {
          const option = field.options.find((o) => same(o.name, value));
          if (!option) {
            core.warning(`The board's field "${name}" has no option "${value}".`);
            continue;
          }
          fieldValue = { singleSelectOptionId: option.id };
        }
        await gql(
          `mutation($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
            updateProjectV2ItemFieldValue(
              input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }
            ) { projectV2Item { id } }
          }`,
          { project: project.id, item, field: field.id, value: fieldValue },
        );
      }
    },

    async archive(issue) {
      const item = await itemOf(issue);
      await gql(
        `mutation($project: ID!, $item: ID!) {
          archiveProjectV2Item(input: { projectId: $project, itemId: $item }) { item { id } }
        }`,
        { project: project.id, item },
      );
    },
  };
}

// Posts to the Discord channel, when DISCORD_WEBHOOK is set. Never pings anyone.
async function notify(core, content) {
  const url = process.env.DISCORD_WEBHOOK;
  if (!url) return;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!response.ok) core.warning(`Discord answered ${response.status}: ${await response.text()}`);
}

// "[#12 Fix the login page](<https://github.com/...>)" for Discord.
const discordLink = (issue) => `[#${issue.number} ${issue.title.replace(/[[\]]/g, '')}](<${issue.html_url}>)`;

module.exports = {
  config,
  STATUS_LABELS,
  same,
  isModerator,
  labelNames,
  statusOf,
  setStatusLabel,
  parseForm,
  firstWord,
  syncForm,
  openBoard,
  notify,
  discordLink,
};
